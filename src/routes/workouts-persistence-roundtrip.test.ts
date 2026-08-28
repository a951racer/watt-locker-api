/**
 * PLAN-029D Verification: Planned Activity Persistence Round-Trip
 * Tests that segments, targetSpeed, referenceMetric, plannedTss, plannedIf
 * survive the full POST → GET → PUT → GET lifecycle.
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

describe('PLAN-029D: Planned Activity Persistence Round-Trip', () => {
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

  const FULL_PLANNED_ACTIVITY = {
    date: '2027-09-15',
    activityType: 'ride',
    title: 'Persistence Test',
    description: 'Testing planned activity persistence',
    plannedDurationSeconds: 1200,
    plannedDistanceMeters: 9656, // ~6 miles
    targetSpeed: 18,
    plannedTss: 25,
    plannedIf: 0.65,
    referenceMetric: { type: 'power_ftp', value: 250 },
    tags: ['test', 'persistence'],
    segments: [
      {
        type: 'warmup',
        durationSeconds: 300,
        powerMin: 35,
        powerMax: 55,
        cadenceMin: 80,
        cadenceMax: 95,
        notes: 'Easy spin',
      },
      {
        type: 'interval',
        durationSeconds: 600,
        powerMin: 75,
        powerMax: 85,
        hrMin: 145,
        hrMax: 165,
        cadenceMin: 90,
        cadenceMax: 100,
        notes: 'Sweet spot',
        intensityMetric: 'power_ftp',
      },
      {
        type: 'recovery',
        durationSeconds: 300,
        powerMin: 45,
        powerMax: 55,
        cadenceMin: 75,
        cadenceMax: 85,
      },
    ],
  };

  describe('POST → GET round-trip', () => {
    it('should persist all planning fields including segments, targetSpeed, and referenceMetric', async () => {
      // POST — create the planned activity
      const postRes = await request(app)
        .post('/api/workouts')
        .send(FULL_PLANNED_ACTIVITY)
        .expect(201);

      const created = postRes.body.data;
      expect(created.id).toBeDefined();

      // Verify POST response contains key fields
      expect(created.title).toBe('Persistence Test');
      expect(created.date).toBe('2027-09-15');

      // GET — retrieve the same activity
      const getRes = await request(app)
        .get(`/api/workouts/${created.id}`)
        .expect(200);

      const fetched = getRes.body.data;

      // Activity-level fields
      expect(fetched.activityType).toBe('ride');
      expect(fetched.date).toBe('2027-09-15');
      expect(fetched.title).toBe('Persistence Test');
      expect(fetched.description).toBe('Testing planned activity persistence');
      expect(fetched.status).toBe('planned');
      expect(fetched.template).toBe(false);
      expect(fetched.plannedDurationSeconds).toBe(1200);
      expect(fetched.plannedDistanceMeters).toBe(9656);
      expect(fetched.targetSpeed).toBe(18);
      expect(fetched.plannedTss).toBe(25);
      expect(fetched.plannedIf).toBe(0.65);
      expect(fetched.tags).toEqual(['test', 'persistence']);

      // Reference metric
      expect(fetched.referenceMetric).toBeDefined();
      expect(fetched.referenceMetric.type).toBe('power_ftp');
      expect(fetched.referenceMetric.value).toBe(250);

      // Segments — all three must be present with all fields
      expect(fetched.segments).toBeDefined();
      expect(fetched.segments).toHaveLength(3);

      // Segment 1: Warmup
      expect(fetched.segments[0].type).toBe('warmup');
      expect(fetched.segments[0].durationSeconds).toBe(300);
      expect(fetched.segments[0].powerMin).toBe(35);
      expect(fetched.segments[0].powerMax).toBe(55);
      expect(fetched.segments[0].cadenceMin).toBe(80);
      expect(fetched.segments[0].cadenceMax).toBe(95);
      expect(fetched.segments[0].notes).toBe('Easy spin');

      // Segment 2: Interval
      expect(fetched.segments[1].type).toBe('interval');
      expect(fetched.segments[1].durationSeconds).toBe(600);
      expect(fetched.segments[1].powerMin).toBe(75);
      expect(fetched.segments[1].powerMax).toBe(85);
      expect(fetched.segments[1].hrMin).toBe(145);
      expect(fetched.segments[1].hrMax).toBe(165);
      expect(fetched.segments[1].cadenceMin).toBe(90);
      expect(fetched.segments[1].cadenceMax).toBe(100);
      expect(fetched.segments[1].notes).toBe('Sweet spot');
      expect(fetched.segments[1].intensityMetric).toBe('power_ftp');

      // Segment 3: Recovery
      expect(fetched.segments[2].type).toBe('recovery');
      expect(fetched.segments[2].durationSeconds).toBe(300);
      expect(fetched.segments[2].powerMin).toBe(45);
      expect(fetched.segments[2].powerMax).toBe(55);
      expect(fetched.segments[2].cadenceMin).toBe(75);
      expect(fetched.segments[2].cadenceMax).toBe(85);
    });
  });

  describe('PUT → GET persistence of modifications', () => {
    it('should persist modifications to segments, targetSpeed, and plannedTss', async () => {
      // Create
      const postRes = await request(app)
        .post('/api/workouts')
        .send(FULL_PLANNED_ACTIVITY)
        .expect(201);

      const id = postRes.body.data.id;

      // Modify via PUT
      await request(app)
        .put(`/api/workouts/${id}`)
        .send({
          targetSpeed: 20,
          plannedTss: 30,
          plannedIf: 0.72,
          segments: [
            { type: 'warmup', durationSeconds: 300, powerMin: 35, powerMax: 55 },
            { type: 'interval', durationSeconds: 900, powerMin: 80, powerMax: 90, notes: 'Updated work' },
            { type: 'recovery', durationSeconds: 300, powerMin: 45, powerMax: 55 },
          ],
        })
        .expect(200);

      // GET the modified activity
      const getRes = await request(app)
        .get(`/api/workouts/${id}`)
        .expect(200);

      const modified = getRes.body.data;

      // Verify modifications persisted
      expect(modified.targetSpeed).toBe(20);
      expect(modified.plannedTss).toBe(30);
      expect(modified.plannedIf).toBe(0.72);

      // Verify modified segments
      expect(modified.segments).toHaveLength(3);
      expect(modified.segments[1].durationSeconds).toBe(900);
      expect(modified.segments[1].powerMin).toBe(80);
      expect(modified.segments[1].powerMax).toBe(90);
      expect(modified.segments[1].notes).toBe('Updated work');
    });
  });

  describe('Calendar API returns planned TSS', () => {
    it('should return planned TSS in the calendar response', async () => {
      // Create a planned activity with TSS
      await request(app)
        .post('/api/workouts')
        .send(FULL_PLANNED_ACTIVITY)
        .expect(201);

      // Query the calendar for that date
      const calRes = await request(app)
        .get('/api/workouts/calendar?dateFrom=2027-09-15&dateTo=2027-09-15')
        .expect(200);

      const activities = calRes.body.data.activities;
      expect(activities).toHaveLength(1);

      const calActivity = activities[0];
      expect(calActivity.title).toBe('Persistence Test');
      expect(calActivity.date).toBe('2027-09-15');
      expect(calActivity.status).toBe('planned');
      expect(calActivity.plannedDurationSeconds).toBe(1200);
      expect(calActivity.plannedTss).toBe(25);
      // Calendar should also include planned distance
      expect(calActivity.plannedDistanceMeters).toBe(9656);
    });

    it('should include planned TSS in weekly summaries', async () => {
      await request(app)
        .post('/api/workouts')
        .send(FULL_PLANNED_ACTIVITY)
        .expect(201);

      // 2027-09-15 is a Wednesday. Week is Mon 09-13 to Sun 09-19
      const calRes = await request(app)
        .get('/api/workouts/calendar?dateFrom=2027-09-13&dateTo=2027-09-19')
        .expect(200);

      const summaries = calRes.body.data.weeklySummaries;
      expect(summaries).toHaveLength(1);
      expect(summaries[0].plannedTss).toBe(25);
      expect(summaries[0].plannedDuration).toBe(1200);
    });
  });

  describe('TSS/IF Override Provenance Persistence', () => {
    it('should persist plannedTssOverride and plannedIfOverride through POST → GET', async () => {
      const postRes = await request(app)
        .post('/api/workouts')
        .send({
          ...FULL_PLANNED_ACTIVITY,
          plannedTssOverride: true,
          plannedIfOverride: false,
        })
        .expect(201);

      const id = postRes.body.data.id;

      const getRes = await request(app)
        .get(`/api/workouts/${id}`)
        .expect(200);

      const fetched = getRes.body.data;
      expect(fetched.plannedTssOverride).toBe(true);
      expect(fetched.plannedIfOverride).toBe(false);
    });

    it('should persist plannedIfOverride=true through POST → GET', async () => {
      const postRes = await request(app)
        .post('/api/workouts')
        .send({
          ...FULL_PLANNED_ACTIVITY,
          plannedTssOverride: false,
          plannedIfOverride: true,
        })
        .expect(201);

      const id = postRes.body.data.id;

      const getRes = await request(app)
        .get(`/api/workouts/${id}`)
        .expect(200);

      const fetched = getRes.body.data;
      expect(fetched.plannedTssOverride).toBe(false);
      expect(fetched.plannedIfOverride).toBe(true);
    });

    it('should update override flags via PUT', async () => {
      // Create with IF override
      const postRes = await request(app)
        .post('/api/workouts')
        .send({
          ...FULL_PLANNED_ACTIVITY,
          plannedTssOverride: false,
          plannedIfOverride: true,
        })
        .expect(201);

      const id = postRes.body.data.id;

      // Update: clear the IF override (user modified a step)
      await request(app)
        .put(`/api/workouts/${id}`)
        .send({
          plannedTss: 64,
          plannedIf: 0.80,
          plannedTssOverride: false,
          plannedIfOverride: false,
        })
        .expect(200);

      const getRes = await request(app)
        .get(`/api/workouts/${id}`)
        .expect(200);

      const fetched = getRes.body.data;
      expect(fetched.plannedTssOverride).toBe(false);
      expect(fetched.plannedIfOverride).toBe(false);
      expect(fetched.plannedTss).toBe(64);
      expect(fetched.plannedIf).toBe(0.80);
    });

    it('activities without override fields return undefined (treated as false)', async () => {
      // Create without override fields (legacy simulation)
      const postRes = await request(app)
        .post('/api/workouts')
        .send(FULL_PLANNED_ACTIVITY)
        .expect(201);

      const id = postRes.body.data.id;

      const getRes = await request(app)
        .get(`/api/workouts/${id}`)
        .expect(200);

      const fetched = getRes.body.data;
      // Fields are not present (undefined) — UI treats this as false
      expect(fetched.plannedTssOverride).toBeUndefined();
      expect(fetched.plannedIfOverride).toBeUndefined();
    });

    it('calendar still returns effective TSS regardless of override flag', async () => {
      await request(app)
        .post('/api/workouts')
        .send({
          ...FULL_PLANNED_ACTIVITY,
          plannedTss: 74,
          plannedIf: 0.86,
          plannedTssOverride: false,
          plannedIfOverride: true,
        })
        .expect(201);

      const calRes = await request(app)
        .get('/api/workouts/calendar?dateFrom=2027-09-15&dateTo=2027-09-15')
        .expect(200);

      const activities = calRes.body.data.activities;
      expect(activities).toHaveLength(1);
      expect(activities[0].plannedTss).toBe(74);
    });
  });
});
