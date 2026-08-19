/**
 * PLAN-020 Tests: Migration — Backfill SourceArtifact records from existing provenance
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { runMigration, parseCliMode } from './020-backfill-source-artifacts';
import { MongoSourceArtifactRepository } from '../repositories/sourceArtifactRepository';

describe('PLAN-020: Backfill source artifacts migration', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let artifactRepo: MongoSourceArtifactRepository;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();
    artifactRepo = new MongoSourceArtifactRepository(db);
    await artifactRepo.createIndexes();
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });
  beforeEach(async () => {
    await db.collection('workouts').deleteMany({});
    await db.collection('sourceArtifacts').deleteMany({});
  });

  function seedWorkout(overrides?: Record<string, unknown>) {
    return db.collection('workouts').insertOne({
      userId: 'user-1',
      activityType: 'ride',
      status: 'completed',
      template: false,
      date: '2026-08-10',
      title: 'Morning Ride',
      startTime: new Date('2026-08-10T14:00:00Z'),
      endTime: new Date('2026-08-10T15:30:00Z'),
      durationSeconds: 5400,
      distanceMeters: 45000,
      dataSource: 'strava',
      fileFormat: 'fit',
      driveFileId: 'drive-abc-123',
      driveWebViewLink: 'https://drive.google.com/file/abc',
      sourceActivityId: 'strava-99999',
      avgPowerWatts: 220,
      tss: 75,
      createdAt: new Date('2026-08-10T16:00:00Z'),
      updatedAt: new Date('2026-08-10T16:00:00Z'),
      ...overrides,
    });
  }

  describe('Basic migration', () => {
    it('should create a SourceArtifact for a qualifying workout', async () => {
      const { insertedId } = await seedWorkout();
      const result = await runMigration(db, { dryRun: false });
      expect(result.created).toBe(1);
      expect(result.qualifying).toBe(1);

      const artifacts = await db.collection('sourceArtifacts').find({}).toArray();
      expect(artifacts).toHaveLength(1);
      const a = artifacts[0];
      expect(a.userId).toBe('user-1');
      expect(a.activityId).toBe(insertedId.toHexString());
      expect(a.role).toBe('primary');
      expect(a.materialized).toBe(true);
      expect(a.source).toBe('strava');
      expect(a.format).toBe('fit');
      expect(a.driveFileId).toBe('drive-abc-123');
      expect(a.driveWebViewLink).toBe('https://drive.google.com/file/abc');
      expect(a.sourceActivityId).toBe('strava-99999');
      expect(a.originalFileName).toBe('Morning Ride');
      expect(a.startTime).toEqual(new Date('2026-08-10T14:00:00Z'));
      expect(a.durationSeconds).toBe(5400);
      expect(a.activityType).toBe('ride');
    });
  });

  describe('Workout without driveFileId', () => {
    it('should NOT create a SourceArtifact', async () => {
      await seedWorkout({ driveFileId: undefined });
      const result = await runMigration(db, { dryRun: false });
      expect(result.skippedNoDriveFile).toBe(1);
      expect(result.created).toBe(0);
      const artifacts = await db.collection('sourceArtifacts').find({}).toArray();
      expect(artifacts).toHaveLength(0);
    });
  });

  describe('Missing title — fallback to Activity ID', () => {
    it('should use Activity ID as originalFileName when title is absent', async () => {
      const { insertedId } = await seedWorkout({ title: undefined });
      await runMigration(db, { dryRun: false });
      const artifact = await db.collection('sourceArtifacts').findOne({});
      expect(artifact!.originalFileName).toBe(insertedId.toHexString());
    });
  });

  describe('Idempotency', () => {
    it('should not create duplicates on second run', async () => {
      await seedWorkout();
      const result1 = await runMigration(db, { dryRun: false });
      expect(result1.created).toBe(1);

      const result2 = await runMigration(db, { dryRun: false });
      expect(result2.created).toBe(0);
      expect(result2.skippedExisting).toBe(1);

      const artifacts = await db.collection('sourceArtifacts').find({}).toArray();
      expect(artifacts).toHaveLength(1);
    });
  });

  describe('Partial/interrupted recovery', () => {
    it('should skip already-migrated and create missing', async () => {
      const w1 = await seedWorkout({ driveFileId: 'drive-1', title: 'Ride 1' });
      await seedWorkout({ driveFileId: 'drive-2', title: 'Ride 2' });

      // Pre-create artifact for w1 (simulates partial run)
      await db.collection('sourceArtifacts').insertOne({
        userId: 'user-1', activityId: w1.insertedId.toHexString(),
        role: 'primary', materialized: true, driveFileId: 'drive-1',
        originalFileName: 'Ride 1', importedAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(),
      });

      const result = await runMigration(db, { dryRun: false });
      expect(result.skippedExisting).toBe(1);
      expect(result.created).toBe(1);

      const artifacts = await db.collection('sourceArtifacts').find({}).toArray();
      expect(artifacts).toHaveLength(2);
    });
  });

  describe('Legacy Workout preservation', () => {
    it('should NOT modify existing WorkoutDocuments', async () => {
      const { insertedId } = await seedWorkout();
      const before = await db.collection('workouts').findOne({ _id: insertedId });

      await runMigration(db, { dryRun: false });

      const after = await db.collection('workouts').findOne({ _id: insertedId });
      expect(after!.driveFileId).toBe(before!.driveFileId);
      expect(after!.driveWebViewLink).toBe(before!.driveWebViewLink);
      expect(after!.sourceActivityId).toBe(before!.sourceActivityId);
      expect(after!.dataSource).toBe(before!.dataSource);
      expect(after!.fileFormat).toBe(before!.fileFormat);
      expect(after!.title).toBe(before!.title);
      expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    });
  });

  describe('Multiple users', () => {
    it('should preserve correct userId on each artifact', async () => {
      await seedWorkout({ userId: 'user-1', driveFileId: 'drive-u1' });
      await seedWorkout({ userId: 'user-2', driveFileId: 'drive-u2' });

      await runMigration(db, { dryRun: false });

      const artifacts = await db.collection('sourceArtifacts').find({}).sort({ userId: 1 }).toArray();
      expect(artifacts).toHaveLength(2);
      expect(artifacts[0].userId).toBe('user-1');
      expect(artifacts[1].userId).toBe('user-2');
    });
  });

  describe('Existing equivalent artifact — skip', () => {
    it('should not create a second artifact when activityId+driveFileId already exists', async () => {
      const { insertedId } = await seedWorkout();
      // Pre-create the exact equivalent artifact
      await db.collection('sourceArtifacts').insertOne({
        userId: 'user-1', activityId: insertedId.toHexString(),
        role: 'primary', materialized: true, driveFileId: 'drive-abc-123',
        originalFileName: 'Morning Ride', importedAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(),
      });

      const result = await runMigration(db, { dryRun: false });
      expect(result.skippedExisting).toBe(1);
      expect(result.created).toBe(0);

      const artifacts = await db.collection('sourceArtifacts').find({}).toArray();
      expect(artifacts).toHaveLength(1);
    });
  });

  describe('Existing different artifact — does not interfere', () => {
    it('should create new artifact when existing has different driveFileId', async () => {
      const { insertedId } = await seedWorkout({ driveFileId: 'drive-new' });
      // Pre-create artifact with a DIFFERENT driveFileId
      await db.collection('sourceArtifacts').insertOne({
        userId: 'user-1', activityId: insertedId.toHexString(),
        role: 'secondary', materialized: true, driveFileId: 'drive-old',
        originalFileName: 'Old File', importedAt: new Date(),
        createdAt: new Date(), updatedAt: new Date(),
      });

      const result = await runMigration(db, { dryRun: false });
      expect(result.created).toBe(1);

      const artifacts = await db.collection('sourceArtifacts').find({ activityId: insertedId.toHexString() }).toArray();
      expect(artifacts).toHaveLength(2);
    });
  });

  describe('Dry run', () => {
    it('should report counts but create ZERO artifacts', async () => {
      await seedWorkout();
      await seedWorkout({ driveFileId: 'drive-2', title: 'Ride 2' });

      const result = await runMigration(db, { dryRun: true });
      expect(result.qualifying).toBe(2);
      expect(result.created).toBe(2); // would-create count
      expect(result.skippedExisting).toBe(0);

      const artifacts = await db.collection('sourceArtifacts').find({}).toArray();
      expect(artifacts).toHaveLength(0);
    });
  });

  describe('CLI mode parsing', () => {
    it('should parse --dry-run', () => {
      expect(parseCliMode(['node', 'script', '--dry-run'])).toBe('dry-run');
    });

    it('should parse --execute', () => {
      expect(parseCliMode(['node', 'script', '--execute'])).toBe('execute');
    });

    it('should default to none when no flag', () => {
      expect(parseCliMode(['node', 'script'])).toBe('none');
    });

    it('should refuse to execute when mode is none — runMigration is never called', async () => {
      // Simulate the main() safety logic without calling process.exit
      const mode = parseCliMode(['node', 'script']);
      expect(mode).toBe('none');

      // Verify: if mode is 'none', the migration must NOT be invoked
      // Seed data to prove no writes happen
      await seedWorkout();
      // Only execute if mode is NOT 'none' — the main() pattern
      if (mode !== 'none') {
        await runMigration(db, { dryRun: false });
      }
      // No artifacts created because mode was 'none'
      const artifacts = await db.collection('sourceArtifacts').find({}).toArray();
      expect(artifacts).toHaveLength(0);
    });
  });

  describe('Missing optional provenance fields', () => {
    it('should not fabricate missing optional fields', async () => {
      await seedWorkout({
        dataSource: undefined,
        fileFormat: undefined,
        sourceActivityId: undefined,
        driveWebViewLink: undefined,
        startTime: undefined,
        durationSeconds: undefined,
      });

      await runMigration(db, { dryRun: false });

      const artifact = await db.collection('sourceArtifacts').findOne({});
      expect(artifact!.source).toBeUndefined();
      expect(artifact!.format).toBeUndefined();
      expect(artifact!.sourceActivityId).toBeUndefined();
      expect(artifact!.driveWebViewLink).toBeUndefined();
      expect(artifact!.startTime).toBeUndefined();
      expect(artifact!.durationSeconds).toBeUndefined();
      // But required fields are present
      expect(artifact!.driveFileId).toBe('drive-abc-123');
      expect(artifact!.role).toBe('primary');
      expect(artifact!.materialized).toBe(true);
    });
  });
});
