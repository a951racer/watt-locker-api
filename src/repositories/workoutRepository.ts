import { Collection, Db, ObjectId, Filter, Sort } from 'mongodb';
import { WorkoutRecord, WorkoutMetadata, ActivityUpdateFields, MetricDataPoint, MetricType } from '../models/workout';
import { PaginatedResult } from '../models/api';

/** Query parameters for listing workouts */
export interface WorkoutQuery {
  userId: string;
  page: number;
  pageSize: number;
  sortBy?: 'date' | 'duration' | 'distance';
  sortOrder?: 'asc' | 'desc';
  dateFrom?: Date;
  dateTo?: Date;
  activityType?: string;
  dataSource?: string;
  status?: string[];
  template?: boolean;
  search?: string;
}

/** Query parameters for retrieving time-series metrics */
export interface MetricQuery {
  workoutId?: string;
  timeFrom: Date;
  timeTo: Date;
  metricTypes?: MetricType[];
}

/** Stored workout document shape in MongoDB */
export interface WorkoutDocument {
  _id: ObjectId;
  userId: string;
  // Lifecycle
  status?: string;    // 'planned' | 'completed' | 'skipped' — optional for legacy docs
  template?: boolean; // optional for legacy docs
  date?: string;      // YYYY-MM-DD — optional for legacy docs (PLAN-003 backfills)
  // Planned values
  plannedDurationSeconds?: number;
  plannedDistanceMeters?: number;
  plannedTss?: number;
  plannedIf?: number;
  plannedTssOverride?: boolean;
  plannedIfOverride?: boolean;
  // Summary
  activityType: string;
  subActivityType?: string;
  startTime?: Date;
  endTime?: Date;
  durationSeconds?: number;
  movingTimeSeconds?: number;
  distanceMeters?: number;
  elevationGainMeters?: number;
  elevationLossMeters?: number;
  calories?: number;
  avgTemperatureCelsius?: number;
  maxTemperatureCelsius?: number;
  avgPowerWatts?: number;
  maxPowerWatts?: number;
  normalizedPowerWatts?: number;
  totalWorkKj?: number;
  ftpWatts?: number;
  ftpUsed?: number;
  intensityFactor?: number;
  tss?: number;
  aerobicDecoupling?: number;
  maxPowers?: Record<string, number>;
  avgHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  avgCadenceRpm?: number;
  maxCadenceRpm?: number;
  totalPedalRevolutions?: number;
  avgSpeedMps?: number;
  maxSpeedMps?: number;
  aerobicTrainingEffect?: number;
  anaerobicTrainingEffect?: number;
  dataSource?: string;
  sourceActivityId?: string;
  fileFormat?: string;
  driveFileId?: string;
  driveWebViewLink?: string;
  title?: string;
  description?: string;
  comment?: string;
  tags?: string[];
  // Planning-specific
  segments?: unknown[];
  targetSpeed?: number;
  targetPowerMin?: number;
  targetPowerMax?: number;
  targetHrMin?: number;
  targetHrMax?: number;
  targetCadenceMin?: number;
  targetCadenceMax?: number;
  referenceMetric?: { type: string; value: number };
  equipment?: unknown;
  eventId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Stored metric document shape in the time-series collection */
export interface MetricDocument {
  timestamp: Date;
  meta: {
    workoutId: string;
    activityType: string;
    dataSource: string;
  };
  heartRateBpm?: number;
  powerWatts?: number;
  cadenceRpm?: number;
  speedMps?: number;
  distanceMeters?: number;
  elevationMeters?: number;
  latitude?: number;
  longitude?: number;
  temperature?: number;
}

/** Workout repository interface for database access abstraction */
export interface IWorkoutRepository {
  create(workout: WorkoutRecord): Promise<WorkoutRecord>;
  findById(id: string): Promise<WorkoutRecord | null>;
  findMany(query: WorkoutQuery): Promise<PaginatedResult<WorkoutRecord>>;
  findByDateRange(userId: string, dateFrom: string, dateTo: string, status?: string[]): Promise<WorkoutRecord[]>;
  findPlannedCandidates(userId: string, date: string, activityType?: string): Promise<WorkoutRecord[]>;
  evaluateSkippedActivities(userId: string, userToday: string): Promise<number>;
  createTemplate(template: Record<string, unknown>): Promise<WorkoutRecord>;
  update(id: string, updates: Partial<WorkoutMetadata> | ActivityUpdateFields): Promise<WorkoutRecord>;
  updateStatus(id: string, status: string): Promise<WorkoutRecord>;
  updateDateAndStatus(id: string, date: string, status?: string): Promise<WorkoutRecord>;
  updatePowerMetrics(
    id: string,
    metrics: { tss?: number; intensityFactor?: number; ftpUsed?: number },
  ): Promise<WorkoutRecord>;
  updateAvgSpeed(id: string, avgSpeedMps: number): Promise<WorkoutRecord>;
  updateMaxPowers(id: string, maxPowers: Record<string, number>): Promise<WorkoutRecord>;
  delete(id: string): Promise<void>;
  findDuplicate(userId: string, startTime: Date, durationSeconds: number): Promise<WorkoutRecord | null>;
  findBySourceActivityId(userId: string, sourceActivityId: string): Promise<WorkoutRecord | null>;
  insertMetrics(workoutId: string, metrics: MetricDataPoint[]): Promise<void>;
  deleteMetrics(workoutId: string): Promise<void>;
  materializeUpdate(id: string, fields: Record<string, unknown>): Promise<void>;
  clearMaterialization(id: string, fields: Record<string, unknown>): Promise<void>;
  queryMetrics(query: MetricQuery): Promise<MetricDataPoint[]>;
}

/** MongoDB implementation of the workout repository */
export class MongoWorkoutRepository implements IWorkoutRepository {
  private workouts: Collection<Omit<WorkoutDocument, '_id'>>;
  private metrics: Collection<MetricDocument>;

  constructor(db: Db) {
    this.workouts = db.collection('workouts');
    this.metrics = db.collection('metrics');
  }

  /** Ensure required indexes exist on the workouts collection */
  async createIndexes(): Promise<void> {
    await this.workouts.createIndex({ userId: 1, startTime: -1 });
    await this.workouts.createIndex(
      { userId: 1, sourceActivityId: 1 },
      {
        unique: true,
        partialFilterExpression: { sourceActivityId: { $exists: true } },
      },
    );
    // PLAN-004: Calendar queries (filter by user, date range, status)
    await this.workouts.createIndex({ userId: 1, date: 1, status: 1 });
    // PLAN-004: Template library queries (filter by user, template flag)
    await this.workouts.createIndex({ userId: 1, template: 1 });
  }

  async create(workout: WorkoutRecord): Promise<WorkoutRecord> {
    const now = new Date();
    const doc: Record<string, unknown> = {
      userId: workout.userId,
      activityType: workout.activityType,
      status: workout.status,
      template: workout.template,
      date: workout.date,
      createdAt: now,
      updatedAt: now,
    };

    // Include fields only when defined (avoids storing null/undefined)
    if (workout.plannedDurationSeconds !== undefined) doc.plannedDurationSeconds = workout.plannedDurationSeconds;
    if (workout.plannedDistanceMeters !== undefined) doc.plannedDistanceMeters = workout.plannedDistanceMeters;
    if (workout.startTime !== undefined) doc.startTime = workout.startTime;
    if (workout.endTime !== undefined) doc.endTime = workout.endTime;
    if (workout.durationSeconds !== undefined) doc.durationSeconds = workout.durationSeconds;
    if (workout.distanceMeters !== undefined) doc.distanceMeters = workout.distanceMeters;
    if (workout.elevationGainMeters !== undefined) doc.elevationGainMeters = workout.elevationGainMeters;
    if (workout.dataSource !== undefined) doc.dataSource = workout.dataSource;
    if (workout.fileFormat !== undefined) doc.fileFormat = workout.fileFormat;
    if (workout.driveFileId !== undefined) doc.driveFileId = workout.driveFileId;

    // Only include optional fields when defined to avoid storing null
    // (important for sparse unique index on sourceActivityId)
    if (workout.avgPowerWatts !== undefined) doc.avgPowerWatts = workout.avgPowerWatts;
    if (workout.maxPowerWatts !== undefined) doc.maxPowerWatts = workout.maxPowerWatts;
    if (workout.normalizedPowerWatts !== undefined) doc.normalizedPowerWatts = workout.normalizedPowerWatts;
    if (workout.totalWorkKj !== undefined) doc.totalWorkKj = workout.totalWorkKj;
    if (workout.ftpWatts !== undefined) doc.ftpWatts = workout.ftpWatts;
    if (workout.ftpUsed !== undefined) doc.ftpUsed = workout.ftpUsed;
    if (workout.intensityFactor !== undefined) doc.intensityFactor = workout.intensityFactor;
    if (workout.tss !== undefined) doc.tss = workout.tss;
    if (workout.aerobicDecoupling !== undefined) doc.aerobicDecoupling = workout.aerobicDecoupling;
    if (workout.maxPowers !== undefined) doc.maxPowers = workout.maxPowers;
    if (workout.avgHeartRateBpm !== undefined) doc.avgHeartRateBpm = workout.avgHeartRateBpm;
    if (workout.maxHeartRateBpm !== undefined) doc.maxHeartRateBpm = workout.maxHeartRateBpm;
    if (workout.avgCadenceRpm !== undefined) doc.avgCadenceRpm = workout.avgCadenceRpm;
    if (workout.maxCadenceRpm !== undefined) doc.maxCadenceRpm = workout.maxCadenceRpm;
    if (workout.totalPedalRevolutions !== undefined) doc.totalPedalRevolutions = workout.totalPedalRevolutions;
    if (workout.avgSpeedMps !== undefined) doc.avgSpeedMps = workout.avgSpeedMps;
    if (workout.maxSpeedMps !== undefined) doc.maxSpeedMps = workout.maxSpeedMps;
    if (workout.aerobicTrainingEffect !== undefined) doc.aerobicTrainingEffect = workout.aerobicTrainingEffect;
    if (workout.anaerobicTrainingEffect !== undefined) doc.anaerobicTrainingEffect = workout.anaerobicTrainingEffect;
    if (workout.subActivityType !== undefined) doc.subActivityType = workout.subActivityType;
    if (workout.movingTimeSeconds !== undefined) doc.movingTimeSeconds = workout.movingTimeSeconds;
    if (workout.elevationLossMeters !== undefined) doc.elevationLossMeters = workout.elevationLossMeters;
    if (workout.calories !== undefined) doc.calories = workout.calories;
    if (workout.avgTemperatureCelsius !== undefined) doc.avgTemperatureCelsius = workout.avgTemperatureCelsius;
    if (workout.maxTemperatureCelsius !== undefined) doc.maxTemperatureCelsius = workout.maxTemperatureCelsius;
    if (workout.sourceActivityId !== undefined) doc.sourceActivityId = workout.sourceActivityId;
    if (workout.driveWebViewLink !== undefined) doc.driveWebViewLink = workout.driveWebViewLink;
    if (workout.title !== undefined) doc.title = workout.title;
    if (workout.description !== undefined) doc.description = workout.description;
    if (workout.comment !== undefined) doc.comment = workout.comment;
    if (workout.tags !== undefined) doc.tags = workout.tags;

    // Planning-specific fields
    if ((workout as any).segments !== undefined) doc.segments = (workout as any).segments;
    if ((workout as any).targetSpeed !== undefined) doc.targetSpeed = (workout as any).targetSpeed;
    if ((workout as any).targetPowerMin !== undefined) doc.targetPowerMin = (workout as any).targetPowerMin;
    if ((workout as any).targetPowerMax !== undefined) doc.targetPowerMax = (workout as any).targetPowerMax;
    if ((workout as any).targetHrMin !== undefined) doc.targetHrMin = (workout as any).targetHrMin;
    if ((workout as any).targetHrMax !== undefined) doc.targetHrMax = (workout as any).targetHrMax;
    if ((workout as any).targetCadenceMin !== undefined) doc.targetCadenceMin = (workout as any).targetCadenceMin;
    if ((workout as any).targetCadenceMax !== undefined) doc.targetCadenceMax = (workout as any).targetCadenceMax;
    if ((workout as any).referenceMetric !== undefined) doc.referenceMetric = (workout as any).referenceMetric;
    if ((workout as any).equipment !== undefined) doc.equipment = (workout as any).equipment;
    if ((workout as any).eventId !== undefined) doc.eventId = (workout as any).eventId;
    if ((workout as any).plannedTss !== undefined) doc.plannedTss = (workout as any).plannedTss;
    if ((workout as any).plannedIf !== undefined) doc.plannedIf = (workout as any).plannedIf;
    if ((workout as any).plannedTssOverride !== undefined) doc.plannedTssOverride = (workout as any).plannedTssOverride;
    if ((workout as any).plannedIfOverride !== undefined) doc.plannedIfOverride = (workout as any).plannedIfOverride;

    const result = await this.workouts.insertOne(doc as Omit<WorkoutDocument, '_id'>);

    return {
      ...workout,
      id: result.insertedId.toHexString(),
      createdAt: now,
      updatedAt: now,
    };
  }

  async findById(id: string): Promise<WorkoutRecord | null> {
    if (!ObjectId.isValid(id)) return null;

    const doc = await this.workouts.findOne({ _id: new ObjectId(id) });
    if (!doc) return null;

    return this.toWorkoutRecord(doc as unknown as WorkoutDocument);
  }

  async findMany(query: WorkoutQuery): Promise<PaginatedResult<WorkoutRecord>> {
    const filter: Filter<Omit<WorkoutDocument, '_id'>> = { userId: query.userId };

    // Template filter (default: exclude templates)
    if (query.template !== undefined) {
      filter.template = query.template;
    } else {
      // Default: exclude templates. Match documents where template is false OR absent (legacy)
      filter.$or = [{ template: false }, { template: { $exists: false } }];
    }

    // Status filter
    if (query.status && query.status.length > 0) {
      if (query.status.length === 1) {
        filter.status = query.status[0];
      } else {
        filter.status = { $in: query.status } as unknown as string;
      }
    }

    if (query.dateFrom || query.dateTo) {
      filter.startTime = {};
      if (query.dateFrom) {
        (filter.startTime as Record<string, Date>).$gte = query.dateFrom;
      }
      if (query.dateTo) {
        (filter.startTime as Record<string, Date>).$lte = query.dateTo;
      }
    }

    if (query.activityType) {
      filter.activityType = query.activityType;
    }

    if (query.search) {
      filter.title = { $regex: query.search, $options: 'i' } as unknown as string;
    }

    if (query.dataSource) {
      filter.dataSource = query.dataSource;
    }

    const sort = this.buildSort(query.sortBy, query.sortOrder);
    const skip = (query.page - 1) * query.pageSize;

    const [docs, totalItems] = await Promise.all([
      this.workouts.find(filter).sort(sort).skip(skip).limit(query.pageSize).toArray(),
      this.workouts.countDocuments(filter),
    ]);

    const items = docs.map((doc) => this.toWorkoutRecord(doc as unknown as WorkoutDocument));
    const totalPages = Math.ceil(totalItems / query.pageSize);

    return {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages,
      },
    };
  }

  async findByDateRange(userId: string, dateFrom: string, dateTo: string, status?: string[]): Promise<WorkoutRecord[]> {
    // Match activities by their calendar date field.
    // Also include completed activities that have startTime but no date field
    // (pre-migration documents that haven't been backfilled yet).
    const dateFromObj = new Date(dateFrom + 'T00:00:00');
    const dateToObj = new Date(dateTo + 'T23:59:59.999');

    const filter: Filter<Omit<WorkoutDocument, '_id'>> = {
      userId,
      $or: [
        // Primary: match on the date field (YYYY-MM-DD string comparison)
        { date: { $gte: dateFrom, $lte: dateTo } as unknown as string },
        // Fallback: match on startTime for documents missing the date field
        { date: { $in: [null, ''] } as unknown as string, startTime: { $gte: dateFromObj, $lte: dateToObj } },
        { date: { $exists: false }, startTime: { $gte: dateFromObj, $lte: dateToObj } },
      ],
      // Exclude templates (including legacy docs without the field)
      $and: [{ $or: [{ template: false }, { template: { $exists: false } }] }],
    };

    if (status && status.length > 0) {
      if (status.length === 1) {
        (filter as Record<string, unknown>).status = status[0];
      } else {
        (filter as Record<string, unknown>).status = { $in: status };
      }
    }

    const docs = await this.workouts.find(filter).sort({ date: 1 }).toArray();
    return docs.map((doc) => this.toWorkoutRecord(doc as unknown as WorkoutDocument));
  }

  async findPlannedCandidates(userId: string, date: string, activityType?: string): Promise<WorkoutRecord[]> {
    const filter: Record<string, unknown> = {
      userId,
      status: { $in: ['planned', 'skipped'] },
      template: false,
      date,
    };
    if (activityType) {
      filter.activityType = activityType;
    }
    const docs = await this.workouts.find(filter).sort({ createdAt: 1 }).toArray();
    return docs.map((doc) => this.toWorkoutRecord(doc as unknown as WorkoutDocument));
  }

  async evaluateSkippedActivities(userId: string, userToday: string): Promise<number> {
    const result = await this.workouts.updateMany(
      {
        userId,
        status: 'planned',
        template: false,
        date: { $lt: userToday } as unknown as string,
      },
      {
        $set: { status: 'skipped', updatedAt: new Date() },
      },
    );
    return result.modifiedCount;
  }

  async createTemplate(template: Record<string, unknown>): Promise<WorkoutRecord> {
    const now = new Date();
    const doc = {
      ...template,
      createdAt: now,
      updatedAt: now,
    };

    const result = await this.workouts.insertOne(doc as any);
    const created = await this.findById(result.insertedId.toHexString());
    return created!;
  }

  async update(id: string, updates: Partial<WorkoutMetadata> | ActivityUpdateFields): Promise<WorkoutRecord> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    const $set: Record<string, unknown> = { updatedAt: new Date() };
    const u = updates as Record<string, unknown>;

    // Common fields
    if (u.title !== undefined) $set.title = u.title;
    if (u.description !== undefined) $set.description = u.description;
    if (u.comment !== undefined) $set.comment = u.comment;
    if (u.tags !== undefined) $set.tags = u.tags;
    if (u.activityType !== undefined) $set.activityType = u.activityType;
    // Planning fields
    if (u.date !== undefined) $set.date = u.date;
    if (u.plannedDurationSeconds !== undefined) $set.plannedDurationSeconds = u.plannedDurationSeconds;
    if (u.plannedDistanceMeters !== undefined) $set.plannedDistanceMeters = u.plannedDistanceMeters;
    if (u.segments !== undefined) $set.segments = u.segments;
    if (u.targetPowerMin !== undefined) $set.targetPowerMin = u.targetPowerMin;
    if (u.targetPowerMax !== undefined) $set.targetPowerMax = u.targetPowerMax;
    if (u.targetHrMin !== undefined) $set.targetHrMin = u.targetHrMin;
    if (u.targetHrMax !== undefined) $set.targetHrMax = u.targetHrMax;
    if (u.targetCadenceMin !== undefined) $set.targetCadenceMin = u.targetCadenceMin;
    if (u.targetCadenceMax !== undefined) $set.targetCadenceMax = u.targetCadenceMax;
    if (u.targetSpeed !== undefined) $set.targetSpeed = u.targetSpeed;
    if (u.plannedTss !== undefined) $set.plannedTss = u.plannedTss;
    if (u.plannedIf !== undefined) $set.plannedIf = u.plannedIf;
    if (u.plannedTssOverride !== undefined) $set.plannedTssOverride = u.plannedTssOverride;
    if (u.plannedIfOverride !== undefined) $set.plannedIfOverride = u.plannedIfOverride;
    if (u.referenceMetric !== undefined) $set.referenceMetric = u.referenceMetric;
    if (u.equipment !== undefined) $set.equipment = u.equipment;
    if (u.eventId !== undefined) $set.eventId = u.eventId;
    // Completed-editable fields
    if (u.rpe !== undefined) $set.rpe = u.rpe;
    if (u.movingTimeSeconds !== undefined) $set.movingTimeSeconds = u.movingTimeSeconds;

    const result = await this.workouts.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' },
    );

    if (!result) {
      throw new Error(`Workout not found: ${id}`);
    }

    return this.toWorkoutRecord(result as unknown as WorkoutDocument);
  }

  async updateStatus(id: string, status: string): Promise<WorkoutRecord> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    const result = await this.workouts.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    if (!result) {
      throw new Error(`Workout not found: ${id}`);
    }

    return this.toWorkoutRecord(result as unknown as WorkoutDocument);
  }

  async updateDateAndStatus(id: string, date: string, status?: string): Promise<WorkoutRecord> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    const $set: Record<string, unknown> = { date, updatedAt: new Date() };
    if (status !== undefined) {
      $set.status = status;
    }

    const result = await this.workouts.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' },
    );

    if (!result) {
      throw new Error(`Workout not found: ${id}`);
    }

    return this.toWorkoutRecord(result as unknown as WorkoutDocument);
  }

  async updatePowerMetrics(
    id: string,
    metrics: { tss?: number; intensityFactor?: number; ftpUsed?: number },
  ): Promise<WorkoutRecord> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    const $set: Record<string, unknown> = { updatedAt: new Date() };

    if (metrics.tss !== undefined) $set.tss = metrics.tss;
    if (metrics.intensityFactor !== undefined) $set.intensityFactor = metrics.intensityFactor;
    if (metrics.ftpUsed !== undefined) $set.ftpUsed = metrics.ftpUsed;

    const result = await this.workouts.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set },
      { returnDocument: 'after' },
    );

    if (!result) {
      throw new Error(`Workout not found: ${id}`);
    }

    return this.toWorkoutRecord(result as unknown as WorkoutDocument);
  }

  async updateAvgSpeed(id: string, avgSpeedMps: number): Promise<WorkoutRecord> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    const result = await this.workouts.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { avgSpeedMps, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    if (!result) {
      throw new Error(`Workout not found: ${id}`);
    }

    return this.toWorkoutRecord(result as unknown as WorkoutDocument);
  }

  async updateMaxPowers(id: string, maxPowers: Record<string, number>): Promise<WorkoutRecord> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    const result = await this.workouts.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { maxPowers, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    if (!result) {
      throw new Error(`Workout not found: ${id}`);
    }

    return this.toWorkoutRecord(result as unknown as WorkoutDocument);
  }

  async delete(id: string): Promise<void> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    const result = await this.workouts.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      throw new Error(`Workout not found: ${id}`);
    }

    // Also delete associated metrics
    await this.metrics.deleteMany({ 'meta.workoutId': id });
  }

  async findDuplicate(
    userId: string,
    startTime: Date,
    durationSeconds: number,
  ): Promise<WorkoutRecord | null> {
    const doc = await this.workouts.findOne({
      userId,
      startTime,
      durationSeconds,
    });

    if (!doc) return null;
    return this.toWorkoutRecord(doc as unknown as WorkoutDocument);
  }

  async findBySourceActivityId(
    userId: string,
    sourceActivityId: string,
  ): Promise<WorkoutRecord | null> {
    const doc = await this.workouts.findOne({
      userId,
      sourceActivityId,
    });

    if (!doc) return null;
    return this.toWorkoutRecord(doc as unknown as WorkoutDocument);
  }

  async insertMetrics(workoutId: string, metrics: MetricDataPoint[]): Promise<void> {
    if (metrics.length === 0) return;

    const docs: MetricDocument[] = metrics.map((m) => ({
      timestamp: m.timestamp,
      meta: {
        workoutId,
        activityType: m.activityType,
        dataSource: m.dataSource,
      },
      heartRateBpm: m.heartRateBpm,
      powerWatts: m.powerWatts,
      cadenceRpm: m.cadenceRpm,
      speedMps: m.speedMps,
      distanceMeters: m.distanceMeters,
      elevationMeters: m.elevationMeters,
      latitude: m.latitude,
      longitude: m.longitude,
      temperature: m.temperature,
    }));

    await this.metrics.insertMany(docs);
  }

  async deleteMetrics(workoutId: string): Promise<void> {
    await this.metrics.deleteMany({ 'meta.workoutId': workoutId });
  }

  async materializeUpdate(id: string, fields: Record<string, unknown>): Promise<void> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    const result = await this.workouts.updateOne(
      { _id: new ObjectId(id) },
      { $set: fields },
    );

    if (result.matchedCount === 0) {
      throw new Error(`Workout not found: ${id}`);
    }
  }

  async clearMaterialization(id: string, fields: Record<string, unknown>): Promise<void> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    // Separate null fields (to $unset) from valued fields (to $set)
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(fields)) {
      if (value === null) {
        $unset[key] = '';
      } else {
        $set[key] = value;
      }
    }

    const update: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) update.$set = $set;
    if (Object.keys($unset).length > 0) update.$unset = $unset;

    if (Object.keys(update).length === 0) return;

    const result = await this.workouts.updateOne(
      { _id: new ObjectId(id) },
      update,
    );

    if (result.matchedCount === 0) {
      throw new Error(`Workout not found: ${id}`);
    }
  }

  async queryMetrics(query: MetricQuery): Promise<MetricDataPoint[]> {
    const filter: Filter<MetricDocument> = {
      timestamp: {
        $gte: query.timeFrom,
        $lte: query.timeTo,
      },
    };

    if (query.workoutId) {
      filter['meta.workoutId'] = query.workoutId;
    }

    let cursor = this.metrics.find(filter);

    // Apply projection only when specific metric types are requested
    if (query.metricTypes && query.metricTypes.length > 0) {
      const projection = this.buildMetricProjection(query.metricTypes);
      cursor = cursor.project(projection) as typeof cursor;
    }

    const docs = await cursor.sort({ timestamp: 1 }).toArray();

    return docs.map((doc) => this.toMetricDataPoint(doc as unknown as MetricDocument));
  }

  /** Convert a MongoDB document to a WorkoutRecord */
  private toWorkoutRecord(doc: WorkoutDocument): WorkoutRecord {
    return {
      id: doc._id.toHexString(),
      userId: doc.userId,
      // Lifecycle: templates have no status/date; legacy non-template docs default to 'completed'
      status: doc.template === true
        ? (doc.status as WorkoutRecord['status'] ?? null)
        : ((doc.status as WorkoutRecord['status']) ?? 'completed'),
      template: doc.template ?? false,
      date: doc.date ?? null,
      // Planned values
      plannedDurationSeconds: doc.plannedDurationSeconds,
      plannedDistanceMeters: doc.plannedDistanceMeters,
      plannedTss: doc.plannedTss,
      plannedIf: doc.plannedIf,
      // Summary
      activityType: doc.activityType,
      subActivityType: doc.subActivityType,
      startTime: doc.startTime,
      endTime: doc.endTime,
      durationSeconds: doc.durationSeconds,
      movingTimeSeconds: doc.movingTimeSeconds,
      distanceMeters: doc.distanceMeters,
      elevationGainMeters: doc.elevationGainMeters,
      elevationLossMeters: doc.elevationLossMeters,
      calories: doc.calories,
      avgTemperatureCelsius: doc.avgTemperatureCelsius,
      maxTemperatureCelsius: doc.maxTemperatureCelsius,
      avgPowerWatts: doc.avgPowerWatts,
      maxPowerWatts: doc.maxPowerWatts,
      normalizedPowerWatts: doc.normalizedPowerWatts,
      totalWorkKj: doc.totalWorkKj,
      ftpWatts: doc.ftpWatts,
      ftpUsed: doc.ftpUsed,
      intensityFactor: doc.intensityFactor,
      tss: doc.tss,
      aerobicDecoupling: doc.aerobicDecoupling,
      maxPowers: doc.maxPowers,
      avgHeartRateBpm: doc.avgHeartRateBpm,
      maxHeartRateBpm: doc.maxHeartRateBpm,
      avgCadenceRpm: doc.avgCadenceRpm,
      maxCadenceRpm: doc.maxCadenceRpm,
      totalPedalRevolutions: doc.totalPedalRevolutions,
      avgSpeedMps: doc.avgSpeedMps,
      maxSpeedMps: doc.maxSpeedMps,
      aerobicTrainingEffect: doc.aerobicTrainingEffect,
      anaerobicTrainingEffect: doc.anaerobicTrainingEffect,
      dataSource: doc.dataSource as WorkoutRecord['dataSource'],
      sourceActivityId: doc.sourceActivityId,
      fileFormat: doc.fileFormat as WorkoutRecord['fileFormat'],
      driveFileId: doc.driveFileId,
      driveWebViewLink: doc.driveWebViewLink,
      title: doc.title,
      description: doc.description,
      comment: doc.comment,
      tags: doc.tags,
      // Planning-specific fields
      segments: (doc as any).segments,
      targetSpeed: (doc as any).targetSpeed,
      targetPowerMin: (doc as any).targetPowerMin,
      targetPowerMax: (doc as any).targetPowerMax,
      targetHrMin: (doc as any).targetHrMin,
      targetHrMax: (doc as any).targetHrMax,
      targetCadenceMin: (doc as any).targetCadenceMin,
      targetCadenceMax: (doc as any).targetCadenceMax,
      referenceMetric: (doc as any).referenceMetric,
      equipment: (doc as any).equipment,
      eventId: (doc as any).eventId,
      plannedTssOverride: (doc as any).plannedTssOverride,
      plannedIfOverride: (doc as any).plannedIfOverride,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  /** Convert a metric document to a MetricDataPoint */
  private toMetricDataPoint(doc: MetricDocument): MetricDataPoint {
    return {
      timestamp: doc.timestamp,
      workoutId: doc.meta.workoutId,
      activityType: doc.meta.activityType,
      dataSource: doc.meta.dataSource as MetricDataPoint['dataSource'],
      heartRateBpm: doc.heartRateBpm,
      powerWatts: doc.powerWatts,
      cadenceRpm: doc.cadenceRpm,
      speedMps: doc.speedMps,
      distanceMeters: doc.distanceMeters,
      elevationMeters: doc.elevationMeters,
      latitude: doc.latitude,
      longitude: doc.longitude,
      temperature: doc.temperature,
    };
  }

  /** Build MongoDB sort object from query parameters */
  private buildSort(sortBy?: string, sortOrder?: string): Sort {
    const direction = sortOrder === 'asc' ? 1 : -1;

    switch (sortBy) {
      case 'duration':
        return { durationSeconds: direction };
      case 'distance':
        return { distanceMeters: direction };
      case 'date':
      default:
        return { startTime: direction };
    }
  }

  /** Build projection for metric queries to only include requested types */
  private buildMetricProjection(metricTypes?: MetricType[]): Record<string, number> {
    // Always include base fields
    const projection: Record<string, number> = {
      timestamp: 1,
      meta: 1,
    };

    if (!metricTypes || metricTypes.length === 0) {
      // Include all metric fields
      return projection;
    }

    // Map metric types to document fields
    const typeToField: Record<MetricType, string> = {
      heartRate: 'heartRateBpm',
      power: 'powerWatts',
      cadence: 'cadenceRpm',
      speed: 'speedMps',
      distance: 'distanceMeters',
      elevation: 'elevationMeters',
      gps: 'latitude', // GPS includes both lat/lng
      temperature: 'temperature',
    };

    for (const type of metricTypes) {
      const field = typeToField[type];
      if (field) {
        projection[field] = 1;
      }
      // GPS needs both latitude and longitude
      if (type === 'gps') {
        projection['longitude'] = 1;
      }
    }

    return projection;
  }
}
