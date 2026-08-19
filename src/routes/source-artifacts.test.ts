/**
 * PLAN-024 Tests: Source Artifact API endpoints
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSourceArtifactsRouter } from './sourceArtifacts';
import { createWorkoutsRouter } from './workouts';
import { MongoSourceArtifactRepository, SourceArtifactRecord } from '../repositories/sourceArtifactRepository';
import { MongoWorkoutRepository } from '../repositories/workoutRepository';
import { WorkoutService } from '../services/workoutService';
import { errorHandler } from '../middleware/errorHandler';

const fakeAuthMiddleware = (userId: string) => (req: Request, _res: Response, next: NextFunction) => {
  req.user = { userId, email: `${userId}@test.com` };
  next();
};

const mockUploadService = {
  uploadFile: jest.fn(),
  uploadSingle: jest.fn(),
  uploadBulk: jest.fn(),
  ingestFromInbox: jest.fn(),
  intakeUpload: jest.fn(),
} as any;

describe('PLAN-024: Source Artifact API', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let sourceArtifactRepo: MongoSourceArtifactRepository;
  let workoutRepo: MongoWorkoutRepository;
  let app: express.Application;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();

    sourceArtifactRepo = new MongoSourceArtifactRepository(db);
    await sourceArtifactRepo.createIndexes();
    workoutRepo = new MongoWorkoutRepository(db);
    await workoutRepo.createIndexes();

    const workoutService = new WorkoutService(workoutRepo, {
      store: jest.fn(),
      retrieve: jest.fn(),
      delete: jest.fn(),
      listFiles: jest.fn().mockResolvedValue([]),
      removeFromFolder: jest.fn(),
    } as any);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).correlationId = 'test'; next(); });
    app.use('/api/source-artifacts', createSourceArtifactsRouter(sourceArtifactRepo, workoutRepo, fakeAuthMiddleware('user-1')));
    app.use('/api/workouts', createWorkoutsRouter(workoutService, mockUploadService, fakeAuthMiddleware('user-1'), undefined, workoutRepo, sourceArtifactRepo));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    await db.collection('sourceArtifacts').deleteMany({});
    await db.collection('workouts').deleteMany({});
  });

  /** Helper to create a workout directly in the DB */
  async function createWorkout(userId: string, overrides?: Record<string, unknown>): Promise<string> {
    const result = await db.collection('workouts').insertOne({
      userId,
      activityType: 'cycling',
      status: 'completed',
      template: false,
      date: '2024-06-15',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
    return result.insertedId.toHexString();
  }

  /** Helper to create an artifact */
  async function createArtifact(overrides?: Partial<Omit<SourceArtifactRecord, 'id' | 'createdAt' | 'updatedAt'>>): Promise<SourceArtifactRecord> {
    return sourceArtifactRepo.create({
      userId: 'user-1',
      source: 'manual',
      format: 'fit',
      originalFileName: 'workout.fit',
      importedAt: new Date(),
      driveFileId: 'drive-123',
      activityId: null,
      role: 'secondary',
      materialized: false,
      ...overrides,
    });
  }

  describe('GET /api/workouts/:id/sources', () => {
    it('should return artifacts for the Activity', async () => {
      const activityId = await createWorkout('user-1');
      await createArtifact({ activityId, role: 'primary', materialized: true });
      await createArtifact({ activityId, role: 'secondary' });

      const res = await request(app).get(`/api/workouts/${activityId}/sources`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].activityId).toBe(activityId);
      expect(res.body.data[1].activityId).toBe(activityId);
    });

    it('should return empty list when no artifacts exist', async () => {
      const activityId = await createWorkout('user-1');

      const res = await request(app).get(`/api/workouts/${activityId}/sources`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('should not return artifacts from another user', async () => {
      const activityId = await createWorkout('user-1');
      // Create artifact owned by user-2 but referencing same activityId
      await createArtifact({ userId: 'user-2', activityId, role: 'secondary' });

      const res = await request(app).get(`/api/workouts/${activityId}/sources`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('should return 404 for non-existent Activity', async () => {
      const res = await request(app).get('/api/workouts/aaaaaaaaaaaaaaaaaaaaaaaa/sources');

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/source-artifacts/:artifactId/promote', () => {
    it('should promote secondary to primary', async () => {
      const activityId = await createWorkout('user-1');
      const artifact = await createArtifact({ activityId, role: 'secondary' });

      const res = await request(app).put(`/api/source-artifacts/${artifact.id}/promote`);

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('primary');
      expect(res.body.data.materialized).toBe(true);
    });

    it('should demote existing primary when promoting', async () => {
      const activityId = await createWorkout('user-1');
      const primary = await createArtifact({ activityId, role: 'primary', materialized: true });
      const secondary = await createArtifact({ activityId, role: 'secondary', originalFileName: 'other.fit' });

      const res = await request(app).put(`/api/source-artifacts/${secondary.id}/promote`);

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('primary');

      // Verify old primary is now secondary
      const oldPrimary = await sourceArtifactRepo.findById(primary.id);
      expect(oldPrimary!.role).toBe('secondary');
      expect(oldPrimary!.materialized).toBe(false);
    });

    it('should reject promoting an unassociated artifact', async () => {
      const artifact = await createArtifact({ activityId: null, role: 'secondary' });

      const res = await request(app).put(`/api/source-artifacts/${artifact.id}/promote`);

      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toContain('not associated');
    });

    it('should reject promoting an already-primary artifact', async () => {
      const activityId = await createWorkout('user-1');
      const artifact = await createArtifact({ activityId, role: 'primary', materialized: true });

      const res = await request(app).put(`/api/source-artifacts/${artifact.id}/promote`);

      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toContain('already the primary');
    });

    it('should reject cross-user promote', async () => {
      const activityId = await createWorkout('user-2');
      const artifact = await createArtifact({ userId: 'user-2', activityId, role: 'secondary' });

      const res = await request(app).put(`/api/source-artifacts/${artifact.id}/promote`);

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/source-artifacts/:artifactId/associate', () => {
    it('should associate artifact to Activity without primary (becomes primary)', async () => {
      const activityId = await createWorkout('user-1');
      const artifact = await createArtifact({ activityId: null });

      const res = await request(app)
        .put(`/api/source-artifacts/${artifact.id}/associate`)
        .send({ activityId });

      expect(res.status).toBe(200);
      expect(res.body.data.activityId).toBe(activityId);
      expect(res.body.data.role).toBe('primary');
      expect(res.body.data.materialized).toBe(true);
    });

    it('should associate artifact to Activity with existing primary (becomes secondary)', async () => {
      const activityId = await createWorkout('user-1');
      await createArtifact({ activityId, role: 'primary', materialized: true });
      const artifact = await createArtifact({ activityId: null, originalFileName: 'second.fit' });

      const res = await request(app)
        .put(`/api/source-artifacts/${artifact.id}/associate`)
        .send({ activityId });

      expect(res.status).toBe(200);
      expect(res.body.data.activityId).toBe(activityId);
      expect(res.body.data.role).toBe('secondary');
      expect(res.body.data.materialized).toBe(false);
    });

    it('should reject cross-user associate (artifact belongs to other user)', async () => {
      const activityId = await createWorkout('user-1');
      const artifact = await createArtifact({ userId: 'user-2', activityId: null });

      const res = await request(app)
        .put(`/api/source-artifacts/${artifact.id}/associate`)
        .send({ activityId });

      expect(res.status).toBe(404);
    });

    it('should reject associate to Activity belonging to other user', async () => {
      const activityId = await createWorkout('user-2');
      const artifact = await createArtifact({ activityId: null });

      const res = await request(app)
        .put(`/api/source-artifacts/${artifact.id}/associate`)
        .send({ activityId });

      expect(res.status).toBe(404);
    });

    it('should reject missing activityId', async () => {
      const artifact = await createArtifact({ activityId: null });

      const res = await request(app)
        .put(`/api/source-artifacts/${artifact.id}/associate`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/source-artifacts/:artifactId/disassociate', () => {
    it('should disassociate artifact from Activity', async () => {
      const activityId = await createWorkout('user-1');
      const artifact = await createArtifact({ activityId, role: 'primary', materialized: true });

      const res = await request(app).put(`/api/source-artifacts/${artifact.id}/disassociate`);

      expect(res.status).toBe(200);
      expect(res.body.data.activityId).toBeNull();
      expect(res.body.data.role).toBe('secondary');
      expect(res.body.data.materialized).toBe(false);
    });

    it('should reject cross-user disassociate', async () => {
      const activityId = await createWorkout('user-2');
      const artifact = await createArtifact({ userId: 'user-2', activityId, role: 'secondary' });

      const res = await request(app).put(`/api/source-artifacts/${artifact.id}/disassociate`);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/source-artifacts/unassociated', () => {
    it('should return only unassociated artifacts', async () => {
      const activityId = await createWorkout('user-1');
      await createArtifact({ activityId, role: 'primary', materialized: true });
      const unassociated = await createArtifact({ activityId: null, originalFileName: 'orphan.fit' });

      const res = await request(app).get('/api/source-artifacts/unassociated');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(unassociated.id);
      expect(res.body.data[0].activityId).toBeNull();
    });

    it('should not return artifacts from other users', async () => {
      await createArtifact({ userId: 'user-2', activityId: null });

      const res = await request(app).get('/api/source-artifacts/unassociated');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('should return empty list when all artifacts are associated', async () => {
      const activityId = await createWorkout('user-1');
      await createArtifact({ activityId, role: 'primary', materialized: true });

      const res = await request(app).get('/api/source-artifacts/unassociated');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('Activity deletion disassociates artifacts', () => {
    it('should disassociate all artifacts when Activity is deleted', async () => {
      const activityId = await createWorkout('user-1');
      const a1 = await createArtifact({ activityId, role: 'primary', materialized: true });
      const a2 = await createArtifact({ activityId, role: 'secondary', originalFileName: 'backup.fit' });

      const res = await request(app).delete(`/api/workouts/${activityId}`);

      expect(res.status).toBe(200);

      // Verify artifacts are now unassociated
      const artifact1 = await sourceArtifactRepo.findById(a1.id);
      expect(artifact1!.activityId).toBeNull();
      expect(artifact1!.role).toBe('secondary');

      const artifact2 = await sourceArtifactRepo.findById(a2.id);
      expect(artifact2!.activityId).toBeNull();
      expect(artifact2!.role).toBe('secondary');
    });
  });
});
