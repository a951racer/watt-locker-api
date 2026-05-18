import { UploadService, Logger, FileInput } from './uploadService';
import { ParserFactory, WorkoutParser } from '../parsers/parserFactory';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { FileStorageAdapter, StorageReference } from '../storage/googleDriveAdapter';
import { ISettingsService } from './settingsService';
import { ParsedWorkout, WorkoutRecord } from '../models/workout';
import { UserSettings } from '../models/settings';
import { ValidationError, ConflictError } from '../utils/errors';

// --- Mock factories ---

function createMockParser(): jest.Mocked<WorkoutParser> {
  return {
    parse: jest.fn(),
    supports: jest.fn().mockReturnValue(true),
  };
}

function createMockParserFactory(): jest.Mocked<ParserFactory> {
  return {
    getParser: jest.fn(),
    getPrinter: jest.fn(),
  };
}

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

function createMockFileStorageAdapter(): jest.Mocked<FileStorageAdapter> {
  return {
    store: jest.fn(),
    retrieve: jest.fn(),
    delete: jest.fn(),
    listFiles: jest.fn(),
    removeFromFolder: jest.fn(),
  };
}

function createMockSettingsService(): jest.Mocked<ISettingsService> {
  return {
    getSettings: jest.fn(),
    updateSettings: jest.fn(),
  };
}

function createMockLogger(): jest.Mocked<Logger> {
  return {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  };
}

// --- Test data ---

const mockParsedWorkout: ParsedWorkout = {
  summary: {
    activityType: 'ride',
    startTime: new Date('2024-03-15T08:00:00Z'),
    endTime: new Date('2024-03-15T09:30:00Z'),
    durationSeconds: 5400,
    distanceMeters: 45000,
    elevationGainMeters: 350,
  },
  dataPoints: [
    {
      timestamp: new Date('2024-03-15T08:00:00Z'),
      workoutId: '',
      activityType: 'ride',
      dataSource: 'manual',
      heartRateBpm: 140,
      powerWatts: 200,
      cadenceRpm: 90,
      speedMps: 8.3,
    },
    {
      timestamp: new Date('2024-03-15T08:01:00Z'),
      workoutId: '',
      activityType: 'ride',
      dataSource: 'manual',
      heartRateBpm: 145,
      powerWatts: 220,
      cadenceRpm: 92,
      speedMps: 8.5,
    },
  ],
  sourceFormat: 'fit',
};

const mockStorageRef: StorageReference = {
  fileId: 'drive-file-123',
  fileName: 'morning-ride.fit',
  folderPath: 'WattLocker/2024/03',
  webViewLink: 'https://drive.google.com/file/d/drive-file-123/view',
};

const mockSettings: UserSettings = {
  userId: 'user-1',
  driveStoragePath: 'WattLocker',
  driveInboxPath: 'WattLocker/Inbox',
  connectedSources: [],
  updatedAt: new Date(),
};

const mockCreatedWorkout: WorkoutRecord = {
  id: 'workout-abc-123',
  userId: 'user-1',
  activityType: 'ride',
  startTime: new Date('2024-03-15T08:00:00Z'),
  endTime: new Date('2024-03-15T09:30:00Z'),
  durationSeconds: 5400,
  distanceMeters: 45000,
  elevationGainMeters: 350,
  avgPowerWatts: 210,
  maxPowerWatts: 220,
  avgHeartRateBpm: 143,
  maxHeartRateBpm: 145,
  avgCadenceRpm: 91,
  avgSpeedMps: 8,
  dataSource: 'manual',
  fileFormat: 'fit',
  driveFileId: 'drive-file-123',
  driveWebViewLink: 'https://drive.google.com/file/d/drive-file-123/view',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// --- Tests ---

describe('UploadService', () => {
  let service: UploadService;
  let mockParserFactory: jest.Mocked<ParserFactory>;
  let mockWorkoutRepo: jest.Mocked<IWorkoutRepository>;
  let mockStorage: jest.Mocked<FileStorageAdapter>;
  let mockSettingsService: jest.Mocked<ISettingsService>;
  let mockLogger: jest.Mocked<Logger>;
  let mockParser: jest.Mocked<WorkoutParser>;

  beforeEach(() => {
    mockParserFactory = createMockParserFactory();
    mockWorkoutRepo = createMockWorkoutRepository();
    mockStorage = createMockFileStorageAdapter();
    mockSettingsService = createMockSettingsService();
    mockLogger = createMockLogger();
    mockParser = createMockParser();

    // Default mock setups
    mockParserFactory.getParser.mockReturnValue(mockParser);
    mockParser.parse.mockResolvedValue(mockParsedWorkout);
    mockWorkoutRepo.findDuplicate.mockResolvedValue(null);
    mockSettingsService.getSettings.mockResolvedValue(mockSettings);
    mockStorage.store.mockResolvedValue(mockStorageRef);
    mockWorkoutRepo.create.mockResolvedValue(mockCreatedWorkout);
    mockWorkoutRepo.insertMetrics.mockResolvedValue(undefined);

    service = new UploadService(
      mockParserFactory,
      mockWorkoutRepo,
      mockStorage,
      mockSettingsService,
      mockLogger,
    );
  });

  describe('uploadSingle', () => {
    const file = Buffer.from('fake-fit-data');
    const fileName = 'morning-ride.fit';
    const userId = 'user-1';

    it('should successfully upload a single file through the full pipeline', async () => {
      const result = await service.uploadSingle(file, fileName, userId);

      expect(result).toEqual({
        workoutId: 'workout-abc-123',
        driveFileId: 'drive-file-123',
        summary: {
          activityType: 'ride',
          startTime: new Date('2024-03-15T08:00:00Z'),
          durationSeconds: 5400,
          distanceMeters: 45000,
        },
      });
    });

    it('should validate file format via ParserFactory', async () => {
      await service.uploadSingle(file, fileName, userId);

      expect(mockParserFactory.getParser).toHaveBeenCalledWith('fit');
    });

    it('should throw ValidationError for unsupported file format', async () => {
      mockParserFactory.getParser.mockImplementation(() => {
        throw new ValidationError('Unsupported file format: "pdf"');
      });

      await expect(service.uploadSingle(file, 'workout.pdf', userId)).rejects.toThrow(
        ValidationError,
      );
    });

    it('should throw ValidationError for file without extension', async () => {
      await expect(service.uploadSingle(file, 'noextension', userId)).rejects.toThrow(
        ValidationError,
      );
      await expect(service.uploadSingle(file, 'noextension', userId)).rejects.toThrow(
        /no extension/i,
      );
    });

    it('should parse the file using the resolved parser', async () => {
      await service.uploadSingle(file, fileName, userId);

      expect(mockParser.parse).toHaveBeenCalledWith(file);
    });

    it('should check for duplicates with userId, startTime, and durationSeconds', async () => {
      await service.uploadSingle(file, fileName, userId);

      expect(mockWorkoutRepo.findDuplicate).toHaveBeenCalledWith(
        userId,
        mockParsedWorkout.summary.startTime,
        mockParsedWorkout.summary.durationSeconds,
      );
    });

    it('should throw ConflictError when duplicate is found', async () => {
      mockWorkoutRepo.findDuplicate.mockResolvedValue(mockCreatedWorkout);

      await expect(service.uploadSingle(file, fileName, userId)).rejects.toThrow(ConflictError);
      await expect(service.uploadSingle(file, fileName, userId)).rejects.toThrow(/duplicate/i);
    });

    it('should not store file in Drive when duplicate is found', async () => {
      mockWorkoutRepo.findDuplicate.mockResolvedValue(mockCreatedWorkout);

      await expect(service.uploadSingle(file, fileName, userId)).rejects.toThrow();
      expect(mockStorage.store).not.toHaveBeenCalled();
    });

    it('should store the raw file in Google Drive with correct metadata', async () => {
      await service.uploadSingle(file, fileName, userId);

      expect(mockStorage.store).toHaveBeenCalledWith(file, {
        fileName,
        mimeType: 'application/vnd.ant.fit',
        workoutDate: mockParsedWorkout.summary.startTime,
        dataSource: 'manual',
      });
    });

    it('should use custom dataSource from options', async () => {
      await service.uploadSingle(file, fileName, userId, { dataSource: 'strava' });

      expect(mockStorage.store).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ dataSource: 'strava' }),
      );
    });

    it('should save workout record to DB after Drive upload', async () => {
      await service.uploadSingle(file, fileName, userId);

      expect(mockWorkoutRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          activityType: 'ride',
          startTime: mockParsedWorkout.summary.startTime,
          durationSeconds: 5400,
          distanceMeters: 45000,
          driveFileId: 'drive-file-123',
          fileFormat: 'fit',
          dataSource: 'manual',
        }),
      );
    });

    it('should insert time-series metrics after creating workout record', async () => {
      await service.uploadSingle(file, fileName, userId);

      expect(mockWorkoutRepo.insertMetrics).toHaveBeenCalledWith(
        'workout-abc-123',
        mockParsedWorkout.dataPoints,
      );
    });

    it('should not insert metrics when dataPoints is empty', async () => {
      const parsedNoMetrics: ParsedWorkout = {
        ...mockParsedWorkout,
        dataPoints: [],
      };
      mockParser.parse.mockResolvedValue(parsedNoMetrics);

      await service.uploadSingle(file, fileName, userId);

      expect(mockWorkoutRepo.insertMetrics).not.toHaveBeenCalled();
    });

    it('should log orphaned file when DB write fails after Drive upload', async () => {
      const dbError = new Error('MongoDB connection timeout');
      mockWorkoutRepo.create.mockRejectedValue(dbError);

      await expect(service.uploadSingle(file, fileName, userId)).rejects.toThrow(
        'MongoDB connection timeout',
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Orphaned file'),
        expect.objectContaining({
          driveFileId: 'drive-file-123',
          fileName,
          userId,
        }),
      );
    });

    it('should log orphaned file when insertMetrics fails after Drive upload', async () => {
      const metricsError = new Error('Metrics write failed');
      mockWorkoutRepo.insertMetrics.mockRejectedValue(metricsError);

      await expect(service.uploadSingle(file, fileName, userId)).rejects.toThrow(
        'Metrics write failed',
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Orphaned file'),
        expect.objectContaining({
          driveFileId: 'drive-file-123',
        }),
      );
    });

    it('should propagate Drive upload errors without creating DB record', async () => {
      const driveError = new Error('Google Drive API error');
      mockStorage.store.mockRejectedValue(driveError);

      await expect(service.uploadSingle(file, fileName, userId)).rejects.toThrow(
        'Google Drive API error',
      );
      expect(mockWorkoutRepo.create).not.toHaveBeenCalled();
    });

    it('should handle TCX file extension correctly', async () => {
      await service.uploadSingle(file, 'workout.tcx', userId);

      expect(mockParserFactory.getParser).toHaveBeenCalledWith('tcx');
      expect(mockStorage.store).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ mimeType: 'application/vnd.garmin.tcx+xml' }),
      );
    });

    it('should handle GPX file extension correctly', async () => {
      await service.uploadSingle(file, 'workout.gpx', userId);

      expect(mockParserFactory.getParser).toHaveBeenCalledWith('gpx');
      expect(mockStorage.store).toHaveBeenCalledWith(
        file,
        expect.objectContaining({ mimeType: 'application/gpx+xml' }),
      );
    });

    it('should pass sourceActivityId from options to workout record', async () => {
      await service.uploadSingle(file, fileName, userId, {
        dataSource: 'strava',
        sourceActivityId: 'strava-12345',
      });

      expect(mockWorkoutRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          dataSource: 'strava',
          sourceActivityId: 'strava-12345',
        }),
      );
    });

    it('should return UploadResult with correct workoutId and driveFileId', async () => {
      const result = await service.uploadSingle(file, fileName, userId);

      expect(result.workoutId).toBe('workout-abc-123');
      expect(result.driveFileId).toBe('drive-file-123');
    });

    it('should return summary with activityType, startTime, duration, and distance', async () => {
      const result = await service.uploadSingle(file, fileName, userId);

      expect(result.summary).toEqual({
        activityType: 'ride',
        startTime: new Date('2024-03-15T08:00:00Z'),
        durationSeconds: 5400,
        distanceMeters: 45000,
      });
    });
  });

  describe('uploadBulk', () => {
    const userId = 'user-1';

    function makeFileInput(fileName: string): FileInput {
      return { buffer: Buffer.from(`fake-data-${fileName}`), fileName };
    }

    it('should process multiple files successfully and return BulkUploadResult', async () => {
      const files: FileInput[] = [
        makeFileInput('ride1.fit'),
        makeFileInput('ride2.fit'),
        makeFileInput('ride3.fit'),
      ];

      const result = await service.uploadBulk(files, userId);

      expect(result.total).toBe(3);
      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
      expect(result.inProgress).toBe(0);
    });

    it('should continue processing remaining files when one fails', async () => {
      const files: FileInput[] = [
        makeFileInput('ride1.fit'),
        makeFileInput('bad-file.fit'),
        makeFileInput('ride3.fit'),
      ];

      // Make the second file fail during parsing
      let callCount = 0;
      mockParser.parse.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Corrupted file data');
        }
        return mockParsedWorkout;
      });

      const result = await service.uploadBulk(files, userId);

      expect(result.total).toBe(3);
      expect(result.successful).toHaveLength(2);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].fileName).toBe('bad-file.fit');
      expect(result.failed[0].error).toContain('Corrupted file data');
    });

    it('should track success/failure for each file independently', async () => {
      const files: FileInput[] = [
        makeFileInput('ride1.fit'),
        makeFileInput('ride2.fit'),
        makeFileInput('ride3.fit'),
        makeFileInput('ride4.fit'),
      ];

      // Make files 2 and 4 fail
      let callCount = 0;
      mockParser.parse.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('Parse error file 2');
        if (callCount === 4) throw new Error('Parse error file 4');
        return mockParsedWorkout;
      });

      const result = await service.uploadBulk(files, userId);

      expect(result.total).toBe(4);
      expect(result.successful).toHaveLength(2);
      expect(result.failed).toHaveLength(2);
      expect(result.failed[0].fileName).toBe('ride2.fit');
      expect(result.failed[0].error).toContain('Parse error file 2');
      expect(result.failed[1].fileName).toBe('ride4.fit');
      expect(result.failed[1].error).toContain('Parse error file 4');
    });

    it('should return BulkUploadResult with correct total, successful, failed, and inProgress counts', async () => {
      const files: FileInput[] = [
        makeFileInput('ride1.fit'),
        makeFileInput('ride2.fit'),
      ];

      // Make the first file fail with a ConflictError (duplicate)
      let callCount = 0;
      mockWorkoutRepo.findDuplicate.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return mockCreatedWorkout;
        return null;
      });

      const result = await service.uploadBulk(files, userId);

      expect(result.total).toBe(2);
      expect(result.successful).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.inProgress).toBe(0);
      expect(result.failed[0].fileName).toBe('ride1.fit');
      expect(result.failed[0].error).toContain('Duplicate');
    });

    it('should handle all files failing without throwing', async () => {
      const files: FileInput[] = [
        makeFileInput('bad1.fit'),
        makeFileInput('bad2.fit'),
      ];

      mockParser.parse.mockRejectedValue(new Error('All files corrupted'));

      const result = await service.uploadBulk(files, userId);

      expect(result.total).toBe(2);
      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(2);
      expect(result.inProgress).toBe(0);
    });

    it('should handle an empty file list', async () => {
      const result = await service.uploadBulk([], userId);

      expect(result.total).toBe(0);
      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.inProgress).toBe(0);
    });

    it('should pass dataSource option to each uploadSingle call', async () => {
      const files: FileInput[] = [makeFileInput('ride1.fit')];

      const result = await service.uploadBulk(files, userId, { dataSource: 'strava' });

      expect(result.successful).toHaveLength(1);
      expect(mockWorkoutRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ dataSource: 'strava' }),
      );
    });

    it('should include errorCode in failed upload entries', async () => {
      const files: FileInput[] = [makeFileInput('ride1.fit')];

      const validationError = new ValidationError('Bad format');
      (validationError as unknown as { code: string }).code = 'VALIDATION_ERROR';
      mockParser.parse.mockRejectedValue(validationError);

      const result = await service.uploadBulk(files, userId);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].errorCode).toBe('VALIDATION_ERROR');
    });

    it('should return UNKNOWN_ERROR code when error has no code property', async () => {
      const files: FileInput[] = [makeFileInput('ride1.fit')];

      mockParser.parse.mockRejectedValue(new Error('Something went wrong'));

      const result = await service.uploadBulk(files, userId);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].errorCode).toBe('UNKNOWN_ERROR');
    });

    it('should return successful UploadResult objects with correct structure', async () => {
      const files: FileInput[] = [makeFileInput('ride1.fit')];

      const result = await service.uploadBulk(files, userId);

      expect(result.successful[0]).toEqual({
        workoutId: 'workout-abc-123',
        driveFileId: 'drive-file-123',
        summary: {
          activityType: 'ride',
          startTime: new Date('2024-03-15T08:00:00Z'),
          durationSeconds: 5400,
          distanceMeters: 45000,
        },
      });
    });
  });

  describe('ingestFromInbox', () => {
    const userId = 'user-1';

    const inboxFileRefs = [
      {
        fileId: 'inbox-file-1',
        fileName: 'ride1.fit',
        folderPath: 'WattLocker/Inbox',
        webViewLink: 'https://drive.google.com/file/d/inbox-file-1/view',
      },
      {
        fileId: 'inbox-file-2',
        fileName: 'ride2.tcx',
        folderPath: 'WattLocker/Inbox',
        webViewLink: 'https://drive.google.com/file/d/inbox-file-2/view',
      },
      {
        fileId: 'inbox-file-3',
        fileName: 'ride3.gpx',
        folderPath: 'WattLocker/Inbox',
        webViewLink: 'https://drive.google.com/file/d/inbox-file-3/view',
      },
    ];

    beforeEach(() => {
      mockStorage.retrieve.mockResolvedValue(Buffer.from('fake-file-data'));
    });

    it('should list files from the user configured inbox folder path', async () => {
      mockStorage.listFiles.mockResolvedValue([]);

      await service.ingestFromInbox(userId);

      expect(mockSettingsService.getSettings).toHaveBeenCalledWith(userId);
      expect(mockStorage.listFiles).toHaveBeenCalledWith('WattLocker/Inbox');
    });

    it('should process each file through the upload pipeline', async () => {
      mockStorage.listFiles.mockResolvedValue(inboxFileRefs);

      await service.ingestFromInbox(userId);

      // Each file should be retrieved from Drive
      expect(mockStorage.retrieve).toHaveBeenCalledTimes(3);
      expect(mockStorage.retrieve).toHaveBeenCalledWith(inboxFileRefs[0]);
      expect(mockStorage.retrieve).toHaveBeenCalledWith(inboxFileRefs[1]);
      expect(mockStorage.retrieve).toHaveBeenCalledWith(inboxFileRefs[2]);

      // Each file should be parsed
      expect(mockParser.parse).toHaveBeenCalledTimes(3);

      // Each file should be stored in Drive (via uploadSingle pipeline)
      expect(mockStorage.store).toHaveBeenCalledTimes(3);
    });

    it('should remove successfully processed files from inbox', async () => {
      mockStorage.listFiles.mockResolvedValue(inboxFileRefs);

      await service.ingestFromInbox(userId);

      // removeFromFolder should be called for each successful file
      expect(mockStorage.removeFromFolder).toHaveBeenCalledTimes(3);
      expect(mockStorage.removeFromFolder).toHaveBeenCalledWith(inboxFileRefs[0]);
      expect(mockStorage.removeFromFolder).toHaveBeenCalledWith(inboxFileRefs[1]);
      expect(mockStorage.removeFromFolder).toHaveBeenCalledWith(inboxFileRefs[2]);
    });

    it('should leave failed files in inbox (removeFromFolder NOT called for failures)', async () => {
      mockStorage.listFiles.mockResolvedValue(inboxFileRefs);

      // Make the second file fail during parsing
      let callCount = 0;
      mockParser.parse.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Corrupted TCX data');
        }
        return mockParsedWorkout;
      });

      await service.ingestFromInbox(userId);

      // removeFromFolder should only be called for successful files (1st and 3rd)
      expect(mockStorage.removeFromFolder).toHaveBeenCalledTimes(2);
      expect(mockStorage.removeFromFolder).toHaveBeenCalledWith(inboxFileRefs[0]);
      expect(mockStorage.removeFromFolder).toHaveBeenCalledWith(inboxFileRefs[2]);
      // NOT called for the failed file
      expect(mockStorage.removeFromFolder).not.toHaveBeenCalledWith(inboxFileRefs[1]);
    });

    it('should return correct BulkUploadResult with total, successful, failed, and inProgress', async () => {
      mockStorage.listFiles.mockResolvedValue(inboxFileRefs);

      const result = await service.ingestFromInbox(userId);

      expect(result.total).toBe(3);
      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
      expect(result.inProgress).toBe(0);
      expect(result.successful[0]).toEqual({
        workoutId: 'workout-abc-123',
        driveFileId: 'drive-file-123',
        summary: {
          activityType: 'ride',
          startTime: new Date('2024-03-15T08:00:00Z'),
          durationSeconds: 5400,
          distanceMeters: 45000,
        },
      });
    });

    it('should handle empty inbox folder', async () => {
      mockStorage.listFiles.mockResolvedValue([]);

      const result = await service.ingestFromInbox(userId);

      expect(result.total).toBe(0);
      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.inProgress).toBe(0);
      expect(mockStorage.retrieve).not.toHaveBeenCalled();
      expect(mockStorage.removeFromFolder).not.toHaveBeenCalled();
    });

    it('should handle mixed success/failure scenarios correctly', async () => {
      mockStorage.listFiles.mockResolvedValue(inboxFileRefs);

      // Make files 1 and 3 succeed, file 2 fail
      let callCount = 0;
      mockParser.parse.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Parse error for ride2.tcx');
        }
        return mockParsedWorkout;
      });

      const result = await service.ingestFromInbox(userId);

      expect(result.total).toBe(3);
      expect(result.successful).toHaveLength(2);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].fileName).toBe('ride2.tcx');
      expect(result.failed[0].error).toContain('Parse error for ride2.tcx');
      expect(result.inProgress).toBe(0);

      // Only successful files removed from inbox
      expect(mockStorage.removeFromFolder).toHaveBeenCalledTimes(2);
    });

    it('should use the user configured driveInboxPath from settings', async () => {
      const customSettings: UserSettings = {
        ...mockSettings,
        driveInboxPath: 'MyCustom/InboxFolder',
      };
      mockSettingsService.getSettings.mockResolvedValue(customSettings);
      mockStorage.listFiles.mockResolvedValue([]);

      await service.ingestFromInbox(userId);

      expect(mockStorage.listFiles).toHaveBeenCalledWith('MyCustom/InboxFolder');
    });

    it('should continue processing remaining files when one fails', async () => {
      mockStorage.listFiles.mockResolvedValue(inboxFileRefs);

      // Make the first file fail
      let callCount = 0;
      mockParser.parse.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('First file corrupted');
        }
        return mockParsedWorkout;
      });

      const result = await service.ingestFromInbox(userId);

      // All 3 files should still be attempted
      expect(mockStorage.retrieve).toHaveBeenCalledTimes(3);
      expect(result.total).toBe(3);
      expect(result.successful).toHaveLength(2);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].fileName).toBe('ride1.fit');
    });

    it('should handle all files failing without throwing', async () => {
      mockStorage.listFiles.mockResolvedValue(inboxFileRefs);
      mockParser.parse.mockRejectedValue(new Error('All files corrupted'));

      const result = await service.ingestFromInbox(userId);

      expect(result.total).toBe(3);
      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(3);
      expect(result.inProgress).toBe(0);
      // No files should be removed from inbox
      expect(mockStorage.removeFromFolder).not.toHaveBeenCalled();
    });

    it('should include errorCode in failed entries', async () => {
      mockStorage.listFiles.mockResolvedValue([inboxFileRefs[0]]);

      const validationError = new ValidationError('Bad format');
      (validationError as unknown as { code: string }).code = 'VALIDATION_ERROR';
      mockParser.parse.mockRejectedValue(validationError);

      const result = await service.ingestFromInbox(userId);

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].errorCode).toBe('VALIDATION_ERROR');
      expect(result.failed[0].fileName).toBe('ride1.fit');
    });
  });
});
