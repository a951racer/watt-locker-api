/**
 * PLAN-010 Tests: PUT /api/workouts/:id/status — Activity lifecycle transitions
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import express from 'express';
import request from 'supertest';
import { createWorkoutsRouter } from './workouts';
import { WorkoutService } from '../services/workoutService';
import { MongoWorkoutRepository } from '../repositories/workoutRepository';
import { SettingsService } from '../services/settingsService';
import { MongoSettingsRepository } from '../repositories/settingsRepository';
import { errorHandler } from '../middleware/errorHandler';

const mockUploadService = { uploadFile: jest.fn(), uploadSingle: jest.fn(), uploadBulk: jest.fn(), ingestFromInbox: jest.fn() } as any;
const fakeAuthMiddleware: express.RequestHandler = (req, _res, next) => {
  (req as any).user = { userId: 'user-1', email: 'test@test.com' };
  next();
};

/**
 * Get today's date string (YYYY-MM-DD) in a given timezone.
 */
function getTodayInTimezone(timezone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

/**
 * Get a date string N days offset from today in a given timezone.
 */
function getDateOffsetInTimezone(timezone: string, dayOffset: number): string {
  const now = new Date();
  now.setDate(now.getDate() + dayOffset);
  return now.toLocaleDateString('en-CA', { timeZone: timezone });
}

describe('PLAN-010: PUT /api/workouts/:id/status — Lifecycle transitions', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Application;
  let repo: MongoWorkoutRepository;
  let settingsRepo: MongoSettingsRepository;

  const TEST_TIMEZONE = 'America/Chicago';

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();
    repo = new MongoWorkoutRepository(db);
    await repo.createIndexes();
    settingsRepo = new MongoSettingsRepository(db);
    const workoutService = new WorkoutService(repo, { store: jest.fn(), retrieve: jest.fn(), delete: jest.fn(), listFiles: jest.fn(), removeFromFolder: jest.fn() } as any);
    const settingsService = new SettingsService(settingsRepo);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).correlationId = 'test'; next(); });
    app.use('/api/workouts', createWorkoutsRouter(workoutService, mockUploadService, fakeAuthMiddleware, settingsService, repo));
    app.use(errorHandler);

    // Create user settings with timezone
    await settingsRepo.upsert('user-1', { timezone: TEST_TIMEZONE });
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });
  beforeEach(async () => { await db.collection('workouts').deleteMany({}); });

  // Helper: create a planned Activity
  async function createPlanned(overrides?: Record<string, unknown>) {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
      date: getDateOffsetInTimezone(TEST_TIMEZONE, 1), // tomorrow by default
      title: 'Planned Ride', plannedDurationSeconds: 3600,
      createdAt: new Date(), updatedAt: new Date(),
      ...overrides,
    });
    return result.insertedId.toHexString();
  }

  // Helper: create a completed Activity
  async function createCompleted(overrides?: Record<string, unknown>) {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
      date: '2026-08-10',
      startTime: new Date('2026-08-10T14:00:00Z'), endTime: new Date('2026-08-10T15:30:00Z'),
      durationSeconds: 5400, distanceMeters: 45000,
      avgPowerWatts: 220, normalizedPowerWatts: 235, tss: 75,
      title: 'Completed Ride',
      createdAt: new Date(), updatedAt: new Date(),
      ...overrides,
    });
    return result.insertedId.toHexString();
  }

  // Helper: create a skipped Activity
  async function createSkipped(date?: string) {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'cycling', status: 'skipped', template: false,
      date: date ?? getDateOffsetInTimezone(TEST_TIMEZONE, 1), // tomorrow by default
      title: 'Skipped Ride', plannedDurationSeconds: 3600, plannedDistanceMeters: 30000,
      createdAt: new Date(), updatedAt: new Date(),
    });
    return result.insertedId.toHexString();
  }

  describe('Valid transitions', () => {
    it('should transition planned → completed', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'completed' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('completed');
    });

    it('should transition planned → skipped', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'skipped' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('skipped');
    });

    it('should transition skipped → planned when date is today', async () => {
      const today = getTodayInTimezone(TEST_TIMEZONE);
      const id = await createSkipped(today);
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'planned' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('planned');
    });

    it('should transition skipped → planned when date is future', async () => {
      const future = getDateOffsetInTimezone(TEST_TIMEZONE, 3);
      const id = await createSkipped(future);
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'planned' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('planned');
    });

    it('should transition skipped → completed', async () => {
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'completed' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('completed');
    });
  });

  describe('Invalid transitions', () => {
    it('should REJECT completed → planned (400)', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'planned' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('status');
      expect(res.body.errors[0].message).toContain('not allowed');
    });

    it('should REJECT completed → skipped (400)', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'skipped' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('status');
    });

    it('should REJECT same-status transition (planned → planned)', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'planned' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toContain('already in status');
    });

    it('should REJECT same-status transition (completed → completed)', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'completed' });
      expect(res.status).toBe(400);
    });

    it('should REJECT same-status transition (skipped → skipped)', async () => {
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'skipped' });
      expect(res.status).toBe(400);
    });
  });

  describe('Timezone-aware skipped → planned date rule', () => {
    it('should REJECT skipped → planned when date is yesterday', async () => {
      const yesterday = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      const id = await createSkipped(yesterday);
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'planned' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toContain('before today');
    });

    it('should REJECT skipped → planned when date is far in the past', async () => {
      const id = await createSkipped('2020-01-01');
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'planned' });
      expect(res.status).toBe(400);
    });

    it('should use user timezone for date comparison', async () => {
      // Set a distinct timezone for this test to verify it's used
      await settingsRepo.upsert('user-1', { timezone: 'Pacific/Auckland' });
      const todayNZ = getTodayInTimezone('Pacific/Auckland');
      const id = await createSkipped(todayNZ);
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'planned' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('planned');
      // Restore timezone
      await settingsRepo.upsert('user-1', { timezone: TEST_TIMEZONE });
    });
  });

  describe('Input validation', () => {
    it('should reject missing status field', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({});
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('status');
    });

    it('should reject null status', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: null });
      expect(res.status).toBe(400);
    });

    it('should reject empty string status', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: '' });
      expect(res.status).toBe(400);
    });

    it('should reject invalid status value', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'archived' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toContain('Invalid status');
    });

    it('should reject non-string status', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 123 });
      expect(res.status).toBe(400);
    });
  });

  describe('Ownership', () => {
    it('should reject transition for Activity belonging to another user', async () => {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-2', activityType: 'ride', status: 'planned', template: false,
        date: '2026-09-15', createdAt: new Date(), updatedAt: new Date(),
      });
      const id = result.insertedId.toHexString();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'completed' });
      expect(res.status).toBe(404);
    });

    it('should return 404 for nonexistent Activity', async () => {
      const res = await request(app).put('/api/workouts/000000000000000000000000/status').send({ status: 'completed' });
      expect(res.status).toBe(404);
    });

    it('should return 404 for invalid ObjectId', async () => {
      const res = await request(app).put('/api/workouts/not-valid-id/status').send({ status: 'completed' });
      expect(res.status).toBe(404);
    });
  });

  describe('Template protection', () => {
    it('should REJECT transition on a template', async () => {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', template: true,
        title: 'Template Ride', plannedDurationSeconds: 3600,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const id = result.insertedId.toHexString();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'completed' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toContain('Templates');
    });
  });

  describe('Preservation — only status changes', () => {
    it('should preserve date when transitioning planned → skipped', async () => {
      const date = getDateOffsetInTimezone(TEST_TIMEZONE, 2);
      const id = await createPlanned({ date, title: 'Preserve Test', plannedDurationSeconds: 7200 });
      await request(app).put(`/api/workouts/${id}/status`).send({ status: 'skipped' });
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(id) });
      expect(doc!.date).toBe(date);
      expect(doc!.title).toBe('Preserve Test');
      expect(doc!.plannedDurationSeconds).toBe(7200);
      expect(doc!.status).toBe('skipped');
    });

    it('should preserve all fields when transitioning planned → completed', async () => {
      const date = getDateOffsetInTimezone(TEST_TIMEZONE, 1);
      const id = await createPlanned({
        date,
        title: 'Full Preserve',
        plannedDurationSeconds: 5400,
        plannedDistanceMeters: 40000,
        activityType: 'cycling',
      });
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'completed' });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe(date);
      expect(res.body.data.title).toBe('Full Preserve');
      expect(res.body.data.plannedDurationSeconds).toBe(5400);
      expect(res.body.data.plannedDistanceMeters).toBe(40000);
      expect(res.body.data.activityType).toBe('cycling');
      expect(res.body.data.status).toBe('completed');
    });

    it('should preserve date when transitioning skipped → planned', async () => {
      const today = getTodayInTimezone(TEST_TIMEZONE);
      const id = await createSkipped(today);
      await request(app).put(`/api/workouts/${id}/status`).send({ status: 'planned' });
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(id) });
      expect(doc!.date).toBe(today);
      expect(doc!.title).toBe('Skipped Ride');
      expect(doc!.plannedDurationSeconds).toBe(3600);
      expect(doc!.plannedDistanceMeters).toBe(30000);
      expect(doc!.status).toBe('planned');
    });

    it('should not create completion data when transitioning planned → completed', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/status`).send({ status: 'completed' });
      expect(res.status).toBe(200);
      // No actual data should be created
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(id) });
      expect(doc!.durationSeconds).toBeUndefined();
      expect(doc!.distanceMeters).toBeUndefined();
      expect(doc!.startTime).toBeUndefined();
      expect(doc!.endTime).toBeUndefined();
      expect(doc!.avgPowerWatts).toBeUndefined();
    });
  });
});
