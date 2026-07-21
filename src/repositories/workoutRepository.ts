import { Collection, Db, ObjectId, Filter, Sort } from 'mongodb';
import { WorkoutRecord, WorkoutMetadata, MetricDataPoint, MetricType } from '../models/workout';
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
  activityType: string;
  subActivityType?: string;
  startTime: Date;
  endTime: Date;
  durationSeconds: number;
  movingTimeSeconds?: number;
  distanceMeters: number;
  elevationGainMeters: number;
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
  dataSource: string;
  sourceActivityId?: string;
  fileFormat: string;
  driveFileId: string;
  driveWebViewLink?: string;
  title?: string;
  description?: string;
  comment?: string;
  tags?: string[];
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
  update(id: string, updates: Partial<WorkoutMetadata>): Promise<WorkoutRecord>;
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
  }

  async create(workout: WorkoutRecord): Promise<WorkoutRecord> {
    const now = new Date();
    const doc: Record<string, unknown> = {
      userId: workout.userId,
      activityType: workout.activityType,
      startTime: workout.startTime,
      endTime: workout.endTime,
      durationSeconds: workout.durationSeconds,
      distanceMeters: workout.distanceMeters,
      elevationGainMeters: workout.elevationGainMeters,
      dataSource: workout.dataSource,
      fileFormat: workout.fileFormat,
      driveFileId: workout.driveFileId,
      createdAt: now,
      updatedAt: now,
    };

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

  async update(id: string, updates: Partial<WorkoutMetadata>): Promise<WorkoutRecord> {
    if (!ObjectId.isValid(id)) {
      throw new Error(`Workout not found: ${id}`);
    }

    const $set: Record<string, unknown> = { updatedAt: new Date() };

    if (updates.title !== undefined) $set.title = updates.title;
    if (updates.description !== undefined) $set.description = updates.description;
    if (updates.comment !== undefined) $set.comment = updates.comment;
    if (updates.tags !== undefined) $set.tags = updates.tags;
    if (updates.activityType !== undefined) $set.activityType = updates.activityType;

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
