/**
 * PLAN-024 Service-Level Tests: materializeActivity() and clearActivityMaterialization()
 * Uses real MongoDB + mocked parser to verify actual materialization behavior.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { UploadService } from './uploadService';
import { MongoWorkoutRepository } from '../repositories/workoutRepository';
import { MongoSourceArtifactRepository } from '../repositories/sourceArtifactRepository';
import { MongoSettingsRepository } from '../repositories/settingsRepository';
import { SettingsService } from './settingsService';
import { DefaultParserFactory } from '../parsers/parserFactory';
import { ParsedWorkout, MetricDataPoint } from '../models/workout';
import { FileStorageAdapter } from '../storage/googleDriveAdapter';

// Build a realistic ParsedWorkout that the mock parser will return
const MOCK_START_TIME = new Date('2027-06-15T14:00:00Z');
const mockDataPoints: MetricDataPoint[] = Array.from({ length: 60 }, (_, i) => ({
  timestamp: new Date(MOCK_START_TIME.getTime() + i * 60000),
  workoutId: '',
  activityType: 'ride',
  dataSource: 'manual' as const,
  powerWatts: 200 + Math.round(Math.sin(i / 5) * 50),
  heartRateBpm: 140 + Math.round(Math.sin(i / 8) * 15),
  cadenceRpm: 85 + Math.round(Math.sin(i / 3) * 10),
  speedMps: 8.0 + Math.sin(i / 6),
}));

const mockParsedWorkout: ParsedWorkout = {
  summary: {
    activityType: 'ride',
    startTime: MOCK_START_TIME,
    endTime: new Date(MOCK_START_TIME.getTime() + 3600000),
    durationSeconds: 3600,
    movingTimeSeconds: 3500,
    distanceMeters: 30000,
    elevationGainMeters: 450,
  },
  dataPoints: mockDataPoints,
  sourceFormat: 'fit',
};

const mockParser = {
  parse: jest.fn().mockResolvedValue(mockParsedWorkout),
  parseLightMetadata: jest.fn().mockResolvedValue({
    startTime: MOCK_START_TIME,
    durationSeconds: 3600,
    activityType: 'ride',
  }),
  supports: jest.fn().mockReturnValue(true),
};

const mockParserFactory = new DefaultParserFactory();
// Override getParser to return our mock
(mockParserFactory as any).parsers = new Map([['fit', mockParser]]);

const mockDriveAdapter: FileStorageAdapter = {
  store: jest.fn().mockResolvedValue({ fileId: 'drive-test', webViewLink: undefined }),
  retrieve: jest.fn().mockResolvedValue(Buffer.from('fake-fit-data')),
  delete: jest.fn(),
  listFiles: jest.fn().mockResolvedValue([]),
  removeFromFolder: jest.fn(),
};

describe('PLAN-024 Service-Level: materializeActivity & clearActivityMaterialization', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let workoutRepo: MongoWorkoutRepository;
  let artifactRepo: MongoSourceArtifactRepository;
  let settingsRepo: MongoSettingsRepository;
  let uploadService: UploadService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();
    workoutRepo = new MongoWorkoutRepository(db);
    await workoutRepo.createIndexes();
    artifactRepo = new MongoSourceArtifactRepository(db);
    await artifactRepo.createIndexes();
    settingsRepo = new MongoSettingsRepository(db);
    const settingsService = new SettingsService(settingsRepo);

    // Create user settings
    await settingsRepo.upsert('user-1', { timezone: 'America/Chicago' });

    uploadService = new UploadService(
      mockParserFactory,
      workoutRepo,
      mockDriveAdapter,
      settingsService,
      undefined,
      artifactRepo,
    );
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });
  beforeEach(async () => {
    await db.collection('workouts').deleteMany({});
    await db.collection('sourceArtifacts').deleteMany({});
    await db.collection('metrics').deleteMany({});
    jest.clearAllMocks();
    mockParser.parse.mockResolvedValue(mockParsedWorkout);
  });

  /**
   * Helper: Create a planned Activity with planned values
   */
  async function createPlannedActivity(): Promise<string> {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1',
      activityType: 'cycling',
      status: 'planned',
      template: false,
      date: '2027-06-15',
      title: 'Morning Tempo',
      plannedDurationSeconds: 3600,
      plannedDistanceMeters: 30000,
      plannedTss: 85,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return result.insertedId.toHexString();
  }

  /**
   * Helper: Create a SourceArtifact associated with an Activity
   */
  async function createArtifact(activityId: string | null): Promise<string> {
    const artifact = await artifactRepo.create({
      userId: 'user-1',
      source: 'manual',
      format: 'fit',
      originalFileName: 'ride.fit',
      importedAt: new Date(),
      driveFileId: 'drive-test-file',
      activityId,
      role: 'primary',
      materialized: false,
      startTime: MOCK_START_TIME,
      durationSeconds: 3600,
      activityType: 'ride',
    });
    return artifact.id;
  }

  describe('materializeActivity()', () => {
    it('should parse the file and update Activity with actual values', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      // Verify real parser was called
      expect(mockParser.parse).toHaveBeenCalledWith(Buffer.from('data'));

      // Verify Activity was updated with actual values
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      expect(doc!.status).toBe('completed');
      expect(doc!.durationSeconds).toBe(3600);
      expect(doc!.distanceMeters).toBe(30000);
      expect(doc!.elevationGainMeters).toBe(450);
      expect(doc!.startTime).toEqual(MOCK_START_TIME);
      expect(doc!.avgPowerWatts).toBeDefined();
      expect(typeof doc!.avgPowerWatts).toBe('number');
    });

    it('should preserve planned values after materialization', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      // Planned values MUST remain
      expect(doc!.plannedDurationSeconds).toBe(3600);
      expect(doc!.plannedDistanceMeters).toBe(30000);
      expect(doc!.plannedTss).toBe(85);
      // Actual values coexist
      expect(doc!.durationSeconds).toBe(3600);
      expect(doc!.distanceMeters).toBe(30000);
      // TSS is computed (actual) — differs from planned
      expect(doc!.tss).toBeDefined();
      // Both planned and actual coexist
      expect(doc!.plannedTss).toBe(85); // unchanged
    });

    it('should insert metric observations', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      const metrics = await db.collection('metrics').find({ 'meta.workoutId': activityId }).toArray();
      expect(metrics.length).toBe(60); // 60 data points
      expect(metrics[0].powerWatts).toBeDefined();
      expect(metrics[0].heartRateBpm).toBeDefined();
    });

    it('should replace existing metric observations on re-materialization', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      // First materialization
      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );
      const metricsAfterFirst = await db.collection('metrics').countDocuments({ 'meta.workoutId': activityId });
      expect(metricsAfterFirst).toBe(60);

      // Second materialization (re-materialization)
      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );
      const metricsAfterSecond = await db.collection('metrics').countDocuments({ 'meta.workoutId': activityId });
      // Should still be 60, not 120 — old ones were deleted
      expect(metricsAfterSecond).toBe(60);
    });

    it('should derive Activity.date from startTime in user timezone', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      // 2027-06-15T14:00:00Z in America/Chicago (CDT = UTC-5) = 2027-06-15 09:00 local → date remains '2027-06-15'
      expect(doc!.date).toBe('2027-06-15');
    });

    it('should mark SourceArtifact as materialized=true', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      const artifact = await artifactRepo.findById(artifactId);
      expect(artifact!.materialized).toBe(true);
    });

    it('should preserve title from the Activity', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      expect(doc!.title).toBe('Morning Tempo');
    });
  });

  describe('clearActivityMaterialization()', () => {
    it('should remove actual fields from Activity', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      // First materialize
      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      // Verify actual fields exist
      let doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      expect(doc!.durationSeconds).toBe(3600);
      expect(doc!.avgPowerWatts).toBeDefined();

      // Clear
      await uploadService.clearActivityMaterialization(activityId, 'user-1');

      // Verify actual fields gone
      doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      expect(doc!.durationSeconds).toBeUndefined();
      expect(doc!.avgPowerWatts).toBeUndefined();
      expect(doc!.startTime).toBeUndefined();
      expect(doc!.tss).toBeUndefined();
      expect(doc!.normalizedPowerWatts).toBeUndefined();
    });

    it('should preserve planned values after clearing', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );
      await uploadService.clearActivityMaterialization(activityId, 'user-1');

      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      expect(doc!.plannedDurationSeconds).toBe(3600);
      expect(doc!.plannedDistanceMeters).toBe(30000);
      expect(doc!.plannedTss).toBe(85);
    });

    it('should restore status to planned when planned values exist', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      // Status should be completed after materialization
      let doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      expect(doc!.status).toBe('completed');

      // Clear — should restore to planned
      await uploadService.clearActivityMaterialization(activityId, 'user-1');
      doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      expect(doc!.status).toBe('planned');
    });

    it('should leave status as completed when no planned values exist', async () => {
      // Create Activity WITHOUT planned values
      const result = await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        date: '2027-06-15', durationSeconds: 3600, distanceMeters: 30000,
        avgPowerWatts: 220, tss: 75,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const activityId = result.insertedId.toHexString();

      await uploadService.clearActivityMaterialization(activityId, 'user-1');

      const doc = await db.collection('workouts').findOne({ _id: result.insertedId });
      expect(doc!.status).toBe('completed'); // empty shell
    });

    it('should remove metric observations', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      // Verify metrics exist
      let metricsCount = await db.collection('metrics').countDocuments({ 'meta.workoutId': activityId });
      expect(metricsCount).toBe(60);

      // Clear
      await uploadService.clearActivityMaterialization(activityId, 'user-1');

      // Metrics should be gone
      metricsCount = await db.collection('metrics').countDocuments({ 'meta.workoutId': activityId });
      expect(metricsCount).toBe(0);
    });

    it('should preserve title after clearing', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );
      await uploadService.clearActivityMaterialization(activityId, 'user-1');

      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      expect(doc!.title).toBe('Morning Tempo');
    });
  });

  describe('Planned vs Actual coexistence', () => {
    it('plannedTss and actual tss both exist after materialization', async () => {
      const activityId = await createPlannedActivity();
      const artifactId = await createArtifact(activityId);

      await uploadService.materializeActivity(
        activityId, 'user-1', Buffer.from('data'), 'ride.fit', artifactId,
      );

      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activityId) });
      expect(doc!.plannedTss).toBe(85); // planned value preserved
      expect(doc!.tss).toBeDefined(); // actual computed value
      expect(doc!.tss).not.toBe(85); // actual TSS is computed, likely different from planned
    });
  });
});
