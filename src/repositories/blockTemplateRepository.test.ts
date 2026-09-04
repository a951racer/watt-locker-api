/**
 * PLAN-058: MongoBlockTemplateRepository persistence tests.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { MongoBlockTemplateRepository } from './blockTemplateRepository';
import { PlanSegment } from '../models/workout';

const warmup: PlanSegment = { name: 'Warm Up', type: 'warmup', durationType: 'time', durationSeconds: 300, intensityMetric: 'power_ftp', powerMin: 55, powerMax: 65 };
const work: PlanSegment = { name: 'Sweet Spot', type: 'interval', durationType: 'time', durationSeconds: 600, intensityMetric: 'power_ftp', powerMin: 88, powerMax: 92 };
const recovery: PlanSegment = { type: 'recovery', durationType: 'time', durationSeconds: 180, intensityMetric: 'power_ftp', powerMin: 45, powerMax: 55 };
const distanceStep: PlanSegment = { type: 'interval', durationType: 'distance', distanceMeters: 8047, intensityMetric: 'power_ftp', powerMin: 90, powerMax: 95 };

describe('MongoBlockTemplateRepository', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let repo: MongoBlockTemplateRepository;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db('test');
    repo = new MongoBlockTemplateRepository(db);
    await repo.createIndexes();
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await db.collection('blockTemplates').deleteMany({});
  });

  it('creates a Block Template with id, repeatCount, ordered steps, timestamps', async () => {
    const created = await repo.create('user-1', { name: '3x Sweet Spot', repeatCount: 3, steps: [warmup, work, recovery] });
    expect(created.id).toBeTruthy();
    expect(created.userId).toBe('user-1');
    expect(created.name).toBe('3x Sweet Spot');
    expect(created.repeatCount).toBe(3);
    expect(created.steps).toHaveLength(3);
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('preserves step ordering', async () => {
    const created = await repo.create('user-1', { name: 'B', repeatCount: 2, steps: [warmup, work, recovery] });
    const found = await repo.findById(created.id);
    expect(found!.steps.map((s) => s.type)).toEqual(['warmup', 'interval', 'recovery']);
    expect(found!.steps[1].name).toBe('Sweet Spot');
  });

  it('persists repeatCount', async () => {
    const created = await repo.create('user-1', { name: 'B', repeatCount: 5, steps: [work] });
    expect((await repo.findById(created.id))!.repeatCount).toBe(5);
  });

  it('persists time and distance steps', async () => {
    const created = await repo.create('user-1', { name: 'Mixed', repeatCount: 1, steps: [work, distanceStep] });
    const found = await repo.findById(created.id);
    expect(found!.steps[0].durationType).toBe('time');
    expect(found!.steps[0].durationSeconds).toBe(600);
    expect(found!.steps[1].durationType).toBe('distance');
    expect(found!.steps[1].distanceMeters).toBe(8047);
  });

  it('persists multiple steps and stores NO nested block structure', async () => {
    const created = await repo.create('user-1', { name: 'Multi', repeatCount: 2, steps: [warmup, work, recovery] });
    const raw = await db.collection('blockTemplates').findOne({ name: 'Multi' });
    expect(raw).not.toBeNull();
    void created;
    // steps is a flat array; no element contains its own `steps`/nested block.
    for (const s of (raw as unknown as { steps: Record<string, unknown>[] }).steps) {
      expect(s.steps).toBeUndefined();
      expect(s.blocks).toBeUndefined();
    }
  });

  it('returns null for invalid/missing id', async () => {
    expect(await repo.findById('nope')).toBeNull();
    expect(await repo.findById('507f1f77bcf86cd799439011')).toBeNull();
  });

  it('lists only the user\'s own templates, updatedAt DESC', async () => {
    const a = await repo.create('user-1', { name: 'First', repeatCount: 1, steps: [work] });
    await new Promise((r) => setTimeout(r, 5));
    const b = await repo.create('user-1', { name: 'Second', repeatCount: 1, steps: [work] });
    await repo.create('user-2', { name: 'Other', repeatCount: 1, steps: [work] });

    const list = await repo.listByUser('user-1');
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it('user ownership isolation: user-2 sees none of user-1\'s templates', async () => {
    await repo.create('user-1', { name: 'Mine', repeatCount: 1, steps: [work] });
    expect(await repo.listByUser('user-2')).toHaveLength(0);
  });

  it('updates name/repeatCount/steps', async () => {
    const created = await repo.create('user-1', { name: 'Old', repeatCount: 2, steps: [work] });
    const updated = await repo.update(created.id, { name: 'New', repeatCount: 4, steps: [warmup, work] });
    expect(updated!.name).toBe('New');
    expect(updated!.repeatCount).toBe(4);
    expect(updated!.steps).toHaveLength(2);
  });

  it('deletes a template', async () => {
    const created = await repo.create('user-1', { name: 'Temp', repeatCount: 1, steps: [work] });
    expect(await repo.delete(created.id)).toBe(true);
    expect(await repo.findById(created.id)).toBeNull();
  });

  it('independence: block template ops never touch the workouts or stepTemplates collections', async () => {
    await db.collection('workouts').insertOne({ userId: 'user-1', activityType: 'ride' });
    await db.collection('stepTemplates').insertOne({ userId: 'user-1', name: 'Sweet Spot', step: work });

    const created = await repo.create('user-1', { name: 'X', repeatCount: 2, steps: [work] });
    await repo.update(created.id, { name: 'Y' });
    await repo.delete(created.id);

    expect(await db.collection('workouts').countDocuments({})).toBe(1);
    expect(await db.collection('stepTemplates').countDocuments({})).toBe(1);
    // Block template doc carries no activity / step-template reference.
    const b = await repo.create('user-1', { name: 'Z', repeatCount: 1, steps: [work] });
    const raw = await db.collection('blockTemplates').findOne({ userId: 'user-1', name: 'Z' }) as Record<string, unknown>;
    expect(raw.activityId).toBeUndefined();
    expect(raw.stepTemplateId).toBeUndefined();
    for (const s of raw.steps as Record<string, unknown>[]) {
      expect(s.stepTemplateId).toBeUndefined();
    }
    expect(b.steps[0]).toEqual(work);
  });
});
