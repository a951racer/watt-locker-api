import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { IWorkoutService, ListWorkoutsOptions } from '../services/workoutService';
import { IUploadService } from '../services/uploadService';
import { ISettingsService } from '../services/settingsService';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { ISourceArtifactRepository } from '../repositories/sourceArtifactRepository';
import { WorkoutRecord } from '../models/workout';
import { ValidationError } from '../utils/errors';
import { successResponse } from '../utils/response';
import { lookupFtp } from '../utils/ftpLookup';
import { computeMaxPowers } from '../utils/powerCurve';

/**
 * Creates the workouts router with injected dependencies.
 * All endpoints require JWT authentication (applied via authMiddleware).
 */
export function createWorkoutsRouter(
  workoutService: IWorkoutService,
  uploadService: IUploadService,
  authMiddleware: RequestHandler,
  settingsService?: ISettingsService,
  workoutRepository?: IWorkoutRepository,
  sourceArtifactRepository?: ISourceArtifactRepository,
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
   * POST /api/workouts
   * Create a new planned Activity.
   * Required: date, activityType.
   * Optional: title, description, durationSeconds, distanceMeters.
   */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      validatePlannedActivityCreation(body);

      const userId = req.user!.userId;

      const workout: Partial<WorkoutRecord> & { userId: string; activityType: string; status: 'planned'; template: false; date: string } = {
        userId,
        activityType: body.activityType,
        status: 'planned',
        template: false,
        date: body.date,
      };

      // Optional fields
      if (body.title !== undefined) workout.title = body.title;
      if (body.description !== undefined) workout.description = body.description;
      if (body.plannedDurationSeconds !== undefined) workout.plannedDurationSeconds = body.plannedDurationSeconds;
      if (body.plannedDistanceMeters !== undefined) workout.plannedDistanceMeters = body.plannedDistanceMeters;

      // Extended planning fields
      const extendedWorkout = workout as Record<string, unknown>;
      if (body.plannedTss !== undefined) extendedWorkout.plannedTss = body.plannedTss;
      if (body.plannedIf !== undefined) extendedWorkout.plannedIf = body.plannedIf;
      if (body.plannedTssOverride !== undefined) extendedWorkout.plannedTssOverride = body.plannedTssOverride;
      if (body.plannedIfOverride !== undefined) extendedWorkout.plannedIfOverride = body.plannedIfOverride;
      if (body.targetPowerMin !== undefined) extendedWorkout.targetPowerMin = body.targetPowerMin;
      if (body.targetPowerMax !== undefined) extendedWorkout.targetPowerMax = body.targetPowerMax;
      if (body.targetHrMin !== undefined) extendedWorkout.targetHrMin = body.targetHrMin;
      if (body.targetHrMax !== undefined) extendedWorkout.targetHrMax = body.targetHrMax;
      if (body.targetCadenceMin !== undefined) extendedWorkout.targetCadenceMin = body.targetCadenceMin;
      if (body.targetCadenceMax !== undefined) extendedWorkout.targetCadenceMax = body.targetCadenceMax;
      if (body.targetSpeed !== undefined) extendedWorkout.targetSpeed = body.targetSpeed;
      if (body.segments !== undefined) extendedWorkout.segments = body.segments;
      if (body.tags !== undefined) extendedWorkout.tags = body.tags;
      if (body.equipment !== undefined) extendedWorkout.equipment = body.equipment;
      if (body.eventId !== undefined) extendedWorkout.eventId = body.eventId;
      if (body.comment !== undefined) extendedWorkout.comment = body.comment;
      if (body.referenceMetric !== undefined) extendedWorkout.referenceMetric = body.referenceMetric;

      const created = await workoutRepository!.create(workout as WorkoutRecord);
      res.status(201).json(successResponse(created));
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
      if (isNaN(days) || days < 1 || days > 3650) {
        throw new ValidationError('days must be between 1 and 3650', { field: 'days' });
      }

      // Fetch all workouts for the user (need full history for accurate CTL)
      // Only completed Activities contribute to longitudinal analytics (PLAN-006)
      const allWorkouts = await workoutService.listWorkouts(req.user!.userId, {
        page: 1,
        pageSize: 10000,
        sortBy: 'date',
        sortOrder: 'asc',
        status: ['completed'],
        template: false,
      });

      // Aggregate daily TSS
      const dailyTSS: Map<string, number> = new Map();
      for (const w of allWorkouts.items) {
        if (!w.startTime) continue;
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
      const firstWithTime = allWorkouts.items.find(w => w.startTime);
      if (firstWithTime && firstWithTime.startTime) {
        const first = firstWithTime.startTime;
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
   * POST /api/workouts/recalculate
   * Recalculate TSS, IF, and ftpUsed for all workouts using the user's FTP history.
   */
  router.post('/recalculate', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!settingsService || !workoutRepository) {
        throw new ValidationError('Recalculate endpoint is not configured');
      }

      const userId = req.user!.userId;
      const settings = await settingsService.getSettings(userId);

      // Fetch all workouts for the user — only completed Activities (PLAN-006)
      const allWorkouts = await workoutService.listWorkouts(userId, {
        page: 1,
        pageSize: 10000,
        sortBy: 'date',
        sortOrder: 'asc',
        status: ['completed'],
        template: false,
      });

      let updated = 0;
      let failed = 0;

      for (const workout of allWorkouts.items) {
        if (!workout.normalizedPowerWatts) continue;
        if (!workout.startTime) continue;

        try {
          const workoutDate = workout.startTime instanceof Date
            ? workout.startTime
            : new Date(workout.startTime);

          const ftp = lookupFtp(workoutDate, settings.ftpHistory, workout.ftpWatts);
          const np = workout.normalizedPowerWatts;
          const duration = workout.movingTimeSeconds ?? workout.durationSeconds;
          if (!duration) continue;

          const tss = Math.round(
            ((duration * Math.pow(np, 2)) / (Math.pow(ftp, 2) * 3600)) * 100 * 10,
          ) / 10;
          const intensityFactor = Math.round((np / ftp) * 1000) / 1000;

          await workoutRepository.updatePowerMetrics(workout.id, {
            tss,
            intensityFactor,
            ftpUsed: ftp,
          });
          updated++;
        } catch {
          failed++;
        }
      }

      res.status(200).json(successResponse({ total: allWorkouts.items.length, updated, failed }));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/workouts/recalculate-speed
   * Recalculate avgSpeedMps for all workouts using distance / movingTime (or duration).
   */
  router.post('/recalculate-speed', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!workoutRepository) {
        throw new ValidationError('Recalculate-speed endpoint is not configured');
      }

      const userId = req.user!.userId;

      const allWorkouts = await workoutService.listWorkouts(userId, {
        page: 1,
        pageSize: 10000,
        sortBy: 'date',
        sortOrder: 'asc',
        status: ['completed'],
        template: false,
      });

      let updated = 0;
      let failed = 0;

      for (const workout of allWorkouts.items) {
        try {
          const timeSeconds = workout.movingTimeSeconds ?? workout.durationSeconds;
          if (!timeSeconds || timeSeconds <= 0 || !workout.distanceMeters || workout.distanceMeters <= 0) continue;

          const avgSpeedMps = Math.round((workout.distanceMeters / timeSeconds) * 100) / 100;

          await workoutRepository.updateAvgSpeed(workout.id, avgSpeedMps);
          updated++;
        } catch {
          failed++;
        }
      }

      res.status(200).json(successResponse({ total: allWorkouts.items.length, updated, failed }));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/workouts/power-curve
   * Return workouts with maxPowers data within a date range.
   * Query params: months (default 6)
   */
  router.get('/power-curve', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!workoutRepository) {
        throw new ValidationError('Power curve endpoint is not configured');
      }

      const months = req.query.months ? parseInt(req.query.months as string, 10) : 6;
      if (isNaN(months) || months < 1 || months > 120) {
        throw new ValidationError('months must be between 1 and 120', { field: 'months' });
      }

      const userId = req.user!.userId;
      const dateFrom = new Date();
      dateFrom.setMonth(dateFrom.getMonth() - months);

      const allWorkouts = await workoutService.listWorkouts(userId, {
        page: 1,
        pageSize: 10000,
        sortBy: 'date',
        sortOrder: 'desc',
        dateFrom,
        status: ['completed'],
        template: false,
      });

      const results = allWorkouts.items
        .filter((w) => (w as unknown as Record<string, unknown>).maxPowers != null && w.startTime)
        .map((w) => ({
          workoutId: w.id,
          date: w.startTime instanceof Date ? w.startTime.toISOString().split('T')[0] : new Date(w.startTime!).toISOString().split('T')[0],
          title: w.title,
          maxPowers: (w as unknown as Record<string, unknown>).maxPowers,
        }));

      res.status(200).json(successResponse(results));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/workouts/compute-power-curves
   * Backfill maxPowers for workouts that don't have it yet.
   * Fetches time-series metrics and computes power curves.
   * Query params:
   *   force=true - recompute all (not just missing)
   *   batchSize - max workouts to process per request (default 50, avoids Heroku 30s timeout)
   */
  router.post('/compute-power-curves', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!workoutRepository) {
        throw new ValidationError('Compute power curves endpoint is not configured');
      }

      const userId = req.user!.userId;
      const batchSize = Math.min(Number(req.query.batchSize) || 50, 200);

      // Fetch all workouts for the user — only completed Activities (PLAN-006)
      const allWorkouts = await workoutService.listWorkouts(userId, {
        page: 1,
        pageSize: 10000,
        sortBy: 'date',
        sortOrder: 'desc',
        status: ['completed'],
        template: false,
      });

      // Filter to workouts without maxPowers (unless force=true to recompute all)
      const force = req.query.force === 'true';
      const workoutsToProcess = force
        ? allWorkouts.items
        : allWorkouts.items.filter(
            (w) => (w as unknown as Record<string, unknown>).maxPowers == null,
          );

      // Process only a batch to stay within Heroku's 30s timeout
      const batch = workoutsToProcess.slice(0, batchSize);
      let computed = 0;
      let skipped = 0;
      let failed = 0;

      for (const workout of batch) {
        try {
          if (!workout.startTime || !workout.endTime) {
            skipped++;
            continue;
          }
          const metrics = await workoutRepository.queryMetrics({
            workoutId: workout.id,
            timeFrom: workout.startTime instanceof Date ? workout.startTime : new Date(workout.startTime),
            timeTo: workout.endTime instanceof Date ? workout.endTime : new Date(workout.endTime),
          });

          const powerValues = metrics
            .map((m) => m.powerWatts)
            .filter((v): v is number => v != null);

          if (powerValues.length < 5) {
            skipped++;
            continue;
          }

          const maxPwrs = computeMaxPowers(powerValues);

          if (Object.keys(maxPwrs).length === 0) {
            skipped++;
            continue;
          }

          await workoutRepository.updateMaxPowers(workout.id, maxPwrs);
          computed++;
        } catch {
          failed++;
        }
      }

      res.status(200).json(
        successResponse({
          computed,
          skipped,
          failed,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/workouts/templates
   * List Activity templates for the template library.
   * Optional: search (title text match), activityType filter, pagination (page, pageSize).
   */
  router.get('/templates', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      // Parse pagination using existing conventions
      const options: ListWorkoutsOptions & { search?: string } = {
        template: true,
      };

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

      if (req.query.activityType) {
        options.activityType = req.query.activityType as string;
      }

      if (req.query.search && typeof req.query.search === 'string' && req.query.search.trim() !== '') {
        options.search = req.query.search as string;
      }

      const result = await workoutService.listWorkouts(userId, options);
      res.status(200).json(successResponse(result.items, result.pagination));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/workouts/templates
   * Create a new Activity template.
   * Templates have: template=true, no status, no date.
   * Required: activityType. Optional: title, description, plannedDurationSeconds, etc.
   */
  router.post('/templates', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!workoutRepository) {
        throw new ValidationError('Templates endpoint is not configured');
      }

      const body = req.body;
      if (body === null || typeof body !== 'object') {
        throw new ValidationError('Request body must be an object');
      }

      const payload = body as Record<string, unknown>;

      // Required: activityType
      if (!payload.activityType || typeof payload.activityType !== 'string' || (payload.activityType as string).trim() === '') {
        throw new ValidationError('activityType is required and must be a non-empty string', { field: 'activityType' });
      }

      // Validate optional planning fields
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
      if ('plannedDurationSeconds' in payload && payload.plannedDurationSeconds !== undefined) {
        if (typeof payload.plannedDurationSeconds !== 'number' || payload.plannedDurationSeconds <= 0) {
          throw new ValidationError('plannedDurationSeconds must be a positive number', { field: 'plannedDurationSeconds' });
        }
      }
      if ('plannedDistanceMeters' in payload && payload.plannedDistanceMeters !== undefined) {
        if (typeof payload.plannedDistanceMeters !== 'number' || payload.plannedDistanceMeters <= 0) {
          throw new ValidationError('plannedDistanceMeters must be a positive number', { field: 'plannedDistanceMeters' });
        }
      }
      if ('tags' in payload && payload.tags !== undefined) {
        if (!Array.isArray(payload.tags)) {
          throw new ValidationError('tags must be an array of strings', { field: 'tags' });
        }
      }

      const userId = req.user!.userId;

      // Build the template document — no status, no date
      const templateDoc: Record<string, unknown> = {
        userId,
        activityType: payload.activityType,
        template: true,
      };

      // Optional fields
      if (payload.title !== undefined) templateDoc.title = payload.title;
      if (payload.description !== undefined) templateDoc.description = payload.description;
      if (payload.plannedDurationSeconds !== undefined) templateDoc.plannedDurationSeconds = payload.plannedDurationSeconds;
      if (payload.plannedDistanceMeters !== undefined) templateDoc.plannedDistanceMeters = payload.plannedDistanceMeters;
      if (payload.plannedTss !== undefined) templateDoc.plannedTss = payload.plannedTss;
      if (payload.plannedIf !== undefined) templateDoc.plannedIf = payload.plannedIf;
      if (payload.segments !== undefined) templateDoc.segments = payload.segments;
      if (payload.tags !== undefined) templateDoc.tags = payload.tags;
      if (payload.equipment !== undefined) templateDoc.equipment = payload.equipment;
      if (payload.referenceMetric !== undefined) templateDoc.referenceMetric = payload.referenceMetric;
      if (payload.targetPowerMin !== undefined) templateDoc.targetPowerMin = payload.targetPowerMin;
      if (payload.targetPowerMax !== undefined) templateDoc.targetPowerMax = payload.targetPowerMax;
      if (payload.targetHrMin !== undefined) templateDoc.targetHrMin = payload.targetHrMin;
      if (payload.targetHrMax !== undefined) templateDoc.targetHrMax = payload.targetHrMax;
      if (payload.targetCadenceMin !== undefined) templateDoc.targetCadenceMin = payload.targetCadenceMin;
      if (payload.targetCadenceMax !== undefined) templateDoc.targetCadenceMax = payload.targetCadenceMax;
      if (payload.targetSpeed !== undefined) templateDoc.targetSpeed = payload.targetSpeed;

      // Explicitly do NOT include: status, date, comment/comments, userId from body

      // Insert via repository — use direct insert for templates (no status/date)
      const now = new Date();
      const insertDoc = { ...templateDoc, createdAt: now, updatedAt: now };
      const result = await workoutRepository.createTemplate(insertDoc as any);
      res.status(201).json(successResponse(result));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/workouts/templates/:id/copy
   * Create a new planned Activity from an existing template.
   * Required body: { date: "YYYY-MM-DD" }
   * Copies: activityType, segments, targets, tags, description, equipment.
   * Does NOT copy: comments, eventId, actual metrics, source data.
   */
  router.post('/templates/:id/copy', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!workoutRepository) {
        throw new ValidationError('Templates endpoint is not configured');
      }

      const templateId = req.params.id as string;
      const body = req.body;

      // Validate request body
      if (body === null || typeof body !== 'object') {
        throw new ValidationError('Request body must be an object');
      }

      const requestedDate = (body as Record<string, unknown>).date;
      if (requestedDate === undefined || requestedDate === null || requestedDate === '') {
        throw new ValidationError('date is required', { field: 'date' });
      }
      if (typeof requestedDate !== 'string') {
        throw new ValidationError('date must be a string in YYYY-MM-DD format', { field: 'date' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        throw new ValidationError('date must be in YYYY-MM-DD format', { field: 'date' });
      }
      if (!isValidCalendarDate(requestedDate)) {
        throw new ValidationError('date is not a valid calendar date', { field: 'date' });
      }

      // Load the source template — must exist and belong to authenticated user
      const userId = req.user!.userId;
      const source = await workoutService.getWorkout(templateId, userId);

      // Must be a template
      if (!source.template) {
        throw new ValidationError('Source must be a template', { field: 'id' });
      }

      // Build the new planned Activity from explicit allowlist
      const newActivity: Record<string, unknown> = {
        userId,
        activityType: source.activityType,
        template: false,
        status: 'planned',
        date: requestedDate,
      };

      // Copy approved reusable planning fields (only if present on source)
      if (source.title !== undefined) newActivity.title = source.title;
      if (source.description !== undefined) newActivity.description = source.description;
      if (source.tags !== undefined) newActivity.tags = source.tags;
      if (source.plannedDurationSeconds !== undefined) newActivity.plannedDurationSeconds = source.plannedDurationSeconds;
      if (source.plannedDistanceMeters !== undefined) newActivity.plannedDistanceMeters = source.plannedDistanceMeters;
      if (source.plannedTss !== undefined) newActivity.plannedTss = source.plannedTss;
      if (source.plannedIf !== undefined) newActivity.plannedIf = source.plannedIf;

      // Copy fields that exist on the raw DB document but not on WorkoutRecord
      // (segments, targets, equipment, referenceMetric) — read from DB directly
      const rawDoc = await (workoutRepository as any).workouts.findOne(
        { _id: new (require('mongodb').ObjectId)(templateId) }
      );
      if (rawDoc) {
        if (rawDoc.segments !== undefined) newActivity.segments = rawDoc.segments;
        if (rawDoc.targetPowerMin !== undefined) newActivity.targetPowerMin = rawDoc.targetPowerMin;
        if (rawDoc.targetPowerMax !== undefined) newActivity.targetPowerMax = rawDoc.targetPowerMax;
        if (rawDoc.targetHrMin !== undefined) newActivity.targetHrMin = rawDoc.targetHrMin;
        if (rawDoc.targetHrMax !== undefined) newActivity.targetHrMax = rawDoc.targetHrMax;
        if (rawDoc.targetCadenceMin !== undefined) newActivity.targetCadenceMin = rawDoc.targetCadenceMin;
        if (rawDoc.targetCadenceMax !== undefined) newActivity.targetCadenceMax = rawDoc.targetCadenceMax;
        if (rawDoc.targetSpeed !== undefined) newActivity.targetSpeed = rawDoc.targetSpeed;
        if (rawDoc.equipment !== undefined) newActivity.equipment = rawDoc.equipment;
        if (rawDoc.referenceMetric !== undefined) newActivity.referenceMetric = rawDoc.referenceMetric;
        if (rawDoc.title !== undefined) newActivity.title = rawDoc.title;
      }

      // Explicitly NOT copying: comment, comments, eventId, actual metrics, source fields

      // Create the new Activity via direct insert (same as createTemplate) to preserve all planning fields
      const created = await workoutRepository.createTemplate(newActivity);
      res.status(201).json(successResponse(created));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/workouts/calendar
   * Retrieve Activities within a calendar date range for the Calendar UI.
   * Required: dateFrom, dateTo (YYYY-MM-DD). Optional: status (comma-separated).
   * Excludes templates. Sorted by date ascending.
   */
  router.get('/calendar', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!workoutRepository) {
        throw new ValidationError('Calendar endpoint is not configured');
      }

      // Validate dateFrom
      const dateFrom = req.query.dateFrom as string | undefined;
      if (!dateFrom) {
        throw new ValidationError('dateFrom is required', { field: 'dateFrom' });
      }
      if (typeof dateFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        throw new ValidationError('dateFrom must be in YYYY-MM-DD format', { field: 'dateFrom' });
      }
      if (!isValidCalendarDate(dateFrom)) {
        throw new ValidationError('dateFrom is not a valid calendar date', { field: 'dateFrom' });
      }

      // Validate dateTo
      const dateTo = req.query.dateTo as string | undefined;
      if (!dateTo) {
        throw new ValidationError('dateTo is required', { field: 'dateTo' });
      }
      if (typeof dateTo !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        throw new ValidationError('dateTo must be in YYYY-MM-DD format', { field: 'dateTo' });
      }
      if (!isValidCalendarDate(dateTo)) {
        throw new ValidationError('dateTo is not a valid calendar date', { field: 'dateTo' });
      }

      // dateFrom must be <= dateTo
      if (dateFrom > dateTo) {
        throw new ValidationError('dateFrom must be on or before dateTo', { field: 'dateFrom' });
      }

      // Optional status filter
      let statusFilter: string[] | undefined;
      if (req.query.status) {
        const statusStr = req.query.status as string;
        const statuses = statusStr.split(',').map(s => s.trim());
        const validStatuses = ['planned', 'completed', 'skipped'];
        for (const s of statuses) {
          if (!validStatuses.includes(s)) {
            throw new ValidationError(
              `Invalid status "${s}". Valid statuses: ${validStatuses.join(', ')}`,
              { field: 'status' },
            );
          }
        }
        statusFilter = statuses;
      }

      const userId = req.user!.userId;

      // Fetch user settings for timezone-aware date derivation and skip evaluation
      const settings = settingsService
        ? await settingsService.getSettings(userId)
        : { timezone: 'UTC' };

      // Lazy skip evaluation: transition overdue planned Activities to skipped (PLAN-013)
      if (settingsService) {
        const userToday = new Date().toLocaleDateString('en-CA', { timeZone: settings.timezone });
        await workoutRepository.evaluateSkippedActivities(userId, userToday);
      }

      const activities = await workoutRepository.findByDateRange(userId, dateFrom, dateTo, statusFilter);

      // Return calendar summary fields.
      // Date hierarchy: stored Activity.date (authoritative) → derive from startTime + user timezone (fallback).
      const calendarItems = activities.map(a => {
        let activityDate = a.date;

        // If the document had no stored date, derive from startTime using user's timezone
        if (!activityDate && a.startTime) {
          const st = a.startTime instanceof Date ? a.startTime : new Date(a.startTime as unknown as string);
          activityDate = st.toLocaleDateString('en-CA', { timeZone: settings.timezone });

          // Verify derived date falls within the requested range (timezone edge case)
          if (activityDate < dateFrom || activityDate > dateTo) {
            return null;
          }
        }

        if (!activityDate) return null;

        return {
          id: a.id,
          date: activityDate,
          status: a.status as string,
          title: a.title,
          activityType: a.activityType,
          plannedTss: a.plannedTss,
          tss: a.tss,
          plannedDurationSeconds: a.plannedDurationSeconds,
          durationSeconds: a.durationSeconds,
          plannedDistanceMeters: a.plannedDistanceMeters,
          distanceMeters: a.distanceMeters,
        };
      }).filter((a): a is NonNullable<typeof a> => a != null);

      const weeklySummaries = calculateWeeklySummaries(calendarItems, dateFrom, dateTo);

      res.status(200).json(successResponse({ activities: calendarItems, weeklySummaries }));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/workouts/weekly-summary
   * Weekly TSS rollup for a Monday–Sunday calendar week.
   * Required: weekOf (YYYY-MM-DD, any date in the desired week).
   */
  router.get('/weekly-summary', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!workoutRepository || !settingsService) {
        throw new ValidationError('Weekly summary endpoint is not configured');
      }

      // Validate weekOf
      const weekOf = req.query.weekOf as string | undefined;
      if (!weekOf) {
        throw new ValidationError('weekOf is required', { field: 'weekOf' });
      }
      if (typeof weekOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
        throw new ValidationError('weekOf must be in YYYY-MM-DD format', { field: 'weekOf' });
      }
      if (!isValidCalendarDate(weekOf)) {
        throw new ValidationError('weekOf is not a valid calendar date', { field: 'weekOf' });
      }

      // Derive Monday–Sunday week boundaries from weekOf
      const { weekStart, weekEnd } = deriveWeekBoundaries(weekOf);

      const userId = req.user!.userId;

      // Lazy skip evaluation before querying (PLAN-013)
      const settings = await settingsService.getSettings(userId);
      const userToday = new Date().toLocaleDateString('en-CA', { timeZone: settings.timezone });
      await workoutRepository.evaluateSkippedActivities(userId, userToday);

      // Query the week's Activities (excludes templates)
      const activities = await workoutRepository.findByDateRange(userId, weekStart, weekEnd);

      // Calculate TSS totals
      let plannedTss = 0;
      let completedTss = 0;
      let remainingTss = 0;

      for (const a of activities) {
        if (a.status === 'planned') {
          const pTss = a.plannedTss ?? 0;
          plannedTss += pTss;
          remainingTss += pTss;
        } else if (a.status === 'completed') {
          completedTss += a.tss ?? 0;
        }
        // skipped contributes to nothing
      }

      // Build activity summaries
      const activitySummaries = activities.map(a => ({
        id: a.id,
        date: a.date,
        status: a.status,
        title: a.title,
        activityType: a.activityType,
        plannedTss: a.plannedTss,
        tss: a.tss,
      }));

      res.status(200).json(successResponse({
        weekStart,
        weekEnd,
        plannedTss,
        completedTss,
        remainingTss,
        activities: activitySummaries,
      }));
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
      // CSV export represents historical actual workout data — completed only (PLAN-006)
      if (!options.status) {
        options.status = ['completed'];
      }
      if (options.template === undefined) {
        options.template = false;
      }
      const result = await workoutService.listWorkouts(req.user!.userId, options);

      const header = 'id,date,duration,title,comment,tags,activityType';
      const rows = result.items.map((w) => {
        const date = w.date ?? (w.startTime instanceof Date
          ? w.startTime.toISOString().split('T')[0]
          : w.startTime ? new Date(w.startTime).toISOString().split('T')[0] : '');
        const duration = formatDurationForCsv(w.durationSeconds ?? 0);
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
   * PUT /api/workouts/:id/status
   * Lifecycle status transition. Validates transition rules:
   * - planned → completed (allowed)
   * - planned → skipped (allowed)
   * - skipped → planned (allowed, requires date >= today in user's timezone)
   * - skipped → completed (allowed)
   * - completed → planned (REJECTED)
   * - completed → skipped (REJECTED)
   */
  router.put('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const body = req.body;

      // Validate request body
      if (body === null || typeof body !== 'object') {
        throw new ValidationError('Request body must be an object');
      }

      const requestedStatus = (body as Record<string, unknown>).status;
      if (requestedStatus === undefined || requestedStatus === null || requestedStatus === '') {
        throw new ValidationError('status is required', { field: 'status' });
      }
      if (typeof requestedStatus !== 'string') {
        throw new ValidationError('status must be a string', { field: 'status' });
      }
      const validStatuses = ['planned', 'completed', 'skipped'];
      if (!validStatuses.includes(requestedStatus)) {
        throw new ValidationError(
          `Invalid status "${requestedStatus}". Valid statuses: ${validStatuses.join(', ')}`,
          { field: 'status' },
        );
      }

      // Load the Activity and verify ownership
      const existing = await workoutService.getWorkout(id, req.user!.userId);

      // Templates cannot be transitioned
      if (existing.template) {
        throw new ValidationError('Templates cannot undergo lifecycle transitions');
      }

      const currentStatus = existing.status;

      // Templates already rejected above — non-template Activities always have a status
      if (!currentStatus) {
        throw new ValidationError('Activity has no lifecycle status');
      }

      // Same-status transitions are not valid
      if (currentStatus === requestedStatus) {
        throw new ValidationError(
          `Activity is already in status "${currentStatus}"`,
          { field: 'status' },
        );
      }

      // Validate transition rules
      validateStatusTransition(currentStatus, requestedStatus);

      // For skipped → planned, enforce date >= today in user's timezone
      if (currentStatus === 'skipped' && requestedStatus === 'planned') {
        if (!settingsService) {
          throw new ValidationError('Settings service is not configured');
        }
        const settings = await settingsService.getSettings(req.user!.userId);
        const userTimezone = settings.timezone;
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: userTimezone });
        const activityDate = existing.date;

        if (!activityDate || activityDate < todayStr) {
          throw new ValidationError(
            `Cannot transition skipped Activity to planned: Activity date (${activityDate}) is before today (${todayStr}) in your timezone`,
            { field: 'status' },
          );
        }
      }

      // Perform the status update
      const updated = await workoutRepository!.updateStatus(id, requestedStatus);
      res.status(200).json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/workouts/:id/move
   * Move a planned or skipped Activity to a different calendar date.
   * - Planned Activity: date changes, status remains planned.
   * - Skipped Activity: date changes; if new date >= today (user TZ) → status becomes planned.
   * - Completed Activity: rejected (400).
   * - Template: rejected (400).
   */
  router.put('/:id/move', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const body = req.body;

      // Validate request body
      if (body === null || typeof body !== 'object') {
        throw new ValidationError('Request body must be an object');
      }

      const requestedDate = (body as Record<string, unknown>).date;
      if (requestedDate === undefined || requestedDate === null || requestedDate === '') {
        throw new ValidationError('date is required', { field: 'date' });
      }
      if (typeof requestedDate !== 'string') {
        throw new ValidationError('date must be a string in YYYY-MM-DD format', { field: 'date' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        throw new ValidationError('date must be in YYYY-MM-DD format', { field: 'date' });
      }
      // Basic calendar date validity check (month 01-12, day 01-31 range)
      const [year, month, day] = requestedDate.split('-').map(Number);
      const dateObj = new Date(year, month - 1, day);
      if (dateObj.getFullYear() !== year || dateObj.getMonth() !== month - 1 || dateObj.getDate() !== day) {
        throw new ValidationError('date is not a valid calendar date', { field: 'date' });
      }

      // Load the Activity and verify ownership
      const existing = await workoutService.getWorkout(id, req.user!.userId);

      // Templates cannot be moved
      if (existing.template) {
        throw new ValidationError('Templates cannot be moved');
      }

      // Completed Activities cannot be moved
      if (existing.status === 'completed') {
        throw new ValidationError('Completed Activities cannot be moved', { field: 'date' });
      }

      // Determine resulting status for skipped Activities
      let resultingStatus: string | undefined;
      if (existing.status === 'skipped') {
        if (!settingsService) {
          throw new ValidationError('Settings service is not configured');
        }
        const settings = await settingsService.getSettings(req.user!.userId);
        const userTimezone = settings.timezone;
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: userTimezone });

        if (requestedDate >= todayStr) {
          resultingStatus = 'planned';
        }
        // else: remains skipped (no status change needed)
      }

      // Perform the update
      const updated = await workoutRepository!.updateDateAndStatus(id, requestedDate, resultingStatus);
      res.status(200).json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/workouts/:id/save-as-template
   * Create a new reusable template from an existing Activity (planned or completed).
   * Copies reusable planning structure. Strips actual data, comments, eventId, date, status.
   */
  router.post('/:id/save-as-template', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!workoutRepository) {
        throw new ValidationError('Save-as-template endpoint is not configured');
      }

      const activityId = req.params.id as string;
      const userId = req.user!.userId;

      // Load the source Activity — must exist and belong to authenticated user
      const source = await workoutService.getWorkout(activityId, userId);

      // Must NOT be a template — this is Activity → Template
      if (source.template) {
        throw new ValidationError('Cannot save a template as a template. Use the template directly.');
      }

      // Build the new template from explicit allowlist of reusable fields
      const templateDoc: Record<string, unknown> = {
        userId,
        activityType: source.activityType,
        template: true,
      };

      // Copy reusable planning fields from domain model
      if (source.title !== undefined) templateDoc.title = source.title;
      if (source.description !== undefined) templateDoc.description = source.description;
      if (source.tags !== undefined) templateDoc.tags = source.tags;
      if (source.plannedDurationSeconds !== undefined) templateDoc.plannedDurationSeconds = source.plannedDurationSeconds;
      if (source.plannedDistanceMeters !== undefined) templateDoc.plannedDistanceMeters = source.plannedDistanceMeters;
      if (source.plannedTss !== undefined) templateDoc.plannedTss = source.plannedTss;
      if (source.plannedIf !== undefined) templateDoc.plannedIf = source.plannedIf;

      // Copy fields from raw DB document that aren't on WorkoutRecord
      const rawDoc = await (workoutRepository as any).workouts.findOne(
        { _id: new (require('mongodb').ObjectId)(activityId) }
      );
      if (rawDoc) {
        if (rawDoc.segments !== undefined) templateDoc.segments = rawDoc.segments;
        if (rawDoc.targetPowerMin !== undefined) templateDoc.targetPowerMin = rawDoc.targetPowerMin;
        if (rawDoc.targetPowerMax !== undefined) templateDoc.targetPowerMax = rawDoc.targetPowerMax;
        if (rawDoc.targetHrMin !== undefined) templateDoc.targetHrMin = rawDoc.targetHrMin;
        if (rawDoc.targetHrMax !== undefined) templateDoc.targetHrMax = rawDoc.targetHrMax;
        if (rawDoc.targetCadenceMin !== undefined) templateDoc.targetCadenceMin = rawDoc.targetCadenceMin;
        if (rawDoc.targetCadenceMax !== undefined) templateDoc.targetCadenceMax = rawDoc.targetCadenceMax;
        if (rawDoc.targetSpeed !== undefined) templateDoc.targetSpeed = rawDoc.targetSpeed;
        if (rawDoc.equipment !== undefined) templateDoc.equipment = rawDoc.equipment;
        if (rawDoc.referenceMetric !== undefined) templateDoc.referenceMetric = rawDoc.referenceMetric;
      }

      // Explicitly NOT copying: date, status, comment, comments, eventId,
      // startTime, endTime, durationSeconds, distanceMeters, actual metrics, source data

      // Create the new template
      const created = await workoutRepository.createTemplate(templateDoc);
      res.status(201).json(successResponse(created));
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/workouts/:id
   * Update Activity fields. Status-aware validation determines which fields are editable.
   * Planned/skipped: all planning fields editable.
   * Completed: title, description, comments, rpe, movingTimeSeconds, tags, equipment, event only.
   */
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const body = req.body;

      if (body === null || typeof body !== 'object') {
        throw new ValidationError('Request body must be an object');
      }

      // Lifecycle fields cannot be changed via PUT (lifecycle transitions belong to dedicated endpoints)
      const payload = body as Record<string, unknown>;
      if ('status' in payload) {
        throw new ValidationError('Cannot change status via PUT. Use lifecycle transition endpoints.', { field: 'status' });
      }
      if ('template' in payload) {
        throw new ValidationError('Cannot change template flag via PUT.', { field: 'template' });
      }

      // Load the Activity to determine status-aware editability
      const existing = await workoutService.getWorkout(id, req.user!.userId);

      // Determine permitted fields based on lifecycle status
      const status = existing.status;

      if (status === 'completed') {
        // Completed Activities: only these fields are editable
        const completedAllowed = new Set(['title', 'description', 'comment', 'rpe', 'movingTimeSeconds', 'tags', 'equipment', 'eventId']);
        for (const key of Object.keys(payload)) {
          if (!completedAllowed.has(key)) {
            throw new ValidationError(
              `Field "${key}" is not editable on a completed Activity`,
              { field: key },
            );
          }
        }
      }

      // Templates cannot be edited through this generic endpoint in ways that conflict with their nature
      // (but basic metadata edits are fine)

      // Validate individual field types
      validateWorkoutUpdate(body);
      validatePlanningFieldTypes(body);

      const updated = await workoutService.updateWorkout(id, req.user!.userId, body);
      res.status(200).json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/workouts/:id/sources
   * Returns all SourceArtifacts for the Activity, scoped to authenticated user.
   */
  router.get('/:id/sources', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const activityId = req.params.id as string;

      if (!sourceArtifactRepository) {
        throw new ValidationError('Source artifact repository is not configured');
      }

      // Verify the Activity exists and belongs to user
      const activity = await workoutService.getWorkout(activityId, userId);
      if (!activity) {
        throw new ValidationError('Activity not found');
      }

      const artifacts = await sourceArtifactRepository.findByActivityId(userId, activityId);
      res.status(200).json(successResponse(artifacts));
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/workouts/:id
   * Delete a workout. Optional query param: removeFromDrive (boolean).
   * Disassociates all source artifacts before deleting.
   */
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const removeFromDrive = req.query.removeFromDrive === 'true';

      // Disassociate all source artifacts from this Activity before deletion
      if (sourceArtifactRepository) {
        await sourceArtifactRepository.disassociateByActivityId(id);
      }

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

  // Status filter (comma-separated list of: planned, completed, skipped)
  if (req.query.status) {
    const statusStr = req.query.status as string;
    const statuses = statusStr.split(',').map(s => s.trim());
    const validStatuses = ['planned', 'completed', 'skipped'];
    for (const s of statuses) {
      if (!validStatuses.includes(s)) {
        throw new ValidationError(
          `Invalid status "${s}". Valid statuses: ${validStatuses.join(', ')}`,
          { field: 'status' },
        );
      }
    }
    options.status = statuses;
  }

  // Template filter (boolean: true or false)
  if (req.query.template !== undefined) {
    const templateStr = req.query.template as string;
    if (templateStr === 'true') {
      options.template = true;
    } else if (templateStr === 'false') {
      options.template = false;
    } else {
      throw new ValidationError(
        'template must be "true" or "false"',
        { field: 'template' },
      );
    }
  }

  return options;
}

/**
 * Validates the planned Activity creation payload.
 * Required: date, activityType.
 * Optional: title, description, durationSeconds, distanceMeters.
 */
function validatePlannedActivityCreation(body: unknown): void {
  if (body === null || typeof body !== 'object') {
    throw new ValidationError('Request body must be an object');
  }

  const payload = body as Record<string, unknown>;

  // Required: date (YYYY-MM-DD)
  if (!payload.date || typeof payload.date !== 'string') {
    throw new ValidationError('date is required and must be a string in YYYY-MM-DD format', {
      field: 'date',
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
    throw new ValidationError('date must be in YYYY-MM-DD format', { field: 'date' });
  }

  // Required: activityType
  if (!payload.activityType || typeof payload.activityType !== 'string' || payload.activityType.trim() === '') {
    throw new ValidationError('activityType is required and must be a non-empty string', {
      field: 'activityType',
    });
  }

  // Optional: title
  if ('title' in payload && payload.title !== undefined) {
    if (typeof payload.title !== 'string') {
      throw new ValidationError('title must be a string', { field: 'title' });
    }
  }

  // Optional: description
  if ('description' in payload && payload.description !== undefined) {
    if (typeof payload.description !== 'string') {
      throw new ValidationError('description must be a string', { field: 'description' });
    }
  }

  // Optional: plannedDurationSeconds
  if ('plannedDurationSeconds' in payload && payload.plannedDurationSeconds !== undefined) {
    if (typeof payload.plannedDurationSeconds !== 'number' || payload.plannedDurationSeconds <= 0) {
      throw new ValidationError('plannedDurationSeconds must be a positive number', {
        field: 'plannedDurationSeconds',
      });
    }
  }

  // Optional: plannedDistanceMeters
  if ('plannedDistanceMeters' in payload && payload.plannedDistanceMeters !== undefined) {
    if (typeof payload.plannedDistanceMeters !== 'number' || payload.plannedDistanceMeters <= 0) {
      throw new ValidationError('plannedDistanceMeters must be a positive number', {
        field: 'plannedDistanceMeters',
      });
    }
  }

  // Optional: plannedTss
  if ('plannedTss' in payload && payload.plannedTss !== undefined) {
    if (typeof payload.plannedTss !== 'number' || payload.plannedTss < 0) {
      throw new ValidationError('plannedTss must be a non-negative number', { field: 'plannedTss' });
    }
  }

  // Optional: plannedIf
  if ('plannedIf' in payload && payload.plannedIf !== undefined) {
    if (typeof payload.plannedIf !== 'number' || payload.plannedIf < 0) {
      throw new ValidationError('plannedIf must be a non-negative number', { field: 'plannedIf' });
    }
  }

  // Optional: target power range
  if ('targetPowerMin' in payload && payload.targetPowerMin !== undefined) {
    if (typeof payload.targetPowerMin !== 'number' || payload.targetPowerMin < 0) {
      throw new ValidationError('targetPowerMin must be a non-negative number', { field: 'targetPowerMin' });
    }
  }
  if ('targetPowerMax' in payload && payload.targetPowerMax !== undefined) {
    if (typeof payload.targetPowerMax !== 'number' || payload.targetPowerMax < 0) {
      throw new ValidationError('targetPowerMax must be a non-negative number', { field: 'targetPowerMax' });
    }
  }

  // Optional: target HR range
  if ('targetHrMin' in payload && payload.targetHrMin !== undefined) {
    if (typeof payload.targetHrMin !== 'number' || payload.targetHrMin < 0) {
      throw new ValidationError('targetHrMin must be a non-negative number', { field: 'targetHrMin' });
    }
  }
  if ('targetHrMax' in payload && payload.targetHrMax !== undefined) {
    if (typeof payload.targetHrMax !== 'number' || payload.targetHrMax < 0) {
      throw new ValidationError('targetHrMax must be a non-negative number', { field: 'targetHrMax' });
    }
  }

  // Optional: target cadence range
  if ('targetCadenceMin' in payload && payload.targetCadenceMin !== undefined) {
    if (typeof payload.targetCadenceMin !== 'number' || payload.targetCadenceMin < 0) {
      throw new ValidationError('targetCadenceMin must be a non-negative number', { field: 'targetCadenceMin' });
    }
  }
  if ('targetCadenceMax' in payload && payload.targetCadenceMax !== undefined) {
    if (typeof payload.targetCadenceMax !== 'number' || payload.targetCadenceMax < 0) {
      throw new ValidationError('targetCadenceMax must be a non-negative number', { field: 'targetCadenceMax' });
    }
  }

  // Optional: targetSpeed
  if ('targetSpeed' in payload && payload.targetSpeed !== undefined) {
    if (typeof payload.targetSpeed !== 'number' || payload.targetSpeed < 0) {
      throw new ValidationError('targetSpeed must be a non-negative number', { field: 'targetSpeed' });
    }
  }

  // Optional: segments (array)
  if ('segments' in payload && payload.segments !== undefined) {
    if (!Array.isArray(payload.segments)) {
      throw new ValidationError('segments must be an array', { field: 'segments' });
    }
  }

  // Optional: tags (array of strings)
  if ('tags' in payload && payload.tags !== undefined) {
    if (!Array.isArray(payload.tags)) {
      throw new ValidationError('tags must be an array of strings', { field: 'tags' });
    }
    for (const tag of payload.tags as unknown[]) {
      if (typeof tag !== 'string') {
        throw new ValidationError('Each tag must be a string', { field: 'tags' });
      }
    }
  }

  // Optional: equipment
  if ('equipment' in payload && payload.equipment !== undefined && payload.equipment !== null) {
    if (typeof payload.equipment !== 'object') {
      throw new ValidationError('equipment must be an object or null', { field: 'equipment' });
    }
  }

  // Optional: eventId
  if ('eventId' in payload && payload.eventId !== undefined) {
    if (typeof payload.eventId !== 'string') {
      throw new ValidationError('eventId must be a string', { field: 'eventId' });
    }
  }

  // Optional: comment
  if ('comment' in payload && payload.comment !== undefined) {
    if (typeof payload.comment !== 'string') {
      throw new ValidationError('comment must be a string', { field: 'comment' });
    }
  }

  // Optional: referenceMetric
  if ('referenceMetric' in payload && payload.referenceMetric !== undefined) {
    if (typeof payload.referenceMetric !== 'object' || payload.referenceMetric === null) {
      throw new ValidationError('referenceMetric must be an object', { field: 'referenceMetric' });
    }
  }
}

/**
 * Calculates weekly summaries from calendar activities.
 * Groups activities by their Monday–Sunday week and sums metrics.
 * Skipped activities are excluded from both planned and completed totals.
 */
function calculateWeeklySummaries(
  activities: Array<{
    date: string;
    status: string;
    plannedDurationSeconds?: number;
    durationSeconds?: number;
    plannedDistanceMeters?: number;
    distanceMeters?: number;
    plannedTss?: number;
    tss?: number;
  }>,
  _dateFrom: string,
  _dateTo: string,
): Array<{
  weekStart: string;
  weekEnd: string;
  plannedDuration: number;
  completedDuration: number;
  plannedDistance: number;
  completedDistance: number;
  plannedTss: number;
  completedTss: number;
}> {
  const weekMap = new Map<string, {
    weekStart: string;
    weekEnd: string;
    plannedDuration: number;
    completedDuration: number;
    plannedDistance: number;
    completedDistance: number;
    plannedTss: number;
    completedTss: number;
  }>();

  for (const a of activities) {
    if (a.status === 'skipped') continue;

    const { weekStart, weekEnd } = deriveWeekBoundaries(a.date);

    if (!weekMap.has(weekStart)) {
      weekMap.set(weekStart, {
        weekStart,
        weekEnd,
        plannedDuration: 0,
        completedDuration: 0,
        plannedDistance: 0,
        completedDistance: 0,
        plannedTss: 0,
        completedTss: 0,
      });
    }

    const summary = weekMap.get(weekStart)!;

    if (a.status === 'planned') {
      summary.plannedDuration += a.plannedDurationSeconds ?? 0;
      summary.plannedDistance += a.plannedDistanceMeters ?? 0;
      summary.plannedTss += a.plannedTss ?? 0;
    } else if (a.status === 'completed') {
      summary.completedDuration += a.durationSeconds ?? 0;
      summary.completedDistance += a.distanceMeters ?? 0;
      summary.completedTss += a.tss ?? 0;
    }
  }

  // Sort by weekStart ascending
  return Array.from(weekMap.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/**
 * Derives Monday–Sunday week boundaries from a given YYYY-MM-DD date.
 * Returns weekStart (Monday) and weekEnd (Sunday) as YYYY-MM-DD strings.
 */
function deriveWeekBoundaries(dateStr: string): { weekStart: string; weekEnd: string } {
  const [year, month, day] = dateStr.split('-').map(Number);
  // Use UTC to avoid DST issues in date arithmetic
  const d = new Date(Date.UTC(year, month - 1, day));
  // getUTCDay(): 0=Sunday, 1=Monday, ..., 6=Saturday
  const dow = d.getUTCDay();
  // Offset to Monday: if Sunday(0) → -6, else -(dow-1)
  const mondayOffset = dow === 0 ? -6 : -(dow - 1);
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  const weekStart = monday.toISOString().split('T')[0];
  const weekEnd = sunday.toISOString().split('T')[0];
  return { weekStart, weekEnd };
}

/**
 * Validates that a YYYY-MM-DD string represents a real calendar date.
 */
function isValidCalendarDate(dateStr: string): boolean {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  return dateObj.getFullYear() === year && dateObj.getMonth() === month - 1 && dateObj.getDate() === day;
}

/**
 * Validates that a lifecycle status transition is allowed.
 * Throws ValidationError for invalid transitions.
 */
function validateStatusTransition(currentStatus: string, requestedStatus: string): void {
  // Define allowed transitions
  const allowedTransitions: Record<string, string[]> = {
    planned: ['completed', 'skipped'],
    skipped: ['planned', 'completed'],
    completed: [], // No transitions allowed from completed
  };

  const allowed = allowedTransitions[currentStatus];
  if (!allowed || !allowed.includes(requestedStatus)) {
    throw new ValidationError(
      `Transition from "${currentStatus}" to "${requestedStatus}" is not allowed`,
      { field: 'status' },
    );
  }
}

/**
 * Validates planning-specific field types (used alongside validateWorkoutUpdate).
 */
function validatePlanningFieldTypes(body: unknown): void {
  if (body === null || typeof body !== 'object') return;
  const payload = body as Record<string, unknown>;

  if ('date' in payload && payload.date !== undefined) {
    if (typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
      throw new ValidationError('date must be in YYYY-MM-DD format', { field: 'date' });
    }
  }

  if ('plannedDurationSeconds' in payload && payload.plannedDurationSeconds !== undefined) {
    if (typeof payload.plannedDurationSeconds !== 'number' || payload.plannedDurationSeconds <= 0) {
      throw new ValidationError('plannedDurationSeconds must be a positive number', { field: 'plannedDurationSeconds' });
    }
  }

  if ('plannedDistanceMeters' in payload && payload.plannedDistanceMeters !== undefined) {
    if (typeof payload.plannedDistanceMeters !== 'number' || payload.plannedDistanceMeters <= 0) {
      throw new ValidationError('plannedDistanceMeters must be a positive number', { field: 'plannedDistanceMeters' });
    }
  }

  if ('rpe' in payload && payload.rpe !== undefined) {
    if (typeof payload.rpe !== 'number' || payload.rpe < 1 || payload.rpe > 10) {
      throw new ValidationError('rpe must be a number between 1 and 10', { field: 'rpe' });
    }
  }

  if ('movingTimeSeconds' in payload && payload.movingTimeSeconds !== undefined) {
    if (typeof payload.movingTimeSeconds !== 'number' || payload.movingTimeSeconds <= 0) {
      throw new ValidationError('movingTimeSeconds must be a positive number', { field: 'movingTimeSeconds' });
    }
  }
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
