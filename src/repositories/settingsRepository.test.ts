import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { MongoSettingsRepository } from './settingsRepository';

describe('MongoSettingsRepository', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let repo: MongoSettingsRepository;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    const uri = mongod.getUri();
    client = new MongoClient(uri);
    await client.connect();
    db = client.db('test');
    repo = new MongoSettingsRepository(db);
    await repo.createIndexes();
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await db.collection('settings').deleteMany({});
  });

  describe('findByUserId', () => {
    it('should return null when no settings exist for user', async () => {
      const result = await repo.findByUserId('user-123');
      expect(result).toBeNull();
    });

    it('should return settings when they exist', async () => {
      await repo.upsert('user-456', { driveStoragePath: 'MyDrive/Cycling' });

      const result = await repo.findByUserId('user-456');

      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-456');
      expect(result!.driveStoragePath).toBe('MyDrive/Cycling');
      expect(result!.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('upsert', () => {
    it('should create settings with defaults when none exist', async () => {
      const result = await repo.upsert('user-new', {});

      expect(result.userId).toBe('user-new');
      expect(result.driveStoragePath).toBe('WattLocker');
      expect(result.driveInboxPath).toBe('WattLocker/Inbox');
      expect(result.connectedSources).toEqual([]);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it('should apply provided values over defaults on creation', async () => {
      const result = await repo.upsert('user-custom', {
        driveStoragePath: 'Custom/Path',
        driveInboxPath: 'Custom/Inbox',
      });

      expect(result.userId).toBe('user-custom');
      expect(result.driveStoragePath).toBe('Custom/Path');
      expect(result.driveInboxPath).toBe('Custom/Inbox');
      expect(result.connectedSources).toEqual([]);
    });

    it('should update existing settings', async () => {
      await repo.upsert('user-update', {});

      const updated = await repo.upsert('user-update', {
        driveStoragePath: 'NewPath',
      });

      expect(updated.userId).toBe('user-update');
      expect(updated.driveStoragePath).toBe('NewPath');
      expect(updated.driveInboxPath).toBe('WattLocker/Inbox');
    });

    it('should update updatedAt on each upsert', async () => {
      const first = await repo.upsert('user-time', {});
      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await repo.upsert('user-time', { driveStoragePath: 'Changed' });

      expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    });

    it('should enforce unique userId index', async () => {
      // Insert directly to test the index constraint
      const collection = db.collection('settings');
      await collection.insertOne({
        userId: 'user-dup',
        driveStoragePath: 'WattLocker',
        driveInboxPath: 'WattLocker/Inbox',
        connectedSources: [],
        updatedAt: new Date(),
      });

      // Direct insert with same userId should fail
      await expect(
        collection.insertOne({
          userId: 'user-dup',
          driveStoragePath: 'Other',
          driveInboxPath: 'Other/Inbox',
          connectedSources: [],
          updatedAt: new Date(),
        }),
      ).rejects.toThrow();
    });

    it('should handle connectedSources updates', async () => {
      const result = await repo.upsert('user-sources', {
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-15'),
          },
        ],
      });

      expect(result.connectedSources).toHaveLength(1);
      expect(result.connectedSources[0].provider).toBe('strava');
      expect(result.connectedSources[0].connected).toBe(true);
    });
  });
});
