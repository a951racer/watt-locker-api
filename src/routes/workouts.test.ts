import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createWorkoutsRouter } from './workouts';
import { IWorkoutService } from '../services/workoutService';
import { IUploadService } from '../services/uploadService';
import { errorHandler } from '../middleware/errorHandler';
import { NotFoundError } from '../utils/errors';
import { WorkoutRecord } from '../models/workout';
import { PaginatedResult } from '../models/api';

/** Create a mock WorkoutService */
function createMockWorkoutService(): jest.Mocked<IWorkoutService> {
  return {
    getWorkout: jest.fn(),
    listWorkouts: jest.fn(),
    updateWorkout: jest.fn(),
    deleteWorkout: jest.fn(),
  };
}

/** Create a mock UploadService */
function createMockUploadService(): jest.Mocked<IUploadService> {
  return {
    uploadSingle: jest.fn(),
    uploadBulk: jest.fn(),
    ingestFromInbox: jest.fn(),
  };
}

/** Fake auth middleware that always attaches a user context */
function fakeAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.user = { userId: 'user-123', email: 'test@example.com' };
  next();
}

/** Fake auth middleware that rejects unauthenticated requests */
function rejectingAuthMiddleware(_req: Request, res: Response): void {
  res.status(401).json({
    data: null,
    errors: [{ code: 'AUTHENTICATION_ERROR', message: 'Missing or malformed authorization header' }],
    pagination: null,
    correlationId: 'test-correlation-id',
  });
}

/** Create a minimal Express app with the workouts router and error handler */
function createTestApp(
  workoutService: IWorkoutService,
  uploadService: IUploadService,
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  app.use('/api/workouts', createWorkoutsRouter(workoutService, uploadService, authMiddleware));
  app.use(errorHandler);
  return app;
}

/** Sample workout record for testing */
function sampleWorkout(overrides?: Partial<WorkoutRecord>): WorkoutRecord {
  return {
    id: 'workout-1',
    userId: 'user-123',
    activityType: 'ride',
    startTime: new Date('2024-01-15T08:00:00Z'),
    endTime: new Date('2024-01-15T09:30:00Z'),
    durationSeconds: 5400,
    distanceMeters: 45000,
    elevationGainMeters: 600,
    dataSource: 'manual',
    fileFormat: 'fit',
    driveFileId: 'drive-file-1',
    createdAt: new Date('2024-01-15T10:00:00Z'),
    updatedAt: new Date('2024-01-15T10:00:00Z'),
    ...overrides,
  };
}

describe('Workouts Routes', () => {
  let mockWorkoutService: jest.Mocked<IWorkoutService>;
  let mockUploadService: jest.Mocked<IUploadService>;
  let app: express.Application;

  beforeEach(() => {
    mockWorkoutService = createMockWorkoutService();
    mockUploadService = createMockUploadService();
    app = createTestApp(mockWorkoutService, mockUploadService, fakeAuthMiddleware);
  });

  describe('GET /api/workouts', () => {
    it('should return paginated list of workouts', async () => {
      const paginatedResult: PaginatedResult<WorkoutRecord> = {
        items: [sampleWorkout()],
        pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      };
      mockWorkoutService.listWorkouts.mockResolvedValue(paginatedResult);

      const res = await request(app).get('/api/workouts');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination).toEqual({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
      expect(res.body.errors).toBeNull();
    });

    it('should pass query params to service', async () => {
      const paginatedResult: PaginatedResult<WorkoutRecord> = {
        items: [],
        pagination: { page: 2, pageSize: 10, totalItems: 0, totalPages: 0 },
      };
      mockWorkoutService.listWorkouts.mockResolvedValue(paginatedResult);

      await request(app)
        .get('/api/workouts')
        .query({ page: '2', pageSize: '10', sortBy: 'duration', sortOrder: 'asc', activityType: 'ride' });

      expect(mockWorkoutService.listWorkouts).toHaveBeenCalledWith('user-123', {
        page: 2,
        pageSize: 10,
        sortBy: 'duration',
        sortOrder: 'asc',
        activityType: 'ride',
      });
    });

    it('should pass date filters to service', async () => {
      const paginatedResult: PaginatedResult<WorkoutRecord> = {
        items: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      };
      mockWorkoutService.listWorkouts.mockResolvedValue(paginatedResult);

      await request(app)
        .get('/api/workouts')
        .query({ dateFrom: '2024-01-01', dateTo: '2024-12-31', dataSource: 'strava' });

      expect(mockWorkoutService.listWorkouts).toHaveBeenCalledWith('user-123', {
        dateFrom: new Date('2024-01-01'),
        dateTo: new Date('2024-12-31'),
        dataSource: 'strava',
      });
    });

    it('should return 400 for invalid page parameter', async () => {
      const res = await request(app).get('/api/workouts').query({ page: '-1' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('page');
    });

    it('should return 400 for invalid pageSize parameter', async () => {
      const res = await request(app).get('/api/workouts').query({ pageSize: '200' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('pageSize');
    });

    it('should return 400 for invalid sortBy parameter', async () => {
      const res = await request(app).get('/api/workouts').query({ sortBy: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('sortBy');
    });

    it('should return 400 for invalid sortOrder parameter', async () => {
      const res = await request(app).get('/api/workouts').query({ sortOrder: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('sortOrder');
    });

    it('should return 400 for invalid dateFrom parameter', async () => {
      const res = await request(app).get('/api/workouts').query({ dateFrom: 'not-a-date' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('dateFrom');
    });

    it('should require authentication', async () => {
      const unauthApp = createTestApp(mockWorkoutService, mockUploadService, rejectingAuthMiddleware);

      const res = await request(unauthApp).get('/api/workouts');

      expect(res.status).toBe(401);
      expect(res.body.errors[0].code).toBe('AUTHENTICATION_ERROR');
    });
  });

  describe('GET /api/workouts/:id', () => {
    it('should return a single workout', async () => {
      const workout = sampleWorkout();
      mockWorkoutService.getWorkout.mockResolvedValue(workout);

      const res = await request(app).get('/api/workouts/workout-1');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('workout-1');
      expect(res.body.errors).toBeNull();
    });

    it('should call getWorkout with correct params', async () => {
      mockWorkoutService.getWorkout.mockResolvedValue(sampleWorkout());

      await request(app).get('/api/workouts/workout-1');

      expect(mockWorkoutService.getWorkout).toHaveBeenCalledWith('workout-1', 'user-123');
    });

    it('should return 404 when workout not found', async () => {
      mockWorkoutService.getWorkout.mockRejectedValue(new NotFoundError('Workout not found'));

      const res = await request(app).get('/api/workouts/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe('NOT_FOUND');
    });

    it('should require authentication', async () => {
      const unauthApp = createTestApp(mockWorkoutService, mockUploadService, rejectingAuthMiddleware);

      const res = await request(unauthApp).get('/api/workouts/workout-1');

      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/workouts/:id', () => {
    it('should update workout metadata and return updated record', async () => {
      const updated = sampleWorkout({ title: 'Morning Ride' });
      mockWorkoutService.updateWorkout.mockResolvedValue(updated);

      const res = await request(app)
        .put('/api/workouts/workout-1')
        .send({ title: 'Morning Ride' });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Morning Ride');
      expect(res.body.errors).toBeNull();
    });

    it('should call updateWorkout with correct params', async () => {
      mockWorkoutService.updateWorkout.mockResolvedValue(sampleWorkout());

      await request(app)
        .put('/api/workouts/workout-1')
        .send({ title: 'Updated', description: 'A ride', tags: ['morning'] });

      expect(mockWorkoutService.updateWorkout).toHaveBeenCalledWith('workout-1', 'user-123', {
        title: 'Updated',
        description: 'A ride',
        tags: ['morning'],
      });
    });

    it('should return 400 for invalid title type', async () => {
      const res = await request(app)
        .put('/api/workouts/workout-1')
        .send({ title: 123 });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('title');
    });

    it('should return 400 for invalid tags type', async () => {
      const res = await request(app)
        .put('/api/workouts/workout-1')
        .send({ tags: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('tags');
    });

    it('should return 400 for non-string tag in array', async () => {
      const res = await request(app)
        .put('/api/workouts/workout-1')
        .send({ tags: ['valid', 123] });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('tags');
    });

    it('should return 400 for empty activityType', async () => {
      const res = await request(app)
        .put('/api/workouts/workout-1')
        .send({ activityType: '  ' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('activityType');
    });

    it('should return 404 when workout not found', async () => {
      mockWorkoutService.updateWorkout.mockRejectedValue(new NotFoundError('Workout not found'));

      const res = await request(app)
        .put('/api/workouts/nonexistent')
        .send({ title: 'Test' });

      expect(res.status).toBe(404);
    });

    it('should require authentication', async () => {
      const unauthApp = createTestApp(mockWorkoutService, mockUploadService, rejectingAuthMiddleware);

      const res = await request(unauthApp)
        .put('/api/workouts/workout-1')
        .send({ title: 'Test' });

      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/workouts/:id', () => {
    it('should delete a workout and return success', async () => {
      mockWorkoutService.deleteWorkout.mockResolvedValue(undefined);

      const res = await request(app).delete('/api/workouts/workout-1');

      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
      expect(res.body.errors).toBeNull();
    });

    it('should pass removeFromDrive=false by default', async () => {
      mockWorkoutService.deleteWorkout.mockResolvedValue(undefined);

      await request(app).delete('/api/workouts/workout-1');

      expect(mockWorkoutService.deleteWorkout).toHaveBeenCalledWith('workout-1', 'user-123', {
        removeFromDrive: false,
      });
    });

    it('should pass removeFromDrive=true when query param is set', async () => {
      mockWorkoutService.deleteWorkout.mockResolvedValue(undefined);

      await request(app).delete('/api/workouts/workout-1').query({ removeFromDrive: 'true' });

      expect(mockWorkoutService.deleteWorkout).toHaveBeenCalledWith('workout-1', 'user-123', {
        removeFromDrive: true,
      });
    });

    it('should return 404 when workout not found', async () => {
      mockWorkoutService.deleteWorkout.mockRejectedValue(new NotFoundError('Workout not found'));

      const res = await request(app).delete('/api/workouts/nonexistent');

      expect(res.status).toBe(404);
    });

    it('should require authentication', async () => {
      const unauthApp = createTestApp(mockWorkoutService, mockUploadService, rejectingAuthMiddleware);

      const res = await request(unauthApp).delete('/api/workouts/workout-1');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/workouts/upload', () => {
    it('should upload a single file and return 201', async () => {
      const uploadResult = {
        workoutId: 'workout-new',
        driveFileId: 'drive-new',
        summary: {
          activityType: 'ride',
          startTime: new Date('2024-01-15T08:00:00Z'),
          durationSeconds: 3600,
          distanceMeters: 30000,
        },
      };
      mockUploadService.uploadSingle.mockResolvedValue(uploadResult);

      const res = await request(app)
        .post('/api/workouts/upload')
        .send({
          file: Buffer.from('fake-fit-data').toString('base64'),
          fileName: 'ride.fit',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.workoutId).toBe('workout-new');
      expect(res.body.errors).toBeNull();
    });

    it('should call uploadSingle with correct params', async () => {
      mockUploadService.uploadSingle.mockResolvedValue({
        workoutId: 'w1',
        driveFileId: 'd1',
        summary: { activityType: 'ride', startTime: new Date(), durationSeconds: 100, distanceMeters: 1000 },
      });

      await request(app)
        .post('/api/workouts/upload')
        .send({
          file: Buffer.from('data').toString('base64'),
          fileName: 'test.tcx',
          dataSource: 'strava',
        });

      expect(mockUploadService.uploadSingle).toHaveBeenCalledWith(
        expect.any(Buffer),
        'test.tcx',
        'user-123',
        { dataSource: 'strava' },
      );
    });

    it('should return 400 when no file is provided', async () => {
      const res = await request(app)
        .post('/api/workouts/upload')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('file');
    });

    it('should require authentication', async () => {
      const unauthApp = createTestApp(mockWorkoutService, mockUploadService, rejectingAuthMiddleware);

      const res = await request(unauthApp)
        .post('/api/workouts/upload')
        .send({ file: 'data', fileName: 'test.fit' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/workouts/upload/bulk', () => {
    it('should upload multiple files and return results', async () => {
      const bulkResult = {
        total: 2,
        successful: [
          { workoutId: 'w1', driveFileId: 'd1', summary: { activityType: 'ride', startTime: new Date(), durationSeconds: 100, distanceMeters: 1000 } },
        ],
        failed: [{ fileName: 'bad.fit', error: 'Parse error', errorCode: 'VALIDATION_ERROR' }],
        inProgress: 0,
      };
      mockUploadService.uploadBulk.mockResolvedValue(bulkResult);

      const res = await request(app)
        .post('/api/workouts/upload/bulk')
        .send({
          files: [
            { file: Buffer.from('data1').toString('base64'), fileName: 'ride1.fit' },
            { file: Buffer.from('data2').toString('base64'), fileName: 'ride2.fit' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.successful).toHaveLength(1);
      expect(res.body.data.failed).toHaveLength(1);
      expect(res.body.errors).toBeNull();
    });

    it('should return 400 when no files are provided', async () => {
      const res = await request(app)
        .post('/api/workouts/upload/bulk')
        .send({ files: [] });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('files');
    });

    it('should return 400 when files field is missing', async () => {
      const res = await request(app)
        .post('/api/workouts/upload/bulk')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.errors[0].field).toBe('files');
    });

    it('should require authentication', async () => {
      const unauthApp = createTestApp(mockWorkoutService, mockUploadService, rejectingAuthMiddleware);

      const res = await request(unauthApp)
        .post('/api/workouts/upload/bulk')
        .send({ files: [{ file: 'data', fileName: 'test.fit' }] });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/workouts/ingest/inbox', () => {
    it('should trigger inbox ingestion and return results', async () => {
      const ingestResult = {
        total: 3,
        successful: [
          { workoutId: 'w1', driveFileId: 'd1', summary: { activityType: 'ride', startTime: new Date(), durationSeconds: 100, distanceMeters: 1000 } },
        ],
        failed: [],
        inProgress: 0,
      };
      mockUploadService.ingestFromInbox.mockResolvedValue(ingestResult);

      const res = await request(app).post('/api/workouts/ingest/inbox');

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.errors).toBeNull();
    });

    it('should call ingestFromInbox with the authenticated userId', async () => {
      mockUploadService.ingestFromInbox.mockResolvedValue({
        total: 0,
        successful: [],
        failed: [],
        inProgress: 0,
      });

      await request(app).post('/api/workouts/ingest/inbox');

      expect(mockUploadService.ingestFromInbox).toHaveBeenCalledWith('user-123');
    });

    it('should require authentication', async () => {
      const unauthApp = createTestApp(mockWorkoutService, mockUploadService, rejectingAuthMiddleware);

      const res = await request(unauthApp).post('/api/workouts/ingest/inbox');

      expect(res.status).toBe(401);
    });

    it('should pass errors to the error handler', async () => {
      mockUploadService.ingestFromInbox.mockRejectedValue(new Error('Drive connection failed'));

      const res = await request(app).post('/api/workouts/ingest/inbox');

      expect(res.status).toBe(500);
    });
  });
});
