import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ISettingsService } from '../services/settingsService';
import { ValidationError } from '../utils/errors';
import { successResponse } from '../utils/response';
import { DataSource } from '../models/workout';

/** Valid data source provider names */
const VALID_PROVIDERS: DataSource[] = ['manual', 'strava', 'trainingpeaks', 'garmin'];

/**
 * Creates the settings router with injected dependencies.
 * Both endpoints require JWT authentication (applied via authMiddleware).
 */
export function createSettingsRouter(
  settingsService: ISettingsService,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  // Apply auth middleware to all settings routes
  router.use(authMiddleware);

  /**
   * GET /api/settings
   * Retrieve the authenticated user's settings.
   */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const settings = await settingsService.getSettings(req.user!.userId);
      res.status(200).json(successResponse(settings));
    } catch (err) {
      next(err);
    }
  });

  /**
   * PUT /api/settings
   * Update the authenticated user's settings (partial update).
   */
  router.put('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;

      validateSettingsUpdate(body);

      const updated = await settingsService.updateSettings(req.user!.userId, body);
      res.status(200).json(successResponse(updated));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Validates the settings update payload.
 * - driveStoragePath: must be a non-empty string if provided
 * - driveInboxPath: must be a non-empty string if provided
 * - connectedSources: must be a valid array of ConnectedSource objects if provided
 */
function validateSettingsUpdate(body: unknown): void {
  if (body === null || typeof body !== 'object') {
    throw new ValidationError('Request body must be an object');
  }

  const payload = body as Record<string, unknown>;

  if ('driveStoragePath' in payload) {
    if (typeof payload.driveStoragePath !== 'string' || payload.driveStoragePath.trim() === '') {
      throw new ValidationError('driveStoragePath must be a non-empty string', {
        field: 'driveStoragePath',
      });
    }
  }

  if ('driveInboxPath' in payload) {
    if (typeof payload.driveInboxPath !== 'string' || payload.driveInboxPath.trim() === '') {
      throw new ValidationError('driveInboxPath must be a non-empty string', {
        field: 'driveInboxPath',
      });
    }
  }

  if ('connectedSources' in payload) {
    if (!Array.isArray(payload.connectedSources)) {
      throw new ValidationError('connectedSources must be an array', {
        field: 'connectedSources',
      });
    }

    for (const source of payload.connectedSources as unknown[]) {
      validateConnectedSource(source);
    }
  }
}

/**
 * Validates a single ConnectedSource entry.
 */
function validateConnectedSource(source: unknown): void {
  if (source === null || typeof source !== 'object') {
    throw new ValidationError('Each connected source must be an object', {
      field: 'connectedSources',
    });
  }

  const entry = source as Record<string, unknown>;

  if (!entry.provider || typeof entry.provider !== 'string') {
    throw new ValidationError('Each connected source must have a provider', {
      field: 'connectedSources',
    });
  }

  if (!VALID_PROVIDERS.includes(entry.provider as DataSource)) {
    throw new ValidationError(
      `Invalid provider "${entry.provider}". Valid providers: ${VALID_PROVIDERS.join(', ')}`,
      { field: 'connectedSources' },
    );
  }

  if (typeof entry.connected !== 'boolean') {
    throw new ValidationError('Each connected source must have a boolean "connected" field', {
      field: 'connectedSources',
    });
  }
}
