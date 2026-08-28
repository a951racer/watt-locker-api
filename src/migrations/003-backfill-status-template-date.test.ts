import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db, ObjectId } from 'mongodb';
import { runMigration, parseCliMode } from './003-backfill-status-template-date';

describe('PLAN-003 Migration: CLI mode parsing', () => {
  it('should return dry-run when --dry-run is present', () => {
    expect(parseCliMode(['node', 'script.ts', '--dry-run'])).toBe('dry-run');
  });

  it('should return execute when --execute is present', () => {
    expect(parseCliMode(['node', 'script.ts', '--execute'])).toBe('execute');
  });

  it('should return none when no mode flag is present', () => {
    expect(parseCliMode(['node', 'script.ts'])).toBe('none');
  });

  it('should return none for unrecognized flags', () => {
    expect(parseCliMode(['node', 'script.ts', '--verbose'])).toBe('none');
  });

  it('should prefer dry-run if both flags present', () => {
    // --dry-run checked first
    expect(parseCliMode(['node', 'script.ts', '--dry-run', '--execute'])).toBe('dry-run');
  });
});

describe('PLAN-003 Migration: Backfill status, template, date', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    client = new MongoClient(uri);
    await client.connect();
    db = client.db();
  });

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    await db.collection('workouts').deleteMany({});
    await db.collection('settings').deleteMany({});
    // Set up user timezone
    await db.collection('settings').insertOne({
      userId: 'user-1',
      timezone: 'America/Chicago',
      driveStoragePath: 'WattLocker',
      driveInboxPath: 'WattLocker/Inbox',
      connectedSources: [],
      updatedAt: new Date(),
    });
  });

  describe('Normal migration', () => {
    it('should populate status, template, and date on a legacy document', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1',
        activityType: 'ride',
        startTime: new Date('2024-06-15T14:00:00Z'), // 9 AM CDT
        endTime: new Date('2024-06-15T15:30:00Z'),
        durationSeconds: 5400,
        distanceMeters: 45000,
        elevationGainMeters: 600,
        dataSource: 'manual',
        fileFormat: 'fit',
        driveFileId: 'drive-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await runMigration(db);

      expect(result.documentsChanged).toBe(1);
      expect(result.statusPopulated).toBe(1);
      expect(result.templatePopulated).toBe(1);
      expect(result.datePopulated).toBe(1);

      const doc = await db.collection('workouts').findOne({ userId: 'user-1' });
      expect(doc!.status).toBe('completed');
      expect(doc!.template).toBe(false);
      expect(doc!.date).toBe('2024-06-15'); // CDT is UTC-5, 14:00 UTC = 09:00 CDT = still June 15
    });
  });

  describe('Timezone boundary — negative offset', () => {
    it('should derive correct date when UTC midnight crosses to previous local day', async () => {
      // UTC: 2024-08-11T03:30:00Z → CDT (UTC-5): 2024-08-10T22:30:00 → date should be 2024-08-10
      await db.collection('workouts').insertOne({
        userId: 'user-1',
        activityType: 'ride',
        startTime: new Date('2024-08-11T03:30:00Z'),
        endTime: new Date('2024-08-11T05:00:00Z'),
        durationSeconds: 5400,
        distanceMeters: 40000,
        elevationGainMeters: 300,
        dataSource: 'manual',
        fileFormat: 'fit',
        driveFileId: 'drive-tz1',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await runMigration(db);

      const doc = await db.collection('workouts').findOne({ userId: 'user-1' });
      expect(doc!.date).toBe('2024-08-10'); // Previous day in CDT
      expect(result.datePopulated).toBe(1);
    });
  });

  describe('Timezone boundary — positive offset', () => {
    it('should derive correct date for positive-offset timezone', async () => {
      // Set user to Asia/Tokyo (UTC+9)
      await db.collection('settings').updateOne(
        { userId: 'user-1' },
        { $set: { timezone: 'Asia/Tokyo' } },
      );

      // UTC: 2024-08-10T20:00:00Z → JST (UTC+9): 2024-08-11T05:00:00 → date should be 2024-08-11
      await db.collection('workouts').insertOne({
        userId: 'user-1',
        activityType: 'ride',
        startTime: new Date('2024-08-10T20:00:00Z'),
        endTime: new Date('2024-08-10T21:30:00Z'),
        durationSeconds: 5400,
        distanceMeters: 40000,
        elevationGainMeters: 300,
        dataSource: 'manual',
        fileFormat: 'fit',
        driveFileId: 'drive-tz2',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await runMigration(db);

      const doc = await db.collection('workouts').findOne({ userId: 'user-1' });
      expect(doc!.date).toBe('2024-08-11'); // Next day in JST
      expect(result.datePopulated).toBe(1);
    });
  });

  describe('Existing values preserved', () => {
    it('should not overwrite existing status, template, or date', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1',
        activityType: 'ride',
        status: 'completed',
        template: false,
        date: '2024-06-15',
        startTime: new Date('2024-06-15T14:00:00Z'),
        endTime: new Date('2024-06-15T15:30:00Z'),
        durationSeconds: 5400,
        distanceMeters: 45000,
        elevationGainMeters: 600,
        dataSource: 'manual',
        fileFormat: 'fit',
        driveFileId: 'drive-existing',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await runMigration(db);

      expect(result.totalExamined).toBe(0); // Query doesn't match fully migrated docs
      expect(result.documentsChanged).toBe(0);
    });
  });

  describe('Partial legacy state', () => {
    it('should populate missing fields without touching existing ones', async () => {
      // Has status but missing template and date
      await db.collection('workouts').insertOne({
        userId: 'user-1',
        activityType: 'ride',
        status: 'completed',
        // template missing
        // date missing
        startTime: new Date('2024-06-15T14:00:00Z'),
        endTime: new Date('2024-06-15T15:30:00Z'),
        durationSeconds: 5400,
        distanceMeters: 45000,
        elevationGainMeters: 600,
        dataSource: 'manual',
        fileFormat: 'fit',
        driveFileId: 'drive-partial',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await runMigration(db);

      expect(result.documentsChanged).toBe(1);
      expect(result.statusPopulated).toBe(0); // Already had status
      expect(result.templatePopulated).toBe(1);
      expect(result.datePopulated).toBe(1);

      const doc = await db.collection('workouts').findOne({ userId: 'user-1' });
      expect(doc!.status).toBe('completed'); // Preserved
      expect(doc!.template).toBe(false); // Newly set
      expect(doc!.date).toBe('2024-06-15'); // Newly derived
    });
  });

  describe('Missing startTime', () => {
    it('should skip date for documents without startTime and report them', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1',
        activityType: 'ride',
        // No startTime
        durationSeconds: 3600,
        dataSource: 'manual',
        fileFormat: 'fit',
        driveFileId: 'drive-no-start',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await runMigration(db);

      expect(result.documentsChanged).toBe(1); // status + template still set
      expect(result.statusPopulated).toBe(1);
      expect(result.templatePopulated).toBe(1);
      expect(result.datePopulated).toBe(0); // No date derived
      expect(result.skippedMissingStartTime.length).toBe(1);

      const doc = await db.collection('workouts').findOne({ userId: 'user-1' });
      expect(doc!.status).toBe('completed');
      expect(doc!.template).toBe(false);
      expect(doc!.date).toBeUndefined(); // NOT fabricated
    });
  });

  describe('Idempotency', () => {
    it('should make no changes on second run', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1',
        activityType: 'ride',
        startTime: new Date('2024-06-15T14:00:00Z'),
        endTime: new Date('2024-06-15T15:30:00Z'),
        durationSeconds: 5400,
        distanceMeters: 45000,
        elevationGainMeters: 600,
        dataSource: 'manual',
        fileFormat: 'fit',
        driveFileId: 'drive-idem',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // First run
      const first = await runMigration(db);
      expect(first.documentsChanged).toBe(1);

      // Second run
      const second = await runMigration(db);
      expect(second.totalExamined).toBe(0);
      expect(second.documentsChanged).toBe(0);
    });
  });

  describe('Dry run', () => {
    it('should report intended changes without modifying documents', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1',
        activityType: 'ride',
        startTime: new Date('2024-06-15T14:00:00Z'),
        endTime: new Date('2024-06-15T15:30:00Z'),
        durationSeconds: 5400,
        distanceMeters: 45000,
        elevationGainMeters: 600,
        dataSource: 'manual',
        fileFormat: 'fit',
        driveFileId: 'drive-dry',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await runMigration(db, { dryRun: true });

      expect(result.documentsChanged).toBe(1);
      expect(result.statusPopulated).toBe(1);

      // Verify document was NOT actually modified
      const doc = await db.collection('workouts').findOne({ userId: 'user-1' });
      expect(doc!.status).toBeUndefined();
      expect(doc!.template).toBeUndefined();
      expect(doc!.date).toBeUndefined();
    });
  });

  describe('Failure isolation', () => {
    it('should continue processing after one document error', async () => {
      // Insert two documents — one valid, one will have userId issues
      const validId = new ObjectId();
      const problematicId = new ObjectId();

      await db.collection('workouts').insertMany([
        {
          _id: validId,
          userId: 'user-1',
          activityType: 'ride',
          startTime: new Date('2024-06-15T14:00:00Z'),
          endTime: new Date('2024-06-15T15:30:00Z'),
          durationSeconds: 5400,
          distanceMeters: 45000,
          elevationGainMeters: 600,
          dataSource: 'manual',
          fileFormat: 'fit',
          driveFileId: 'drive-valid',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          _id: problematicId,
          userId: 'user-2', // Different user — no settings, will use fallback
          activityType: 'ride',
          startTime: new Date('2024-06-16T14:00:00Z'),
          endTime: new Date('2024-06-16T15:30:00Z'),
          durationSeconds: 3600,
          distanceMeters: 30000,
          elevationGainMeters: 200,
          dataSource: 'manual',
          fileFormat: 'fit',
          driveFileId: 'drive-user2',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const result = await runMigration(db);

      // Both should succeed (user-2 uses fallback timezone)
      expect(result.documentsChanged).toBe(2);
      expect(result.errors.length).toBe(0);
    });
  });
});
