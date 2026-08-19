/**
 * PLAN-008 Tests: POST /api/workouts — Create planned Activity
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

const mockUploadService = {
  uploadFile: jest.fn(),
  uploadSingle: jest.fn(),
  uploadBulk: jest.fn(),
  ingestFromInbox: jest.fn(),
} as any;

const fakeAuthMiddleware: express.RequestHandler = (req, _res, next) => {
  (req as any).user = { userId: 'user-1', email: 'test@test.com' };
  next();
};

describe('PLAN-008: POST /api/workouts — Create planned Activity', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let app: express.Application;
  let workoutRepo: MongoWorkoutRepository;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();

    workoutRepo = new MongoWorkoutRepository(db);
    await workoutRepo.createIndexes();
    const settingsRepo = new MongoSettingsRepository(db);

    const workoutService = new WorkoutService(workoutRepo, { store: jest.fn(), retrieve: jest.fn(), delete: jest.fn(), listFiles: jest.fn(), removeFromFolder: jest.fn() } as any);
    const settingsService = new SettingsService(settingsRepo);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).correlationId = 'test'; next(); });
    app.use('/api/workouts', createWorkoutsRouter(workoutService, mockUploadService, fakeAuthMiddleware, settingsService, workoutRepo));
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    await db.collection('workouts').deleteMany({});
  });

  describe('Basic creation', () => {
    it('should create a planned Activity with minimum required fields', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling' });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('planned');
      expect(res.body.data.template).toBe(false);
      expect(res.body.data.date).toBe('2026-09-15');
      expect(res.body.data.activityType).toBe('cycling');
      expect(res.body.data.id).toBeDefined();
    });

    it('should persist the Activity in the database', async () => {
      await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling' });

      const doc = await db.collection('workouts').findOne({ userId: 'user-1' });
      expect(doc).not.toBeNull();
      expect(doc!.status).toBe('planned');
      expect(doc!.template).toBe(false);
      expect(doc!.date).toBe('2026-09-15');
    });
  });

  describe('Optional fields', () => {
    it('should persist title when supplied', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', title: 'Morning VO2 session' });

      expect(res.status).toBe(201);
      expect(res.body.data.title).toBe('Morning VO2 session');
    });

    it('should persist description when supplied', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', description: '4x8 min at threshold' });

      expect(res.status).toBe(201);
      expect(res.body.data.description).toBe('4x8 min at threshold');
    });

    it('should persist plannedDurationSeconds when supplied', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', plannedDurationSeconds: 3600 });

      expect(res.status).toBe(201);
      const doc = await db.collection('workouts').findOne({ userId: 'user-1' });
      expect(doc!.plannedDurationSeconds).toBe(3600);
    });

    it('should persist plannedDistanceMeters when supplied', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', plannedDistanceMeters: 40000 });

      expect(res.status).toBe(201);
      const doc = await db.collection('workouts').findOne({ userId: 'user-1' });
      expect(doc!.plannedDistanceMeters).toBe(40000);
    });
  });

  describe('No source/actual data', () => {
    it('should not have startTime on the created Activity', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling' });

      expect(res.status).toBe(201);
      expect(res.body.data.startTime).toBeUndefined();
    });

    it('should not have endTime on the created Activity', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling' });

      expect(res.body.data.endTime).toBeUndefined();
    });

    it('should not have source artifact metadata', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling' });

      expect(res.body.data.dataSource).toBeUndefined();
      expect(res.body.data.fileFormat).toBeUndefined();
      expect(res.body.data.driveFileId).toBeUndefined();
    });
  });

  describe('Ownership', () => {
    it('should assign the Activity to the authenticated user', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling' });

      expect(res.body.data.userId).toBe('user-1');
    });

    it('should not allow userId override from request body', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', userId: 'attacker-user' });

      expect(res.status).toBe(201);
      expect(res.body.data.userId).toBe('user-1'); // Authenticated user, not body
    });
  });

  describe('Lifecycle protection', () => {
    it('should always create with status=planned regardless of body', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', status: 'completed' });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('planned');
    });

    it('should always create with template=false regardless of body', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', template: true });

      expect(res.status).toBe(201);
      expect(res.body.data.template).toBe(false);
    });
  });

  describe('Validation', () => {
    it('should reject missing date', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ activityType: 'cycling' });

      expect(res.status).toBe(400);
    });

    it('should reject invalid date format', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '09/15/2026', activityType: 'cycling' });

      expect(res.status).toBe(400);
    });

    it('should reject missing activityType', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15' });

      expect(res.status).toBe(400);
    });

    it('should reject empty activityType', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: '' });

      expect(res.status).toBe(400);
    });

    it('should reject non-number plannedDurationSeconds', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', plannedDurationSeconds: 'one hour' });

      expect(res.status).toBe(400);
    });

    it('should reject negative plannedDurationSeconds', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', plannedDurationSeconds: -100 });

      expect(res.status).toBe(400);
    });

    it('should reject non-number plannedDistanceMeters', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', plannedDistanceMeters: '40km' });

      expect(res.status).toBe(400);
    });

    it('should reject negative plannedDistanceMeters', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', plannedDistanceMeters: -500 });

      expect(res.status).toBe(400);
    });

    it('should reject non-object body', async () => {
      const res = await request(app)
        .post('/api/workouts')
        .send('not an object');

      expect(res.status).toBe(400);
    });
  });

  describe('Duplicates allowed', () => {
    it('should allow creating two planned Activities on the same date', async () => {
      const res1 = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', title: 'Morning ride' });

      const res2 = await request(app)
        .post('/api/workouts')
        .send({ date: '2026-09-15', activityType: 'cycling', title: 'Evening ride' });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.data.id).not.toBe(res2.body.data.id);
    });
  });
});
