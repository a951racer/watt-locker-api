import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createGoogleAuthRouter, IGoogleOAuth2Client, encryptToken } from './googleAuth';
import { ISettingsService } from '../services/settingsService';
import { UserSettings } from '../models/settings';
import { errorHandler } from '../middleware/errorHandler';

/** Create a mock SettingsService */
function createMockSettingsService(): jest.Mocked<ISettingsService> {
  return {
    getSettings: jest.fn(),
    updateSettings: jest.fn(),
  };
}

/** Create a mock OAuth2 client */
function createMockOAuth2Client(): jest.Mocked<IGoogleOAuth2Client> {
  return {
    generateAuthUrl: jest.fn(),
    getToken: jest.fn(),
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

/** Create a minimal Express app with the Google auth router and error handler */
function createTestApp(
  settingsService: ISettingsService,
  authMiddleware: (req: Request, res: Response, next: NextFunction) => void,
  oauth2Client: IGoogleOAuth2Client,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  app.use(
    '/api/auth/google',
    createGoogleAuthRouter(settingsService, authMiddleware, () => oauth2Client),
  );
  app.use(errorHandler);
  return app;
}

const mockSettings: UserSettings = {
  userId: 'user-123',
  driveStoragePath: 'WattLocker',
  driveInboxPath: 'WattLocker/Inbox',
  connectedSources: [],
  updatedAt: new Date('2024-06-01'),
};

describe('Google Auth Routes', () => {
  let mockSettingsService: jest.Mocked<ISettingsService>;
  let mockOAuth2Client: jest.Mocked<IGoogleOAuth2Client>;
  let app: express.Application;

  beforeEach(() => {
    mockSettingsService = createMockSettingsService();
    mockOAuth2Client = createMockOAuth2Client();
    app = createTestApp(mockSettingsService, fakeAuthMiddleware, mockOAuth2Client);
  });

  describe('GET /api/auth/google', () => {
    it('should return 200 with an authorization URL', async () => {
      const expectedUrl = 'https://accounts.google.com/o/oauth2/v2/auth?scope=drive.file';
      mockOAuth2Client.generateAuthUrl.mockReturnValue(expectedUrl);

      const res = await request(app).get('/api/auth/google');

      expect(res.status).toBe(200);
      expect(res.body.data.authUrl).toBe(expectedUrl);
      expect(res.body.errors).toBeNull();
    });

    it('should generate auth URL with correct parameters', async () => {
      mockOAuth2Client.generateAuthUrl.mockReturnValue('https://example.com/auth');

      await request(app).get('/api/auth/google');

      expect(mockOAuth2Client.generateAuthUrl).toHaveBeenCalledWith({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/drive.file'],
        state: 'user-123',
        prompt: 'consent',
      });
    });

    it('should require authentication', async () => {
      const unauthApp = createTestApp(
        mockSettingsService,
        rejectingAuthMiddleware,
        mockOAuth2Client,
      );

      const res = await request(unauthApp).get('/api/auth/google');

      expect(res.status).toBe(401);
      expect(res.body.errors[0].code).toBe('AUTHENTICATION_ERROR');
    });

    it('should pass errors to the error handler', async () => {
      mockOAuth2Client.generateAuthUrl.mockImplementation(() => {
        throw new Error('OAuth client error');
      });

      const res = await request(app).get('/api/auth/google');

      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/auth/google/callback', () => {
    it('should exchange code for tokens and store encrypted refresh token', async () => {
      mockOAuth2Client.getToken.mockResolvedValue({
        tokens: { refresh_token: 'test-refresh-token' },
      });
      mockSettingsService.getSettings.mockResolvedValue(mockSettings);
      mockSettingsService.updateSettings.mockResolvedValue({
        ...mockSettings,
        connectedSources: [
          {
            provider: 'manual',
            connected: true,
            connectedAt: new Date(),
            oauthTokenEncrypted: `gdrive:${encryptToken('test-refresh-token')}`,
          },
        ],
      });

      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code-123', state: 'user-123' });

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('Google Drive connected successfully');
      expect(res.body.data.connected).toBe(true);
      expect(res.body.errors).toBeNull();
    });

    it('should call getToken with the authorization code', async () => {
      mockOAuth2Client.getToken.mockResolvedValue({
        tokens: { refresh_token: 'test-refresh-token' },
      });
      mockSettingsService.getSettings.mockResolvedValue(mockSettings);
      mockSettingsService.updateSettings.mockResolvedValue(mockSettings);

      await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code-123', state: 'user-123' });

      expect(mockOAuth2Client.getToken).toHaveBeenCalledWith('auth-code-123');
    });

    it('should store encrypted token in user settings via settingsService', async () => {
      mockOAuth2Client.getToken.mockResolvedValue({
        tokens: { refresh_token: 'my-secret-token' },
      });
      mockSettingsService.getSettings.mockResolvedValue(mockSettings);
      mockSettingsService.updateSettings.mockResolvedValue(mockSettings);

      await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code-123', state: 'user-123' });

      expect(mockSettingsService.updateSettings).toHaveBeenCalledWith('user-123', {
        connectedSources: expect.arrayContaining([
          expect.objectContaining({
            provider: 'manual',
            connected: true,
            oauthTokenEncrypted: expect.stringContaining('gdrive:enc:'),
          }),
        ]),
      });
    });

    it('should replace existing Google Drive entry in connectedSources', async () => {
      const settingsWithExisting: UserSettings = {
        ...mockSettings,
        connectedSources: [
          {
            provider: 'manual',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: 'gdrive:enc:old-token',
          },
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-02-01'),
            oauthTokenEncrypted: 'strava-token',
          },
        ],
      };

      mockOAuth2Client.getToken.mockResolvedValue({
        tokens: { refresh_token: 'new-refresh-token' },
      });
      mockSettingsService.getSettings.mockResolvedValue(settingsWithExisting);
      mockSettingsService.updateSettings.mockResolvedValue(mockSettings);

      await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code-123', state: 'user-123' });

      const updateCall = mockSettingsService.updateSettings.mock.calls[0];
      const sources = updateCall[1].connectedSources!;

      // Should keep the Strava entry and replace the Google Drive entry
      expect(sources).toHaveLength(2);
      expect(sources.find((s) => s.provider === 'strava')).toBeDefined();
      expect(
        sources.find((s) => s.oauthTokenEncrypted?.startsWith('gdrive:')),
      ).toBeDefined();
      // Old gdrive entry should be gone
      expect(
        sources.find((s) => s.oauthTokenEncrypted === 'gdrive:enc:old-token'),
      ).toBeUndefined();
    });

    it('should return 400 when code is missing', async () => {
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ state: 'user-123' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('code');
    });

    it('should return 400 when state is missing', async () => {
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code-123' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('state');
    });

    it('should return 401 when Google returns an error', async () => {
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ error: 'access_denied', state: 'user-123' });

      expect(res.status).toBe(401);
      expect(res.body.errors[0].code).toBe('AUTHENTICATION_ERROR');
      expect(res.body.errors[0].message).toContain('access_denied');
    });

    it('should return 401 when no refresh token is received', async () => {
      mockOAuth2Client.getToken.mockResolvedValue({
        tokens: { refresh_token: null },
      });

      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code-123', state: 'user-123' });

      expect(res.status).toBe(401);
      expect(res.body.errors[0].message).toContain('No refresh token received');
    });

    it('should return 500 when token exchange fails', async () => {
      mockOAuth2Client.getToken.mockRejectedValue(new Error('Token exchange failed'));

      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'invalid-code', state: 'user-123' });

      expect(res.status).toBe(500);
    });
  });

  describe('encryptToken', () => {
    it('should return a string prefixed with enc:', () => {
      const result = encryptToken('my-token');
      expect(result).toMatch(/^enc:/);
    });

    it('should encode the token in base64', () => {
      const result = encryptToken('my-token');
      const encoded = result.replace('enc:', '');
      const decoded = Buffer.from(encoded, 'base64').toString();
      expect(decoded).toBe('my-token');
    });

    it('should produce different output for different tokens', () => {
      const result1 = encryptToken('token-1');
      const result2 = encryptToken('token-2');
      expect(result1).not.toBe(result2);
    });
  });
});
