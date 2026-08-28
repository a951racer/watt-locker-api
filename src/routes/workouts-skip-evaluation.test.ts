/**
 * PLAN-013 Tests: evaluateSkippedActivities — Automatic skip evaluation
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

describe('PLAN-013: evaluateSkippedActivities — Automatic skip evaluation', () => {
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

  describe('Repository evaluateSkippedActivities — unit tests', () => {
    it('should skip overdue planned Activity (date yesterday)', async () => {
      const yesterday = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: yesterday, title: 'Overdue', createdAt: new Date(), updatedAt: new Date(),
      });
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      const count = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count).toBe(1);
      const doc = await db.collection('workouts').findOne({ title: 'Overdue' });
      expect(doc!.status).toBe('skipped');
    });

    it('should skip overdue planned Activity (date several days ago)', async () => {
      const pastDate = getDateOffsetInTimezone(TEST_TIMEZONE, -5);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: pastDate, title: 'Old Planned', createdAt: new Date(), updatedAt: new Date(),
      });
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      const count = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count).toBe(1);
    });

    it('should NOT skip planned Activity dated today', async () => {
      const today = getTodayInTimezone(TEST_TIMEZONE);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: today, title: 'Today', createdAt: new Date(), updatedAt: new Date(),
      });
      const count = await repo.evaluateSkippedActivities('user-1', today);
      expect(count).toBe(0);
      const doc = await db.collection('workouts').findOne({ title: 'Today' });
      expect(doc!.status).toBe('planned');
    });

    it('should NOT skip planned Activity dated tomorrow', async () => {
      const tomorrow = getDateOffsetInTimezone(TEST_TIMEZONE, 1);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: tomorrow, title: 'Tomorrow', createdAt: new Date(), updatedAt: new Date(),
      });
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      const count = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count).toBe(0);
    });

    it('should NOT skip templates even if overdue', async () => {
      const pastDate = getDateOffsetInTimezone(TEST_TIMEZONE, -3);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: true,
        date: pastDate, title: 'Template', createdAt: new Date(), updatedAt: new Date(),
      });
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      const count = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count).toBe(0);
      const doc = await db.collection('workouts').findOne({ title: 'Template' });
      expect(doc!.status).toBe('planned');
    });

    it('should NOT change already-skipped Activities', async () => {
      const pastDate = getDateOffsetInTimezone(TEST_TIMEZONE, -2);
      const originalUpdatedAt = new Date('2026-01-01T00:00:00Z');
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'skipped', template: false,
        date: pastDate, title: 'Already Skipped', createdAt: new Date(), updatedAt: originalUpdatedAt,
      });
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      const count = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count).toBe(0);
      const doc = await db.collection('workouts').findOne({ title: 'Already Skipped' });
      expect(doc!.status).toBe('skipped');
      expect(doc!.updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
    });

    it('should NOT change completed Activities', async () => {
      const pastDate = getDateOffsetInTimezone(TEST_TIMEZONE, -2);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
        date: pastDate, title: 'Completed', createdAt: new Date(), updatedAt: new Date(),
      });
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      const count = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count).toBe(0);
      const doc = await db.collection('workouts').findOne({ title: 'Completed' });
      expect(doc!.status).toBe('completed');
    });

    it('should NOT affect another user Activities', async () => {
      const pastDate = getDateOffsetInTimezone(TEST_TIMEZONE, -2);
      await db.collection('workouts').insertOne({
        userId: 'user-2', activityType: 'cycling', status: 'planned', template: false,
        date: pastDate, title: 'User 2 Activity', createdAt: new Date(), updatedAt: new Date(),
      });
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      const count = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count).toBe(0);
      const doc = await db.collection('workouts').findOne({ title: 'User 2 Activity' });
      expect(doc!.status).toBe('planned');
    });

    it('should be idempotent — second call produces zero modifications', async () => {
      const yesterday = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: yesterday, title: 'Idempotent Test', createdAt: new Date(), updatedAt: new Date(),
      });
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      const count1 = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count1).toBe(1);
      const count2 = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count2).toBe(0);
    });

    it('should preserve Activity.date — date is not changed', async () => {
      const pastDate = getDateOffsetInTimezone(TEST_TIMEZONE, -3);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: pastDate, title: 'Date Preserved', plannedDurationSeconds: 7200,
        createdAt: new Date(), updatedAt: new Date(),
      });
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      await repo.evaluateSkippedActivities('user-1', userToday);
      const doc = await db.collection('workouts').findOne({ title: 'Date Preserved' });
      expect(doc!.date).toBe(pastDate);
      expect(doc!.plannedDurationSeconds).toBe(7200);
      expect(doc!.status).toBe('skipped');
    });

    it('should handle multiple overdue Activities in bulk', async () => {
      const past1 = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      const past2 = getDateOffsetInTimezone(TEST_TIMEZONE, -3);
      const past3 = getDateOffsetInTimezone(TEST_TIMEZONE, -7);
      await db.collection('workouts').insertMany([
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: past1, title: 'A', createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: past2, title: 'B', createdAt: new Date(), updatedAt: new Date() },
        { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: past3, title: 'C', createdAt: new Date(), updatedAt: new Date() },
      ]);
      const userToday = getTodayInTimezone(TEST_TIMEZONE);
      const count = await repo.evaluateSkippedActivities('user-1', userToday);
      expect(count).toBe(3);
    });
  });

  describe('Calendar integration — skip evaluation before query', () => {
    it('should return overdue Activity as skipped via calendar endpoint', async () => {
      const yesterday = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: yesterday, title: 'Overdue Via Calendar',
        createdAt: new Date(), updatedAt: new Date(),
      });
      const dateFrom = getDateOffsetInTimezone(TEST_TIMEZONE, -7);
      const dateTo = getTodayInTimezone(TEST_TIMEZONE);
      const res = await request(app).get(`/api/workouts/calendar?dateFrom=${dateFrom}&dateTo=${dateTo}`);
      expect(res.status).toBe(200);
      const item = res.body.data.activities.find((a: any) => a.title === 'Overdue Via Calendar');
      expect(item).toBeDefined();
      expect(item.status).toBe('skipped');
    });

    it('should persist the skipped status after calendar query', async () => {
      const yesterday = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      const result = await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: yesterday, title: 'Persisted Skip',
        createdAt: new Date(), updatedAt: new Date(),
      });
      const dateFrom = getDateOffsetInTimezone(TEST_TIMEZONE, -7);
      const dateTo = getTodayInTimezone(TEST_TIMEZONE);
      await request(app).get(`/api/workouts/calendar?dateFrom=${dateFrom}&dateTo=${dateTo}`);
      const doc = await db.collection('workouts').findOne({ _id: result.insertedId });
      expect(doc!.status).toBe('skipped');
    });

    it('should NOT skip today planned Activity via calendar endpoint', async () => {
      const today = getTodayInTimezone(TEST_TIMEZONE);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: today, title: 'Today Planned',
        createdAt: new Date(), updatedAt: new Date(),
      });
      const dateFrom = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      const dateTo = getDateOffsetInTimezone(TEST_TIMEZONE, 1);
      const res = await request(app).get(`/api/workouts/calendar?dateFrom=${dateFrom}&dateTo=${dateTo}`);
      const item = res.body.data.activities.find((a: any) => a.title === 'Today Planned');
      expect(item.status).toBe('planned');
    });

    it('should NOT skip templates via calendar endpoint', async () => {
      const yesterday = getDateOffsetInTimezone(TEST_TIMEZONE, -1);
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: true,
        date: yesterday, title: 'Template Not Skipped',
        createdAt: new Date(), updatedAt: new Date(),
      });
      const dateFrom = getDateOffsetInTimezone(TEST_TIMEZONE, -7);
      const dateTo = getTodayInTimezone(TEST_TIMEZONE);
      await request(app).get(`/api/workouts/calendar?dateFrom=${dateFrom}&dateTo=${dateTo}`);
      // Template should remain planned in DB
      const doc = await db.collection('workouts').findOne({ title: 'Template Not Skipped' });
      expect(doc!.status).toBe('planned');
    });
  });

  describe('Timezone boundary', () => {
    it('should use user timezone (not UTC) for today determination', async () => {
      // Use Pacific/Auckland (UTC+12) — "today" there is ahead of UTC
      await settingsRepo.upsert('user-1', { timezone: 'Pacific/Auckland' });
      const todayNZ = getTodayInTimezone('Pacific/Auckland');
      const yesterdayNZ = (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return d.toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
      })();

      // Activity dated "yesterday" in NZ should be skipped
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: yesterdayNZ, title: 'NZ Yesterday',
        createdAt: new Date(), updatedAt: new Date(),
      });
      // Activity dated "today" in NZ should remain planned
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: todayNZ, title: 'NZ Today',
        createdAt: new Date(), updatedAt: new Date(),
      });

      const count = await repo.evaluateSkippedActivities('user-1', todayNZ);
      expect(count).toBe(1);

      const skippedDoc = await db.collection('workouts').findOne({ title: 'NZ Yesterday' });
      expect(skippedDoc!.status).toBe('skipped');

      const plannedDoc = await db.collection('workouts').findOne({ title: 'NZ Today' });
      expect(plannedDoc!.status).toBe('planned');

      // Restore timezone
      await settingsRepo.upsert('user-1', { timezone: TEST_TIMEZONE });
    });
  });
});
