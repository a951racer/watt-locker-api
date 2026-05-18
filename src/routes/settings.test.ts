import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createSettingsRouter } from './settings';
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

/**
 * Fake auth middleware that always attaches a user context.
 * Simulates a pre-authenticated request.
 */
function fakeAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.user = { userId: 'user-123', email: 'test@example.com' };
  next();
}

/** Create a minimal Express app with the settings router and error handler */
function createTestApp(settingsService: ISettingsService) {
  const app = express();
  app.use(express.json());
  // Attach a dummy correlationId for error handler compatibility
  app.use((req, _res, next) => {
    req.correlationId = 'test-correlation-id';
    next();
  });
  app.use('/api/settings', createSettingsRouter(settingsService, fakeAuthMiddleware));
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

describe('Settings Routes', () => {
  let mockSettingsService: jest.Mocked<ISettingsService>;
  let app: express.Application;

  beforeEach(() => {
    mockSettingsService = createMockSettingsService();
    app = createTestApp(mockSettingsService);
  });

  describe('GET /api/settings', () => {
    it('should return 200 with user settings', async () => {
      mockSettingsService.getSettings.mockResolvedValue(mockSettings);

      const res = await request(app).get('/api/settings');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        userId: 'user-123',
        driveStoragePath: 'WattLocker',
        driveInboxPath: 'WattLocker/Inbox',
        connectedSources: [],
      });
      expect(res.body.errors).toBeNull();
      expect(mockSettingsService.getSettings).toHaveBeenCalledWith('user-123');
    });

    it('should call getSettings with the authenticated user ID', async () => {
      mockSettingsService.getSettings.mockResolvedValue(mockSettings);

      await request(app).get('/api/settings');

      expect(mockSettingsService.getSettings).toHaveBeenCalledWith('user-123');
    });
  });

  describe('PUT /api/settings', () => {
    it('should return 200 with updated settings on valid payload', async () => {
      const updatedSettings: UserSettings = {
        ...mockSettings,
        driveStoragePath: 'MyDrive/Cycling',
      };
      mockSettingsService.updateSettings.mockResolvedValue(updatedSettings);

      const res = await request(app)
        .put('/api/settings')
        .send({ driveStoragePath: 'MyDrive/Cycling' });

      expect(res.status).toBe(200);
      expect(res.body.data.driveStoragePath).toBe('MyDrive/Cycling');
      expect(res.body.errors).toBeNull();
      expect(mockSettingsService.updateSettings).toHaveBeenCalledWith('user-123', {
        driveStoragePath: 'MyDrive/Cycling',
      });
    });

    it('should accept valid connectedSources array', async () => {
      const updatedSettings: UserSettings = {
        ...mockSettings,
        connectedSources: [{ provider: 'strava', connected: true }],
      };
      mockSettingsService.updateSettings.mockResolvedValue(updatedSettings);

      const res = await request(app)
        .put('/api/settings')
        .send({
          connectedSources: [{ provider: 'strava', connected: true }],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.connectedSources).toHaveLength(1);
      expect(res.body.data.connectedSources[0].provider).toBe('strava');
    });

    it('should return 400 when driveStoragePath is empty string', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ driveStoragePath: '' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('driveStoragePath');
      expect(mockSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it('should return 400 when driveStoragePath is whitespace only', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ driveStoragePath: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('driveStoragePath');
    });

    it('should return 400 when driveStoragePath is not a string', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ driveStoragePath: 123 });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('driveStoragePath');
    });

    it('should return 400 when driveInboxPath is empty string', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ driveInboxPath: '' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('driveInboxPath');
    });

    it('should return 400 when driveInboxPath is not a string', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ driveInboxPath: null });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('driveInboxPath');
    });

    it('should return 400 when connectedSources is not an array', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({ connectedSources: 'strava' });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('connectedSources');
    });

    it('should return 400 when connectedSources contains invalid provider', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({
          connectedSources: [{ provider: 'invalid_provider', connected: true }],
        });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('connectedSources');
    });

    it('should return 400 when connectedSources entry is missing provider', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({
          connectedSources: [{ connected: true }],
        });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('connectedSources');
    });

    it('should return 400 when connectedSources entry is missing connected field', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({
          connectedSources: [{ provider: 'strava' }],
        });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('connectedSources');
    });

    it('should return 400 when connectedSources entry is not an object', async () => {
      const res = await request(app)
        .put('/api/settings')
        .send({
          connectedSources: ['strava'],
        });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(res.body.errors[0].field).toBe('connectedSources');
    });

    it('should accept an empty body (no updates)', async () => {
      mockSettingsService.updateSettings.mockResolvedValue(mockSettings);

      const res = await request(app).put('/api/settings').send({});

      expect(res.status).toBe(200);
      expect(mockSettingsService.updateSettings).toHaveBeenCalledWith('user-123', {});
    });

    it('should accept all valid providers', async () => {
      const sources: UserSettings['connectedSources'] = [
        { provider: 'strava', connected: true },
        { provider: 'garmin', connected: false },
        { provider: 'trainingpeaks', connected: true },
        { provider: 'manual', connected: false },
      ];
      const updatedSettings: UserSettings = {
        ...mockSettings,
        connectedSources: sources,
      };
      mockSettingsService.updateSettings.mockResolvedValue(updatedSettings);

      const res = await request(app)
        .put('/api/settings')
        .send({ connectedSources: sources });

      expect(res.status).toBe(200);
      expect(res.body.data.connectedSources).toHaveLength(4);
    });
  });
});
