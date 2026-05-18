import express from 'express';
import request from 'supertest';
import { createWebhookRouter } from './webhooks';
import { IStravaSyncService, StravaWebhookEvent } from '../services/stravaSyncService';
import { errorHandler } from '../middleware/errorHandler';
import { AuthenticationError } from '../utils/errors';

/** Create a mock StravaSyncService */
function createMockStravaSyncService(): jest.Mocked<IStravaSyncService> {
  return {
    getAuthorizationUrl: jest.fn(),
    handleOAuthCallback: jest.fn(),
    handleWebhookEvent: jest.fn(),
    syncHistorical: jest.fn(),
    registerWebhook: jest.fn(),
    verifyWebhook: jest.fn(),
  };
}

/** Create a minimal Express app with the webhook router and error handler */
function createTestApp(stravaSyncService: IStravaSyncService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  app.use('/api/webhooks', createWebhookRouter(stravaSyncService));
  app.use(errorHandler);
  return app;
}

describe('Webhook Routes', () => {
  let mockStravaSyncService: jest.Mocked<IStravaSyncService>;
  let app: express.Application;

  beforeEach(() => {
    mockStravaSyncService = createMockStravaSyncService();
    app = createTestApp(mockStravaSyncService);
  });

  describe('GET /api/webhooks/strava (verification)', () => {
    it('should return 200 with hub.challenge when verification succeeds', async () => {
      mockStravaSyncService.verifyWebhook.mockReturnValue('challenge-abc');

      const res = await request(app).get('/api/webhooks/strava').query({
        'hub.mode': 'subscribe',
        'hub.challenge': 'challenge-abc',
        'hub.verify_token': 'my-verify-token',
      });

      expect(res.status).toBe(200);
      expect(res.body['hub.challenge']).toBe('challenge-abc');
    });

    it('should call verifyWebhook with challenge and verify token', async () => {
      mockStravaSyncService.verifyWebhook.mockReturnValue('test-challenge');

      await request(app).get('/api/webhooks/strava').query({
        'hub.mode': 'subscribe',
        'hub.challenge': 'test-challenge',
        'hub.verify_token': 'test-token',
      });

      expect(mockStravaSyncService.verifyWebhook).toHaveBeenCalledWith(
        'test-challenge',
        'test-token',
      );
    });

    it('should return 400 when hub.mode is not subscribe', async () => {
      const res = await request(app).get('/api/webhooks/strava').query({
        'hub.mode': 'invalid',
        'hub.challenge': 'challenge-abc',
        'hub.verify_token': 'my-verify-token',
      });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('hub.mode');
    });

    it('should return 400 when hub.challenge is missing', async () => {
      const res = await request(app).get('/api/webhooks/strava').query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'my-verify-token',
      });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('hub.challenge');
    });

    it('should return 400 when hub.verify_token is missing', async () => {
      const res = await request(app).get('/api/webhooks/strava').query({
        'hub.mode': 'subscribe',
        'hub.challenge': 'challenge-abc',
      });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('hub.verify_token');
    });

    it('should return 401 when verify token is invalid', async () => {
      mockStravaSyncService.verifyWebhook.mockImplementation(() => {
        throw new AuthenticationError('Invalid webhook verify token');
      });

      const res = await request(app).get('/api/webhooks/strava').query({
        'hub.mode': 'subscribe',
        'hub.challenge': 'challenge-abc',
        'hub.verify_token': 'wrong-token',
      });

      expect(res.status).toBe(401);
      expect(res.body.errors[0].code).toBe('AUTHENTICATION_ERROR');
    });

    it('should not require JWT authentication', async () => {
      mockStravaSyncService.verifyWebhook.mockReturnValue('challenge-abc');

      // No Authorization header — should still work
      const res = await request(app).get('/api/webhooks/strava').query({
        'hub.mode': 'subscribe',
        'hub.challenge': 'challenge-abc',
        'hub.verify_token': 'my-verify-token',
      });

      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/webhooks/strava (events)', () => {
    const validEvent: StravaWebhookEvent = {
      object_type: 'activity',
      object_id: 12345,
      aspect_type: 'create',
      owner_id: 67890,
      subscription_id: 111,
      event_time: 1700000000,
    };

    it('should return 200 and process a valid activity create event', async () => {
      mockStravaSyncService.handleWebhookEvent.mockResolvedValue(undefined);

      const res = await request(app).post('/api/webhooks/strava').send(validEvent);

      expect(res.status).toBe(200);
      expect(res.body.data.received).toBe(true);
      expect(res.body.errors).toBeNull();
    });

    it('should call handleWebhookEvent with the event payload', async () => {
      mockStravaSyncService.handleWebhookEvent.mockResolvedValue(undefined);

      await request(app).post('/api/webhooks/strava').send(validEvent);

      expect(mockStravaSyncService.handleWebhookEvent).toHaveBeenCalledWith(validEvent);
    });

    it('should return 400 when event payload is missing object_type', async () => {
      const res = await request(app).post('/api/webhooks/strava').send({
        object_id: 12345,
        aspect_type: 'create',
        owner_id: 67890,
        subscription_id: 111,
        event_time: 1700000000,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when event payload is missing aspect_type', async () => {
      const res = await request(app).post('/api/webhooks/strava').send({
        object_type: 'activity',
        object_id: 12345,
        owner_id: 67890,
        subscription_id: 111,
        event_time: 1700000000,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when object_id is not a number', async () => {
      const res = await request(app).post('/api/webhooks/strava').send({
        object_type: 'activity',
        object_id: 'not-a-number',
        aspect_type: 'create',
        owner_id: 67890,
        subscription_id: 111,
        event_time: 1700000000,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when owner_id is not a number', async () => {
      const res = await request(app).post('/api/webhooks/strava').send({
        object_type: 'activity',
        object_id: 12345,
        aspect_type: 'create',
        owner_id: 'not-a-number',
        subscription_id: 111,
        event_time: 1700000000,
      });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 when body is empty', async () => {
      const res = await request(app).post('/api/webhooks/strava').send({});

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
    });

    it('should not require JWT authentication', async () => {
      mockStravaSyncService.handleWebhookEvent.mockResolvedValue(undefined);

      // No Authorization header — should still work
      const res = await request(app).post('/api/webhooks/strava').send(validEvent);

      expect(res.status).toBe(200);
    });

    it('should handle athlete events gracefully', async () => {
      mockStravaSyncService.handleWebhookEvent.mockResolvedValue(undefined);

      const athleteEvent: StravaWebhookEvent = {
        object_type: 'athlete',
        object_id: 67890,
        aspect_type: 'update',
        owner_id: 67890,
        subscription_id: 111,
        event_time: 1700000000,
      };

      const res = await request(app).post('/api/webhooks/strava').send(athleteEvent);

      expect(res.status).toBe(200);
      expect(mockStravaSyncService.handleWebhookEvent).toHaveBeenCalledWith(athleteEvent);
    });

    it('should return 500 when handleWebhookEvent throws unexpected error', async () => {
      mockStravaSyncService.handleWebhookEvent.mockRejectedValue(
        new Error('Unexpected failure'),
      );

      const res = await request(app).post('/api/webhooks/strava').send(validEvent);

      expect(res.status).toBe(500);
    });
  });
});
