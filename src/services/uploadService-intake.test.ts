/**
 * PLAN-021 Tests: intakeUpload — Lightweight source file ingestion
 */
import { UploadService } from './uploadService';
import { ISourceArtifactRepository, SourceArtifactRecord } from '../repositories/sourceArtifactRepository';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { ParserFactory } from '../parsers/parserFactory';
import { FileStorageAdapter } from '../storage/googleDriveAdapter';
import { ISettingsService } from './settingsService';
import { ParsedWorkout } from '../models/workout';

// Minimal mock parser that returns lightweight metadata
const mockParsedWorkout: ParsedWorkout = {
  summary: {
    activityType: 'ride',
    startTime: new Date('2027-01-15T07:00:00Z'),
    endTime: new Date('2027-01-15T08:30:00Z'),
    durationSeconds: 5400,
    distanceMeters: 45000,
    elevationGainMeters: 600,
  },
  dataPoints: [],
  sourceFormat: 'fit',
};

const mockParser = {
  parse: jest.fn().mockResolvedValue(mockParsedWorkout),
  parseLightMetadata: jest.fn().mockResolvedValue({
    startTime: new Date('2027-01-15T07:00:00Z'),
    durationSeconds: 5400,
    activityType: 'ride',
  }),
};
const mockParserFactory: ParserFactory = {
  getParser: jest.fn().mockReturnValue(mockParser),
  registerParser: jest.fn(),
} as any;

const mockDriveAdapter: FileStorageAdapter = {
  store: jest.fn().mockResolvedValue({ fileId: 'drive-new-123', webViewLink: 'https://drive.google.com/new' }),
  retrieve: jest.fn(),
  delete: jest.fn(),
  listFiles: jest.fn().mockResolvedValue([]),
  removeFromFolder: jest.fn(),
};

const mockWorkoutRepository: Partial<IWorkoutRepository> = {
  findDuplicate: jest.fn().mockResolvedValue(null),
  create: jest.fn(),
  insertMetrics: jest.fn(),
  findPlannedCandidates: jest.fn().mockResolvedValue([]),
};

const mockSettingsService: Partial<ISettingsService> = {
  getSettings: jest.fn().mockResolvedValue({
    userId: 'user-1',
    driveStoragePath: '/uploads',
    driveInboxPath: '/inbox',
    connectedSources: [],
    timezone: 'America/Chicago',
    updatedAt: new Date(),
  }),
};

let artifactStore: SourceArtifactRecord[] = [];
let artifactIdCounter = 0;

const mockSourceArtifactRepository: ISourceArtifactRepository = {
  createIndexes: jest.fn(),
  create: jest.fn().mockImplementation(async (input) => {
    artifactIdCounter++;
    const record: SourceArtifactRecord = {
      ...input,
      id: `artifact-${artifactIdCounter}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    artifactStore.push(record);
    return record;
  }),
  findById: jest.fn(),
  findByActivityId: jest.fn(),
  findDuplicateCandidate: jest.fn().mockResolvedValue(null),
  update: jest.fn(),
  findPrimaryByActivityId: jest.fn().mockResolvedValue(null),
  findUnassociated: jest.fn().mockResolvedValue([]),
  disassociateByActivityId: jest.fn().mockResolvedValue(0),
};

describe('PLAN-021: intakeUpload — Lightweight intake', () => {
  let service: UploadService;

  beforeEach(() => {
    jest.clearAllMocks();
    artifactStore = [];
    artifactIdCounter = 0;
    service = new UploadService(
      mockParserFactory,
      mockWorkoutRepository as IWorkoutRepository,
      mockDriveAdapter,
      mockSettingsService as ISettingsService,
      undefined, // default logger
      mockSourceArtifactRepository,
    );
  });

  describe('1. Successful intake', () => {
    it('should create a SourceArtifact with correct fields', async () => {
      const result = await service.intakeUpload(Buffer.from('data'), 'morning.fit', 'user-1');
      expect(result.artifactId).toBeDefined();
      expect(result.driveFileId).toBe('drive-new-123');
      expect(result.originalFileName).toBe('morning.fit');

      expect(mockSourceArtifactRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          activityId: null,
          role: 'primary',
          materialized: false,
          driveFileId: 'drive-new-123',
          originalFileName: 'morning.fit',
          format: 'fit',
          source: 'manual',
        }),
      );
    });

    it('should store file in Drive', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(mockDriveAdapter.store).toHaveBeenCalled();
    });
  });

  describe('2. Light metadata', () => {
    it('should extract startTime, durationSeconds, activityType', async () => {
      const result = await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(result.startTime).toEqual(new Date('2027-01-15T07:00:00Z'));
      expect(result.durationSeconds).toBe(5400);
      expect(result.activityType).toBe('ride');
    });
  });

  describe('3. No full materialization', () => {
    it('should NOT create a WorkoutDocument', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(mockWorkoutRepository.create).not.toHaveBeenCalled();
    });

    it('should NOT insert metrics', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(mockWorkoutRepository.insertMetrics).not.toHaveBeenCalled();
    });

    it('should set materialized=false', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      const createCall = (mockSourceArtifactRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.materialized).toBe(false);
    });
  });

  describe('4. Drive upload before artifact creation', () => {
    it('should call Drive store before creating artifact', async () => {
      const callOrder: string[] = [];
      const origStore = mockDriveAdapter.store as jest.Mock;
      const origCreate = mockSourceArtifactRepository.create as jest.Mock;

      origStore.mockImplementationOnce(async () => {
        callOrder.push('drive');
        return { fileId: 'drive-ordered', webViewLink: undefined };
      });
      origCreate.mockImplementationOnce(async (input: any) => {
        callOrder.push('artifact');
        return { ...input, id: 'art-order', createdAt: new Date(), updatedAt: new Date() };
      });

      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(callOrder).toEqual(['drive', 'artifact']);
    });
  });

  describe('5. Ownership', () => {
    it('should use authenticated userId', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-A');
      const createCall = (mockSourceArtifactRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.userId).toBe('user-A');
    });
  });

  describe('6. Filename', () => {
    it('should preserve original filename', async () => {
      await service.intakeUpload(Buffer.from('data'), 'My Morning Ride.fit', 'user-1');
      const createCall = (mockSourceArtifactRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.originalFileName).toBe('My Morning Ride.fit');
    });
  });

  describe('7. Supported formats', () => {
    it('should accept .fit files', async () => {
      const result = await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(result.artifactId).toBeDefined();
    });

    it('should validate format through parserFactory', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride.tcx', 'user-1');
      expect(mockParserFactory.getParser).toHaveBeenCalledWith('tcx');
    });
  });

  describe('8. Invalid upload', () => {
    it('should reject unsupported format', async () => {
      (mockParserFactory.getParser as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Unsupported format: pdf');
      });
      await expect(service.intakeUpload(Buffer.from('data'), 'file.pdf', 'user-1'))
        .rejects.toThrow();
      expect(mockSourceArtifactRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('9. Drive failure', () => {
    it('should create artifact with MongoDB fallback when Drive upload fails (PLAN-037D/PLAN-040)', async () => {
      const sourceBuffer = Buffer.from('ride-source-data');
      (mockDriveAdapter.store as jest.Mock).mockRejectedValueOnce(new Error('Drive unavailable'));

      const result = await service.intakeUpload(sourceBuffer, 'ride.fit', 'user-1');

      // Ingestion succeeds — does NOT reject
      expect(result.duplicate).toBe(false);
      expect(result.artifactId).toBeDefined();

      // SourceArtifact created with fallback representation
      expect(mockSourceArtifactRepository.create).toHaveBeenCalledTimes(1);
      expect(artifactStore).toHaveLength(1);
      expect(artifactStore[0].driveFileId).toBe('local');

      // Original source binary retained in MongoDB
      expect(artifactStore[0].fileContent).toBeDefined();
      expect(artifactStore[0].fileContent!.toString()).toBe('ride-source-data');

      // Result indicates archival fallback
      expect(result.driveArchivalFailed).toBe(true);
      expect(result.driveFileId).toBe('local');
    });
  });

  describe('10. Light parse behavior', () => {
    it('should proceed even if light parse fails (file stored successfully)', async () => {
      mockParser.parseLightMetadata.mockRejectedValueOnce(new Error('Parse error'));
      const result = await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      // Artifact created but without metadata
      expect(result.artifactId).toBeDefined();
      expect(result.startTime).toBeUndefined();
      expect(result.durationSeconds).toBeUndefined();
      expect(result.activityType).toBeUndefined();
    });

    it('should call parseLightMetadata (NOT full parse) during intake', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(mockParser.parseLightMetadata).toHaveBeenCalled();
      expect(mockParser.parse).not.toHaveBeenCalled();
    });
  });

  describe('12. Multiple uploads — no dedup', () => {
    it('should create separate artifacts for two identical files', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(artifactStore).toHaveLength(2);
      expect(artifactStore[0].activityId).toBeNull();
      expect(artifactStore[1].activityId).toBeNull();
      expect(artifactStore[0].role).toBe('primary');
      expect(artifactStore[1].role).toBe('primary');
    });
  });

  describe('PLAN-022 boundary — no dedup', () => {
    it('should NOT classify duplicate uploads as secondary', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride1.fit', 'user-1');
      await service.intakeUpload(Buffer.from('data'), 'ride2.fit', 'user-1');
      // Both are primary, neither is secondary
      for (const art of artifactStore) {
        expect(art.role).toBe('primary');
        expect(art.materialized).toBe(false);
      }
    });
  });

  describe('PLAN-023 boundary — no matching', () => {
    it('should NOT associate artifact with any Activity', async () => {
      await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      const createCall = (mockSourceArtifactRepository.create as jest.Mock).mock.calls[0][0];
      expect(createCall.activityId).toBeNull();
    });
  });
});
