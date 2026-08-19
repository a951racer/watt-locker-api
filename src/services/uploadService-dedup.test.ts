/**
 * PLAN-022 Tests: Duplicate detection via SourceArtifact
 */
import { UploadService } from './uploadService';
import { ISourceArtifactRepository, SourceArtifactRecord } from '../repositories/sourceArtifactRepository';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { ParserFactory } from '../parsers/parserFactory';
import { FileStorageAdapter } from '../storage/googleDriveAdapter';
import { ISettingsService } from './settingsService';

const mockParser = {
  parse: jest.fn(),
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

let driveCounter = 0;
const mockDriveAdapter: FileStorageAdapter = {
  store: jest.fn().mockImplementation(async () => ({ fileId: `drive-${++driveCounter}`, webViewLink: undefined })),
  retrieve: jest.fn(),
  delete: jest.fn(),
  listFiles: jest.fn().mockResolvedValue([]),
  removeFromFolder: jest.fn(),
};

const mockWorkoutRepository: Partial<IWorkoutRepository> = {
  create: jest.fn(),
  insertMetrics: jest.fn(),
  findPlannedCandidates: jest.fn().mockResolvedValue([]),
};

const mockSettingsService: Partial<ISettingsService> = {
  getSettings: jest.fn().mockResolvedValue({
    userId: 'user-1', driveStoragePath: '/uploads', driveInboxPath: '/inbox',
    connectedSources: [], timezone: 'America/Chicago', updatedAt: new Date(),
  }),
};

// In-memory artifact store
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
  findDuplicateCandidate: jest.fn().mockImplementation(async (userId: string, startTime: Date, durationSeconds: number) => {
    return artifactStore.find(a =>
      a.userId === userId &&
      a.startTime?.getTime() === startTime.getTime() &&
      a.durationSeconds === durationSeconds
    ) ?? null;
  }),
  update: jest.fn().mockImplementation(async (id: string, updates: any) => {
    const idx = artifactStore.findIndex(a => a.id === id);
    if (idx >= 0) {
      if (updates.role !== undefined) artifactStore[idx].role = updates.role;
      if (updates.activityId !== undefined) artifactStore[idx].activityId = updates.activityId;
      if (updates.materialized !== undefined) artifactStore[idx].materialized = updates.materialized;
    }
    return artifactStore[idx];
  }),
  findPrimaryByActivityId: jest.fn().mockResolvedValue(null),
  findUnassociated: jest.fn().mockResolvedValue([]),
  disassociateByActivityId: jest.fn().mockResolvedValue(0),
};

describe('PLAN-022: Duplicate detection via SourceArtifact', () => {
  let service: UploadService;

  beforeEach(() => {
    jest.clearAllMocks();
    artifactStore = [];
    artifactIdCounter = 0;
    driveCounter = 0;
    service = new UploadService(
      mockParserFactory,
      mockWorkoutRepository as IWorkoutRepository,
      mockDriveAdapter,
      mockSettingsService as ISettingsService,
      undefined,
      mockSourceArtifactRepository,
    );
  });

  describe('Non-duplicate (first upload)', () => {
    it('should classify first artifact as primary', async () => {
      const result = await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(result.duplicate).toBe(false);
      expect(result.role).toBe('primary');
      expect(result.activityId).toBeNull();
      expect(result.materialized).toBe(false);
    });
  });

  describe('Duplicate detected', () => {
    it('should detect duplicate and classify as secondary', async () => {
      // First upload
      const first = await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      expect(first.duplicate).toBe(false);
      expect(first.role).toBe('primary');

      // Second upload with same startTime/durationSeconds
      const second = await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(second.duplicate).toBe(true);
      expect(second.role).toBe('secondary');
    });

    it('should retain the duplicate artifact', async () => {
      await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(artifactStore).toHaveLength(2);
    });

    it('should set duplicate activityId to existing artifact activityId', async () => {
      // Pre-seed an artifact with an activityId
      artifactStore.push({
        id: 'artifact-pre',
        userId: 'user-1',
        activityId: 'activity-existing',
        role: 'primary',
        materialized: true,
        source: 'manual',
        format: 'fit',
        originalFileName: 'old.fit',
        importedAt: new Date(),
        driveFileId: 'drive-old',
        startTime: new Date('2027-01-15T07:00:00Z'),
        durationSeconds: 5400,
        activityType: 'ride',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      artifactIdCounter = 1;

      const result = await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(result.duplicate).toBe(true);
      expect(result.activityId).toBe('activity-existing');
      expect(result.role).toBe('secondary');
    });

    it('should keep duplicate materialized=false', async () => {
      await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      const second = await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(second.materialized).toBe(false);
    });

    it('should NOT modify the existing artifact', async () => {
      const first = await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      const firstArtifact = artifactStore.find(a => a.id === first.artifactId)!;
      const originalRole = firstArtifact.role;
      const originalActivityId = firstArtifact.activityId;

      await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');

      // First artifact unchanged
      expect(firstArtifact.role).toBe(originalRole);
      expect(firstArtifact.activityId).toBe(originalActivityId);
    });
  });

  describe('Cross-user isolation', () => {
    it('should NOT detect duplicate across different users', async () => {
      // User-2's artifact
      artifactStore.push({
        id: 'artifact-user2',
        userId: 'user-2',
        activityId: null,
        role: 'primary',
        materialized: false,
        source: 'manual',
        format: 'fit',
        originalFileName: 'other.fit',
        importedAt: new Date(),
        driveFileId: 'drive-other',
        startTime: new Date('2027-01-15T07:00:00Z'),
        durationSeconds: 5400,
        activityType: 'ride',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(result.duplicate).toBe(false);
      expect(result.role).toBe('primary');
    });
  });

  describe('Non-matching timing', () => {
    it('should NOT detect duplicate when startTime differs', async () => {
      await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      // Change startTime for second upload
      mockParser.parseLightMetadata.mockResolvedValueOnce({
        startTime: new Date('2027-01-16T07:00:00Z'), // different day
        durationSeconds: 5400,
        activityType: 'ride',
      });
      const second = await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(second.duplicate).toBe(false);
    });

    it('should NOT detect duplicate when durationSeconds differs', async () => {
      await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      mockParser.parseLightMetadata.mockResolvedValueOnce({
        startTime: new Date('2027-01-15T07:00:00Z'),
        durationSeconds: 3600, // different duration
        activityType: 'ride',
      });
      const second = await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(second.duplicate).toBe(false);
    });
  });

  describe('Missing metadata', () => {
    it('should NOT detect duplicate when startTime is missing', async () => {
      await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      mockParser.parseLightMetadata.mockResolvedValueOnce({
        startTime: undefined,
        durationSeconds: 5400,
        activityType: 'ride',
      });
      const second = await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(second.duplicate).toBe(false);
      expect(second.role).toBe('primary');
    });

    it('should NOT detect duplicate when durationSeconds is missing', async () => {
      await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      mockParser.parseLightMetadata.mockResolvedValueOnce({
        startTime: new Date('2027-01-15T07:00:00Z'),
        durationSeconds: undefined,
        activityType: 'ride',
      });
      const second = await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(second.duplicate).toBe(false);
      expect(second.role).toBe('primary');
    });
  });

  describe('No materialization', () => {
    it('should NOT create a WorkoutDocument for duplicates', async () => {
      await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(mockWorkoutRepository.create).not.toHaveBeenCalled();
      expect(mockWorkoutRepository.insertMetrics).not.toHaveBeenCalled();
    });
  });

  describe('Existing artifact with activityId=null', () => {
    it('should preserve null activityId on duplicate', async () => {
      // First upload has activityId=null (normal intake state)
      const first = await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      expect(first.activityId).toBeNull();

      // Duplicate should also get null
      const second = await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(second.activityId).toBeNull(); // preserves existing's null
    });
  });

  describe('Multiple artifacts with identical timing coexist', () => {
    it('should allow multiple artifacts with same timing (heuristic, not constraint)', async () => {
      await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      await service.intakeUpload(Buffer.from('data3'), 'ride3.fit', 'user-1');
      expect(artifactStore).toHaveLength(3);
      // All retained — first is primary, others are secondary
      expect(artifactStore[0].role).toBe('primary');
      expect(artifactStore[1].role).toBe('secondary');
      expect(artifactStore[2].role).toBe('secondary');
    });
  });

  describe('No ConflictError', () => {
    it('should NOT throw ConflictError for duplicate uploads in staged path', async () => {
      await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      // Second upload should succeed, not throw
      await expect(service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1'))
        .resolves.toBeDefined();
    });
  });

  describe('Non-duplicate remains available for PLAN-023', () => {
    it('should leave non-duplicate with activityId=null for future matching', async () => {
      const result = await service.intakeUpload(Buffer.from('data'), 'ride.fit', 'user-1');
      expect(result.activityId).toBeNull();
      expect(result.role).toBe('primary');
      expect(result.materialized).toBe(false);
    });
  });

  describe('Integration: intake → dedup → secondary → STOP', () => {
    it('should perform complete flow: intake creates artifact, dedup classifies secondary, no materialization', async () => {
      // First upload
      const first = await service.intakeUpload(Buffer.from('data1'), 'ride1.fit', 'user-1');
      expect(first.duplicate).toBe(false);
      expect(first.role).toBe('primary');
      expect(first.materialized).toBe(false);

      // Second upload (duplicate)
      const second = await service.intakeUpload(Buffer.from('data2'), 'ride2.fit', 'user-1');
      expect(second.duplicate).toBe(true);
      expect(second.role).toBe('secondary');
      expect(second.materialized).toBe(false);
      expect(second.activityId).toBeNull(); // existing had null

      // No materialization occurred
      expect(mockWorkoutRepository.create).not.toHaveBeenCalled();
      expect(mockWorkoutRepository.insertMetrics).not.toHaveBeenCalled();

      // Both artifacts retained
      expect(artifactStore).toHaveLength(2);
    });
  });
});
