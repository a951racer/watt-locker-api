import {
  StravaSyncService,
  IStravaHttpClient,
  StravaTokenResponse,
  StravaActivityDownload,
  StravaActivitySummary,
  encryptStravaToken,
  decryptStravaToken,
  Logger,
} from './stravaSyncService';
import { ISettingsService } from './settingsService';
import { IUploadService } from './uploadService';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { UserSettings } from '../models/settings';
import { WorkoutRecord } from '../models/workout';
import { AuthenticationError, ValidationError } from '../utils/errors';

/** Create a mock SettingsService */
function createMockSettingsService(): jest.Mocked<ISettingsService> {
  return {
    getSettings: jest.fn(),
    updateSettings: jest.fn(),
  };
}

/** Create a mock Strava HTTP client */
function createMockStravaHttpClient(): jest.Mocked<IStravaHttpClient> {
  return {
    exchangeToken: jest.fn(),
    downloadActivity: jest.fn(),
    listActivities: jest.fn(),
  };
}

/** Create a mock WorkoutRepository */
function createMockWorkoutRepository(): jest.Mocked<IWorkoutRepository> {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findDuplicate: jest.fn(),
    findBySourceActivityId: jest.fn(),
    insertMetrics: jest.fn(),
    queryMetrics: jest.fn(),
  };
}

/** Create a mock UploadService */
function createMockUploadService(): jest.Mocked<IUploadService> {
  return {
    uploadSingle: jest.fn(),
    uploadBulk: jest.fn(),
    ingestFromInbox: jest.fn(),
  };
}

/** Create a mock Logger */
function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

const mockSettings: UserSettings = {
  userId: 'user-123',
  driveStoragePath: 'WattLocker',
  driveInboxPath: 'WattLocker/Inbox',
  connectedSources: [],
  updatedAt: new Date('2024-06-01'),
};

const mockTokenResponse: StravaTokenResponse = {
  access_token: 'strava-access-token-abc',
  refresh_token: 'strava-refresh-token-xyz',
  expires_at: 1700000000,
  athlete: { id: 12345 },
};

describe('StravaSyncService', () => {
  let service: StravaSyncService;
  let mockSettingsService: jest.Mocked<ISettingsService>;
  let mockStravaHttpClient: jest.Mocked<IStravaHttpClient>;

  beforeEach(() => {
    mockSettingsService = createMockSettingsService();
    mockStravaHttpClient = createMockStravaHttpClient();
    service = new StravaSyncService(mockSettingsService, mockStravaHttpClient);
  });

  describe('getAuthorizationUrl', () => {
    it('should return a valid Strava authorization URL', () => {
      const url = service.getAuthorizationUrl('user-123');

      expect(url).toContain('https://www.strava.com/oauth/authorize');
      expect(url).toContain('response_type=code');
      expect(url).toContain('scope=read%2Cactivity%3Aread_all');
    });

    it('should include the userId in the state parameter', () => {
      const url = service.getAuthorizationUrl('user-456');

      expect(url).toContain('state=user-456');
    });

    it('should include client_id from config', () => {
      const url = service.getAuthorizationUrl('user-123');

      expect(url).toContain('client_id=');
    });

    it('should include redirect_uri from config', () => {
      const url = service.getAuthorizationUrl('user-123');

      expect(url).toContain('redirect_uri=');
    });
  });

  describe('handleOAuthCallback', () => {
    it('should exchange code for tokens and store them in settings', async () => {
      mockStravaHttpClient.exchangeToken.mockResolvedValue(mockTokenResponse);
      mockSettingsService.getSettings.mockResolvedValue(mockSettings);
      mockSettingsService.updateSettings.mockResolvedValue(mockSettings);

      await service.handleOAuthCallback('auth-code-123', 'user-123');

      expect(mockStravaHttpClient.exchangeToken).toHaveBeenCalledWith('auth-code-123');
      expect(mockSettingsService.updateSettings).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          connectedSources: expect.arrayContaining([
            expect.objectContaining({
              provider: 'strava',
              connected: true,
              oauthTokenEncrypted: expect.stringContaining('strava:enc:'),
            }),
          ]),
        }),
      );
    });

    it('should throw ValidationError when code is empty', async () => {
      await expect(service.handleOAuthCallback('', 'user-123')).rejects.toThrow(ValidationError);
    });

    it('should throw AuthenticationError when token exchange fails', async () => {
      mockStravaHttpClient.exchangeToken.mockRejectedValue(
        new AuthenticationError('Failed to exchange Strava authorization code for tokens'),
      );

      await expect(service.handleOAuthCallback('bad-code', 'user-123')).rejects.toThrow(
        AuthenticationError,
      );
    });

    it('should replace existing Strava entry in connectedSources', async () => {
      const settingsWithExisting: UserSettings = {
        ...mockSettings,
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: 'strava:enc:old-token',
          },
          {
            provider: 'manual',
            connected: true,
            connectedAt: new Date('2024-02-01'),
            oauthTokenEncrypted: 'gdrive:enc:some-token',
          },
        ],
      };

      mockStravaHttpClient.exchangeToken.mockResolvedValue(mockTokenResponse);
      mockSettingsService.getSettings.mockResolvedValue(settingsWithExisting);
      mockSettingsService.updateSettings.mockResolvedValue(mockSettings);

      await service.handleOAuthCallback('auth-code-123', 'user-123');

      const updateCall = mockSettingsService.updateSettings.mock.calls[0];
      const sources = updateCall[1].connectedSources!;

      // Should keep the Google Drive entry and replace the Strava entry
      expect(sources).toHaveLength(2);
      expect(sources.find((s) => s.provider === 'manual')).toBeDefined();
      expect(sources.find((s) => s.provider === 'strava')).toBeDefined();
      // Old strava entry should be gone
      expect(
        sources.find((s) => s.oauthTokenEncrypted === 'strava:enc:old-token'),
      ).toBeUndefined();
    });

    it('should set connectedAt to current date', async () => {
      mockStravaHttpClient.exchangeToken.mockResolvedValue(mockTokenResponse);
      mockSettingsService.getSettings.mockResolvedValue(mockSettings);
      mockSettingsService.updateSettings.mockResolvedValue(mockSettings);

      const before = new Date();
      await service.handleOAuthCallback('auth-code-123', 'user-123');
      const after = new Date();

      const updateCall = mockSettingsService.updateSettings.mock.calls[0];
      const stravaSource = updateCall[1].connectedSources!.find(
        (s) => s.provider === 'strava',
      );

      expect(stravaSource!.connectedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(stravaSource!.connectedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('verifyWebhook', () => {
    it('should return the challenge when verify token matches', () => {
      // The config.strava.webhookVerifyToken defaults to '' in test env
      const result = service.verifyWebhook('challenge-123', '');

      expect(result).toBe('challenge-123');
    });

    it('should throw AuthenticationError when verify token does not match', () => {
      expect(() => service.verifyWebhook('challenge-123', 'wrong-token')).toThrow(
        AuthenticationError,
      );
    });
  });

  describe('handleWebhookEvent (stub)', () => {
    it('should resolve without error', async () => {
      await expect(
        service.handleWebhookEvent({
          object_type: 'activity',
          object_id: 123,
          aspect_type: 'create',
          owner_id: 456,
          subscription_id: 789,
          event_time: 1700000000,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('handleWebhookEvent', () => {
    let serviceWithDeps: StravaSyncService;
    let mockWorkoutRepository: jest.Mocked<IWorkoutRepository>;
    let mockUploadService: jest.Mocked<IUploadService>;
    let mockLogger: jest.Mocked<Logger>;

    beforeEach(() => {
      mockWorkoutRepository = createMockWorkoutRepository();
      mockUploadService = createMockUploadService();
      mockLogger = createMockLogger();
      serviceWithDeps = new StravaSyncService(
        mockSettingsService,
        mockStravaHttpClient,
        mockWorkoutRepository,
        mockUploadService,
        mockLogger,
      );
    });

    it('should skip non-activity events', async () => {
      await serviceWithDeps.handleWebhookEvent({
        object_type: 'athlete',
        object_id: 123,
        aspect_type: 'update',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockWorkoutRepository.findBySourceActivityId).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Ignoring non-create activity webhook event',
        expect.any(Object),
      );
    });

    it('should skip non-create aspect types', async () => {
      await serviceWithDeps.handleWebhookEvent({
        object_type: 'activity',
        object_id: 123,
        aspect_type: 'update',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockWorkoutRepository.findBySourceActivityId).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Ignoring non-create activity webhook event',
        expect.any(Object),
      );
    });

    it('should skip delete aspect types', async () => {
      await serviceWithDeps.handleWebhookEvent({
        object_type: 'activity',
        object_id: 123,
        aspect_type: 'delete',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockWorkoutRepository.findBySourceActivityId).not.toHaveBeenCalled();
    });

    it('should check for duplicates using sourceActivityId', async () => {
      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue(null);

      await serviceWithDeps.handleWebhookEvent({
        object_type: 'activity',
        object_id: 99999,
        aspect_type: 'create',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockWorkoutRepository.findBySourceActivityId).toHaveBeenCalledWith('456', '99999');
    });

    it('should skip duplicate activities and log', async () => {
      const existingWorkout: WorkoutRecord = {
        id: 'existing-workout-id',
        userId: '456',
        activityType: 'ride',
        startTime: new Date('2024-01-15T10:00:00Z'),
        endTime: new Date('2024-01-15T11:00:00Z'),
        durationSeconds: 3600,
        distanceMeters: 30000,
        elevationGainMeters: 500,
        dataSource: 'strava',
        sourceActivityId: '99999',
        fileFormat: 'fit',
        driveFileId: 'drive-file-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue(existingWorkout);

      await serviceWithDeps.handleWebhookEvent({
        object_type: 'activity',
        object_id: 99999,
        aspect_type: 'create',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Skipping duplicate Strava activity',
        expect.objectContaining({
          sourceActivityId: '99999',
          existingWorkoutId: 'existing-workout-id',
        }),
      );
    });

    it('should download and ingest new activities through upload pipeline', async () => {
      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue(null);

      // Set up settings with a valid Strava connection
      const encryptedAccessToken = encryptStravaToken('test-access-token');
      const tokenData = JSON.stringify({
        accessToken: encryptedAccessToken,
        refreshToken: encryptStravaToken('test-refresh-token'),
        expiresAt: 1700000000,
        athleteId: 456,
      });
      const encryptedTokenData = encryptStravaToken(tokenData);

      const settingsWithStrava: UserSettings = {
        ...mockSettings,
        userId: '456',
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: `strava:${encryptedTokenData}`,
          },
        ],
      };
      mockSettingsService.getSettings.mockResolvedValue(settingsWithStrava);

      const mockDownload: StravaActivityDownload = {
        buffer: Buffer.from('fake-fit-data'),
        fileName: 'strava_12345.fit',
      };
      mockStravaHttpClient.downloadActivity.mockResolvedValue(mockDownload);

      mockUploadService.uploadSingle.mockResolvedValue({
        workoutId: 'new-workout-id',
        driveFileId: 'drive-file-id',
        summary: {
          activityType: 'ride',
          startTime: new Date('2024-01-15T10:00:00Z'),
          durationSeconds: 3600,
          distanceMeters: 30000,
        },
      });

      await serviceWithDeps.handleWebhookEvent({
        object_type: 'activity',
        object_id: 12345,
        aspect_type: 'create',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      // Verify download was called with correct params
      expect(mockStravaHttpClient.downloadActivity).toHaveBeenCalledWith(
        '12345',
        'test-access-token',
      );

      // Verify upload pipeline was called with correct params
      expect(mockUploadService.uploadSingle).toHaveBeenCalledWith(
        mockDownload.buffer,
        mockDownload.fileName,
        '456',
        {
          dataSource: 'strava',
          sourceActivityId: '12345',
        },
      );

      // Verify success was logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Successfully ingested Strava activity',
        expect.objectContaining({
          sourceActivityId: '12345',
          workoutId: 'new-workout-id',
        }),
      );
    });

    it('should log error when Strava access token retrieval fails', async () => {
      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue(null);

      // Settings with no Strava connection
      mockSettingsService.getSettings.mockResolvedValue(mockSettings);

      await serviceWithDeps.handleWebhookEvent({
        object_type: 'activity',
        object_id: 12345,
        aspect_type: 'create',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to retrieve Strava access token for activity download',
        expect.objectContaining({
          sourceActivityId: '12345',
          ownerAthleteId: '456',
        }),
      );

      // Should not attempt download
      expect(mockStravaHttpClient.downloadActivity).not.toHaveBeenCalled();
    });

    it('should log error when activity download fails', async () => {
      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue(null);

      // Set up valid Strava connection
      const encryptedAccessToken = encryptStravaToken('test-access-token');
      const tokenData = JSON.stringify({
        accessToken: encryptedAccessToken,
        refreshToken: encryptStravaToken('test-refresh-token'),
        expiresAt: 1700000000,
        athleteId: 456,
      });
      const encryptedTokenData = encryptStravaToken(tokenData);

      const settingsWithStrava: UserSettings = {
        ...mockSettings,
        userId: '456',
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: `strava:${encryptedTokenData}`,
          },
        ],
      };
      mockSettingsService.getSettings.mockResolvedValue(settingsWithStrava);

      mockStravaHttpClient.downloadActivity.mockRejectedValue(
        new Error('HTTP 500 from Strava'),
      );

      await serviceWithDeps.handleWebhookEvent({
        object_type: 'activity',
        object_id: 12345,
        aspect_type: 'create',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to download Strava activity',
        expect.objectContaining({
          sourceActivityId: '12345',
          ownerAthleteId: '456',
        }),
      );

      // Should not attempt upload
      expect(mockUploadService.uploadSingle).not.toHaveBeenCalled();
    });

    it('should log error when upload pipeline fails', async () => {
      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue(null);

      // Set up valid Strava connection
      const encryptedAccessToken = encryptStravaToken('test-access-token');
      const tokenData = JSON.stringify({
        accessToken: encryptedAccessToken,
        refreshToken: encryptStravaToken('test-refresh-token'),
        expiresAt: 1700000000,
        athleteId: 456,
      });
      const encryptedTokenData = encryptStravaToken(tokenData);

      const settingsWithStrava: UserSettings = {
        ...mockSettings,
        userId: '456',
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: `strava:${encryptedTokenData}`,
          },
        ],
      };
      mockSettingsService.getSettings.mockResolvedValue(settingsWithStrava);

      const mockDownload: StravaActivityDownload = {
        buffer: Buffer.from('fake-fit-data'),
        fileName: 'strava_12345.fit',
      };
      mockStravaHttpClient.downloadActivity.mockResolvedValue(mockDownload);

      mockUploadService.uploadSingle.mockRejectedValue(
        new Error('Drive upload failed'),
      );

      await serviceWithDeps.handleWebhookEvent({
        object_type: 'activity',
        object_id: 12345,
        aspect_type: 'create',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to ingest Strava activity through upload pipeline',
        expect.objectContaining({
          sourceActivityId: '12345',
          ownerAthleteId: '456',
        }),
      );
    });

    it('should warn when workout repository is not configured', async () => {
      const serviceNoDeps = new StravaSyncService(
        mockSettingsService,
        mockStravaHttpClient,
        undefined,
        undefined,
        mockLogger,
      );

      await serviceNoDeps.handleWebhookEvent({
        object_type: 'activity',
        object_id: 123,
        aspect_type: 'create',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Workout repository not configured, skipping webhook event processing',
      );
    });

    it('should warn when upload service is not configured but activity is new', async () => {
      const serviceNoUpload = new StravaSyncService(
        mockSettingsService,
        mockStravaHttpClient,
        mockWorkoutRepository,
        undefined,
        mockLogger,
      );

      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue(null);

      await serviceNoUpload.handleWebhookEvent({
        object_type: 'activity',
        object_id: 123,
        aspect_type: 'create',
        owner_id: 456,
        subscription_id: 789,
        event_time: 1700000000,
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Upload service not configured, skipping activity download',
        expect.objectContaining({
          sourceActivityId: '123',
          ownerAthleteId: '456',
        }),
      );
    });
  });

  describe('syncHistorical', () => {
    let serviceWithDeps: StravaSyncService;
    let mockWorkoutRepository: jest.Mocked<IWorkoutRepository>;
    let mockUploadService: jest.Mocked<IUploadService>;
    let mockLogger: jest.Mocked<Logger>;

    beforeEach(() => {
      mockWorkoutRepository = createMockWorkoutRepository();
      mockUploadService = createMockUploadService();
      mockLogger = createMockLogger();
      serviceWithDeps = new StravaSyncService(
        mockSettingsService,
        mockStravaHttpClient,
        mockWorkoutRepository,
        mockUploadService,
        mockLogger,
      );
    });

    it('should return empty result when no dependencies configured', async () => {
      const serviceNoDeps = new StravaSyncService(
        mockSettingsService,
        mockStravaHttpClient,
        undefined,
        undefined,
        mockLogger,
      );

      const result = await serviceNoDeps.syncHistorical('user-123');

      expect(result).toEqual({
        total: 0,
        successful: [],
        failed: [],
        inProgress: 0,
      });
    });

    it('should return empty result when access token retrieval fails', async () => {
      mockSettingsService.getSettings.mockResolvedValue(mockSettings);

      const result = await serviceWithDeps.syncHistorical('user-123');

      expect(result).toEqual({
        total: 0,
        successful: [],
        failed: [],
        inProgress: 0,
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to retrieve Strava access token for historical sync',
        expect.any(Object),
      );
    });

    it('should fetch all activities from Strava with pagination', async () => {
      const encryptedAccessToken = encryptStravaToken('test-access-token');
      const tokenData = JSON.stringify({
        accessToken: encryptedAccessToken,
        refreshToken: encryptStravaToken('test-refresh-token'),
        expiresAt: 1700000000,
        athleteId: 123,
      });
      const encryptedTokenData = encryptStravaToken(tokenData);

      const settingsWithStrava: UserSettings = {
        ...mockSettings,
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: `strava:${encryptedTokenData}`,
          },
        ],
      };
      mockSettingsService.getSettings.mockResolvedValue(settingsWithStrava);

      // Page 1 returns activities, page 2 returns empty (end of list)
      const activities: StravaActivitySummary[] = [
        { id: 1001, name: 'Morning Ride', type: 'Ride', start_date: '2024-01-15T10:00:00Z', elapsed_time: 3600, distance: 30000 },
        { id: 1002, name: 'Evening Ride', type: 'Ride', start_date: '2024-01-16T18:00:00Z', elapsed_time: 1800, distance: 15000 },
      ];
      mockStravaHttpClient.listActivities
        .mockResolvedValueOnce(activities)
        .mockResolvedValueOnce([]);

      // All activities are new
      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue(null);

      const mockDownload: StravaActivityDownload = {
        buffer: Buffer.from('fake-fit-data'),
        fileName: 'strava_activity.fit',
      };
      mockStravaHttpClient.downloadActivity.mockResolvedValue(mockDownload);

      mockUploadService.uploadSingle.mockResolvedValue({
        workoutId: 'new-workout-id',
        driveFileId: 'drive-file-id',
        summary: {
          activityType: 'ride',
          startTime: new Date('2024-01-15T10:00:00Z'),
          durationSeconds: 3600,
          distanceMeters: 30000,
        },
      });

      const result = await serviceWithDeps.syncHistorical('user-123');

      expect(result.total).toBe(2);
      expect(result.successful).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      expect(mockStravaHttpClient.listActivities).toHaveBeenCalledTimes(2);
    });

    it('should filter out already-ingested activities', async () => {
      const encryptedAccessToken = encryptStravaToken('test-access-token');
      const tokenData = JSON.stringify({
        accessToken: encryptedAccessToken,
        refreshToken: encryptStravaToken('test-refresh-token'),
        expiresAt: 1700000000,
        athleteId: 123,
      });
      const encryptedTokenData = encryptStravaToken(tokenData);

      const settingsWithStrava: UserSettings = {
        ...mockSettings,
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: `strava:${encryptedTokenData}`,
          },
        ],
      };
      mockSettingsService.getSettings.mockResolvedValue(settingsWithStrava);

      const activities: StravaActivitySummary[] = [
        { id: 1001, name: 'Morning Ride', type: 'Ride', start_date: '2024-01-15T10:00:00Z', elapsed_time: 3600, distance: 30000 },
        { id: 1002, name: 'Evening Ride', type: 'Ride', start_date: '2024-01-16T18:00:00Z', elapsed_time: 1800, distance: 15000 },
        { id: 1003, name: 'Weekend Ride', type: 'Ride', start_date: '2024-01-20T09:00:00Z', elapsed_time: 7200, distance: 60000 },
      ];
      mockStravaHttpClient.listActivities
        .mockResolvedValueOnce(activities)
        .mockResolvedValueOnce([]);

      // Activity 1002 already exists
      const existingWorkout: WorkoutRecord = {
        id: 'existing-id',
        userId: 'user-123',
        activityType: 'ride',
        startTime: new Date('2024-01-16T18:00:00Z'),
        endTime: new Date('2024-01-16T18:30:00Z'),
        durationSeconds: 1800,
        distanceMeters: 15000,
        elevationGainMeters: 100,
        dataSource: 'strava',
        sourceActivityId: '1002',
        fileFormat: 'fit',
        driveFileId: 'drive-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockWorkoutRepository.findBySourceActivityId
        .mockImplementation((_userId, sourceActivityId) => {
          if (sourceActivityId === '1002') {
            return Promise.resolve(existingWorkout);
          }
          return Promise.resolve(null);
        });

      const mockDownload: StravaActivityDownload = {
        buffer: Buffer.from('fake-fit-data'),
        fileName: 'strava_activity.fit',
      };
      mockStravaHttpClient.downloadActivity.mockResolvedValue(mockDownload);

      mockUploadService.uploadSingle.mockResolvedValue({
        workoutId: 'new-workout-id',
        driveFileId: 'drive-file-id',
        summary: {
          activityType: 'ride',
          startTime: new Date('2024-01-15T10:00:00Z'),
          durationSeconds: 3600,
          distanceMeters: 30000,
        },
      });

      const result = await serviceWithDeps.syncHistorical('user-123');

      // Only 2 activities should be synced (1001 and 1003)
      expect(result.total).toBe(2);
      expect(result.successful).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      // Download should only be called for non-existing activities
      expect(mockStravaHttpClient.downloadActivity).toHaveBeenCalledTimes(2);
      expect(mockStravaHttpClient.downloadActivity).toHaveBeenCalledWith('1001', 'test-access-token');
      expect(mockStravaHttpClient.downloadActivity).toHaveBeenCalledWith('1003', 'test-access-token');
    });

    it('should handle individual download failures without aborting', async () => {
      const encryptedAccessToken = encryptStravaToken('test-access-token');
      const tokenData = JSON.stringify({
        accessToken: encryptedAccessToken,
        refreshToken: encryptStravaToken('test-refresh-token'),
        expiresAt: 1700000000,
        athleteId: 123,
      });
      const encryptedTokenData = encryptStravaToken(tokenData);

      const settingsWithStrava: UserSettings = {
        ...mockSettings,
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: `strava:${encryptedTokenData}`,
          },
        ],
      };
      mockSettingsService.getSettings.mockResolvedValue(settingsWithStrava);

      const activities: StravaActivitySummary[] = [
        { id: 1001, name: 'Morning Ride', type: 'Ride', start_date: '2024-01-15T10:00:00Z', elapsed_time: 3600, distance: 30000 },
        { id: 1002, name: 'Evening Ride', type: 'Ride', start_date: '2024-01-16T18:00:00Z', elapsed_time: 1800, distance: 15000 },
      ];
      mockStravaHttpClient.listActivities
        .mockResolvedValueOnce(activities)
        .mockResolvedValueOnce([]);

      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue(null);

      // First download fails, second succeeds
      mockStravaHttpClient.downloadActivity
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce({
          buffer: Buffer.from('fake-fit-data'),
          fileName: 'strava_1002.fit',
        });

      mockUploadService.uploadSingle.mockResolvedValue({
        workoutId: 'new-workout-id',
        driveFileId: 'drive-file-id',
        summary: {
          activityType: 'ride',
          startTime: new Date('2024-01-16T18:00:00Z'),
          durationSeconds: 1800,
          distanceMeters: 15000,
        },
      });

      const result = await serviceWithDeps.syncHistorical('user-123');

      expect(result.total).toBe(2);
      expect(result.successful).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].fileName).toBe('strava_1001');
      expect(result.failed[0].errorCode).toBe('SYNC_FAILED');
    });

    it('should return empty result when all activities are already ingested', async () => {
      const encryptedAccessToken = encryptStravaToken('test-access-token');
      const tokenData = JSON.stringify({
        accessToken: encryptedAccessToken,
        refreshToken: encryptStravaToken('test-refresh-token'),
        expiresAt: 1700000000,
        athleteId: 123,
      });
      const encryptedTokenData = encryptStravaToken(tokenData);

      const settingsWithStrava: UserSettings = {
        ...mockSettings,
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: `strava:${encryptedTokenData}`,
          },
        ],
      };
      mockSettingsService.getSettings.mockResolvedValue(settingsWithStrava);

      const activities: StravaActivitySummary[] = [
        { id: 1001, name: 'Morning Ride', type: 'Ride', start_date: '2024-01-15T10:00:00Z', elapsed_time: 3600, distance: 30000 },
      ];
      mockStravaHttpClient.listActivities
        .mockResolvedValueOnce(activities)
        .mockResolvedValueOnce([]);

      // Activity already exists
      mockWorkoutRepository.findBySourceActivityId.mockResolvedValue({
        id: 'existing-id',
        userId: 'user-123',
        activityType: 'ride',
        startTime: new Date(),
        endTime: new Date(),
        durationSeconds: 3600,
        distanceMeters: 30000,
        elevationGainMeters: 0,
        dataSource: 'strava',
        sourceActivityId: '1001',
        fileFormat: 'fit',
        driveFileId: 'drive-123',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await serviceWithDeps.syncHistorical('user-123');

      expect(result.total).toBe(0);
      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(mockStravaHttpClient.downloadActivity).not.toHaveBeenCalled();
    });

    it('should return empty result when Strava has no activities', async () => {
      const encryptedAccessToken = encryptStravaToken('test-access-token');
      const tokenData = JSON.stringify({
        accessToken: encryptedAccessToken,
        refreshToken: encryptStravaToken('test-refresh-token'),
        expiresAt: 1700000000,
        athleteId: 123,
      });
      const encryptedTokenData = encryptStravaToken(tokenData);

      const settingsWithStrava: UserSettings = {
        ...mockSettings,
        connectedSources: [
          {
            provider: 'strava',
            connected: true,
            connectedAt: new Date('2024-01-01'),
            oauthTokenEncrypted: `strava:${encryptedTokenData}`,
          },
        ],
      };
      mockSettingsService.getSettings.mockResolvedValue(settingsWithStrava);

      mockStravaHttpClient.listActivities.mockResolvedValueOnce([]);

      const result = await serviceWithDeps.syncHistorical('user-123');

      expect(result.total).toBe(0);
      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe('registerWebhook (stub)', () => {
    it('should resolve without error', async () => {
      await expect(service.registerWebhook('https://example.com/webhook')).resolves.toBeUndefined();
    });
  });
});

describe('encryptStravaToken', () => {
  it('should return a string prefixed with enc:', () => {
    const result = encryptStravaToken('my-token');
    expect(result).toMatch(/^enc:/);
  });

  it('should encode the token in base64', () => {
    const result = encryptStravaToken('my-token');
    const encoded = result.replace('enc:', '');
    const decoded = Buffer.from(encoded, 'base64').toString();
    expect(decoded).toBe('my-token');
  });

  it('should produce different output for different tokens', () => {
    const result1 = encryptStravaToken('token-1');
    const result2 = encryptStravaToken('token-2');
    expect(result1).not.toBe(result2);
  });
});

describe('decryptStravaToken', () => {
  it('should reverse the encryption', () => {
    const original = 'my-secret-token';
    const encrypted = encryptStravaToken(original);
    const decrypted = decryptStravaToken(encrypted);
    expect(decrypted).toBe(original);
  });

  it('should throw AuthenticationError for invalid format', () => {
    expect(() => decryptStravaToken('invalid-no-prefix')).toThrow(AuthenticationError);
  });

  it('should handle empty token after prefix', () => {
    const encrypted = encryptStravaToken('');
    const decrypted = decryptStravaToken(encrypted);
    expect(decrypted).toBe('');
  });

  it('should handle tokens with special characters', () => {
    const original = 'token/with+special=chars&more';
    const encrypted = encryptStravaToken(original);
    const decrypted = decryptStravaToken(encrypted);
    expect(decrypted).toBe(original);
  });
});
