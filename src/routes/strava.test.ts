import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createStravaRouter } from './strava';
import { IStravaSyncService } from '../services/stravaSyncService';
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

/**
 * Fake auth middleware that always attaches a user context.
 */
function fakeAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.user = { userId: 'user-123', email: 'test@example.com' };
  next();
}

/**
 * Fake auth middleware that rejects unauthenticated requests.
 */
function rejectingAuthMiddleware(_req: Request, res: Response): void {
  res.status(401).json({
    data: null,
    errors: [{ code: 'AUTHENTICATION_ERROR', message: 'Missing or malformed authorization header' }],
    pagination: null,
    correlationId: 'test-correlation-id',
  });
}

/** Create a minimal Express app with the Strava router and error handler */
function createTestApp(
  stravaSyncService: IStravaSyncService,
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  app.use('/api/auth/strava', createStravaRouter(stravaSyncService, authMiddleware));
  app.use(errorHandler);
  return app;
}

describe('Strava Auth Routes', () => {
  let mockStravaSyncService: jest.Mocked<IStravaSyncService>;
  let app: express.Application;

  beforeEach(() => {
    mockStravaSyncService = createMockStravaSyncService();
    app = createTestApp(mockStravaSyncService, fakeAuthMiddleware);
  });

  describe('POST /api/auth/strava', () => {
    it('should return 200 with an authorization URL', async () => {
      const expectedUrl = 'https://www.strava.com/oauth/authorize?client_id=123&state=user-123';
      mockStravaSyncService.getAuthorizationUrl.mockReturnValue(expectedUrl);

      const res = await request(app).post('/api/auth/strava');

      expect(res.status).toBe(200);
      expect(res.body.data.authUrl).toBe(expectedUrl);
      expect(res.body.errors).toBeNull();
    });

    it('should call getAuthorizationUrl with the authenticated userId', async () => {
      mockStravaSyncService.getAuthorizationUrl.mockReturnValue('https://strava.com/auth');

      await request(app).post('/api/auth/strava');

      expect(mockStravaSyncService.getAuthorizationUrl).toHaveBeenCalledWith('user-123');
    });

    it('should require authentication', async () => {
      const unauthApp = createTestApp(mockStravaSyncService, rejectingAuthMiddleware);

      const res = await request(unauthApp).post('/api/auth/strava');

      expect(res.status).toBe(401);
      expect(res.body.errors[0].code).toBe('AUTHENTICATION_ERROR');
    });

    it('should pass errors to the error handler', async () => {
      mockStravaSyncService.getAuthorizationUrl.mockImplementation(() => {
        throw new Error('Service error');
      });

      const res = await request(app).post('/api/auth/strava');

      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/auth/strava/callback', () => {
    it('should exchange code for tokens and return success', async () => {
      mockStravaSyncService.handleOAuthCallback.mockResolvedValue(undefined);

      const res = await request(app)
        .get('/api/auth/strava/callback')
        .query({ code: 'auth-code-123', state: 'user-123' });

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('Strava connected successfully');
      expect(res.body.data.connected).toBe(true);
      expect(res.body.errors).toBeNull();
    });

    it('should call handleOAuthCallback with code and userId from state', async () => {
      mockStravaSyncService.handleOAuthCallback.mockResolvedValue(undefined);

      await request(app)
        .get('/api/auth/strava/callback')
        .query({ code: 'auth-code-456', state: 'user-789' });

      expect(mockStravaSyncService.handleOAuthCallback).toHaveBeenCalledWith(
        'auth-code-456',
        'user-789',
      );
    });

    it('should return 400 when code is missing', async () => {
      const res = await request(app)
        .get('/api/auth/strava/callback')
        .query({ state: 'user-123' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('code');
    });

    it('should return 400 when state is missing', async () => {
      const res = await request(app)
        .get('/api/auth/strava/callback')
        .query({ code: 'auth-code-123' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('state');
    });

    it('should return 401 when Strava returns an error', async () => {
      const res = await request(app)
        .get('/api/auth/strava/callback')
        .query({ error: 'access_denied', state: 'user-123' });

      expect(res.status).toBe(401);
      expect(res.body.errors[0].code).toBe('AUTHENTICATION_ERROR');
      expect(res.body.errors[0].message).toContain('access_denied');
    });

    it('should return 500 when handleOAuthCallback throws unexpected error', async () => {
      mockStravaSyncService.handleOAuthCallback.mockRejectedValue(
        new Error('Unexpected failure'),
      );

      const res = await request(app)
        .get('/api/auth/strava/callback')
        .query({ code: 'auth-code-123', state: 'user-123' });

      expect(res.status).toBe(500);
    });

    it('should return 401 when handleOAuthCallback throws AuthenticationError', async () => {
      mockStravaSyncService.handleOAuthCallback.mockRejectedValue(
        new AuthenticationError('Failed to exchange Strava authorization code for tokens'),
      );

      const res = await request(app)
        .get('/api/auth/strava/callback')
        .query({ code: 'bad-code', state: 'user-123' });

      expect(res.status).toBe(401);
      expect(res.body.errors[0].code).toBe('AUTHENTICATION_ERROR');
    });
  });
});
