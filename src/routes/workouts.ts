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
   * GET /api/workouts/performance-metrics
   * Compute and return CTL (Fitness), ATL (Fatigue), and TSB (Form) over time.
   * Query params: days (number of days to return, default 90)
   */
  router.get('/performance-metrics', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = req.query.days ? parseInt(req.query.days as string, 10) : 90;
      if (isNaN(days) || days < 1 || days > 365) {
        throw new ValidationError('days must be between 1 and 365', { field: 'days' });
      }

      // Fetch all workouts for the user (need full history for accurate CTL)
      const allWorkouts = await workoutService.listWorkouts(req.user!.userId, {
        page: 1,
        pageSize: 10000,
        sortBy: 'date',
        sortOrder: 'asc',
      });

      // Aggregate daily TSS
      const dailyTSS: Map<string, number> = new Map();
      for (const w of allWorkouts.items) {
        const date = (w.startTime instanceof Date ? w.startTime : new Date(w.startTime))
          .toISOString().split('T')[0];
        const tss = (w as unknown as Record<string, unknown>).tss as number | undefined;
        if (tss != null) {
          dailyTSS.set(date, (dailyTSS.get(date) || 0) + tss);
        }
      }

      // Determine date range
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Find earliest workout date to start computation
      let startDate: Date;
      if (allWorkouts.items.length > 0) {
        const first = allWorkouts.items[0].startTime;
        startDate = new Date(first instanceof Date ? first : new Date(first));
        startDate.setHours(0, 0, 0, 0);
      } else {
        startDate = new Date(today);
        startDate.setDate(startDate.getDate() - days);
      }

      // Compute CTL/ATL/TSB from start through today
      let ctl = 0;
      let atl = 0;
      const results: Array<{ date: string; ctl: number; atl: number; tsb: number }> = [];

      const current = new Date(startDate);
      while (current <= today) {
        const dateStr = current.toISOString().split('T')[0];
        const tss = dailyTSS.get(dateStr) || 0;

        ctl = ctl + (tss - ctl) / 42;
        atl = atl + (tss - atl) / 7;
        const tsb = ctl - atl;

        results.push({
          date: dateStr,
          ctl: Math.round(ctl * 10) / 10,
          atl: Math.round(atl * 10) / 10,
          tsb: Math.round(tsb * 10) / 10,
        });

        current.setDate(current.getDate() + 1);
      }

      // Return only the last N days
      const output = results.slice(-days);

      res.status(200).json(successResponse(output));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/workouts/export
   * Export workouts as CSV. Respects filter query params.
   * Columns: id, date, duration, title, comment, tags, activityType
   */
  router.get('/export', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const options = parseListOptions(req);
      options.pageSize = 10000; // No pagination for export
      options.page = 1;
      const result = await workoutService.listWorkouts(req.user!.userId, options);

      const header = 'id,date,duration,title,comment,tags,activityType';
      const rows = result.items.map((w) => {
        const date = w.startTime instanceof Date
          ? w.startTime.toISOString().split('T')[0]
          : new Date(w.startTime).toISOString().split('T')[0];
        const duration = formatDurationForCsv(w.durationSeconds);
        const title = escapeCsvField(w.title || '');
        const comment = escapeCsvField((w as unknown as Record<string, unknown>).comment as string || '');
        const tags = (w.tags || []).join('|');
        const activityType = w.activityType || '';
        return `${w.id},${date},${duration},${title},${comment},${tags},${activityType}`;
      });

      const csv = [header, ...rows].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="workouts-export.csv"');
      res.status(200).send(csv);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/workouts/import
   * Import CSV to bulk update workout metadata.
   * Updatable columns: title, comment, tags
   * Read-only columns (rejected if changed): date, duration, activityType
   */
  router.post('/import', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { csv } = req.body;
      if (!csv || typeof csv !== 'string') {
        throw new ValidationError('CSV data is required in the "csv" field', { field: 'csv' });
      }

      const lines = csv.trim().split('\n');
      if (lines.length < 2) {
        throw new ValidationError('CSV must have a header row and at least one data row', { field: 'csv' });
      }

      const headerLine = lines[0].toLowerCase().trim();
      const headers = parseCsvLine(headerLine);
      const idIdx = headers.indexOf('id');
      if (idIdx === -1) {
        throw new ValidationError('CSV must have an "id" column', { field: 'csv' });
      }

      const titleIdx = headers.indexOf('title');
      const commentIdx = headers.indexOf('comment');
      const tagsIdx = headers.indexOf('tags');

      // Read-only columns: date, duration, activityType (present for context but not updatable)

      const results = { total: lines.length - 1, updated: 0, skipped: 0, failed: [] as Array<{ row: number; id: string; reason: string }> };

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) { results.skipped++; continue; }

        const fields = parseCsvLine(line);
        const id = fields[idIdx]?.trim();
        if (!id) {
          results.failed.push({ row: i + 1, id: '', reason: 'Missing workout ID' });
          continue;
        }

        // Build updates
        const updates: Record<string, unknown> = {};
        if (titleIdx !== -1 && fields[titleIdx] !== undefined && fields[titleIdx] !== '') {
          updates.title = fields[titleIdx];
        }
        if (commentIdx !== -1 && fields[commentIdx] !== undefined) {
          updates.comment = fields[commentIdx];
        }
        if (tagsIdx !== -1 && fields[tagsIdx] !== undefined && fields[tagsIdx] !== '') {
          updates.tags = fields[tagsIdx].split('|').map((t: string) => t.trim()).filter(Boolean);
        }

        if (Object.keys(updates).length === 0) {
          results.skipped++;
          continue;
        }

        try {
          await workoutService.updateWorkout(id, req.user!.userId, updates);
          results.updated++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results.failed.push({ row: i + 1, id, reason: message });
        }
      }

      res.status(200).json(successResponse(results));
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
   * Upload a single workout file or archive (.zip, .gz).
   * Expects multipart/form-data with a 'file' field, or raw body with filename header.
   */
  router.post('/upload', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { buffer, fileName } = extractFileFromRequest(req);
      const dataSource = req.body?.dataSource ?? 'manual';

      const result = await uploadService.uploadFile(buffer, fileName, req.user!.userId, {
        dataSource,
      });

      // If single file (not archive), return the first result directly for backward compat
      if (result.total === 1 && result.successful.length === 1) {
        res.status(201).json(successResponse(result.successful[0]));
      } else {
        res.status(200).json(successResponse(result));
      }
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
    if (isNaN(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new ValidationError('pageSize must be between 1 and 1000', { field: 'pageSize' });
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

  if ('comment' in payload && payload.comment !== undefined) {
    if (typeof payload.comment !== 'string') {
      throw new ValidationError('comment must be a string', { field: 'comment' });
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

/**
 * Format duration in seconds to human-readable string for CSV export.
 */
function formatDurationForCsv(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/**
 * Escape a field value for CSV (wrap in quotes if it contains commas, quotes, or newlines).
 */
function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Parse a CSV line respecting quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}
