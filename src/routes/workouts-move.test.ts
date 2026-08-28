/**
 * PLAN-011 Tests: PUT /api/workouts/:id/move — Move Activity to different date
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

function getTodayInTimezone(timezone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

function getDateOffsetInTimezone(timezone: string, dayOffset: number): string {
  const now = new Date();
  now.setDate(now.getDate() + dayOffset);
  return now.toLocaleDateString('en-CA', { timeZone: timezone });
}

describe('PLAN-011: PUT /api/workouts/:id/move — Move Activity', () => {
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

  async function createPlanned(date?: string, overrides?: Record<string, unknown>) {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
      date: date ?? getDateOffsetInTimezone(TEST_TIMEZONE, 1),
      title: 'Planned Ride', plannedDurationSeconds: 3600, plannedDistanceMeters: 40000,
      description: 'Interval session',
      createdAt: new Date(), updatedAt: new Date(),
      ...overrides,
    });
    return result.insertedId.toHexString();
  }

  async function createSkipped(date?: string) {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'cycling', status: 'skipped', template: false,
      date: date ?? getDateOffsetInTimezone(TEST_TIMEZONE, -2),
      title: 'Skipped Ride', plannedDurationSeconds: 3600, plannedDistanceMeters: 30000,
      description: 'Recovery spin',
      createdAt: new Date(), updatedAt: new Date(),
    });
    return result.insertedId.toHexString();
  }

  async function createCompleted() {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
      date: '2026-08-10',
      startTime: new Date('2026-08-10T14:00:00Z'), endTime: new Date('2026-08-10T15:30:00Z'),
      durationSeconds: 5400, distanceMeters: 45000,
      title: 'Completed Ride',
      createdAt: new Date(), updatedAt: new Date(),
    });
    return result.insertedId.toHexString();
  }

  describe('Planned Activity', () => {
    it('should move planned Activity to a past date', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: '2020-01-15' });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe('2020-01-15');
      expect(res.body.data.status).toBe('planned');
    });

    it('should move planned Activity to today', async () => {
      const today = getTodayInTimezone(TEST_TIMEZONE);
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: today });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe(today);
      expect(res.body.data.status).toBe('planned');
    });

    it('should move planned Activity to a future date', async () => {
      const future = getDateOffsetInTimezone(TEST_TIMEZONE, 10);
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: future });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe(future);
      expect(res.body.data.status).toBe('planned');
    });

    it('should allow same-date move on planned Activity', async () => {
      const date = getDateOffsetInTimezone(TEST_TIMEZONE, 3);
      const id = await createPlanned(date);
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe(date);
      expect(res.body.data.status).toBe('planned');
    });
  });

  describe('Skipped Activity', () => {
    it('should move skipped Activity to past date — remains skipped', async () => {
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: '2020-03-01' });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe('2020-03-01');
      expect(res.body.data.status).toBe('skipped');
    });

    it('should move skipped Activity to today — becomes planned', async () => {
      const today = getTodayInTimezone(TEST_TIMEZONE);
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: today });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe(today);
      expect(res.body.data.status).toBe('planned');
    });

    it('should move skipped Activity to future date — becomes planned', async () => {
      const future = getDateOffsetInTimezone(TEST_TIMEZONE, 5);
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: future });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe(future);
      expect(res.body.data.status).toBe('planned');
    });

    it('should move skipped Activity to yesterday — remains skipped', async () => {
      const yesterday = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: yesterday });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe(yesterday);
      expect(res.body.data.status).toBe('skipped');
    });
  });

  describe('Completed Activity — rejected', () => {
    it('should REJECT move on completed Activity (400)', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: '2026-12-01' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toContain('Completed');
    });

    it('should not modify completed Activity date or status', async () => {
      const id = await createCompleted();
      await request(app).put(`/api/workouts/${id}/move`).send({ date: '2026-12-01' });
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(id) });
      expect(doc!.date).toBe('2026-08-10');
      expect(doc!.status).toBe('completed');
    });
  });

  describe('Template — rejected', () => {
    it('should REJECT move on a template (400)', async () => {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', template: true,
        title: 'Template Ride',
        createdAt: new Date(), updatedAt: new Date(),
      });
      const id = result.insertedId.toHexString();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: '2026-10-01' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toContain('Templates');
    });
  });

  describe('Timezone', () => {
    it('should use user timezone for skipped date comparison', async () => {
      // Set user to Pacific/Auckland (UTC+12/+13)
      await settingsRepo.upsert('user-1', { timezone: 'Pacific/Auckland' });
      const todayNZ = getTodayInTimezone('Pacific/Auckland');
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: todayNZ });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('planned');
      // Restore timezone
      await settingsRepo.upsert('user-1', { timezone: TEST_TIMEZONE });
    });

    it('should not timezone-convert the requested date', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: '2026-09-15' });
      expect(res.status).toBe(200);
      // The stored date must be exactly the requested date, not timezone-shifted
      expect(res.body.data.date).toBe('2026-09-15');
    });
  });

  describe('Ownership', () => {
    it('should reject move for Activity belonging to another user', async () => {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-2', activityType: 'ride', status: 'planned', template: false,
        date: '2026-09-15', createdAt: new Date(), updatedAt: new Date(),
      });
      const id = result.insertedId.toHexString();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: '2026-10-01' });
      expect(res.status).toBe(404);
    });

    it('should return 404 for nonexistent Activity', async () => {
      const res = await request(app).put('/api/workouts/000000000000000000000000/move').send({ date: '2026-10-01' });
      expect(res.status).toBe(404);
    });

    it('should return 404 for invalid ObjectId', async () => {
      const res = await request(app).put('/api/workouts/not-valid-id/move').send({ date: '2026-10-01' });
      expect(res.status).toBe(404);
    });
  });

  describe('Validation', () => {
    it('should reject missing date', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({});
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('date');
    });

    it('should reject malformed date', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: '09/15/2026' });
      expect(res.status).toBe(400);
    });

    it('should reject impossible calendar date (Feb 30)', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: '2026-02-30' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toContain('valid calendar date');
    });

    it('should reject non-string date', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: 20260915 });
      expect(res.status).toBe(400);
    });

    it('should reject null date', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: null });
      expect(res.status).toBe(400);
    });

    it('should reject empty string date', async () => {
      const id = await createPlanned();
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('Preservation — unrelated fields unchanged', () => {
    it('should preserve title, description, activityType, planned values on planned move', async () => {
      const id = await createPlanned(getDateOffsetInTimezone(TEST_TIMEZONE, 1), {
        title: 'VO2 Intervals',
        description: 'Hard intervals',
        activityType: 'cycling',
        plannedDurationSeconds: 5400,
        plannedDistanceMeters: 50000,
      });
      const newDate = getDateOffsetInTimezone(TEST_TIMEZONE, 7);
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: newDate });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe(newDate);
      expect(res.body.data.title).toBe('VO2 Intervals');
      expect(res.body.data.description).toBe('Hard intervals');
      expect(res.body.data.activityType).toBe('cycling');
      expect(res.body.data.plannedDurationSeconds).toBe(5400);
      expect(res.body.data.plannedDistanceMeters).toBe(50000);
      expect(res.body.data.status).toBe('planned');
    });

    it('should preserve title and planned values when skipped → planned via move', async () => {
      const id = await createSkipped(getDateOffsetInTimezone(TEST_TIMEZONE, -3));
      const future = getDateOffsetInTimezone(TEST_TIMEZONE, 2);
      const res = await request(app).put(`/api/workouts/${id}/move`).send({ date: future });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Skipped Ride');
      expect(res.body.data.description).toBe('Recovery spin');
      expect(res.body.data.plannedDurationSeconds).toBe(3600);
      expect(res.body.data.plannedDistanceMeters).toBe(30000);
      expect(res.body.data.status).toBe('planned');
      expect(res.body.data.date).toBe(future);
    });
  });
});
