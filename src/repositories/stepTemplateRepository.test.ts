/**
 * PLAN-057: MongoStepTemplateRepository persistence tests.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { MongoStepTemplateRepository } from './stepTemplateRepository';
import { PlanSegment } from '../models/workout';

const timeStep: PlanSegment = {
  name: 'Sweet Spot',
  type: 'interval',
  durationType: 'time',
  durationSeconds: 600,
  intensityMetric: 'power_ftp',
  powerMin: 88,
  powerMax: 92,
};

const distanceStep: PlanSegment = {
  type: 'interval',
  durationType: 'distance',
  distanceMeters: 8047,
  intensityMetric: 'power_ftp',
  powerMin: 90,
  powerMax: 95,
};

describe('MongoStepTemplateRepository', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let repo: MongoStepTemplateRepository;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db('test');
    repo = new MongoStepTemplateRepository(db);
    await repo.createIndexes();
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await db.collection('stepTemplates').deleteMany({});
  });

  it('creates a Step Template and returns a record with id + timestamps', async () => {
    const created = await repo.create('user-1', { name: 'Sweet Spot 10', step: timeStep });
    expect(created.id).toBeTruthy();
    expect(created.userId).toBe('user-1');
    expect(created.name).toBe('Sweet Spot 10');
    expect(created.step).toEqual(timeStep);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('reads a Step Template by id', async () => {
    const created = await repo.create('user-1', { name: 'A', step: timeStep });
    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.step).toEqual(timeStep);
  });

  it('returns null for a non-existent / invalid id', async () => {
    expect(await repo.findById('not-a-valid-objectid')).toBeNull();
    expect(await repo.findById('507f1f77bcf86cd799439011')).toBeNull();
  });

  it('persists canonical step data including distance steps', async () => {
    const created = await repo.create('user-1', { name: 'Distance', step: distanceStep });
    const found = await repo.findById(created.id);
    expect(found!.step.durationType).toBe('distance');
    expect(found!.step.distanceMeters).toBe(8047);
    expect(found!.step.durationSeconds).toBeUndefined();
  });

  it('lists only a user\'s own templates, most-recently-updated first', async () => {
    const a = await repo.create('user-1', { name: 'First', step: timeStep });
    await new Promise((r) => setTimeout(r, 5));
    const b = await repo.create('user-1', { name: 'Second', step: timeStep });
    await repo.create('user-2', { name: 'Other user', step: timeStep });

    const list = await repo.listByUser('user-1');
    expect(list).toHaveLength(2);
    // updatedAt DESC → most recent (b) first
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
    expect(list.every((t) => t.userId === 'user-1')).toBe(true);
  });

  it('updates name and step and bumps updatedAt', async () => {
    const created = await repo.create('user-1', { name: 'Old', step: timeStep });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await repo.update(created.id, { name: 'New', step: distanceStep });
    expect(updated!.name).toBe('New');
    expect(updated!.step).toEqual(distanceStep);
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('deletes a template', async () => {
    const created = await repo.create('user-1', { name: 'Temp', step: timeStep });
    expect(await repo.delete(created.id)).toBe(true);
    expect(await repo.findById(created.id)).toBeNull();
  });

  it('user ownership isolation: user-2 cannot see user-1 templates in a list', async () => {
    await repo.create('user-1', { name: 'Mine', step: timeStep });
    const list = await repo.listByUser('user-2');
    expect(list).toHaveLength(0);
  });

  it('independence: creating/updating/deleting a step template never touches the workouts collection', async () => {
    // Seed a fake activity document to prove it is unaffected.
    await db.collection('workouts').insertOne({ userId: 'user-1', activityType: 'ride', template: false });

    const created = await repo.create('user-1', { name: 'X', step: timeStep });
    await repo.update(created.id, { name: 'Y' });
    await repo.delete(created.id);

    const workoutCount = await db.collection('workouts').countDocuments({});
    expect(workoutCount).toBe(1); // untouched
    // And the step template document carries NO activity reference field.
    const anotherStep = await repo.create('user-1', { name: 'Z', step: timeStep });
    const rawDoc = await db.collection('stepTemplates').findOne({ userId: 'user-1', name: 'Z' });
    expect(rawDoc).not.toBeNull();
    expect((rawDoc as Record<string, unknown>).activityId).toBeUndefined();
    expect((rawDoc as Record<string, unknown>).workoutId).toBeUndefined();
    expect(anotherStep.step).toEqual(timeStep);
  });
});
