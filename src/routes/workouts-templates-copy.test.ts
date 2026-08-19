/**
 * PLAN-017 Tests: POST /api/workouts/templates/:id/copy — Copy template to planned Activity
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db, ObjectId } from 'mongodb';
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

describe('PLAN-017: POST /api/workouts/templates/:id/copy — Copy template', () => {
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

  async function createTemplate(overrides?: Record<string, unknown>) {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'cycling', template: true,
      title: 'VO2 Max Intervals',
      description: '5x5min at 120% FTP',
      plannedDurationSeconds: 3600,
      plannedDistanceMeters: 30000,
      plannedTss: 90,
      tags: ['vo2', 'intervals'],
      segments: [{ duration: 300, power: 350 }, { duration: 300, power: 150 }],
      targetPowerMin: 300, targetPowerMax: 380,
      equipment: { equipmentId: 'bike-1', configurationId: 'road' },
      createdAt: new Date(), updatedAt: new Date(),
      ...overrides,
    });
    return result.insertedId.toHexString();
  }

  describe('1. Minimal copy', () => {
    it('should create a new planned Activity from a template', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.id).not.toBe(templateId);
      expect(res.body.data.template).toBe(false);
      expect(res.body.data.status).toBe('planned');
      expect(res.body.data.date).toBe('2027-09-15');
      expect(res.body.data.userId).toBe('user-1');
    });
  });

  describe('2. Field-copy matrix', () => {
    it('should copy all approved planning fields', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      expect(res.body.data.activityType).toBe('cycling');
      expect(res.body.data.title).toBe('VO2 Max Intervals');
      expect(res.body.data.description).toBe('5x5min at 120% FTP');
      expect(res.body.data.plannedDurationSeconds).toBe(3600);
      expect(res.body.data.plannedDistanceMeters).toBe(30000);
      expect(res.body.data.tags).toEqual(['vo2', 'intervals']);
    });

    it('should copy segments and targets to DB', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(res.body.data.id) });
      expect(doc!.segments).toEqual([{ duration: 300, power: 350 }, { duration: 300, power: 150 }]);
      expect(doc!.targetPowerMin).toBe(300);
      expect(doc!.targetPowerMax).toBe(380);
      expect(doc!.equipment).toEqual({ equipmentId: 'bike-1', configurationId: 'road' });
    });
  });

  describe('3. Explicit no-copy matrix', () => {
    it('should NOT copy comment/comments', async () => {
      const templateId = await createTemplate({ comment: 'Legacy comment', comments: 'Some notes' });
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(res.body.data.id) });
      expect(doc!.comment).toBeUndefined();
      expect(doc!.comments).toBeUndefined();
    });

    it('should NOT copy eventId', async () => {
      const templateId = await createTemplate({ eventId: 'event-123' });
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(res.body.data.id) });
      expect(doc!.eventId).toBeUndefined();
    });
  });

  describe('4. Lifecycle transformation', () => {
    it('should transform template semantics to planned Activity semantics', async () => {
      const templateId = await createTemplate();
      // Verify source is a template with null status/date
      const sourceDoc = await db.collection('workouts').findOne({ _id: new ObjectId(templateId) });
      expect(sourceDoc!.template).toBe(true);
      expect(sourceDoc!.status).toBeUndefined();
      expect(sourceDoc!.date).toBeUndefined();

      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      expect(res.body.data.template).toBe(false);
      expect(res.body.data.status).toBe('planned');
      expect(res.body.data.date).toBe('2027-09-15');
    });
  });

  describe('5. New identity', () => {
    it('should create a new ID different from source', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      expect(res.body.data.id).not.toBe(templateId);
    });
  });

  describe('6. Source preservation', () => {
    it('should not modify the source template', async () => {
      const templateId = await createTemplate();
      const beforeDoc = await db.collection('workouts').findOne({ _id: new ObjectId(templateId) });
      const beforeUpdatedAt = beforeDoc!.updatedAt;

      await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });

      const afterDoc = await db.collection('workouts').findOne({ _id: new ObjectId(templateId) });
      expect(afterDoc!.template).toBe(true);
      expect(afterDoc!.status).toBeUndefined();
      expect(afterDoc!.date).toBeUndefined();
      expect(afterDoc!.title).toBe('VO2 Max Intervals');
      expect(afterDoc!.updatedAt.getTime()).toBe(beforeUpdatedAt.getTime());
    });
  });

  describe('7. Actual/source data protection', () => {
    it('should NOT copy actual metrics or source data', async () => {
      const templateId = await createTemplate({
        startTime: new Date(), endTime: new Date(),
        durationSeconds: 5400, distanceMeters: 45000,
        avgPowerWatts: 220, tss: 80,
        dataSource: 'strava', sourceActivityId: 'strava-123',
        driveFileId: 'drive-abc',
      });
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(res.body.data.id) });
      expect(doc!.startTime).toBeUndefined();
      expect(doc!.endTime).toBeUndefined();
      expect(doc!.durationSeconds).toBeUndefined();
      expect(doc!.distanceMeters).toBeUndefined();
      expect(doc!.avgPowerWatts).toBeUndefined();
      expect(doc!.tss).toBeUndefined();
      expect(doc!.dataSource).toBeUndefined();
      expect(doc!.sourceActivityId).toBeUndefined();
      expect(doc!.driveFileId).toBeUndefined();
    });
  });

  describe('8. Date validation', () => {
    it('should reject missing date', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({});
      expect(res.status).toBe(400);
    });

    it('should reject malformed date', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '09/15/2027' });
      expect(res.status).toBe(400);
    });

    it('should reject impossible calendar date', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-02-30' });
      expect(res.status).toBe(400);
    });

    it('should reject non-string date', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: 20270915 });
      expect(res.status).toBe(400);
    });

    it('should accept valid date', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      expect(res.status).toBe(201);
      expect(res.body.data.date).toBe('2027-09-15');
    });
  });

  describe('9. Ownership', () => {
    it('should assign new Activity to authenticated user', async () => {
      const templateId = await createTemplate();
      const res = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      expect(res.body.data.userId).toBe('user-1');
    });

    it('should reject copying another user template', async () => {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-2', activityType: 'cycling', template: true,
        title: 'User 2 Template', createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).post(`/api/workouts/templates/${result.insertedId.toHexString()}/copy`).send({ date: '2027-09-15' });
      expect(res.status).toBe(404);
    });
  });

  describe('10. Non-template source', () => {
    it('should reject copying a non-template Activity', async () => {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
        date: '2027-09-01', createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).post(`/api/workouts/templates/${result.insertedId.toHexString()}/copy`).send({ date: '2027-09-15' });
      expect(res.status).toBe(400);
    });

    it('should reject nonexistent template', async () => {
      const res = await request(app).post('/api/workouts/templates/000000000000000000000000/copy').send({ date: '2027-09-15' });
      expect(res.status).toBe(404);
    });
  });

  describe('11. PLAN-015 integration', () => {
    it('should still list the original template after copy', async () => {
      const templateId = await createTemplate();
      await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      const listRes = await request(app).get('/api/workouts/templates');
      expect(listRes.body.data).toHaveLength(1);
      expect(listRes.body.data[0].id).toBe(templateId);
      expect(listRes.body.data[0].template).toBe(true);
    });

    it('should NOT show the copied Activity in template list', async () => {
      const templateId = await createTemplate();
      const copyRes = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      const listRes = await request(app).get('/api/workouts/templates');
      const ids = listRes.body.data.map((a: any) => a.id);
      expect(ids).not.toContain(copyRes.body.data.id);
    });
  });

  describe('12. Calendar integration', () => {
    it('should show the copied Activity in calendar query', async () => {
      const templateId = await createTemplate();
      const copyRes = await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      const calRes = await request(app).get('/api/workouts/calendar?dateFrom=2027-09-15&dateTo=2027-09-15');
      expect(calRes.body.data).toHaveLength(1);
      expect(calRes.body.data[0].id).toBe(copyRes.body.data.id);
      expect(calRes.body.data[0].status).toBe('planned');
    });

    it('should NOT show the source template in calendar', async () => {
      const templateId = await createTemplate();
      await request(app).post(`/api/workouts/templates/${templateId}/copy`).send({ date: '2027-09-15' });
      const calRes = await request(app).get('/api/workouts/calendar?dateFrom=2027-09-15&dateTo=2027-09-15');
      const ids = calRes.body.data.map((a: any) => a.id);
      expect(ids).not.toContain(templateId);
    });
  });
});
