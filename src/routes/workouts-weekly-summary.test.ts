/**
 * PLAN-014 Tests: GET /api/workouts/weekly-summary — Weekly TSS rollup
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

describe('PLAN-014: GET /api/workouts/weekly-summary — Weekly TSS rollup', () => {
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

    await settingsRepo.upsert('user-1', { timezone: TEST_TIMEZONE });
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });
  beforeEach(async () => { await db.collection('workouts').deleteMany({}); });

  // Week of 2027-03-01 (Mon) to 2027-03-07 (Sun)
  describe('Week boundaries — Monday through Sunday', () => {
    it('should derive Monday–Sunday from a Monday weekOf', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-01');
      expect(res.status).toBe(200);
      expect(res.body.data.weekStart).toBe('2027-03-01'); // Monday
      expect(res.body.data.weekEnd).toBe('2027-03-07');   // Sunday
    });

    it('should derive Monday–Sunday from a Wednesday weekOf', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-03');
      expect(res.status).toBe(200);
      expect(res.body.data.weekStart).toBe('2027-03-01');
      expect(res.body.data.weekEnd).toBe('2027-03-07');
    });

    it('should derive Monday–Sunday from a Sunday weekOf', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-07');
      expect(res.status).toBe(200);
      expect(res.body.data.weekStart).toBe('2027-03-01');
      expect(res.body.data.weekEnd).toBe('2027-03-07');
    });

    it('should derive correct week for a Saturday', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-06');
      expect(res.status).toBe(200);
      expect(res.body.data.weekStart).toBe('2027-03-01');
      expect(res.body.data.weekEnd).toBe('2027-03-07');
    });
  });

  describe('Boundary inclusion', () => {
    beforeEach(async () => {
      await db.collection('workouts').insertMany([
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-01', title: 'Monday', plannedTss: 50, createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-07', title: 'Sunday', plannedTss: 60, createdAt: new Date(), updatedAt: new Date() },
        // Outside the week
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-02-28', title: 'Before', plannedTss: 999, createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-08', title: 'After', plannedTss: 999, createdAt: new Date(), updatedAt: new Date() },
      ]);
    });

    it('should include Monday and Sunday Activities', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-03');
      expect(res.body.data.activities).toHaveLength(2);
      const titles = res.body.data.activities.map((a: any) => a.title);
      expect(titles).toContain('Monday');
      expect(titles).toContain('Sunday');
    });

    it('should exclude Activities before Monday and after Sunday', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-03');
      const titles = res.body.data.activities.map((a: any) => a.title);
      expect(titles).not.toContain('Before');
      expect(titles).not.toContain('After');
    });
  });

  describe('TSS calculations', () => {
    beforeEach(async () => {
      await db.collection('workouts').insertMany([
        // Planned Activities
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-02', title: 'Plan A', plannedTss: 70, createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-04', title: 'Plan B', plannedTss: 90, createdAt: new Date(), updatedAt: new Date() },
        // Completed Activities
        { userId: 'user-1', activityType: 'ride', status: 'completed', template: false, date: '2027-03-01', title: 'Done A', tss: 85, createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-1', activityType: 'ride', status: 'completed', template: false, date: '2027-03-03', title: 'Done B', tss: 55, createdAt: new Date(), updatedAt: new Date() },
        // Skipped Activity (contributes to nothing)
        { userId: 'user-1', activityType: 'cycling', status: 'skipped', template: false, date: '2027-03-05', title: 'Skipped', plannedTss: 100, tss: 50, createdAt: new Date(), updatedAt: new Date() },
      ]);
    });

    it('should calculate plannedTss from planned Activities only', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-01');
      expect(res.body.data.plannedTss).toBe(160); // 70 + 90
    });

    it('should calculate completedTss from completed Activities actual tss only', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-01');
      expect(res.body.data.completedTss).toBe(140); // 85 + 55
    });

    it('should calculate remainingTss from still-planned Activities only', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-01');
      expect(res.body.data.remainingTss).toBe(160); // 70 + 90 (same as plannedTss since all still planned)
    });

    it('should not let skipped Activities contribute to any TSS total', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-01');
      // Skipped has plannedTss=100, tss=50 — neither should affect totals
      expect(res.body.data.plannedTss).toBe(160);
      expect(res.body.data.completedTss).toBe(140);
      expect(res.body.data.remainingTss).toBe(160);
    });
  });

  describe('Missing TSS values', () => {
    it('should handle planned Activity without plannedTss gracefully', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: '2027-03-02', title: 'No TSS', createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-02');
      expect(res.body.data.plannedTss).toBe(0);
      expect(res.body.data.remainingTss).toBe(0);
    });

    it('should handle completed Activity without tss gracefully', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        date: '2027-03-03', title: 'No Actual TSS', createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-03');
      expect(res.body.data.completedTss).toBe(0);
    });
  });

  describe('Template exclusion', () => {
    it('should exclude templates from activities and TSS totals', async () => {
      await db.collection('workouts').insertMany([
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-02', title: 'Real', plannedTss: 50, createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-1', activityType: 'cycling', template: true, date: '2027-03-03', title: 'Template', plannedTss: 200, createdAt: new Date(), updatedAt: new Date() },
      ]);
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-02');
      expect(res.body.data.plannedTss).toBe(50);
      expect(res.body.data.activities).toHaveLength(1);
      expect(res.body.data.activities[0].title).toBe('Real');
    });
  });

  describe('Ownership', () => {
    it('should only include authenticated user Activities', async () => {
      await db.collection('workouts').insertMany([
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-02', title: 'Mine', plannedTss: 40, createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-2', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-02', title: 'Theirs', plannedTss: 999, createdAt: new Date(), updatedAt: new Date() },
      ]);
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-02');
      expect(res.body.data.activities).toHaveLength(1);
      expect(res.body.data.activities[0].title).toBe('Mine');
      expect(res.body.data.plannedTss).toBe(40);
    });
  });

  describe('Skip evaluation integration', () => {
    it('should evaluate skips before computing totals — overdue planned becomes skipped', async () => {
      const yesterday = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      const today = getTodayInTimezone(TEST_TIMEZONE);
      // Create overdue planned Activity in the current week
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: yesterday, title: 'Overdue',
        plannedTss: 80, createdAt: new Date(), updatedAt: new Date(),
      });
      // Create a today planned Activity
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: today, title: 'Today Planned',
        plannedTss: 60, createdAt: new Date(), updatedAt: new Date(),
      });

      const res = await request(app).get(`/api/workouts/weekly-summary?weekOf=${today}`);
      expect(res.status).toBe(200);

      // Overdue should be skipped (contributes nothing)
      const overdueActivity = res.body.data.activities.find((a: any) => a.title === 'Overdue');
      if (overdueActivity) {
        expect(overdueActivity.status).toBe('skipped');
      }

      // Today planned should still be planned
      const todayActivity = res.body.data.activities.find((a: any) => a.title === 'Today Planned');
      expect(todayActivity).toBeDefined();
      expect(todayActivity.status).toBe('planned');

      // Only today's plannedTss contributes (overdue is now skipped)
      expect(res.body.data.plannedTss).toBe(60);
      expect(res.body.data.remainingTss).toBe(60);
    });
  });

  describe('Empty week', () => {
    it('should return zero totals and empty activities for a week with no Activities', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2030-06-15');
      expect(res.status).toBe(200);
      expect(res.body.data.weekStart).toBe('2030-06-10');
      expect(res.body.data.weekEnd).toBe('2030-06-16');
      expect(res.body.data.plannedTss).toBe(0);
      expect(res.body.data.completedTss).toBe(0);
      expect(res.body.data.remainingTss).toBe(0);
      expect(res.body.data.activities).toEqual([]);
    });
  });

  describe('Validation', () => {
    it('should reject missing weekOf', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('weekOf');
    });

    it('should reject malformed weekOf', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-3-1');
      expect(res.status).toBe(400);
    });

    it('should reject impossible calendar date', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-02-30');
      expect(res.status).toBe(400);
    });

    it('should reject non-date string', async () => {
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=not-a-date');
      expect(res.status).toBe(400);
    });
  });

  describe('Response shape', () => {
    it('should match the approved Design §4.11 shape', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: '2027-03-03', title: 'Test Ride', plannedTss: 75,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/weekly-summary?weekOf=2027-03-03');
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data).toHaveProperty('weekStart');
      expect(data).toHaveProperty('weekEnd');
      expect(data).toHaveProperty('plannedTss');
      expect(data).toHaveProperty('completedTss');
      expect(data).toHaveProperty('remainingTss');
      expect(data).toHaveProperty('activities');
      expect(Array.isArray(data.activities)).toBe(true);
      const a = data.activities[0];
      expect(a).toHaveProperty('id');
      expect(a).toHaveProperty('date');
      expect(a).toHaveProperty('status');
      expect(a).toHaveProperty('activityType');
    });
  });
});
