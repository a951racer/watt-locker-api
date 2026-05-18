import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { IWorkoutService, ListWorkoutsOptions } from '../services/workoutService';
import { IUploadService } from '../services/uploadService';
import { ValidationError } from '../utils/errors';
import { successResponse } from '../utils/response';

/**
 * Creates the workouts router with injected dependencies.
 * All endpoints require JWT authentication (applied via authMiddleware).
 */
export function createWorkoutsRouter(
  workoutService: IWorkoutService,
  uploadService: IUploadService,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  // Apply auth middleware to all workout routes
  router.use(authMiddleware);

  /**
   * GET /api/workouts
   * List workouts with pagination, sorting, and filtering.
   * Query params: page, pageSize, sortBy, sortOrder, dateFrom, dateTo, activityType, dataSource
   */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const options = parseListOptions(req);
      const result = await workoutService.listWorkouts(req.user!.userId, options);

      res.status(200).json(successResponse(result.items, result.pagination));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/workouts/:id
   * Get a single workout by ID.
   */
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const workout = await workoutService.getWorkout(id, req.user!.userId);

      res.status(200).json(successResponse(workout));
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/workouts/:id
   * Update workout metadata (title, description, tags, activityType).
   */
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const updates = req.body;

      validateWorkoutUpdate(updates);

      const updated = await workoutService.updateWorkout(id, req.user!.userId, updates);
      res.status(200).json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/workouts/:id
   * Delete a workout. Optional query param: removeFromDrive (boolean).
   */
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const removeFromDrive = req.query.removeFromDrive === 'true';

      await workoutService.deleteWorkout(id, req.user!.userId, { removeFromDrive });
      res.status(200).json(successResponse({ deleted: true }));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/workouts/upload
   * Upload a single workout file.
   * Expects multipart/form-data with a 'file' field, or raw body with filename header.
   */
  router.post('/upload', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buffer, fileName } = extractFileFromRequest(req);
      const dataSource = req.body?.dataSource ?? 'manual';

      const result = await uploadService.uploadSingle(buffer, fileName, req.user!.userId, {
        dataSource,
      });

      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/workouts/upload/bulk
   * Upload multiple workout files.
   * Expects multipart/form-data with multiple 'files' fields, or JSON body with file data.
   */
  router.post('/upload/bulk', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = extractFilesFromRequest(req);
      const dataSource = req.body?.dataSource ?? 'manual';

      if (files.length === 0) {
        throw new ValidationError('At least one file is required', { field: 'files' });
      }

      const result = await uploadService.uploadBulk(files, req.user!.userId, { dataSource });
      res.status(200).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/workouts/ingest/inbox
   * Trigger ingestion from the user's Google Drive inbox folder.
   */
  router.post('/ingest/inbox', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await uploadService.ingestFromInbox(req.user!.userId);
      res.status(200).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Parse list query parameters into ListWorkoutsOptions.
 */
function parseListOptions(req: Request): ListWorkoutsOptions {
  const options: ListWorkoutsOptions = {};

  if (req.query.page) {
    const page = parseInt(req.query.page as string, 10);
    if (isNaN(page) || page < 1) {
      throw new ValidationError('page must be a positive integer', { field: 'page' });
    }
    options.page = page;
  }

  if (req.query.pageSize) {
    const pageSize = parseInt(req.query.pageSize as string, 10);
    if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ValidationError('pageSize must be between 1 and 100', { field: 'pageSize' });
    }
    options.pageSize = pageSize;
  }

  if (req.query.sortBy) {
    const sortBy = req.query.sortBy as string;
    if (!['date', 'duration', 'distance'].includes(sortBy)) {
      throw new ValidationError('sortBy must be one of: date, duration, distance', {
        field: 'sortBy',
      });
    }
    options.sortBy = sortBy as 'date' | 'duration' | 'distance';
  }

  if (req.query.sortOrder) {
    const sortOrder = req.query.sortOrder as string;
    if (!['asc', 'desc'].includes(sortOrder)) {
      throw new ValidationError('sortOrder must be one of: asc, desc', { field: 'sortOrder' });
    }
    options.sortOrder = sortOrder as 'asc' | 'desc';
  }

  if (req.query.dateFrom) {
    const dateFrom = new Date(req.query.dateFrom as string);
    if (isNaN(dateFrom.getTime())) {
      throw new ValidationError('dateFrom must be a valid date', { field: 'dateFrom' });
    }
    options.dateFrom = dateFrom;
  }

  if (req.query.dateTo) {
    const dateTo = new Date(req.query.dateTo as string);
    if (isNaN(dateTo.getTime())) {
      throw new ValidationError('dateTo must be a valid date', { field: 'dateTo' });
    }
    options.dateTo = dateTo;
  }

  if (req.query.activityType) {
    options.activityType = req.query.activityType as string;
  }

  if (req.query.dataSource) {
    options.dataSource = req.query.dataSource as string;
  }

  return options;
}

/**
 * Validates the workout update payload.
 * Allowed fields: title, description, tags, activityType.
 */
function validateWorkoutUpdate(body: unknown): void {
  if (body === null || typeof body !== 'object') {
    throw new ValidationError('Request body must be an object');
  }

  const payload = body as Record<string, unknown>;

  if ('title' in payload && payload.title !== undefined) {
    if (typeof payload.title !== 'string') {
      throw new ValidationError('title must be a string', { field: 'title' });
    }
  }

  if ('description' in payload && payload.description !== undefined) {
    if (typeof payload.description !== 'string') {
      throw new ValidationError('description must be a string', { field: 'description' });
    }
  }

  if ('tags' in payload && payload.tags !== undefined) {
    if (!Array.isArray(payload.tags)) {
      throw new ValidationError('tags must be an array of strings', { field: 'tags' });
    }
    for (const tag of payload.tags) {
      if (typeof tag !== 'string') {
        throw new ValidationError('Each tag must be a string', { field: 'tags' });
      }
    }
  }

  if ('activityType' in payload && payload.activityType !== undefined) {
    if (typeof payload.activityType !== 'string' || payload.activityType.trim() === '') {
      throw new ValidationError('activityType must be a non-empty string', {
        field: 'activityType',
      });
    }
  }
}

/**
 * Extract a single file from the request.
 * Supports: req.file (multer-style), or req.body with buffer/fileName fields.
 */
function extractFileFromRequest(req: Request): { buffer: Buffer; fileName: string } {
  // Support multer-style file attachment
  const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
  if (file) {
    return { buffer: file.buffer, fileName: file.originalname };
  }

  // Support raw body with fileName in body or header
  if (req.body?.file && req.body?.fileName) {
    const buffer = Buffer.isBuffer(req.body.file)
      ? req.body.file
      : Buffer.from(req.body.file, 'base64');
    return { buffer, fileName: req.body.fileName };
  }

  throw new ValidationError('A file is required. Provide a file via multipart upload or in the request body.', {
    field: 'file',
  });
}

/**
 * Extract multiple files from the request.
 * Supports: req.files (multer-style), or req.body.files array.
 */
function extractFilesFromRequest(req: Request): Array<{ buffer: Buffer; fileName: string }> {
  // Support multer-style files attachment
  const files = (req as unknown as { files?: Array<{ buffer: Buffer; originalname: string }> })
    .files;
  if (files && Array.isArray(files) && files.length > 0) {
    return files.map((f) => ({ buffer: f.buffer, fileName: f.originalname }));
  }

  // Support JSON body with files array
  if (req.body?.files && Array.isArray(req.body.files)) {
    return req.body.files.map((f: { file: string; fileName: string }) => ({
      buffer: Buffer.from(f.file, 'base64'),
      fileName: f.fileName,
    }));
  }

  return [];
}
