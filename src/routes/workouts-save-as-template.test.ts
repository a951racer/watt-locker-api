/**
 * PLAN-018 Tests: POST /api/workouts/:id/save-as-template — Save Activity as template
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

describe('PLAN-018: POST /api/workouts/:id/save-as-template', () => {
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

  async function createPlannedActivity() {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'cycling', status: 'planned', template: false,
      date: '2027-09-15', title: 'Sweet Spot Ride',
      description: '2x20min at 88-93% FTP',
      plannedDurationSeconds: 5400, plannedDistanceMeters: 40000, plannedTss: 75,
      tags: ['sweetspot', 'threshold'],
      segments: [{ duration: 1200, power: 260 }, { duration: 300, power: 150 }],
      targetPowerMin: 245, targetPowerMax: 270,
      equipment: { equipmentId: 'bike-1', configurationId: 'road' },
      comment: 'Looking forward to this one',
      eventId: 'event-abc',
      createdAt: new Date('2027-09-01T10:00:00Z'), updatedAt: new Date('2027-09-01T10:00:00Z'),
    });
    return result.insertedId.toHexString();
  }

  async function createCompletedActivity() {
    const result = await db.collection('workouts').insertOne({
      userId: 'user-1', activityType: 'ride', status: 'completed', template: false,
      date: '2027-08-20',
      title: 'Morning Ride', description: 'Tempo intervals',
      startTime: new Date('2027-08-20T07:00:00Z'), endTime: new Date('2027-08-20T08:30:00Z'),
      durationSeconds: 5400, distanceMeters: 45000, elevationGainMeters: 600,
      avgPowerWatts: 230, normalizedPowerWatts: 245, maxPowerWatts: 800,
      tss: 82, intensityFactor: 0.88, ftpUsed: 278,
      avgHeartRateBpm: 155, maxHeartRateBpm: 178,
      avgSpeedMps: 8.3, maxSpeedMps: 14.2,
      tags: ['tempo', 'morning'],
      segments: [{ duration: 600, power: 250 }],
      targetPowerMin: 230, targetPowerMax: 260,
      equipment: { equipmentId: 'bike-1', configurationId: 'road' },
      plannedDurationSeconds: 5400, plannedTss: 80,
      comment: 'Felt great today',
      eventId: 'event-xyz',
      dataSource: 'strava', sourceActivityId: 'strava-12345',
      driveFileId: 'drive-file-abc',
      createdAt: new Date('2027-08-20T09:00:00Z'), updatedAt: new Date('2027-08-20T09:00:00Z'),
    });
    return result.insertedId.toHexString();
  }

  describe('1. Planned Activity → Template', () => {
    it('should create a template from a planned Activity', async () => {
      const actId = await createPlannedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.id).not.toBe(actId);
      expect(res.body.data.template).toBe(true);
      expect(res.body.data.status).toBeNull();
      expect(res.body.data.date).toBeNull();
      expect(res.body.data.activityType).toBe('cycling');
      expect(res.body.data.title).toBe('Sweet Spot Ride');
      expect(res.body.data.description).toBe('2x20min at 88-93% FTP');
      expect(res.body.data.tags).toEqual(['sweetspot', 'threshold']);
    });

    it('should preserve the source planned Activity unchanged', async () => {
      const actId = await createPlannedActivity();
      const before = await db.collection('workouts').findOne({ _id: new ObjectId(actId) });
      await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      const after = await db.collection('workouts').findOne({ _id: new ObjectId(actId) });
      expect(after!.status).toBe('planned');
      expect(after!.template).toBe(false);
      expect(after!.date).toBe('2027-09-15');
      expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    });
  });

  describe('2. Completed Activity → Template', () => {
    it('should create a template from a completed Activity', async () => {
      const actId = await createCompletedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      expect(res.status).toBe(201);
      expect(res.body.data.template).toBe(true);
      expect(res.body.data.status).toBeNull();
      expect(res.body.data.date).toBeNull();
      // Reusable fields copied
      expect(res.body.data.activityType).toBe('ride');
      expect(res.body.data.title).toBe('Morning Ride');
      expect(res.body.data.description).toBe('Tempo intervals');
      expect(res.body.data.tags).toEqual(['tempo', 'morning']);
    });

    it('should NOT copy actual metrics from completed Activity', async () => {
      const actId = await createCompletedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(res.body.data.id) });
      expect(doc!.startTime).toBeUndefined();
      expect(doc!.endTime).toBeUndefined();
      expect(doc!.durationSeconds).toBeUndefined();
      expect(doc!.distanceMeters).toBeUndefined();
      expect(doc!.elevationGainMeters).toBeUndefined();
      expect(doc!.avgPowerWatts).toBeUndefined();
      expect(doc!.normalizedPowerWatts).toBeUndefined();
      expect(doc!.maxPowerWatts).toBeUndefined();
      expect(doc!.tss).toBeUndefined();
      expect(doc!.intensityFactor).toBeUndefined();
      expect(doc!.avgHeartRateBpm).toBeUndefined();
      expect(doc!.avgSpeedMps).toBeUndefined();
      expect(doc!.dataSource).toBeUndefined();
      expect(doc!.sourceActivityId).toBeUndefined();
      expect(doc!.driveFileId).toBeUndefined();
    });

    it('should copy segments, targets, equipment from completed Activity', async () => {
      const actId = await createCompletedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(res.body.data.id) });
      expect(doc!.segments).toEqual([{ duration: 600, power: 250 }]);
      expect(doc!.targetPowerMin).toBe(230);
      expect(doc!.targetPowerMax).toBe(260);
      expect(doc!.equipment).toEqual({ equipmentId: 'bike-1', configurationId: 'road' });
      expect(doc!.plannedDurationSeconds).toBe(5400);
      expect(doc!.plannedTss).toBe(80);
    });

    it('should preserve the source completed Activity unchanged', async () => {
      const actId = await createCompletedActivity();
      const before = await db.collection('workouts').findOne({ _id: new ObjectId(actId) });
      await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      const after = await db.collection('workouts').findOne({ _id: new ObjectId(actId) });
      expect(after!.status).toBe('completed');
      expect(after!.template).toBe(false);
      expect(after!.durationSeconds).toBe(5400);
      expect(after!.avgPowerWatts).toBe(230);
      expect(after!.tss).toBe(82);
      expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    });
  });

  describe('3. Template semantics', () => {
    it('should have null status in domain representation (not completed)', async () => {
      const actId = await createPlannedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      expect(res.body.data.status).toBeNull();
    });

    it('should have no status in raw persistence', async () => {
      const actId = await createPlannedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(res.body.data.id) });
      expect(doc!.status).toBeUndefined();
      expect(doc!.date).toBeUndefined();
    });
  });

  describe('4. New identity', () => {
    it('should create a different ID from source', async () => {
      const actId = await createPlannedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      expect(res.body.data.id).not.toBe(actId);
    });
  });

  describe('7. Comments exclusion', () => {
    it('should NOT copy comment from source', async () => {
      const actId = await createPlannedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(res.body.data.id) });
      expect(doc!.comment).toBeUndefined();
      expect(doc!.comments).toBeUndefined();
    });
  });

  describe('8. Event exclusion', () => {
    it('should NOT copy eventId from source', async () => {
      const actId = await createPlannedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(res.body.data.id) });
      expect(doc!.eventId).toBeUndefined();
    });
  });

  describe('9. Ownership', () => {
    it('should assign template to authenticated user', async () => {
      const actId = await createPlannedActivity();
      const res = await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      expect(res.body.data.userId).toBe('user-1');
    });

    it('should reject saving another user Activity as template', async () => {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-2', activityType: 'cycling', status: 'planned', template: false,
        date: '2027-09-15', createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).post(`/api/workouts/${result.insertedId.toHexString()}/save-as-template`).send({});
      expect(res.status).toBe(404);
    });
  });

  describe('10. Template source rejection', () => {
    it('should reject saving a template as a template', async () => {
      const result = await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', template: true,
        title: 'Existing Template', createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).post(`/api/workouts/${result.insertedId.toHexString()}/save-as-template`).send({});
      expect(res.status).toBe(400);
    });
  });

  describe('11. PLAN-015 integration', () => {
    it('should show new template in template list', async () => {
      const actId = await createPlannedActivity();
      await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      const listRes = await request(app).get('/api/workouts/templates');
      expect(listRes.body.data).toHaveLength(1);
      expect(listRes.body.data[0].template).toBe(true);
      expect(listRes.body.data[0].title).toBe('Sweet Spot Ride');
    });

    it('should NOT turn the source Activity into a template', async () => {
      const actId = await createPlannedActivity();
      await request(app).post(`/api/workouts/${actId}/save-as-template`).send({});
      const listRes = await request(app).get('/api/workouts/templates');
      const ids = listRes.body.data.map((a: any) => a.id);
      expect(ids).not.toContain(actId);
    });
  });

  describe('12. Nonexistent source', () => {
    it('should return 404 for nonexistent Activity', async () => {
      const res = await request(app).post('/api/workouts/000000000000000000000000/save-as-template').send({});
      expect(res.status).toBe(404);
    });

    it('should return 404 for invalid ObjectId', async () => {
      const res = await request(app).post('/api/workouts/not-valid-id/save-as-template').send({});
      expect(res.status).toBe(404);
    });
  });
});
