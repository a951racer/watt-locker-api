/**
 * PLAN-012 Tests: GET /api/workouts/calendar — Calendar date-range query
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

describe('PLAN-012: GET /api/workouts/calendar — Calendar query', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Application;
  let repo: MongoWorkoutRepository;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();
    repo = new MongoWorkoutRepository(db);
    await repo.createIndexes();
    const settingsRepo = new MongoSettingsRepository(db);
    const workoutService = new WorkoutService(repo, { store: jest.fn(), retrieve: jest.fn(), delete: jest.fn(), listFiles: jest.fn(), removeFromFolder: jest.fn() } as any);
    const settingsService = new SettingsService(settingsRepo);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).correlationId = 'test'; next(); });
    app.use('/api/workouts', createWorkoutsRouter(workoutService, mockUploadService, fakeAuthMiddleware, settingsService, repo));
    app.use(errorHandler);

    await settingsRepo.upsert('user-1', { timezone: 'America/Chicago' });
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });
  beforeEach(async () => { await db.collection('workouts').deleteMany({}); });

  // Use dates far in the future so skip evaluation does not affect planned Activities
  async function seedActivities() {
    await db.collection('workouts').insertMany([
      { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-01', title: 'Planned Mon', plannedDurationSeconds: 3600, plannedTss: 65, createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'ride', status: 'completed', template: false, date: '2027-03-02', title: 'Completed Tue', durationSeconds: 5400, tss: 80, createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'cycling', status: 'skipped', template: false, date: '2027-03-03', title: 'Skipped Wed', plannedDurationSeconds: 2700, createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-04', title: 'Planned Thu', plannedDurationSeconds: 7200, plannedTss: 120, createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'ride', status: 'completed', template: false, date: '2027-03-05', title: 'Completed Fri', durationSeconds: 3600, tss: 55, createdAt: new Date(), updatedAt: new Date() },
      // Outside date range
      { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-02-28', title: 'Before Range', plannedDurationSeconds: 3600, createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-06', title: 'After Range', plannedDurationSeconds: 3600, createdAt: new Date(), updatedAt: new Date() },
      // Template (should be excluded)
      { userId: 'user-1', activityType: 'cycling', template: true, date: '2027-03-02', title: 'Template Ride', plannedDurationSeconds: 3600, createdAt: new Date(), updatedAt: new Date() },
      // Another user (should be excluded)
      { userId: 'user-2', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-02', title: 'Other User', createdAt: new Date(), updatedAt: new Date() },
    ]);
  }

  describe('Date range — inclusive', () => {
    beforeEach(seedActivities);

    it('should return Activities within date range (inclusive)', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05');
      expect(res.status).toBe(200);
      expect(res.body.data.activities).toHaveLength(5);
    });

    it('should include Activity on dateFrom boundary', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-01');
      expect(res.status).toBe(200);
      expect(res.body.data.activities).toHaveLength(1);
      expect(res.body.data.activities[0].date).toBe('2027-03-01');
    });

    it('should include Activity on dateTo boundary', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-05&dateTo=2027-03-05');
      expect(res.status).toBe(200);
      expect(res.body.data.activities).toHaveLength(1);
      expect(res.body.data.activities[0].date).toBe('2027-03-05');
    });

    it('should exclude Activity immediately before range', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05');
      const dates = res.body.data.activities.map((a: any) => a.date);
      expect(dates).not.toContain('2027-02-28');
    });

    it('should exclude Activity immediately after range', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05');
      const dates = res.body.data.activities.map((a: any) => a.date);
      expect(dates).not.toContain('2027-03-06');
    });
  });

  describe('Mixed statuses — no filter returns all', () => {
    beforeEach(seedActivities);

    it('should return planned, completed, and skipped Activities when no status filter', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05');
      expect(res.status).toBe(200);
      const statuses = res.body.data.activities.map((a: any) => a.status);
      expect(statuses).toContain('planned');
      expect(statuses).toContain('completed');
      expect(statuses).toContain('skipped');
    });
  });

  describe('Status filtering', () => {
    beforeEach(seedActivities);

    it('should filter by status=planned', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05&status=planned');
      expect(res.status).toBe(200);
      expect(res.body.data.activities.length).toBe(2);
      res.body.data.activities.forEach((a: any) => expect(a.status).toBe('planned'));
    });

    it('should filter by status=completed', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05&status=completed');
      expect(res.status).toBe(200);
      expect(res.body.data.activities.length).toBe(2);
      res.body.data.activities.forEach((a: any) => expect(a.status).toBe('completed'));
    });

    it('should filter by status=skipped', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05&status=skipped');
      expect(res.status).toBe(200);
      expect(res.body.data.activities.length).toBe(1);
      expect(res.body.data.activities[0].status).toBe('skipped');
    });

    it('should filter by status=planned,completed', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05&status=planned,completed');
      expect(res.status).toBe(200);
      expect(res.body.data.activities.length).toBe(4);
      res.body.data.activities.forEach((a: any) => expect(['planned', 'completed']).toContain(a.status));
    });

    it('should reject invalid status value', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05&status=archived');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('status');
    });
  });

  describe('Template exclusion', () => {
    beforeEach(seedActivities);

    it('should never return templates', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-02-28&dateTo=2027-03-06');
      const titles = res.body.data.activities.map((a: any) => a.title);
      expect(titles).not.toContain('Template Ride');
    });
  });

  describe('Ownership', () => {
    beforeEach(seedActivities);

    it('should only return Activities belonging to the authenticated user', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-02-28&dateTo=2027-03-06');
      const titles = res.body.data.activities.map((a: any) => a.title);
      expect(titles).not.toContain('Other User');
    });
  });

  describe('Sorting — date ascending', () => {
    it('should return Activities sorted by date ascending', async () => {
      await db.collection('workouts').insertMany([
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-05-05', title: 'C', createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-05-01', title: 'A', createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-05-03', title: 'B', createdAt: new Date(), updatedAt: new Date() },
      ]);
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-05-01&dateTo=2027-05-05');
      expect(res.status).toBe(200);
      expect(res.body.data.activities[0].date).toBe('2027-05-01');
      expect(res.body.data.activities[1].date).toBe('2027-05-03');
      expect(res.body.data.activities[2].date).toBe('2027-05-05');
    });
  });

  describe('Response shape — calendar summary fields', () => {
    it('should return required calendar summary fields for planned Activity', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: '2027-06-10', title: 'Interval Day',
        plannedDurationSeconds: 5400, plannedTss: 90,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-06-10&dateTo=2027-06-10');
      expect(res.status).toBe(200);
      const item = res.body.data.activities[0];
      expect(item.id).toBeDefined();
      expect(item.date).toBe('2027-06-10');
      expect(item.status).toBe('planned');
      expect(item.title).toBe('Interval Day');
      expect(item.activityType).toBe('cycling');
      expect(item.plannedDurationSeconds).toBe(5400);
      expect(item.plannedTss).toBe(90);
      expect(item.tss).toBeUndefined();
      expect(item.durationSeconds).toBeUndefined();
    });

    it('should return required calendar summary fields for completed Activity', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        date: '2027-06-11', title: 'Morning Ride',
        durationSeconds: 7200, tss: 110,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-06-11&dateTo=2027-06-11');
      expect(res.status).toBe(200);
      const item = res.body.data.activities[0];
      expect(item.id).toBeDefined();
      expect(item.date).toBe('2027-06-11');
      expect(item.status).toBe('completed');
      expect(item.title).toBe('Morning Ride');
      expect(item.activityType).toBe('ride');
      expect(item.durationSeconds).toBe(7200);
      expect(item.tss).toBe(110);
      expect(item.plannedTss).toBeUndefined();
      expect(item.plannedDurationSeconds).toBeUndefined();
    });

    it('should include distance fields in calendar response', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        date: '2027-06-12', title: 'Long Ride',
        durationSeconds: 7200, tss: 110, distanceMeters: 50000,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-06-12&dateTo=2027-06-12');
      expect(res.status).toBe(200);
      const item = res.body.data.activities[0];
      expect(item.distanceMeters).toBe(50000);
    });
  });

  describe('Empty results', () => {
    it('should return empty activities array for valid range with no Activities', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2030-01-01&dateTo=2030-01-07');
      expect(res.status).toBe(200);
      expect(res.body.data.activities).toEqual([]);
      expect(res.body.data.weeklySummaries).toEqual([]);
    });
  });

  describe('Validation', () => {
    it('should reject missing dateFrom', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateTo=2027-03-05');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('dateFrom');
    });

    it('should reject missing dateTo', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('dateTo');
    });

    it('should reject malformed dateFrom', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-3-1&dateTo=2027-03-05');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('dateFrom');
    });

    it('should reject malformed dateTo', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=bad-date');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('dateTo');
    });

    it('should reject impossible calendar date (Feb 30)', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-02-30&dateTo=2027-03-01');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('dateFrom');
    });

    it('should reject dateFrom after dateTo', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-20&dateTo=2027-03-10');
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('dateFrom');
    });
  });

  describe('Weekly summaries', () => {
    beforeEach(seedActivities);

    it('should return weeklySummaries grouped by Monday–Sunday week', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05');
      expect(res.status).toBe(200);
      expect(res.body.data.weeklySummaries).toBeDefined();
      expect(Array.isArray(res.body.data.weeklySummaries)).toBe(true);
      // 2027-03-01 is a Monday, 2027-03-05 is a Friday — all same week
      expect(res.body.data.weeklySummaries).toHaveLength(1);
      const summary = res.body.data.weeklySummaries[0];
      expect(summary.weekStart).toBe('2027-03-01');
      expect(summary.weekEnd).toBe('2027-03-07');
    });

    it('should sum planned and completed metrics correctly, excluding skipped', async () => {
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2027-03-01&dateTo=2027-03-05');
      const summary = res.body.data.weeklySummaries[0];
      // Planned: Mon (3600, tss=65) + Thu (7200, tss=120) = 10800, tss=185
      expect(summary.plannedDuration).toBe(10800);
      expect(summary.plannedTss).toBe(185);
      // Completed: Tue (5400, tss=80) + Fri (3600, tss=55) = 9000, tss=135
      expect(summary.completedDuration).toBe(9000);
      expect(summary.completedTss).toBe(135);
    });
  });

  describe('Date fallback — historical activities without date field (timezone-aware)', () => {
    // User timezone is 'America/Chicago' (UTC-5 in winter / UTC-6 in summer)

    it('should include completed activity without date field via startTime fallback', async () => {
      // Activity has startTime but no date field (pre-migration document)
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        title: 'Legacy Ride',
        startTime: new Date('2026-08-15T14:00:00Z'), // 9:00 AM CDT → date should be 2026-08-15
        durationSeconds: 3600, tss: 70,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2026-08-15&dateTo=2026-08-15');
      expect(res.status).toBe(200);
      expect(res.body.data.activities).toHaveLength(1);
      expect(res.body.data.activities[0].title).toBe('Legacy Ride');
      expect(res.body.data.activities[0].date).toBe('2026-08-15');
    });

    it('should derive correct user-local date at UTC midnight boundary', async () => {
      // 2026-06-10T03:00:00Z → in America/Chicago (CDT, UTC-5) this is 2026-06-09 22:00
      // Query for 2026-06-09 to 2026-06-10 so the repo finds it (startTime is in June 10 UTC range)
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        title: 'Late Night Ride',
        startTime: new Date('2026-06-10T03:00:00Z'),
        durationSeconds: 2700, tss: 45,
        createdAt: new Date(), updatedAt: new Date(),
      });
      // Querying a range that includes the UTC date — the local date should be 2026-06-09
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2026-06-09&dateTo=2026-06-10');
      expect(res.status).toBe(200);
      const activity = res.body.data.activities.find((a: any) => a.title === 'Late Night Ride');
      expect(activity).toBeDefined();
      // The derived date should use user's timezone (CDT), so June 9 not June 10
      expect(activity.date).toBe('2026-06-09');
    });

    it('should NOT return fallback activity under the UTC date when local date differs', async () => {
      // Same scenario: UTC date is 2026-06-10, but local date is 2026-06-09
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        title: 'Boundary Ride',
        startTime: new Date('2026-06-10T03:00:00Z'),
        durationSeconds: 2700, tss: 45,
        createdAt: new Date(), updatedAt: new Date(),
      });
      // Querying for the UTC date should NOT include it (local date is previous day)
      const resUtc = await request(app).get('/api/workouts/calendar?dateFrom=2026-06-10&dateTo=2026-06-10');
      expect(resUtc.status).toBe(200);
      const titles = resUtc.body.data.activities.map((a: any) => a.title);
      expect(titles).not.toContain('Boundary Ride');
    });

    it('should use timezone boundary correctly — 2026-05-18T03:00:00Z as 2026-05-17 in America/Chicago', async () => {
      // 2026-05-18T03:00:00Z → CDT (UTC-5) → 2026-05-17 22:00 local
      // The repo finds this via startTime when querying a range that includes May 18 UTC
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        title: 'TZ Boundary Ride',
        startTime: new Date('2026-05-18T03:00:00Z'),
        durationSeconds: 1800, tss: 30, distanceMeters: 15000,
        createdAt: new Date(), updatedAt: new Date(),
      });
      // Query range includes both May 17 and May 18 so repo finds the activity
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2026-05-17&dateTo=2026-05-18');
      expect(res.status).toBe(200);
      const activity = res.body.data.activities.find((a: any) => a.title === 'TZ Boundary Ride');
      expect(activity).toBeDefined();
      // Date derived using user timezone should be May 17 (previous day in CDT)
      expect(activity.date).toBe('2026-05-17');
    });

    it('should use existing date field when present (date takes precedence over startTime)', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        title: 'Has Both Fields',
        date: '2026-09-20',
        startTime: new Date('2026-09-21T02:00:00Z'), // UTC date differs from date field
        durationSeconds: 4500, tss: 60,
        createdAt: new Date(), updatedAt: new Date(),
      });
      // Should use date field (2026-09-20), not startTime-derived date
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2026-09-20&dateTo=2026-09-20');
      expect(res.status).toBe(200);
      expect(res.body.data.activities).toHaveLength(1);
      expect(res.body.data.activities[0].date).toBe('2026-09-20');
      expect(res.body.data.activities[0].title).toBe('Has Both Fields');
    });

    it('stored date is authoritative even when timezone-derived date would differ', async () => {
      // This activity has a stored date of 2026-06-10, but startTime in America/Chicago
      // would produce 2026-06-09. The stored date MUST win because it is authoritative.
      // startTime: 2026-06-10T04:00:00Z → CDT (UTC-5) → 2026-06-09 23:00 → local date = 2026-06-09
      // stored date: 2026-06-10 (authoritative, perhaps manually corrected or from a different timezone)
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        title: 'Authoritative Date Ride',
        date: '2026-06-10',
        startTime: new Date('2026-06-10T04:00:00Z'), // Would be June 9 in CDT
        durationSeconds: 3600, tss: 70,
        createdAt: new Date(), updatedAt: new Date(),
      });
      // Query for June 10 — should find it because stored date is 2026-06-10
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2026-06-10&dateTo=2026-06-10');
      expect(res.status).toBe(200);
      const activity = res.body.data.activities.find((a: any) => a.title === 'Authoritative Date Ride');
      expect(activity).toBeDefined();
      expect(activity.date).toBe('2026-06-10'); // Stored date wins, not CDT-derived 2026-06-09

      // Query for June 9 — should NOT find it because stored date is 2026-06-10
      const resJune9 = await request(app).get('/api/workouts/calendar?dateFrom=2026-06-09&dateTo=2026-06-09');
      expect(resJune9.status).toBe(200);
      const inJune9 = resJune9.body.data.activities.find((a: any) => a.title === 'Authoritative Date Ride');
      expect(inJune9).toBeUndefined();
    });

    it('should include fallback-matched activity in weekly summaries', async () => {
      // Activity without date field, startTime gives local date 2026-07-13 (Monday)
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        title: 'Summary Ride',
        startTime: new Date('2026-07-13T15:00:00Z'), // 10:00 AM CDT → 2026-07-13
        durationSeconds: 5400, tss: 85, distanceMeters: 40000,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2026-07-13&dateTo=2026-07-19');
      expect(res.status).toBe(200);
      expect(res.body.data.activities).toHaveLength(1);
      // Verify weekly summary includes the fallback activity's metrics
      expect(res.body.data.weeklySummaries).toHaveLength(1);
      const summary = res.body.data.weeklySummaries[0];
      expect(summary.completedDuration).toBe(5400);
      expect(summary.completedTss).toBe(85);
      expect(summary.completedDistance).toBe(40000);
    });

    it('should handle planned activities with date field normally (unaffected by fallback logic)', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        title: 'Planned Intervals',
        date: '2026-10-05',
        plannedDurationSeconds: 4200, plannedTss: 75,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2026-10-05&dateTo=2026-10-05');
      expect(res.status).toBe(200);
      expect(res.body.data.activities).toHaveLength(1);
      expect(res.body.data.activities[0].date).toBe('2026-10-05');
      expect(res.body.data.activities[0].status).toBe('planned');
      expect(res.body.data.activities[0].title).toBe('Planned Intervals');
    });

    it('should NOT return activity whose UTC startTime is in range but local date is outside', async () => {
      // 2026-04-01T04:30:00Z → CDT (UTC-5) → 2026-03-31 23:30 local
      // Query for April 1-2, the local date (March 31) is outside that range
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        title: 'Out Of Range Locally',
        startTime: new Date('2026-04-01T04:30:00Z'),
        durationSeconds: 3000, tss: 40,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/calendar?dateFrom=2026-04-01&dateTo=2026-04-02');
      expect(res.status).toBe(200);
      const titles = res.body.data.activities.map((a: any) => a.title);
      expect(titles).not.toContain('Out Of Range Locally');
    });
  });
});
