/**
 * PLAN-006 Behavioral Tests: Analytics endpoints exclude planned/skipped/template Activities.
 *
 * These tests verify that longitudinal analytics/aggregation paths include
 * ONLY completed Activities, regardless of what other Activities exist.
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

// Minimal mock for upload service (not used in these tests)
const mockUploadService = {
  uploadFile: jest.fn(),
  uploadSingle: jest.fn(),
  uploadBulk: jest.fn(),
  ingestFromInbox: jest.fn(),
} as any;

// Fake auth middleware that attaches a user
const fakeAuthMiddleware: express.RequestHandler = (req, _res, next) => {
  (req as any).user = { userId: 'user-1', email: 'test@test.com' };
  next();
};

describe('PLAN-006: Analytics completed-only filtering', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Application;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();

    const workoutRepo = new MongoWorkoutRepository(db);
    await workoutRepo.createIndexes();
    const settingsRepo = new MongoSettingsRepository(db);

    const workoutService = new WorkoutService(workoutRepo, { store: jest.fn(), retrieve: jest.fn(), delete: jest.fn(), listFiles: jest.fn(), removeFromFolder: jest.fn() } as any);
    const settingsService = new SettingsService(settingsRepo);

    app = express();
    app.use(express.json());
    // Add correlationId for error handler compatibility
    app.use((req, _res, next) => { (req as any).correlationId = 'test'; next(); });
    app.use('/api/workouts', createWorkoutsRouter(workoutService, mockUploadService, fakeAuthMiddleware, settingsService, workoutRepo));

    // Set up user settings with timezone
    await db.collection('settings').insertOne({
      userId: 'user-1',
      timezone: 'America/Chicago',
      driveStoragePath: 'WattLocker',
      driveInboxPath: 'WattLocker/Inbox',
      connectedSources: [],
      ftpHistory: [{ effectiveDate: new Date('2024-01-01'), ftpWatts: 270 }],
      updatedAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    await db.collection('workouts').deleteMany({});
  });

  async function insertActivity(overrides: Record<string, unknown>) {
    // Use dates relative to "now" so analytics windows capture the data
    const now = new Date();
    const recentDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const recentDateStr = recentDate.toISOString().split('T')[0];

    const base = {
      userId: 'user-1',
      activityType: 'ride',
      status: 'completed',
      template: false,
      date: recentDateStr,
      startTime: recentDate,
      endTime: new Date(recentDate.getTime() + 5400000),
      durationSeconds: 5400,
      movingTimeSeconds: 5200,
      distanceMeters: 45000,
      elevationGainMeters: 600,
      dataSource: 'manual',
      fileFormat: 'fit',
      driveFileId: 'drive-test',
      normalizedPowerWatts: 230,
      tss: 75,
      intensityFactor: 0.852,
      avgPowerWatts: 210,
      avgHeartRateBpm: 145,
      avgSpeedMps: 8.33,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    await db.collection('workouts').insertOne(base);
  }

  // Helper to get a date string N days ago
  function daysAgo(n: number): { date: string; startTime: Date; endTime: Date } {
    const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
    return {
      date: d.toISOString().split('T')[0],
      startTime: d,
      endTime: new Date(d.getTime() + 5400000),
    };
  }

  describe('Performance metrics (CTL/ATL/TSB)', () => {
    it('should exclude planned Activities from TSS aggregation', async () => {
      const d2 = daysAgo(2);
      await insertActivity({ tss: 75, ...d2 });
      // Planned Activity with TSS=999 (would obviously change result if included)
      await insertActivity({ status: 'planned', tss: 999, plannedTss: 999, ...daysAgo(1), startTime: undefined, endTime: undefined });

      const res = await request(app).get('/api/workouts/performance-metrics?days=30');
      expect(res.status).toBe(200);

      const metrics = res.body.data;
      const lastDay = metrics[metrics.length - 1];
      // ATL with 7-day decay and single 75 TSS should be modest
      expect(lastDay.atl).toBeLessThan(20);
    });

    it('should exclude skipped Activities from TSS aggregation', async () => {
      await insertActivity({ tss: 50, ...daysAgo(3) });
      await insertActivity({ status: 'skipped', tss: 888, ...daysAgo(2), startTime: undefined, endTime: undefined });

      const res = await request(app).get('/api/workouts/performance-metrics?days=30');
      expect(res.status).toBe(200);

      const metrics = res.body.data;
      const lastDay = metrics[metrics.length - 1];
      expect(lastDay.atl).toBeLessThan(15);
    });

    it('should exclude templates from TSS aggregation', async () => {
      const d2 = daysAgo(2);
      await insertActivity({ tss: 60, ...d2 });
      await insertActivity({ template: true, status: null, tss: 777, ...daysAgo(1), date: null });

      const res = await request(app).get('/api/workouts/performance-metrics?days=30');
      expect(res.status).toBe(200);

      const metrics = res.body.data;
      const lastDay = metrics[metrics.length - 1];
      expect(lastDay.atl).toBeLessThan(15);
    });
  });

  describe('Power curve', () => {
    it('should exclude planned Activities from power curve results', async () => {
      const d2 = daysAgo(2);
      await insertActivity({ maxPowers: { '300': 280 }, ...d2 });
      await insertActivity({ status: 'planned', maxPowers: { '300': 999 }, ...daysAgo(1), startTime: undefined, endTime: undefined });

      const res = await request(app).get('/api/workouts/power-curve?months=1');
      expect(res.status).toBe(200);

      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].maxPowers['300']).toBe(280);
    });

    it('should exclude templates from power curve results', async () => {
      const d2 = daysAgo(2);
      await insertActivity({ maxPowers: { '60': 350 }, ...d2 });
      await insertActivity({ template: true, status: null, maxPowers: { '60': 900 }, ...daysAgo(1) });

      const res = await request(app).get('/api/workouts/power-curve?months=1');
      expect(res.status).toBe(200);

      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].maxPowers['60']).toBe(350);
    });
  });

  describe('CSV export', () => {
    it('should export only completed Activities by default', async () => {
      const d3 = daysAgo(3);
      const d2 = daysAgo(2);
      const d1 = daysAgo(1);
      await insertActivity({ title: 'Completed Ride', ...d3 });
      await insertActivity({ status: 'planned', title: 'Planned Ride', ...d2, startTime: undefined, endTime: undefined });
      await insertActivity({ status: 'skipped', title: 'Skipped Ride', ...d1, startTime: undefined, endTime: undefined });
      await insertActivity({ template: true, status: null, title: 'Template Ride', ...daysAgo(4) });

      const res = await request(app).get('/api/workouts/export');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');

      const lines = res.text.trim().split('\n');
      // Header + 1 completed Activity
      expect(lines.length).toBe(2);
      expect(lines[1]).toContain('Completed Ride');
      expect(res.text).not.toContain('Planned Ride');
      expect(res.text).not.toContain('Skipped Ride');
      expect(res.text).not.toContain('Template Ride');
    });
  });

  describe('Regression: all-completed dataset unchanged', () => {
    it('should produce same results with completed-only filter when all data is completed', async () => {
      const d4 = daysAgo(4);
      const d3 = daysAgo(3);
      const d2 = daysAgo(2);
      await insertActivity({ tss: 50, ...d4 });
      await insertActivity({ tss: 75, ...d3 });
      await insertActivity({ tss: 60, ...d2 });

      const res = await request(app).get('/api/workouts/performance-metrics?days=7');
      expect(res.status).toBe(200);

      const metrics = res.body.data;
      expect(metrics.length).toBeGreaterThan(0);
      const lastDay = metrics[metrics.length - 1];
      expect(lastDay.ctl).toBeGreaterThan(0);
      expect(lastDay.atl).toBeGreaterThan(0);
    });
  });
});
