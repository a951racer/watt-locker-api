import { Router, Request, Response, NextFunction } from 'express';
import { IStravaSyncService, StravaWebhookEvent } from '../services/stravaSyncService';
import { successResponse } from '../utils/response';
import { ValidationError } from '../utils/errors';

/**
 * Creates the Strava webhook router.
 * These routes do NOT require JWT authentication — Strava calls them directly.
 *
 * GET  /api/webhooks/strava — Webhook verification (Strava subscription validation)
 * POST /api/webhooks/strava — Webhook event receiver
 */
export function createWebhookRouter(stravaSyncService: IStravaSyncService): Router {
  const router = Router();

  /**
   * GET /api/webhooks/strava
   * Handles Strava's webhook subscription verification challenge.
   * Strava sends a GET request with hub.mode, hub.challenge, and hub.verify_token.
   * We must respond with the challenge value if the verify token is valid.
   */
  router.get('/strava', (req: Request, res: Response, next: NextFunction) => {
    try {
      const mode = req.query['hub.mode'] as string | undefined;
      const challenge = req.query['hub.challenge'] as string | undefined;
      const verifyToken = req.query['hub.verify_token'] as string | undefined;

      if (mode !== 'subscribe') {
        throw new ValidationError('Invalid hub.mode parameter', { field: 'hub.mode' });
      }

      if (!challenge) {
        throw new ValidationError('Missing hub.challenge parameter', { field: 'hub.challenge' });
      }

      if (verifyToken === undefined) {
        throw new ValidationError('Missing hub.verify_token parameter', {
          field: 'hub.verify_token',
        });
      }

      const result = stravaSyncService.verifyWebhook(challenge, verifyToken);

      // Strava expects the response in this exact format
      res.status(200).json({ 'hub.challenge': result });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/webhooks/strava
   * Receives webhook events from Strava when activities are created/updated/deleted.
   * Validates the event payload and delegates to stravaSyncService.handleWebhookEvent.
   * Always responds with 200 to acknowledge receipt (Strava retries on non-2xx).
   */
  router.post('/strava', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = req.body as StravaWebhookEvent;

      // Basic validation of the webhook event payload
      if (!event || !event.object_type || !event.aspect_type) {
        throw new ValidationError('Invalid webhook event payload', {
          field: 'body',
        });
      }

      if (typeof event.object_id !== 'number' || typeof event.owner_id !== 'number') {
        throw new ValidationError('Invalid webhook event: object_id and owner_id must be numbers', {
          field: 'body',
        });
      }

      // Process the event asynchronously — respond immediately to Strava
      // In production, this would be enqueued to a job queue
      await stravaSyncService.handleWebhookEvent(event);

      res.status(200).json(successResponse({ received: true }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
