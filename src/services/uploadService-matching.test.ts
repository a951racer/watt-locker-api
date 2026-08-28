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

      // Clear mock call count before the duplicate import
      mockFileStorage.store.mockClear();

      await uploadService.uploadSingle(Buffer.from('fake-fit-data'), 'workout2.fit', 'user-1');

      // Only ONE artifact exists — the duplicate was not created
      const artifacts = await db.collection('sourceArtifacts').find({ userId: 'user-1' }).toArray();
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].role).toBe('primary');

      // Drive store was NOT called for the duplicate import
      expect(mockFileStorage.store).not.toHaveBeenCalled();
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

  it('re-import after Workout deletion RECOVERS by reusing the artifact (PLAN-050)', async () => {
    // Step 1: Import FIT → creates Workout + SourceArtifact
    const result1 = await uploadService.uploadSingle(Buffer.from('fit-data'), 'workout.fit', 'user-1');
    expect(result1.workoutId).toBeDefined();

    // Confirm state
    let workoutCount = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
    let artifactCount = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' });
    expect(workoutCount).toBe(1);
    expect(artifactCount).toBe(1);

    // Step 2: Delete the Workout (simulates what the DELETE route does)
    await workoutRepo.delete(result1.workoutId);
    await artifactRepo.disassociateByActivityId('user-1', result1.workoutId);

    // Confirm: Workout gone, SourceArtifact remains with null activityId
    workoutCount = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
    artifactCount = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' });
    expect(workoutCount).toBe(0);
    expect(artifactCount).toBe(1);

    const survivingArtifact = await db.collection('sourceArtifacts').findOne({ userId: 'user-1' });
    expect(survivingArtifact!.activityId).toBeNull();

    // Step 3: Re-import the exact same FIT — PLAN-050 recovery, NOT a duplicate
    const result2 = await uploadService.uploadSingle(Buffer.from('fit-data'), 'workout.fit', 'user-1');

    // Recovery: not flagged as a duplicate (the workout no longer existed)
    expect(result2.duplicate).toBeUndefined();
    expect(result2.workoutId).toBeDefined();
    expect(result2.workoutId).not.toBe('');

    // A new Workout IS created (restored)
    workoutCount = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
    expect(workoutCount).toBe(1);

    // NO new SourceArtifact — the surviving artifact is reused
    artifactCount = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' });
    expect(artifactCount).toBe(1);

    // The reused SourceArtifact is re-associated to the restored workout as primary
    const artifact = await db.collection('sourceArtifacts').findOne({ userId: 'user-1' });
    expect(artifact!.activityId).toBe(result2.workoutId);
    expect(artifact!.role).toBe('primary');
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

  describe('PLAN-051: cross-user isolation (integration)', () => {
    beforeEach(async () => {
      await settingsRepo.upsert('user-2', {
        timezone: 'America/Chicago',
        ftpHistory: [{ effectiveDate: new Date('2024-01-01'), ftpWatts: 250 }],
      });
    });

    it('Test 1 — User B upload is NOT a duplicate of User A source', async () => {
      // User A imports first (creates workout + primary artifact)
      const a = await uploadService.uploadSingle(Buffer.from('fit-data'), 'a.fit', 'user-1');
      expect(a.workoutId).toBeTruthy();

      // User B imports the same source signature
      const b = await uploadService.uploadSingle(Buffer.from('fit-data'), 'b.fit', 'user-2');
      expect(b.duplicate).toBeUndefined();
      expect(b.workoutId).toBeTruthy();
      expect(b.workoutId).not.toBe(a.workoutId);

      // Two independent artifacts, one per user
      const aCount = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' });
      const bCount = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-2' });
      expect(aCount).toBe(1);
      expect(bCount).toBe(1);
      // Drive archived for both (no cross-user dedup short-circuit)
      expect(mockFileStorage.store).toHaveBeenCalledTimes(2);
    });

    it('Test 2 — User B does NOT recover User A orphaned artifact', async () => {
      // User A imports, then deletes the workout (orphaning the artifact)
      const a = await uploadService.uploadSingle(Buffer.from('fit-data'), 'a.fit', 'user-1');
      await workoutRepo.delete(a.workoutId);
      await artifactRepo.disassociateByActivityId('user-1', a.workoutId);

      const orphanBefore = await db.collection('sourceArtifacts').findOne({ userId: 'user-1' });
      expect(orphanBefore!.activityId).toBeNull();

      // User B imports the same source — must NOT reuse User A's orphan
      const b = await uploadService.uploadSingle(Buffer.from('fit-data'), 'b.fit', 'user-2');
      expect(b.duplicate).toBeUndefined();
      expect(b.workoutId).toBeTruthy();

      // A brand-new artifact created for User B; User A's orphan untouched
      const bCount = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-2' });
      expect(bCount).toBe(1);
      const orphanAfter = await db.collection('sourceArtifacts').findOne({ userId: 'user-1' });
      expect(orphanAfter!.activityId).toBeNull();
      expect(orphanAfter!.role).toBe('secondary');
      expect(orphanAfter!._id.toString()).toBe(orphanBefore!._id.toString());
    });

    it('Test 3 — Same-user orphan still recovers (regression guard)', async () => {
      const a = await uploadService.uploadSingle(Buffer.from('fit-data'), 'a.fit', 'user-1');
      await workoutRepo.delete(a.workoutId);
      await artifactRepo.disassociateByActivityId('user-1', a.workoutId);

      const re = await uploadService.uploadSingle(Buffer.from('fit-data'), 'a.fit', 'user-1');
      expect(re.duplicate).toBeUndefined();
      expect(re.workoutId).toBeTruthy();
      // No second artifact — the orphan is reused
      const count = await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' });
      expect(count).toBe(1);
      const artifact = await db.collection('sourceArtifacts').findOne({ userId: 'user-1' });
      expect(artifact!.activityId).toBe(re.workoutId);
      expect(artifact!.role).toBe('primary');
    });

    it('Test 4 — Workout deletion for User A does not modify User B artifacts', async () => {
      const a = await uploadService.uploadSingle(Buffer.from('fit-data'), 'a.fit', 'user-1');
      const b = await uploadService.uploadSingle(Buffer.from('fit-data'), 'b.fit', 'user-2');

      // Simulate the DELETE route: user-scoped disassociation for User A only
      await artifactRepo.disassociateByActivityId('user-1', a.workoutId);

      const artA = await db.collection('sourceArtifacts').findOne({ userId: 'user-1' });
      const artB = await db.collection('sourceArtifacts').findOne({ userId: 'user-2' });
      expect(artA!.activityId).toBeNull(); // disassociated
      expect(artB!.activityId).toBe(b.workoutId); // untouched
      expect(artB!.role).toBe('primary');
    });

    it('Test 6 — Active duplicate stays isolated per user', async () => {
      const a = await uploadService.uploadSingle(Buffer.from('fit-data'), 'a.fit', 'user-1');
      // User A re-imports (active duplicate) → short-circuit
      const aDup = await uploadService.uploadSingle(Buffer.from('fit-data'), 'a2.fit', 'user-1');
      expect(aDup.duplicate).toBe(true);

      // User B imports the same source → independent import, not a duplicate
      const b = await uploadService.uploadSingle(Buffer.from('fit-data'), 'b.fit', 'user-2');
      expect(b.duplicate).toBeUndefined();
      expect(b.workoutId).not.toBe(a.workoutId);

      // User A: exactly one artifact/workout; User B: exactly one artifact/workout
      expect(await db.collection('sourceArtifacts').countDocuments({ userId: 'user-1' })).toBe(1);
      expect(await db.collection('sourceArtifacts').countDocuments({ userId: 'user-2' })).toBe(1);
      expect(await db.collection('workouts').countDocuments({ userId: 'user-1', template: false })).toBe(1);
      expect(await db.collection('workouts').countDocuments({ userId: 'user-2', template: false })).toBe(1);
    });
  });
});
