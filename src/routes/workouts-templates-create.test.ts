/**
 * PLAN-016 Tests: POST /api/workouts/templates — Create Activity template
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

describe('PLAN-016: POST /api/workouts/templates — Create template', () => {
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

  describe('Minimal template creation', () => {
    it('should create a template with only activityType', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: 'cycling' });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.template).toBe(true);
      expect(res.body.data.activityType).toBe('cycling');
    });

    it('should have no date on the created template', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: 'cycling' });
      // toWorkoutRecord defaults empty date to '' for legacy compat, but DB doc should have no date
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(res.body.data.id) });
      expect(doc!.date).toBeUndefined();
    });

    it('should have no lifecycle status in the database document', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: 'cycling' });
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(res.body.data.id) });
      expect(doc!.status).toBeUndefined();
    });

    it('should represent status as null through the domain layer (not completed)', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: 'cycling' });
      expect(res.body.data.status).toBeNull();
    });

    it('should represent date as null through the domain layer', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: 'cycling' });
      expect(res.body.data.date).toBeNull();
    });

    it('should set userId to authenticated user', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: 'cycling' });
      expect(res.body.data.userId).toBe('user-1');
    });
  });

  describe('Template planning fields', () => {
    it('should persist all planning fields', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        title: 'VO2 Max Intervals',
        description: '5x5min at 120% FTP',
        plannedDurationSeconds: 3600,
        plannedDistanceMeters: 30000,
        tags: ['vo2', 'intervals'],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.title).toBe('VO2 Max Intervals');
      expect(res.body.data.description).toBe('5x5min at 120% FTP');
      expect(res.body.data.plannedDurationSeconds).toBe(3600);
      expect(res.body.data.plannedDistanceMeters).toBe(30000);
      expect(res.body.data.tags).toEqual(['vo2', 'intervals']);
    });

    it('should persist plannedTss', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        plannedTss: 95,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.plannedTss).toBe(95);
    });
  });

  describe('Description', () => {
    it('should persist description correctly', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        description: 'Steady-state threshold work',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.description).toBe('Steady-state threshold work');
    });
  });

  describe('Comments — not persisted on templates', () => {
    it('should NOT persist comment on the template', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        comment: 'This should not persist',
      });
      expect(res.status).toBe(201);
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(res.body.data.id) });
      expect(doc!.comment).toBeUndefined();
    });

    it('should NOT persist comments on the template', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        comments: 'This should not persist either',
      });
      expect(res.status).toBe(201);
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(res.body.data.id) });
      expect(doc!.comments).toBeUndefined();
      expect(doc!.comment).toBeUndefined();
    });
  });

  describe('Date rejection/ignoring', () => {
    it('should NOT persist a supplied date', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        date: '2027-05-01',
      });
      expect(res.status).toBe(201);
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(res.body.data.id) });
      expect(doc!.date).toBeUndefined();
    });
  });

  describe('Status rejection/ignoring', () => {
    it('should NOT persist status=planned', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        status: 'planned',
      });
      expect(res.status).toBe(201);
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(res.body.data.id) });
      expect(doc!.status).toBeUndefined();
    });

    it('should NOT persist status=completed', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        status: 'completed',
      });
      expect(res.status).toBe(201);
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(res.body.data.id) });
      expect(doc!.status).toBeUndefined();
    });
  });

  describe('Template flag protection', () => {
    it('should always set template=true regardless of supplied value', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        template: false,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.template).toBe(true);
    });
  });

  describe('Ownership', () => {
    it('should ignore userId in request body', async () => {
      const res = await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        userId: 'user-hacker',
      });
      expect(res.status).toBe(201);
      expect(res.body.data.userId).toBe('user-1');
      const doc = await db.collection('workouts').findOne({ _id: new (require('mongodb').ObjectId)(res.body.data.id) });
      expect(doc!.userId).toBe('user-1');
    });
  });

  describe('Lifecycle isolation', () => {
    it('should not create the template as a planned Activity in calendar queries', async () => {
      await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        title: 'Isolated Template',
      });
      // Calendar query should not find it
      const calRes = await request(app).get('/api/workouts/calendar?dateFrom=2020-01-01&dateTo=2030-12-31');
      const titles = calRes.body.data.activities.map((a: any) => a.title);
      expect(titles).not.toContain('Isolated Template');
    });

    it('should not appear in normal workout list', async () => {
      await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        title: 'Template Not In List',
      });
      const listRes = await request(app).get('/api/workouts');
      const titles = listRes.body.data.map((a: any) => a.title);
      expect(titles).not.toContain('Template Not In List');
    });
  });

  describe('PLAN-015 integration — created template appears in template list', () => {
    it('should appear in GET /api/workouts/templates', async () => {
      await request(app).post('/api/workouts/templates').send({
        activityType: 'cycling',
        title: 'New Template',
      });
      const listRes = await request(app).get('/api/workouts/templates');
      expect(listRes.body.data).toHaveLength(1);
      expect(listRes.body.data[0].title).toBe('New Template');
      expect(listRes.body.data[0].template).toBe(true);
    });
  });

  describe('Validation', () => {
    it('should reject missing activityType', async () => {
      const res = await request(app).post('/api/workouts/templates').send({});
      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('activityType');
    });

    it('should reject empty activityType', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: '' });
      expect(res.status).toBe(400);
    });

    it('should reject non-string activityType', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: 123 });
      expect(res.status).toBe(400);
    });

    it('should reject negative plannedDurationSeconds', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: 'cycling', plannedDurationSeconds: -100 });
      expect(res.status).toBe(400);
    });

    it('should reject negative plannedDistanceMeters', async () => {
      const res = await request(app).post('/api/workouts/templates').send({ activityType: 'cycling', plannedDistanceMeters: -50 });
      expect(res.status).toBe(400);
    });

    it('should reject non-object body', async () => {
      const res = await request(app).post('/api/workouts/templates')
        .set('Content-Type', 'application/json')
        .send('null');
      // body-parser strict mode rejects non-object JSON
      expect([400, 500]).toContain(res.status);
    });
  });
});
