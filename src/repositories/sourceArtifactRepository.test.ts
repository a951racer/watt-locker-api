/**
 * PLAN-019 Tests: SourceArtifact repository — Collection, schema, indexes
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { MongoSourceArtifactRepository } from './sourceArtifactRepository';

describe('PLAN-019: MongoSourceArtifactRepository', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let repo: MongoSourceArtifactRepository;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();
    repo = new MongoSourceArtifactRepository(db);
    await repo.createIndexes();
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });
  beforeEach(async () => { await db.collection('sourceArtifacts').deleteMany({}); });

  const baseArtifact = {
    userId: 'user-1',
    source: 'manual' as const,
    format: 'fit' as const,
    originalFileName: 'morning_ride.fit',
    importedAt: new Date('2027-01-15T10:00:00Z'),
    driveFileId: 'drive-abc-123',
    startTime: new Date('2027-01-15T07:00:00Z'),
    durationSeconds: 5400,
    activityType: 'ride',
    activityId: 'activity-001',
    role: 'primary' as const,
    materialized: false,
  };

  describe('create', () => {
    it('should create a source artifact and return it with an id', async () => {
      const result = await repo.create(baseArtifact);
      expect(result.id).toBeDefined();
      expect(result.userId).toBe('user-1');
      expect(result.source).toBe('manual');
      expect(result.format).toBe('fit');
      expect(result.originalFileName).toBe('morning_ride.fit');
      expect(result.driveFileId).toBe('drive-abc-123');
      expect(result.activityId).toBe('activity-001');
      expect(result.role).toBe('primary');
      expect(result.materialized).toBe(false);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it('should store optional fields correctly', async () => {
      const result = await repo.create({
        ...baseArtifact,
        sourceActivityId: 'strava-12345',
        driveWebViewLink: 'https://drive.google.com/file/abc',
      });
      expect(result.sourceActivityId).toBe('strava-12345');
      expect(result.driveWebViewLink).toBe('https://drive.google.com/file/abc');
    });

    it('should support null activityId (unassociated artifact)', async () => {
      const result = await repo.create({ ...baseArtifact, activityId: null });
      expect(result.activityId).toBeNull();
    });
  });

  describe('findById', () => {
    it('should find an artifact by its id', async () => {
      const created = await repo.create(baseArtifact);
      const found = await repo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.userId).toBe('user-1');
      expect(found!.driveFileId).toBe('drive-abc-123');
    });

    it('should return null for non-existent id', async () => {
      const found = await repo.findById('000000000000000000000000');
      expect(found).toBeNull();
    });

    it('should return null for invalid ObjectId', async () => {
      const found = await repo.findById('not-valid');
      expect(found).toBeNull();
    });
  });

  describe('findByActivityId', () => {
    it('should find artifacts by user and activity', async () => {
      await repo.create({ ...baseArtifact, activityId: 'act-A', role: 'primary' });
      await repo.create({ ...baseArtifact, activityId: 'act-A', role: 'secondary' });
      await repo.create({ ...baseArtifact, activityId: 'act-B', role: 'primary' });

      const results = await repo.findByActivityId('user-1', 'act-A');
      expect(results).toHaveLength(2);
    });

    it('should not return artifacts belonging to another user', async () => {
      await repo.create({ ...baseArtifact, userId: 'user-2', activityId: 'act-A', role: 'primary' });
      const results = await repo.findByActivityId('user-1', 'act-A');
      expect(results).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('should update role', async () => {
      const created = await repo.create({ ...baseArtifact, activityId: 'act-X', role: 'secondary' });
      const updated = await repo.update(created.id, { role: 'primary' });
      expect(updated.role).toBe('primary');
    });

    it('should update activityId', async () => {
      const created = await repo.create({ ...baseArtifact, activityId: null, role: 'secondary' });
      const updated = await repo.update(created.id, { activityId: 'act-new' });
      expect(updated.activityId).toBe('act-new');
    });

    it('should update materialized', async () => {
      const created = await repo.create(baseArtifact);
      const updated = await repo.update(created.id, { materialized: true });
      expect(updated.materialized).toBe(true);
    });

    it('should update updatedAt timestamp', async () => {
      const created = await repo.create(baseArtifact);
      await new Promise(r => setTimeout(r, 10));
      const updated = await repo.update(created.id, { materialized: true });
      expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    });

    it('should throw for non-existent artifact', async () => {
      await expect(repo.update('000000000000000000000000', { materialized: true }))
        .rejects.toThrow('Source artifact not found');
    });
  });

  describe('indexes', () => {
    it('should have userId + activityId index', async () => {
      const indexes = await db.collection('sourceArtifacts').indexes();
      const idx = indexes.find(i => i.key?.userId === 1 && i.key?.activityId === 1);
      expect(idx).toBeDefined();
    });

    it('should have userId + startTime + durationSeconds index', async () => {
      const indexes = await db.collection('sourceArtifacts').indexes();
      const idx = indexes.find(i => i.key?.userId === 1 && i.key?.startTime === 1 && i.key?.durationSeconds === 1);
      expect(idx).toBeDefined();
    });

    it('should have partial unique index on activityId + role (primary only)', async () => {
      const indexes = await db.collection('sourceArtifacts').indexes();
      const idx = indexes.find(i => i.key?.activityId === 1 && i.key?.role === 1 && i.unique === true);
      expect(idx).toBeDefined();
      expect(idx!.partialFilterExpression).toEqual({ role: 'primary', activityId: { $type: 'string' } });
    });

    it('should be idempotent — calling createIndexes twice is safe', async () => {
      await repo.createIndexes();
      const indexes = await db.collection('sourceArtifacts').indexes();
      // _id + 3 custom = 4
      expect(indexes.length).toBe(4);
    });
  });

  describe('Primary uniqueness constraint', () => {
    it('should REJECT two primary artifacts for the same Activity', async () => {
      await repo.create({ ...baseArtifact, activityId: 'act-dup', role: 'primary' });
      await expect(
        repo.create({ ...baseArtifact, activityId: 'act-dup', role: 'primary', originalFileName: 'second.fit' })
      ).rejects.toThrow();
    });

    it('should ALLOW primary + secondary for the same Activity', async () => {
      await repo.create({ ...baseArtifact, activityId: 'act-mix', role: 'primary' });
      const secondary = await repo.create({ ...baseArtifact, activityId: 'act-mix', role: 'secondary' });
      expect(secondary.id).toBeDefined();
      expect(secondary.role).toBe('secondary');
    });

    it('should ALLOW multiple secondaries for the same Activity', async () => {
      await repo.create({ ...baseArtifact, activityId: 'act-multi', role: 'secondary', originalFileName: 'a.fit' });
      const second = await repo.create({ ...baseArtifact, activityId: 'act-multi', role: 'secondary', originalFileName: 'b.fit' });
      expect(second.id).toBeDefined();
    });

    it('should ALLOW primary artifacts for different Activities', async () => {
      await repo.create({ ...baseArtifact, activityId: 'act-X', role: 'primary' });
      const second = await repo.create({ ...baseArtifact, activityId: 'act-Y', role: 'primary' });
      expect(second.id).toBeDefined();
    });

    it('should ALLOW multiple primaries with null activityId (unassociated)', async () => {
      await repo.create({ ...baseArtifact, activityId: null, role: 'primary', originalFileName: 'a.fit' });
      const second = await repo.create({ ...baseArtifact, activityId: null, role: 'primary', originalFileName: 'b.fit' });
      expect(second.id).toBeDefined();
    });
  });

  describe('PLAN-051: user isolation', () => {
    it('findDuplicateCandidate must not return another user artifact with the same signature', async () => {
      await repo.create({
        ...baseArtifact,
        userId: 'user-A',
        activityId: 'act-A',
        startTime: new Date('2027-04-01T07:00:00Z'),
        durationSeconds: 3600,
      });

      // User-B searches for the same (startTime, duration) signature
      const found = await repo.findDuplicateCandidate('user-B', new Date('2027-04-01T07:00:00Z'), 3600);
      expect(found).toBeNull();

      // Same-user lookup still finds it
      const foundOwn = await repo.findDuplicateCandidate('user-A', new Date('2027-04-01T07:00:00Z'), 3600);
      expect(foundOwn).not.toBeNull();
      expect(foundOwn!.userId).toBe('user-A');
    });

    it('disassociateByActivityId must not touch another user artifacts sharing an activityId', async () => {
      // Two users each hold a secondary artifact under the same activityId string.
      // (The partial-unique index only constrains role='primary', so secondaries
      // can legitimately share an activityId. This isolates the userId-scoping of
      // disassociateByActivityId from the primary-uniqueness constraint.)
      const artA = await repo.create({ ...baseArtifact, userId: 'user-A', activityId: 'shared-id', role: 'secondary', originalFileName: 'a.fit' });
      const artB = await repo.create({ ...baseArtifact, userId: 'user-B', activityId: 'shared-id', role: 'secondary', originalFileName: 'b.fit' });

      // User-A disassociates their own — must only affect user-A's artifact
      const modified = await repo.disassociateByActivityId('user-A', 'shared-id');
      expect(modified).toBe(1);

      const afterA = await repo.findById(artA.id);
      expect(afterA!.activityId).toBeNull();

      const afterB = await repo.findById(artB.id);
      expect(afterB!.activityId).toBe('shared-id'); // untouched
    });

    it('disassociateByActivityId with a foreign userId modifies nothing', async () => {
      await repo.create({ ...baseArtifact, userId: 'user-A', activityId: 'act-A', role: 'primary' });
      const modified = await repo.disassociateByActivityId('user-B', 'act-A');
      expect(modified).toBe(0);
    });
  });
});
