/**
 * PLAN-015 Tests: GET /api/workouts/templates — Template library listing
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

describe('PLAN-015: GET /api/workouts/templates — Template library', () => {
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

  async function seedData() {
    await db.collection('workouts').insertMany([
      // Templates
      { userId: 'user-1', activityType: 'cycling', template: true, title: 'VO2 Max Intervals', plannedDurationSeconds: 3600, createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'cycling', template: true, title: 'Sweet Spot Tempo', plannedDurationSeconds: 5400, createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'running', template: true, title: 'Long Endurance Run', plannedDurationSeconds: 7200, createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'strength', template: true, title: 'Core Strength', plannedDurationSeconds: 2700, createdAt: new Date(), updatedAt: new Date() },
      // Non-template Activities (should NOT appear)
      { userId: 'user-1', activityType: 'cycling', status: 'planned', template: false, date: '2027-03-01', title: 'Planned Ride', createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'ride', status: 'completed', template: false, date: '2027-03-02', title: 'Completed Ride', createdAt: new Date(), updatedAt: new Date() },
      { userId: 'user-1', activityType: 'cycling', status: 'skipped', template: false, date: '2027-03-03', title: 'Skipped Ride', createdAt: new Date(), updatedAt: new Date() },
      // Another user's template (should NOT appear)
      { userId: 'user-2', activityType: 'cycling', template: true, title: 'User 2 Template', createdAt: new Date(), updatedAt: new Date() },
    ]);
  }

  describe('Basic template listing', () => {
    beforeEach(seedData);

    it('should return only templates', async () => {
      const res = await request(app).get('/api/workouts/templates');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(4);
      const titles = res.body.data.map((a: any) => a.title);
      expect(titles).toContain('VO2 Max Intervals');
      expect(titles).toContain('Sweet Spot Tempo');
      expect(titles).toContain('Long Endurance Run');
      expect(titles).toContain('Core Strength');
    });

    it('should NOT return non-template Activities', async () => {
      const res = await request(app).get('/api/workouts/templates');
      const titles = res.body.data.map((a: any) => a.title);
      expect(titles).not.toContain('Planned Ride');
      expect(titles).not.toContain('Completed Ride');
      expect(titles).not.toContain('Skipped Ride');
    });
  });

  describe('Ownership', () => {
    beforeEach(seedData);

    it('should NOT return templates belonging to another user', async () => {
      const res = await request(app).get('/api/workouts/templates');
      const titles = res.body.data.map((a: any) => a.title);
      expect(titles).not.toContain('User 2 Template');
    });
  });

  describe('Search — title text match', () => {
    beforeEach(seedData);

    it('should filter templates by title search', async () => {
      const res = await request(app).get('/api/workouts/templates?search=VO2');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('VO2 Max Intervals');
    });

    it('should be case-insensitive', async () => {
      const res = await request(app).get('/api/workouts/templates?search=vo2');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('VO2 Max Intervals');
    });

    it('should return all templates when search is empty', async () => {
      const res = await request(app).get('/api/workouts/templates?search=');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(4);
    });

    it('should return empty when search matches nothing', async () => {
      const res = await request(app).get('/api/workouts/templates?search=nonexistent');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('Search — title-only', () => {
    it('should NOT match search term in description or activityType', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', template: true,
        title: 'General Ride',
        description: 'VO2 intervals included in this workout',
        createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/templates?search=VO2');
      // Should NOT return 'General Ride' because VO2 is only in description
      const titles = res.body.data.map((a: any) => a.title);
      expect(titles).not.toContain('General Ride');
    });
  });

  describe('Activity type filter', () => {
    beforeEach(seedData);

    it('should filter by activityType=cycling', async () => {
      const res = await request(app).get('/api/workouts/templates?activityType=cycling');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      res.body.data.forEach((a: any) => expect(a.activityType).toBe('cycling'));
    });

    it('should filter by activityType=running', async () => {
      const res = await request(app).get('/api/workouts/templates?activityType=running');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].activityType).toBe('running');
    });

    it('should return all templates when activityType is omitted', async () => {
      const res = await request(app).get('/api/workouts/templates');
      expect(res.body.data).toHaveLength(4);
    });
  });

  describe('Combined filters — AND semantics', () => {
    beforeEach(seedData);

    it('should AND search and activityType', async () => {
      // 'Sweet Spot Tempo' is cycling, 'Long Endurance Run' is running
      const res = await request(app).get('/api/workouts/templates?search=Endurance&activityType=running');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('Long Endurance Run');
    });

    it('should return empty when title matches but activityType does not', async () => {
      const res = await request(app).get('/api/workouts/templates?search=VO2&activityType=running');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('should return empty when activityType matches but title does not', async () => {
      const res = await request(app).get('/api/workouts/templates?search=nonexistent&activityType=cycling');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('Pagination', () => {
    beforeEach(async () => {
      // Create 5 templates
      const templates = Array.from({ length: 5 }, (_, i) => ({
        userId: 'user-1', activityType: 'cycling', template: true,
        title: `Template ${i + 1}`, createdAt: new Date(), updatedAt: new Date(),
      }));
      await db.collection('workouts').insertMany(templates);
    });

    it('should respect pageSize', async () => {
      const res = await request(app).get('/api/workouts/templates?pageSize=2');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('should return correct pagination metadata', async () => {
      const res = await request(app).get('/api/workouts/templates?page=1&pageSize=2');
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.pageSize).toBe(2);
      expect(res.body.pagination.totalItems).toBe(5);
      expect(res.body.pagination.totalPages).toBe(3);
    });

    it('should return page 2 correctly', async () => {
      const res = await request(app).get('/api/workouts/templates?page=2&pageSize=2');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination.page).toBe(2);
    });

    it('should return empty array for page beyond results', async () => {
      const res = await request(app).get('/api/workouts/templates?page=10&pageSize=2');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('Empty results', () => {
    it('should return HTTP 200 with empty data array when no templates exist', async () => {
      const res = await request(app).get('/api/workouts/templates');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('Template with status field edge case', () => {
    it('should return a template even if it has a status field', async () => {
      await db.collection('workouts').insertOne({
        userId: 'user-1', activityType: 'cycling', template: true,
        status: 'planned', // Malformed but template flag takes precedence
        title: 'Template With Status', createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await request(app).get('/api/workouts/templates');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('Template With Status');
    });
  });

  describe('Validation', () => {
    it('should reject invalid page value', async () => {
      const res = await request(app).get('/api/workouts/templates?page=0');
      expect(res.status).toBe(400);
    });

    it('should reject invalid pageSize value', async () => {
      const res = await request(app).get('/api/workouts/templates?pageSize=0');
      expect(res.status).toBe(400);
    });
  });
});
