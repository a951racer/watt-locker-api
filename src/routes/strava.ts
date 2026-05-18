import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { IStravaSyncService } from '../services/stravaSyncService';
import { successResponse } from '../utils/response';
import { ValidationError, AuthenticationError } from '../utils/errors';

/**
 * Creates the Strava OAuth and integration router with injected dependencies.
 * Provides endpoints to initiate and complete the Strava OAuth flow.
 */
export function createStravaRouter(
  stravaSyncService: IStravaSyncService,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  /**
   * POST /api/auth/strava
   * Initiates the Strava OAuth flow by generating an authorization URL.
   * Requires JWT authentication. Returns the URL for the client to redirect to.
   */
  router.post('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const authUrl = stravaSyncService.getAuthorizationUrl(userId);

      res.status(200).json(successResponse({ authUrl }));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/auth/strava/callback
   * Handles the OAuth callback from Strava.
   * Exchanges the authorization code for tokens and stores the encrypted
   * tokens in user settings via the StravaSyncService.
   */
  router.get('/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, state, error } = req.query;

      if (error) {
        throw new AuthenticationError(`Strava OAuth error: ${String(error)}`);
      }

      if (!code || typeof code !== 'string') {
        throw new ValidationError('Authorization code is required', { field: 'code' });
      }

      if (!state || typeof state !== 'string') {
        throw new ValidationError('State parameter is required', { field: 'state' });
      }

      const userId = state;
      await stravaSyncService.handleOAuthCallback(code, userId);

      res.status(200).json(
        successResponse({
          message: 'Strava connected successfully',
          connected: true,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
