/**
 * PLAN-009 Tests: PUT /api/workouts/:id — Status-aware field editing
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

describe('PLAN-009: PUT /api/workouts/:id — Status-aware editing', () => {
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
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });
  beforeEach(async () => { await db.collection('workouts').deleteMany({}); });

  async function createPlanned() {
    const res = await request(app).post('/api/workouts').send({ date: '2026-09-15', activityType: 'cycling', title: 'Original' });
    return res.body.data;
  }

  async function createCompleted() {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'ride', status: 'completed', template: false, date: '2026-08-10',
      startTime: new Date('2026-08-10T14:00:00Z'), endTime: new Date('2026-08-10T15:30:00Z'),
      durationSeconds: 5400, distanceMeters: 45000, elevationGainMeters: 600,
      avgPowerWatts: 220, normalizedPowerWatts: 235, tss: 75,
      plannedDurationSeconds: 3600, plannedDistanceMeters: 40000,
      createdAt: new Date(), updatedAt: new Date(),
    });
    return result.insertedId.toHexString();
  }

  describe('Planned Activity — all planning fields editable', () => {
    it('should update title on planned Activity', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ title: 'Updated Title' });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Updated Title');
    });

    it('should update date on planned Activity', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ date: '2026-10-01' });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe('2026-10-01');
    });

    it('should update plannedDurationSeconds on planned Activity', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ plannedDurationSeconds: 7200 });
      expect(res.status).toBe(200);
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(activity.id) });
      expect(doc!.plannedDurationSeconds).toBe(7200);
    });

    it('should update description on planned Activity', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ description: 'Interval session' });
      expect(res.status).toBe(200);
      expect(res.body.data.description).toBe('Interval session');
    });

    it('should update tags on planned Activity', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ tags: ['vo2', 'hard'] });
      expect(res.status).toBe(200);
      expect(res.body.data.tags).toEqual(['vo2', 'hard']);
    });
  });

  describe('Completed Activity — restricted fields', () => {
    it('should allow updating title on completed Activity', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}`).send({ title: 'New Title' });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('New Title');
    });

    it('should allow updating rpe on completed Activity', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}`).send({ rpe: 7 });
      expect(res.status).toBe(200);
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(id) });
      expect(doc!.rpe).toBe(7);
    });

    it('should allow updating movingTimeSeconds on completed Activity', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}`).send({ movingTimeSeconds: 5000 });
      expect(res.status).toBe(200);
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(id) });
      expect(doc!.movingTimeSeconds).toBe(5000);
    });

    it('should allow updating tags on completed Activity', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}`).send({ tags: ['race'] });
      expect(res.status).toBe(200);
      expect(res.body.data.tags).toEqual(['race']);
    });

    it('should REJECT durationSeconds update on completed Activity', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}`).send({ durationSeconds: 9999 });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('durationSeconds');
    });

    it('should REJECT date update on completed Activity', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}`).send({ date: '2026-12-25' });
      expect(res.status).toBe(400);
    });

    it('should REJECT plannedDurationSeconds update on completed Activity', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}`).send({ plannedDurationSeconds: 1800 });
      expect(res.status).toBe(400);
    });

    it('should REJECT avgPowerWatts update on completed Activity', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}`).send({ avgPowerWatts: 999 });
      expect(res.status).toBe(400);
    });

    it('should preserve planned values when editing completed Activity', async () => {
      const id = await createCompleted();
      await request(app).put(`/api/workouts/${id}`).send({ title: 'Edited' });
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(id) });
      expect(doc!.plannedDurationSeconds).toBe(3600); // Preserved
      expect(doc!.plannedDistanceMeters).toBe(40000); // Preserved
    });
  });

  describe('Skipped Activity — planning fields editable', () => {
    async function createSkipped() {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'skipped', template: false, date: '2026-09-20',
        plannedDurationSeconds: 3600, plannedDistanceMeters: 30000,
        title: 'Skipped Ride',
        createdAt: new Date(), updatedAt: new Date(),
      });
      return result.insertedId.toHexString();
    }

    it('should update title on skipped Activity', async () => {
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}`).send({ title: 'Rescheduled' });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Rescheduled');
    });

    it('should update date on skipped Activity', async () => {
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}`).send({ date: '2026-10-05' });
      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe('2026-10-05');
    });

    it('should update plannedDurationSeconds on skipped Activity', async () => {
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}`).send({ plannedDurationSeconds: 5400 });
      expect(res.status).toBe(200);
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(id) });
      expect(doc!.plannedDurationSeconds).toBe(5400);
    });

    it('should update description on skipped Activity', async () => {
      const id = await createSkipped();
      const res = await request(app).put(`/api/workouts/${id}`).send({ description: 'Was sick' });
      expect(res.status).toBe(200);
      expect(res.body.data.description).toBe('Was sick');
    });
  });

  describe('Lifecycle circumvention prevention', () => {
    it('should REJECT status change via PUT (planned → completed)', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ status: 'completed' });
      expect(res.status).toBe(400);
    });

    it('should REJECT status change via PUT (planned → skipped)', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ status: 'skipped' });
      expect(res.status).toBe(400);
    });

    it('should REJECT status change on completed Activity', async () => {
      const id = await createCompleted();
      const res = await request(app).put(`/api/workouts/${id}`).send({ status: 'planned' });
      expect(res.status).toBe(400);
    });

    it('should REJECT template change via PUT', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ template: true });
      expect(res.status).toBe(400);
    });
  });

  describe('Ownership', () => {
    it('should reject update for Activity belonging to another user', async () => {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-2', activityType: 'ride', status: 'planned', template: false, date: '2026-09-15',
        createdAt: new Date(), updatedAt: new Date(),
      });
      const id = result.insertedId.toHexString();
      const res = await request(app).put(`/api/workouts/${id}`).send({ title: 'Hacked' });
      expect(res.status).toBe(404);
    });
  });

  describe('Nonexistent / Invalid', () => {
    it('should return 404 for nonexistent Activity', async () => {
      const res = await request(app).put('/api/workouts/000000000000000000000000').send({ title: 'x' });
      expect(res.status).toBe(404);
    });

    it('should return 404 for invalid ObjectId', async () => {
      const res = await request(app).put('/api/workouts/not-a-valid-id').send({ title: 'x' });
      expect(res.status).toBe(404);
    });
  });

  describe('Validation', () => {
    it('should reject invalid date format on planned Activity', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ date: '09/15/2026' });
      expect(res.status).toBe(400);
    });

    it('should reject negative plannedDurationSeconds', async () => {
      const activity = await createPlanned();
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({ plannedDurationSeconds: -100 });
      expect(res.status).toBe(400);
    });

    it('should handle empty body gracefully', async () => {
      const activity = await createPlanned();
      // Send an empty JSON object — should succeed (no-op update)
      const res = await request(app).put(`/api/workouts/${activity.id}`).send({});
      expect(res.status).toBe(200);
    });
  });
});
