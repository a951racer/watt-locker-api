/**
 * PLAN-037: Ingestion Matching & Deduplication Tests
 * Tests that the upload pipeline correctly matches imported workouts
 * to existing planned activities, preserves planned values, and handles duplicates.
 */
import { UploadService } from './uploadService';
import { MongoWorkoutRepository } from '../repositories/workoutRepository';
import { MongoSourceArtifactRepository } from '../repositories/sourceArtifactRepository';
import { MongoSettingsRepository } from '../repositories/settingsRepository';
import { SettingsService } from './settingsService';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { WorkoutRecord } from '../models/workout';

// Minimal mock file storage
const mockFileStorage = {
  store: jest.fn().mockResolvedValue({ fileId: 'drive-file-1', webViewLink: 'https://drive.google.com/file1' }),
  retrieve: jest.fn(),
  delete: jest.fn(),
  listFiles: jest.fn().mockResolvedValue([]),
  removeFromFolder: jest.fn(),
};

describe('PLAN-037: Ingestion Matching & Deduplication', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let workoutRepo: MongoWorkoutRepository;
  let artifactRepo: MongoSourceArtifactRepository;
  let settingsRepo: MongoSettingsRepository;
  let settingsService: SettingsService;
  let uploadService: UploadService;
  let parserFactory: any;

  // Create a minimal valid FIT-like buffer that the parser can handle
  // We'll mock the parser instead
  const mockParsedWorkout = {
    summary: {
      activityType: 'ride',
      startTime: new Date('2027-09-15T14:00:00Z'),
      endTime: new Date('2027-09-15T15:30:00Z'),
      durationSeconds: 5400,
      movingTimeSeconds: 5200,
      distanceMeters: 40000,
      elevationGainMeters: 300,
      title: 'Afternoon Ride',
    },
    dataPoints: [],
    sourceFormat: 'fit' as const,
  };

  const mockParser = {
    parse: jest.fn().mockResolvedValue(mockParsedWorkout),
    parseLightMetadata: jest.fn().mockResolvedValue({
      startTime: mockParsedWorkout.summary.startTime,
      durationSeconds: mockParsedWorkout.summary.durationSeconds,
      activityType: mockParsedWorkout.summary.activityType,
    }),
  };

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

    settingsService = new SettingsService(settingsRepo);
    await settingsRepo.upsert('user-1', {
      timezone: 'America/Chicago',
      ftpHistory: [{ effectiveDate: new Date('2024-01-01'), ftpWatts: 250 }],
    });

    // Create a mock parser factory
    parserFactory = { getParser: jest.fn().mockReturnValue(mockParser) } as any;

    uploadService = new UploadService(
      parserFactory,
      workoutRepo,
      mockFileStorage as any,
      settingsService,
      undefined, // logger
      artifactRepo,
    );
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    await db.collection('workouts').deleteMany({});
    await db.collection('sourceArtifacts').deleteMany({});
    jest.clearAllMocks();
    mockFileStorage.store.mockResolvedValue({ fileId: `drive-${Date.now()}`, webViewLink: 'https://drive.google.com/file' });
    mockParser.parse.mockResolvedValue(mockParsedWorkout);
    mockParser.parseLightMetadata.mockResolvedValue({
      startTime: mockParsedWorkout.summary.startTime,
      durationSeconds: mockParsedWorkout.summary.durationSeconds,
      activityType: mockParsedWorkout.summary.activityType,
    });
  });

  describe('Planned Activity Matching', () => {
    it('matches imported workout to existing planned activity on the same date', async () => {
      // Create a planned activity for Sep 15, 2027 (same date the imported workout will be)
      const planned = await workoutRepo.create({
        userId: 'user-1',
        status: 'planned',
        template: false,
        date: '2027-09-15',
        activityType: 'ride',
        title: 'Sweet Spot Intervals',
        plannedDurationSeconds: 5400,
        plannedTss: 96,
        plannedIf: 0.86,
      } as WorkoutRecord);

      // Import the workout file
      const result = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout.fit',
        'user-1',
      );

      // Should match the existing planned activity — not create a new one
      expect(result.workoutId).toBe(planned.id);
      expect(result.matchedExisting).toBe(true);

      // Verify the matched activity is now completed with both planned and actual data
      const completed = await workoutRepo.findById(planned.id);
      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');

      // Planned values preserved
      expect(completed!.plannedDurationSeconds).toBe(5400);
      expect(completed!.plannedTss).toBe(96);
      expect(completed!.plannedIf).toBe(0.86);

      // Actual values populated
      expect(completed!.durationSeconds).toBe(5400);
      expect(completed!.distanceMeters).toBe(40000);

      // Only ONE activity should exist
      const allActivities = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
      expect(allActivities).toBe(1);
    });

    it('creates a new completed activity when no planned activity exists', async () => {
      // No planned activity exists for this date
      const result = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout.fit',
        'user-1',
      );

      expect(result.matchedExisting).toBe(false);

      // A new completed activity should be created
      const activity = await workoutRepo.findById(result.workoutId);
      expect(activity).not.toBeNull();
      expect(activity!.status).toBe('completed');
      expect(activity!.durationSeconds).toBe(5400);
      expect(activity!.distanceMeters).toBe(40000);

      const count = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
      expect(count).toBe(1);
    });

    it('does not match a planned activity on a DIFFERENT date', async () => {
      // Planned activity for Sep 14 (different day)
      await workoutRepo.create({
        userId: 'user-1',
        status: 'planned',
        template: false,
        date: '2027-09-14',
        activityType: 'ride',
        title: 'Yesterday Workout',
        plannedDurationSeconds: 3600,
      } as WorkoutRecord);

      const result = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout.fit',
        'user-1',
      );

      // Should NOT match — creates a new activity
      expect(result.matchedExisting).toBe(false);

      // Two activities should exist: the original planned + the new completed
      const count = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
      expect(count).toBe(2);
    });

    it('preserves segments and planning fields when matching', async () => {
      // Create planned activity with segments
      const planned = await workoutRepo.create({
        userId: 'user-1',
        status: 'planned',
        template: false,
        date: '2027-09-15',
        activityType: 'ride',
        title: 'Interval Session',
        plannedDurationSeconds: 5400,
        plannedTss: 96,
        plannedIf: 0.86,
      } as WorkoutRecord);

      // Also store segments on the raw document (as the planning workflow does)
      await db.collection('workouts').updateOne(
        { _id: (planned as any)._id ?? new (require('mongodb').ObjectId)(planned.id) },
        { $set: { segments: [{ type: 'warmup', durationSeconds: 600, powerMin: 50, powerMax: 60 }] } },
      );

      const result = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout.fit',
        'user-1',
      );

      expect(result.workoutId).toBe(planned.id);

      // Verify segments survived materialization
      const raw = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(planned.id) });
      expect(raw!.segments).toBeDefined();
      expect(raw!.segments).toHaveLength(1);
      expect(raw!.segments[0].type).toBe('warmup');
      expect(raw!.plannedTss).toBe(96);
      expect(raw!.plannedIf).toBe(0.86);
    });
  });

  describe('Duplicate Detection', () => {
    it('does not create a duplicate when the same workout is imported twice', async () => {
      // First import
      const result1 = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout.fit',
        'user-1',
      );

      // Second import of the same workout (same startTime + duration)
      const result2 = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout.fit',
        'user-1',
      );

      // Should return the same activity
      expect(result2.workoutId).toBe(result1.workoutId);
      expect(result2.duplicate).toBe(true);

      // Only ONE activity should exist
      const count = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
      expect(count).toBe(1);

      // Only ONE SourceArtifact should exist
      const artifacts = await db.collection('sourceArtifacts').find({ userId: 'user-1' }).toArray();
      expect(artifacts.length).toBe(1);
    });

    it('duplicate import does not create duplicate source artifacts for the same activity', async () => {
      await uploadService.uploadSingle(Buffer.from('fake-fit-data'), 'workout1.fit', 'user-1');
      await uploadService.uploadSingle(Buffer.from('fake-fit-data'), 'workout2.fit', 'user-1');

      // Only ONE artifact exists — the duplicate was not created
      const artifacts = await db.collection('sourceArtifacts').find({ userId: 'user-1' }).toArray();
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].role).toBe('primary');
    });
  });

  describe('Source Artifact Association', () => {
    it('creates a primary source artifact associated with the matched activity', async () => {
      const planned = await workoutRepo.create({
        userId: 'user-1',
        status: 'planned',
        template: false,
        date: '2027-09-15',
        activityType: 'ride',
        plannedDurationSeconds: 5400,
      } as WorkoutRecord);

      await uploadService.uploadSingle(Buffer.from('fake-fit-data'), 'workout.fit', 'user-1');

      const artifacts = await artifactRepo.findByActivityId('user-1', planned.id);
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].activityId).toBe(planned.id);
      expect(artifacts[0].role).toBe('primary');
      expect(artifacts[0].materialized).toBe(true);
    });
  });
});

describe('PLAN-037D: Skipped Activity Matching', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let workoutRepo: MongoWorkoutRepository;
  let artifactRepo: MongoSourceArtifactRepository;
  let settingsRepo: MongoSettingsRepository;
  let settingsService: SettingsService;
  let uploadService: UploadService;

  const mockParsedWorkout = {
    summary: {
      activityType: 'ride',
      startTime: new Date('2026-08-04T14:00:00Z'),
      endTime: new Date('2026-08-04T15:30:00Z'),
      durationSeconds: 5400,
      movingTimeSeconds: 5200,
      distanceMeters: 40000,
      elevationGainMeters: 300,
      title: 'Afternoon Ride',
    },
    dataPoints: [],
    sourceFormat: 'fit' as const,
  };

  const mockParser = {
    parse: jest.fn().mockResolvedValue(mockParsedWorkout),
    parseLightMetadata: jest.fn().mockResolvedValue({
      startTime: mockParsedWorkout.summary.startTime,
      durationSeconds: mockParsedWorkout.summary.durationSeconds,
      activityType: mockParsedWorkout.summary.activityType,
    }),
  };

  const mockFileStorage = {
    store: jest.fn().mockResolvedValue({ fileId: 'drive-file-1', webViewLink: 'https://drive.google.com/file' }),
    retrieve: jest.fn(),
    delete: jest.fn(),
    listFiles: jest.fn().mockResolvedValue([]),
    removeFromFolder: jest.fn(),
  };

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
    settingsService = new SettingsService(settingsRepo);
    await settingsRepo.upsert('user-1', {
      timezone: 'America/Chicago',
      ftpHistory: [{ effectiveDate: new Date('2024-01-01'), ftpWatts: 250 }],
    });

    const parserFactory = { getParser: jest.fn().mockReturnValue(mockParser) } as any;
    uploadService = new UploadService(parserFactory, workoutRepo, mockFileStorage as any, settingsService, undefined, artifactRepo);
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });

  beforeEach(async () => {
    await db.collection('workouts').deleteMany({});
    await db.collection('sourceArtifacts').deleteMany({});
    jest.clearAllMocks();
    mockFileStorage.store.mockResolvedValue({ fileId: `drive-${Date.now()}`, webViewLink: 'https://drive.google.com/file' });
  });

  it('matches imported workout to existing SKIPPED activity on the same date (August 4 scenario)', async () => {
    // Create a skipped activity — exactly the Aug 4 scenario
    const skipped = await workoutRepo.create({
      userId: 'user-1',
      status: 'skipped',
      template: false,
      date: '2026-08-04',
      activityType: 'ride',
      title: 'TT Intervals',
      plannedDurationSeconds: 5400,
      plannedTss: 96,
      plannedIf: 0.86,
    } as WorkoutRecord);

    const result = await uploadService.uploadSingle(
      Buffer.from('fake-fit-data'),
      'workout.fit',
      'user-1',
    );

    // Must match the existing skipped activity
    expect(result.workoutId).toBe(skipped.id);
    expect(result.matchedExisting).toBe(true);

    // Activity must now be completed
    const completed = await workoutRepo.findById(skipped.id);
    expect(completed!.status).toBe('completed');

    // Planned values preserved
    expect(completed!.plannedDurationSeconds).toBe(5400);
    expect(completed!.plannedTss).toBe(96);
    expect(completed!.plannedIf).toBe(0.86);
    expect(completed!.title).toBe('TT Intervals');

    // Actual values populated
    expect(completed!.durationSeconds).toBe(5400);
    expect(completed!.distanceMeters).toBe(40000);

    // Only ONE activity on that date
    const count = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
    expect(count).toBe(1);
  });

  it('skipped activity matching preserves segments', async () => {
    const skipped = await workoutRepo.create({
      userId: 'user-1',
      status: 'skipped',
      template: false,
      date: '2026-08-04',
      activityType: 'ride',
      title: 'TT Intervals',
      plannedDurationSeconds: 5400,
    } as WorkoutRecord);

    await db.collection('workouts').updateOne(
      { _id: new (require('mongodb').ObjectId)(skipped.id) },
      { $set: { segments: [{ type: 'interval', durationSeconds: 1200, powerMin: 90, powerMax: 100 }] } },
    );

    await uploadService.uploadSingle(Buffer.from('fake-fit-data'), 'workout.fit', 'user-1');

    const raw = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(skipped.id) });
    expect(raw!.segments).toHaveLength(1);
    expect(raw!.segments[0].type).toBe('interval');
    expect(raw!.status).toBe('completed');
  });

  it('SourceArtifact is associated with the matched skipped activity', async () => {
    const skipped = await workoutRepo.create({
      userId: 'user-1',
      status: 'skipped',
      template: false,
      date: '2026-08-04',
      activityType: 'ride',
      plannedDurationSeconds: 5400,
    } as WorkoutRecord);

    await uploadService.uploadSingle(Buffer.from('fake-fit-data'), 'workout.fit', 'user-1');

    const artifacts = await artifactRepo.findByActivityId('user-1', skipped.id);
    expect(artifacts.length).toBe(1);
    expect(artifacts[0].activityId).toBe(skipped.id);
    expect(artifacts[0].materialized).toBe(true);
  });
});


describe('PLAN-037H: Duplicate After Workout Deletion', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let workoutRepo: MongoWorkoutRepository;
  let artifactRepo: MongoSourceArtifactRepository;
  let settingsRepo: MongoSettingsRepository;
  let settingsService: SettingsService;
  let uploadService: UploadService;

  const mockParsedWorkout = {
    summary: {
      activityType: 'ride',
      startTime: new Date('2026-08-04T14:00:00Z'),
      endTime: new Date('2026-08-04T15:30:00Z'),
      durationSeconds: 5400,
      movingTimeSeconds: 5200,
      distanceMeters: 40000,
      elevationGainMeters: 300,
      title: 'TT Ride',
    },
    dataPoints: [],
    sourceFormat: 'fit' as const,
  };

  const mockParser = {
    parse: jest.fn().mockResolvedValue(mockParsedWorkout),
    parseLightMetadata: jest.fn().mockResolvedValue({
      startTime: mockParsedWorkout.summary.startTime,
      durationSeconds: mockParsedWorkout.summary.durationSeconds,
      activityType: mockParsedWorkout.summary.activityType,
    }),
  };

  const mockFileStorage = {
    store: jest.fn().mockResolvedValue({ fileId: 'drive-file-1', webViewLink: 'https://drive.google.com/file' }),
    retrieve: jest.fn(),
    delete: jest.fn(),
    listFiles: jest.fn().mockResolvedValue([]),
    removeFromFolder: jest.fn(),
  };

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
    settingsService = new SettingsService(settingsRepo);
    await settingsRepo.upsert('user-1', {
      timezone: 'America/Chicago',
      ftpHistory: [{ effectiveDate: new Date('2024-01-01'), ftpWatts: 250 }],
    });

    const parserFactory = { getParser: jest.fn().mockReturnValue(mockParser) } as any;
    uploadService = new UploadService(parserFactory, workoutRepo, mockFileStorage as any, settingsService, undefined, artifactRepo);
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });

  beforeEach(async () => {
    await db.collection('workouts').deleteMany({});
    await db.collection('sourceArtifacts').deleteMany({});
    jest.clearAllMocks();
    mockFileStorage.store.mockResolvedValue({ fileId: `drive-${Date.now()}`, webViewLink: 'https://drive.google.com/file' });
  });

  it('duplicate with existing Workout returns duplicate without creating anything', async () => {
    // First import — creates Workout + SourceArtifact
    const result1 = await uploadService.uploadSingle(Buffer.from('fit-data'), 'workout.fit', 'user-1');
    expect(result1.duplicate).toBeUndefined();

    // Second import — same source file
    const result2 = await uploadService.uploadSingle(Buffer.from('fit-data'), 'workout.fit', 'user-1');
    expect(result2.duplicate).toBe(true);
    expect(result2.workoutId).toBe(result1.workoutId);

    // Exactly 1 Workout, 1 SourceArtifact
    const workouts = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
    expect(workouts).toBe(1);
    const artifacts = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' });
    expect(artifacts).toBe(1);
  });

  it('duplicate after Workout deletion does NOT create a new Workout or SourceArtifact', async () => {
    // Step 1: Import FIT → creates Workout + SourceArtifact
    const result1 = await uploadService.uploadSingle(Buffer.from('fit-data'), 'workout.fit', 'user-1');
    expect(result1.workoutId).toBeDefined();

    // Confirm state
    let workoutCount = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
    let artifactCount = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' });
    expect(workoutCount).toBe(1);
    expect(artifactCount).toBe(1);

    // Step 2: Delete the Workout (simulates what the DELETE route does)
    await artifactRepo.disassociateByActivityId(result1.workoutId);
    await workoutRepo.delete(result1.workoutId);

    // Confirm: Workout gone, SourceArtifact remains with null activityId
    workoutCount = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
    artifactCount = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' });
    expect(workoutCount).toBe(0);
    expect(artifactCount).toBe(1);

    const survivingArtifact = await db.collection('sourceArtifacts').findOne({ userId: 'user-1' });
    expect(survivingArtifact!.activityId).toBeNull();

    // Step 3: Re-import the exact same FIT
    const result2 = await uploadService.uploadSingle(Buffer.from('fit-data'), 'workout.fit', 'user-1');

    // Must be treated as duplicate
    expect(result2.duplicate).toBe(true);

    // No new Workout created
    workoutCount = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
    expect(workoutCount).toBe(0);

    // No new SourceArtifact created
    artifactCount = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' });
    expect(artifactCount).toBe(1);

    // Existing SourceArtifact unchanged
    const artifact = await db.collection('sourceArtifacts').findOne({ userId: 'user-1' });
    expect(artifact!.activityId).toBeNull();
    expect(artifact!.role).toBe('secondary');
  });

  it('existing matching tests still work — planned activity matching', async () => {
    // Create planned activity
    const planned = await workoutRepo.create({
      userId: 'user-1',
      status: 'planned',
      template: false,
      date: '2026-08-04',
      activityType: 'ride',
      title: 'TT Intervals',
      plannedDurationSeconds: 5400,
      plannedTss: 96,
    } as WorkoutRecord);

    // Import FIT — should match
    const result = await uploadService.uploadSingle(Buffer.from('fit-data'), 'workout.fit', 'user-1');
    expect(result.workoutId).toBe(planned.id);
    expect(result.matchedExisting).toBe(true);
    expect(result.duplicate).toBeUndefined();

    // Planned activity becomes completed
    const activity = await workoutRepo.findById(planned.id);
    expect(activity!.status).toBe('completed');
    expect(activity!.plannedTss).toBe(96);
  });
});
