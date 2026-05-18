import { SettingsService } from './settingsService';
import { ISettingsRepository } from '../repositories/settingsRepository';
import { UserSettings } from '../models/settings';

describe('SettingsService', () => {
  let settingsService: SettingsService;
  let mockSettingsRepository: jest.Mocked<ISettingsRepository>;

  const mockSettings: UserSettings = {
    userId: 'user-123',
    driveStoragePath: 'WattLocker',
    driveInboxPath: 'WattLocker/Inbox',
    connectedSources: [],
    updatedAt: new Date('2024-06-01T00:00:00Z'),
  };

  beforeEach(() => {
    mockSettingsRepository = {
      findByUserId: jest.fn(),
      upsert: jest.fn(),
    };

    settingsService = new SettingsService(mockSettingsRepository);
  });

  describe('getSettings', () => {
    it('should return existing settings when found', async () => {
      mockSettingsRepository.findByUserId.mockResolvedValue(mockSettings);

      const result = await settingsService.getSettings('user-123');

      expect(mockSettingsRepository.findByUserId).toHaveBeenCalledWith('user-123');
      expect(result).toEqual(mockSettings);
      expect(mockSettingsRepository.upsert).not.toHaveBeenCalled();
    });

    it('should create default settings when none exist', async () => {
      mockSettingsRepository.findByUserId.mockResolvedValue(null);
      mockSettingsRepository.upsert.mockResolvedValue(mockSettings);

      const result = await settingsService.getSettings('user-123');

      expect(mockSettingsRepository.findByUserId).toHaveBeenCalledWith('user-123');
      expect(mockSettingsRepository.upsert).toHaveBeenCalledWith('user-123', {});
      expect(result).toEqual(mockSettings);
    });

    it('should pass the correct userId to the repository', async () => {
      mockSettingsRepository.findByUserId.mockResolvedValue(null);
      mockSettingsRepository.upsert.mockResolvedValue({
        ...mockSettings,
        userId: 'different-user',
      });

      await settingsService.getSettings('different-user');

      expect(mockSettingsRepository.findByUserId).toHaveBeenCalledWith('different-user');
      expect(mockSettingsRepository.upsert).toHaveBeenCalledWith('different-user', {});
    });
  });

  describe('updateSettings', () => {
    it('should update driveStoragePath and persist immediately', async () => {
      const updatedSettings: UserSettings = {
        ...mockSettings,
        driveStoragePath: 'MyCustomFolder',
        updatedAt: new Date('2024-06-02T00:00:00Z'),
      };
      mockSettingsRepository.upsert.mockResolvedValue(updatedSettings);

      const result = await settingsService.updateSettings('user-123', {
        driveStoragePath: 'MyCustomFolder',
      });

      expect(mockSettingsRepository.upsert).toHaveBeenCalledWith('user-123', {
        driveStoragePath: 'MyCustomFolder',
      });
      expect(result).toEqual(updatedSettings);
    });

    it('should update driveInboxPath and persist immediately', async () => {
      const updatedSettings: UserSettings = {
        ...mockSettings,
        driveInboxPath: 'MyCustomFolder/Inbox',
        updatedAt: new Date('2024-06-02T00:00:00Z'),
      };
      mockSettingsRepository.upsert.mockResolvedValue(updatedSettings);

      const result = await settingsService.updateSettings('user-123', {
        driveInboxPath: 'MyCustomFolder/Inbox',
      });

      expect(mockSettingsRepository.upsert).toHaveBeenCalledWith('user-123', {
        driveInboxPath: 'MyCustomFolder/Inbox',
      });
      expect(result).toEqual(updatedSettings);
    });

    it('should update connectedSources and persist immediately', async () => {
      const connectedSources = [
        { provider: 'strava' as const, connected: true, connectedAt: new Date() },
      ];
      const updatedSettings: UserSettings = {
        ...mockSettings,
        connectedSources,
        updatedAt: new Date('2024-06-02T00:00:00Z'),
      };
      mockSettingsRepository.upsert.mockResolvedValue(updatedSettings);

      const result = await settingsService.updateSettings('user-123', {
        connectedSources,
      });

      expect(mockSettingsRepository.upsert).toHaveBeenCalledWith('user-123', {
        connectedSources,
      });
      expect(result).toEqual(updatedSettings);
    });

    it('should support partial updates with multiple fields', async () => {
      const updatedSettings: UserSettings = {
        ...mockSettings,
        driveStoragePath: 'NewPath',
        driveInboxPath: 'NewPath/Inbox',
        updatedAt: new Date('2024-06-02T00:00:00Z'),
      };
      mockSettingsRepository.upsert.mockResolvedValue(updatedSettings);

      const result = await settingsService.updateSettings('user-123', {
        driveStoragePath: 'NewPath',
        driveInboxPath: 'NewPath/Inbox',
      });

      expect(mockSettingsRepository.upsert).toHaveBeenCalledWith('user-123', {
        driveStoragePath: 'NewPath',
        driveInboxPath: 'NewPath/Inbox',
      });
      expect(result).toEqual(updatedSettings);
    });

    it('should strip userId from updates to prevent overwriting', async () => {
      mockSettingsRepository.upsert.mockResolvedValue(mockSettings);

      await settingsService.updateSettings('user-123', {
        userId: 'malicious-user-id',
        driveStoragePath: 'NewPath',
      } as Partial<UserSettings>);

      expect(mockSettingsRepository.upsert).toHaveBeenCalledWith('user-123', {
        driveStoragePath: 'NewPath',
      });
    });

    it('should strip updatedAt from updates as it is managed internally', async () => {
      mockSettingsRepository.upsert.mockResolvedValue(mockSettings);

      await settingsService.updateSettings('user-123', {
        updatedAt: new Date('1999-01-01'),
        driveStoragePath: 'NewPath',
      } as Partial<UserSettings>);

      expect(mockSettingsRepository.upsert).toHaveBeenCalledWith('user-123', {
        driveStoragePath: 'NewPath',
      });
    });

    it('should create settings with defaults if user has no existing settings', async () => {
      // upsert handles creation with defaults when no document exists
      mockSettingsRepository.upsert.mockResolvedValue(mockSettings);

      const result = await settingsService.updateSettings('new-user', {
        driveStoragePath: 'CustomPath',
      });

      expect(mockSettingsRepository.upsert).toHaveBeenCalledWith('new-user', {
        driveStoragePath: 'CustomPath',
      });
      expect(result).toEqual(mockSettings);
    });
  });
});
