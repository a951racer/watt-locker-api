/**
 * PLAN-040 Regression Tests: Deduplicate Before Archival + Drive Fallback UX
 *
 * Tests verify:
 * 1. New source archives to Drive and reports archival: 'drive'
 * 2. Duplicate does NOT archive to Drive
 * 3. Duplicate after workout deletion does NOT archive to Drive
 * 4. Drive failure falls back to MongoDB and reports archival: 'fallback'
 * 6. Real ingestion failure remains a failure (not misreported as fallback)
 */
import { UploadService } from './uploadService';
import { ISourceArtifactRepository, SourceArtifactRecord } from '../repositories/sourceArtifactRepository';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { ParserFactory } from '../parsers/parserFactory';
import { FileStorageAdapter } from '../storage/googleDriveAdapter';
import { ISettingsService } from './settingsService';
// --- Mocks ---

const mockParser = {
  parse: jest.fn().mockResolvedValue({
    summary: {
      activityType: 'ride',
      startTime: new Date('2027-03-10T08:00:00Z'),
      endTime: new Date('2027-03-10T09:30:00Z'),
      durationSeconds: 5400,
      movingTimeSeconds: 5200,
      distanceMeters: 42000,
      elevationGainMeters: 350,
      title: 'Morning Ride',
    },
    dataPoints: [],
    sourceFormat: 'fit' as const,
  }),
  parseLightMetadata: jest.fn().mockResolvedValue({
    startTime: new Date('2027-03-10T08:00:00Z'),
    durationSeconds: 5400,
    activityType: 'ride',
  }),
};

const mockParserFactory: ParserFactory = {
  getParser: jest.fn().mockReturnValue(mockParser),
  registerParser: jest.fn(),
} as any;

let driveCounter = 0;
const mockDriveAdapter: jest.Mocked<FileStorageAdapter> = {
  store: jest.fn().mockImplementation(async () => ({
    fileId: `drive-${++driveCounter}`,
    fileName: `file-${driveCounter}.fit`,
    folderPath: '/uploads/2027/03',
    webViewLink: `https://drive.google.com/file/drive-${driveCounter}`,
  })),
  retrieve: jest.fn(),
  delete: jest.fn(),
  listFiles: jest.fn().mockResolvedValue([]),
  removeFromFolder: jest.fn(),
} as any;

let workoutIdCounter = 0;
let workoutStore: any[] = [];
const mockWorkoutRepository: Partial<IWorkoutRepository> = {
  create: jest.fn().mockImplementation(async (input: any) => {
    workoutIdCounter++;
    const record = {
      ...input,
      id: `workout-${workoutIdCounter}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    workoutStore.push(record);
    return record;
  }),
  findById: jest.fn().mockImplementation(async (id: string) => {
    return workoutStore.find((w) => w.id === id) ?? null;
  }),
  insertMetrics: jest.fn(),
  deleteMetrics: jest.fn(),
  findPlannedCandidates: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockImplementation(async (id: string, updates: any) => ({
    id,
    ...updates,
    updatedAt: new Date(),
  })),
  updateStatus: jest.fn(),
  updatePowerMetrics: jest.fn(),
  updateMaxPowers: jest.fn(),
  updateAvgSpeed: jest.fn(),
  materializeUpdate: jest.fn(),
};

const mockSettingsService: Partial<ISettingsService> = {
  getSettings: jest.fn().mockResolvedValue({
    userId: 'user-1',
    driveStoragePath: '/uploads',
    driveInboxPath: '/inbox',
    connectedSources: [],
    timezone: 'America/Chicago',
    updatedAt: new Date(),
    ftpHistory: [{ effectiveDate: new Date('2024-01-01'), ftpWatts: 250 }],
  }),
};

// In-memory artifact store
let artifactStore: SourceArtifactRecord[] = [];
let artifactIdCounter = 0;

const mockSourceArtifactRepository: ISourceArtifactRepository = {
  createIndexes: jest.fn(),
  create: jest.fn().mockImplementation(async (input: any) => {
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
  findDuplicateCandidate: jest.fn().mockImplementation(
    async (userId: string, startTime: Date, durationSeconds: number) => {
      return artifactStore.find(
        (a) =>
          a.userId === userId &&
          a.startTime?.getTime() === startTime.getTime() &&
          a.durationSeconds === durationSeconds,
      ) ?? null;
    },
  ),
  update: jest.fn().mockImplementation(async (id: string, updates: any) => {
    const idx = artifactStore.findIndex((a) => a.id === id);
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

// --- Test Suite ---

describe('PLAN-040: Deduplicate Before Archival + Drive Fallback UX', () => {
  let service: UploadService;

  beforeEach(() => {
    jest.clearAllMocks();
    artifactStore = [];
    artifactIdCounter = 0;
    driveCounter = 0;
    workoutIdCounter = 0;
    workoutStore = [];

    // Reset Drive adapter to succeed by default
    mockDriveAdapter.store.mockImplementation(async () => ({
      fileId: `drive-${++driveCounter}`,
      fileName: `file-${driveCounter}.fit`,
      folderPath: '/uploads/2027/03',
      webViewLink: `https://drive.google.com/file/drive-${driveCounter}`,
    }));

    service = new UploadService(
      mockParserFactory,
      mockWorkoutRepository as IWorkoutRepository,
      mockDriveAdapter,
      mockSettingsService as ISettingsService,
      undefined,
      mockSourceArtifactRepository,
    );
  });

  // =========================================================================
  // TEST 1: New source archives to Drive
  // =========================================================================
  describe('Test 1: New source archives to Drive', () => {
    it('should call Drive store exactly once for a new source', async () => {
      const result = await service.uploadSingle(Buffer.from('new-fit-data'), 'ride.fit', 'user-1');

      expect(mockDriveAdapter.store).toHaveBeenCalledTimes(1);
      expect(result.duplicate).toBeFalsy();
    });

    it('should create one SourceArtifact with a real Drive file ID', async () => {
      await service.uploadSingle(Buffer.from('new-fit-data'), 'ride.fit', 'user-1');

      expect(artifactStore).toHaveLength(1);
      expect(artifactStore[0].driveFileId).toMatch(/^drive-/);
      expect(artifactStore[0].fileContent).toBeUndefined();
    });

    it('should create a WorkoutRecord (materialized)', async () => {
      const result = await service.uploadSingle(Buffer.from('new-fit-data'), 'ride.fit', 'user-1');

      expect(result.workoutId).toBeDefined();
      expect(result.workoutId).not.toBe('');
      expect(mockWorkoutRepository.create).toHaveBeenCalledTimes(1);
    });

    it('should return archival: "drive" indicating successful Drive archival', async () => {
      const result = await service.uploadSingle(Buffer.from('new-fit-data'), 'ride.fit', 'user-1');

      expect(result.archival).toBe('drive');
    });
  });

  // =========================================================================
  // TEST 2: Duplicate does NOT archive to Drive
  // =========================================================================
  describe('Test 2: Duplicate does NOT archive to Drive', () => {
    it('should NOT call Drive store when a duplicate is detected', async () => {
      // First upload — new source
      await service.uploadSingle(Buffer.from('data1'), 'first.fit', 'user-1');
      expect(mockDriveAdapter.store).toHaveBeenCalledTimes(1);

      // Reset to track second call
      mockDriveAdapter.store.mockClear();

      // Second upload — same startTime+duration = duplicate
      const result = await service.uploadSingle(Buffer.from('data2'), 'second.fit', 'user-1');

      expect(result.duplicate).toBe(true);
      expect(mockDriveAdapter.store).not.toHaveBeenCalled();
    });

    it('should not create a second SourceArtifact for a duplicate', async () => {
      await service.uploadSingle(Buffer.from('data1'), 'first.fit', 'user-1');
      await service.uploadSingle(Buffer.from('data2'), 'second.fit', 'user-1');

      // Only the first upload creates an artifact
      expect(artifactStore).toHaveLength(1);
    });

    it('should not create a second WorkoutRecord for a duplicate', async () => {
      await service.uploadSingle(Buffer.from('data1'), 'first.fit', 'user-1');
      (mockWorkoutRepository.create as jest.Mock).mockClear();

      const result = await service.uploadSingle(Buffer.from('data2'), 'second.fit', 'user-1');

      expect(result.duplicate).toBe(true);
      expect(mockWorkoutRepository.create).not.toHaveBeenCalled();
    });

    it('should return duplicate result without archival field', async () => {
      await service.uploadSingle(Buffer.from('data1'), 'first.fit', 'user-1');
      const result = await service.uploadSingle(Buffer.from('data2'), 'second.fit', 'user-1');

      expect(result.duplicate).toBe(true);
      expect(result.archival).toBeUndefined();
    });
  });

  // =========================================================================
  // TEST 3: Re-import after Workout deletion RECOVERS without re-archiving (PLAN-050)
  //
  // Superseded by PLAN-050: a surviving artifact whose workout was deleted
  // (activityId=null, or pointing at a non-existent workout) is an ORPHANED
  // source, not an active duplicate. Re-importing must restore the workout by
  // REUSING the existing artifact (no new artifact, no Drive re-upload).
  // =========================================================================
  describe('Test 3: Re-import after Workout deletion recovers without re-archiving (PLAN-050)', () => {
    it('should recover an orphaned artifact (activityId=null) and re-import it', async () => {
      // Simulate: source was imported, then WorkoutRecord was deleted.
      // The SourceArtifact survives with activityId: null
      artifactStore.push({
        id: 'artifact-survived',
        userId: 'user-1',
        activityId: null, // WorkoutRecord deleted
        role: 'primary',
        materialized: true,
        source: 'manual',
        format: 'fit',
        originalFileName: 'original.fit',
        importedAt: new Date(),
        driveFileId: 'drive-original',
        startTime: new Date('2027-03-10T08:00:00Z'),
        durationSeconds: 5400,
        activityType: 'ride',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Attempt to re-import the same source
      const result = await service.uploadSingle(Buffer.from('same-data'), 'reimport.fit', 'user-1');

      // NOT a duplicate — the source is recoverable because no workout exists
      expect(result.duplicate).toBeUndefined();

      // Drive must NOT be called — the source is already archived
      expect(mockDriveAdapter.store).not.toHaveBeenCalled();

      // No new SourceArtifact — the surviving artifact is reused
      expect(artifactStore).toHaveLength(1);
      expect(artifactStore[0].id).toBe('artifact-survived');

      // A new WorkoutRecord IS created (no planned match here)
      expect(mockWorkoutRepository.create).toHaveBeenCalledTimes(1);

      // The workout is restored — result carries a real workout id
      expect(result.workoutId).not.toBe('');
      expect(result.workoutId).toBeDefined();

      // The reused artifact is re-associated to the new workout as primary
      expect(artifactStore[0].activityId).toBe(result.workoutId);
      expect(artifactStore[0].role).toBe('primary');
    });

    it('should recover an orphaned artifact whose workout no longer exists (stale activityId)', async () => {
      // Artifact still references an activityId, but that workout was deleted
      // from the workouts collection (findById returns null).
      artifactStore.push({
        id: 'artifact-stale',
        userId: 'user-1',
        activityId: 'workout-deleted-999',
        role: 'primary',
        materialized: true,
        source: 'manual',
        format: 'fit',
        originalFileName: 'original.fit',
        importedAt: new Date(),
        driveFileId: 'drive-original',
        startTime: new Date('2027-03-10T08:00:00Z'),
        durationSeconds: 5400,
        activityType: 'ride',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.uploadSingle(Buffer.from('same-data'), 'reimport.fit', 'user-1');

      expect(result.duplicate).toBeUndefined();
      expect(mockDriveAdapter.store).not.toHaveBeenCalled();
      expect(artifactStore).toHaveLength(1);
      expect(mockWorkoutRepository.create).toHaveBeenCalledTimes(1);
      expect(result.workoutId).not.toBe('');
      expect(artifactStore[0].activityId).toBe(result.workoutId);
      expect(artifactStore[0].role).toBe('primary');
    });

    it('should still treat a source with a LIVE workout as an active duplicate', async () => {
      // Seed a live workout and its primary artifact.
      workoutStore.push({ id: 'workout-live', userId: 'user-1', status: 'completed', template: false });
      artifactStore.push({
        id: 'artifact-live',
        userId: 'user-1',
        activityId: 'workout-live',
        role: 'primary',
        materialized: true,
        source: 'manual',
        format: 'fit',
        originalFileName: 'original.fit',
        importedAt: new Date(),
        driveFileId: 'drive-original',
        startTime: new Date('2027-03-10T08:00:00Z'),
        durationSeconds: 5400,
        activityType: 'ride',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.uploadSingle(Buffer.from('same-data'), 'reimport.fit', 'user-1');

      // Active duplicate — short-circuit, no recovery
      expect(result.duplicate).toBe(true);
      expect(mockDriveAdapter.store).not.toHaveBeenCalled();
      expect(artifactStore).toHaveLength(1);
      expect(mockWorkoutRepository.create).not.toHaveBeenCalled();
      // activityId points at the still-live workout
      expect(result.workoutId).toBe('workout-live');
    });

    it('should re-associate a recovered orphan to a matching planned Activity', async () => {
      // A planned activity exists on the source's date — recovery should match it.
      workoutStore.push({ id: 'planned-1', userId: 'user-1', status: 'planned', template: false });
      (mockWorkoutRepository.findPlannedCandidates as jest.Mock).mockResolvedValueOnce([
        { id: 'planned-1', userId: 'user-1', status: 'planned' },
      ]);
      artifactStore.push({
        id: 'artifact-orphan',
        userId: 'user-1',
        activityId: null,
        role: 'secondary',
        materialized: false,
        source: 'manual',
        format: 'fit',
        originalFileName: 'original.fit',
        importedAt: new Date(),
        driveFileId: 'drive-original',
        startTime: new Date('2027-03-10T08:00:00Z'),
        durationSeconds: 5400,
        activityType: 'ride',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.uploadSingle(Buffer.from('same-data'), 'reimport.fit', 'user-1');

      expect(result.duplicate).toBeUndefined();
      expect(mockDriveAdapter.store).not.toHaveBeenCalled();
      expect(artifactStore).toHaveLength(1);
      // Materialized onto the matched planned activity — no new workout created
      expect(mockWorkoutRepository.create).not.toHaveBeenCalled();
      expect(result.workoutId).toBe('planned-1');
      expect(artifactStore[0].activityId).toBe('planned-1');
    });

    it('should recover a local-fallback orphan (driveFileId="local") without Drive', async () => {
      artifactStore.push({
        id: 'artifact-local',
        userId: 'user-1',
        activityId: null,
        role: 'primary',
        materialized: false,
        source: 'manual',
        format: 'fit',
        originalFileName: 'original.fit',
        importedAt: new Date(),
        driveFileId: 'local',
        fileContent: Buffer.from('same-data'),
        startTime: new Date('2027-03-10T08:00:00Z'),
        durationSeconds: 5400,
        activityType: 'ride',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.uploadSingle(Buffer.from('same-data'), 'reimport.fit', 'user-1');

      expect(result.duplicate).toBeUndefined();
      expect(mockDriveAdapter.store).not.toHaveBeenCalled();
      expect(artifactStore).toHaveLength(1);
      // fileContent preserved on the reused artifact
      expect(artifactStore[0].fileContent).toBeDefined();
      expect(result.workoutId).not.toBe('');
    });

    it('should NOT expose another user orphaned artifact on re-import', async () => {
      // User-2 owns the orphaned artifact; User-1 imports the same signature.
      artifactStore.push({
        id: 'artifact-user2-orphan',
        userId: 'user-2',
        activityId: null,
        role: 'primary',
        materialized: true,
        source: 'manual',
        format: 'fit',
        originalFileName: 'original.fit',
        importedAt: new Date(),
        driveFileId: 'drive-original',
        startTime: new Date('2027-03-10T08:00:00Z'),
        durationSeconds: 5400,
        activityType: 'ride',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.uploadSingle(Buffer.from('same-data'), 'reimport.fit', 'user-1');

      // User-1 sees NO duplicate/recovery from User-2's artifact — fresh import.
      expect(result.duplicate).toBeUndefined();
      // A brand-new artifact is created for User-1 (Drive archived normally).
      expect(mockDriveAdapter.store).toHaveBeenCalledTimes(1);
      expect(artifactStore).toHaveLength(2);
      // User-2's artifact is untouched.
      const user2 = artifactStore.find((a) => a.id === 'artifact-user2-orphan')!;
      expect(user2.activityId).toBeNull();
      expect(user2.userId).toBe('user-2');
    });
  });

  // =========================================================================
  // TEST 4: Drive failure falls back to MongoDB
  // =========================================================================
  describe('Test 4: Drive failure falls back to MongoDB', () => {
    beforeEach(() => {
      // Make Drive throw
      mockDriveAdapter.store.mockImplementation(async () => {
        throw new Error('Google Drive storage adapter is not configured.');
      });
    });

    it('should succeed with ingestion when Drive throws', async () => {
      const result = await service.uploadSingle(Buffer.from('fit-data-binary'), 'ride.fit', 'user-1');

      expect(result.workoutId).toBeDefined();
      expect(result.workoutId).not.toBe('');
    });

    it('should create a SourceArtifact with driveFileId="local"', async () => {
      await service.uploadSingle(Buffer.from('fit-data-binary'), 'ride.fit', 'user-1');

      expect(artifactStore).toHaveLength(1);
      expect(artifactStore[0].driveFileId).toBe('local');
    });

    it('should retain the original file content in SourceArtifact', async () => {
      const fileBuffer = Buffer.from('fit-data-binary');
      await service.uploadSingle(fileBuffer, 'ride.fit', 'user-1');

      expect(artifactStore[0].fileContent).toBeDefined();
      expect(artifactStore[0].fileContent!.toString()).toBe('fit-data-binary');
    });

    it('should create a WorkoutRecord (materialized)', async () => {
      const result = await service.uploadSingle(Buffer.from('fit-data-binary'), 'ride.fit', 'user-1');

      expect(mockWorkoutRepository.create).toHaveBeenCalledTimes(1);
      expect(result.workoutId).toBeDefined();
    });

    it('should return archival: "fallback" indicating Drive failure', async () => {
      const result = await service.uploadSingle(Buffer.from('fit-data-binary'), 'ride.fit', 'user-1');

      expect(result.archival).toBe('fallback');
    });
  });

  // =========================================================================
  // TEST 6: Real ingestion failure remains a failure
  // =========================================================================
  describe('Test 6: Real ingestion failure remains a failure', () => {
    it('parser failure should throw, not become a fallback success', async () => {
      // Both light parse and full parse fail — intake proceeds with no metadata
      // but when it reaches materialization, full parse will throw
      mockParser.parseLightMetadata.mockRejectedValueOnce(new Error('Corrupt FIT file'));
      // After light parse fails, intake continues (light parse is non-fatal)
      // Then when materializeActivity calls parse, it also fails
      mockParser.parse.mockRejectedValueOnce(new Error('Corrupt FIT file'));

      // uploadFile wraps errors into BulkUploadResult.failed
      const bulkResult = await service.uploadFile(Buffer.from('corrupt'), 'bad.fit', 'user-1');

      // It should be a failure, not a successful fallback
      expect(bulkResult.failed).toHaveLength(1);
      expect(bulkResult.successful).toHaveLength(0);
      expect(bulkResult.failed[0].error).toContain('Corrupt FIT file');
    });

    it('parser failure during materialization should propagate as failure via uploadFile', async () => {
      // Light parse succeeds (for intake) but full parse fails (for materialization)
      mockParser.parseLightMetadata.mockResolvedValueOnce({
        startTime: new Date('2027-04-01T10:00:00Z'),
        durationSeconds: 3600,
        activityType: 'ride',
      });
      mockParser.parse.mockRejectedValueOnce(new Error('FIT file CRC mismatch'));

      // uploadFile wraps errors into BulkUploadResult.failed
      const bulkResult = await service.uploadFile(Buffer.from('corrupt'), 'bad.fit', 'user-1');

      expect(bulkResult.failed).toHaveLength(1);
      expect(bulkResult.successful).toHaveLength(0);
      expect(bulkResult.failed[0].error).toContain('CRC mismatch');
    });

    it('repository create failure should propagate as failure', async () => {
      // Drive succeeds, but workout create throws
      (mockWorkoutRepository.create as jest.Mock).mockRejectedValueOnce(
        new Error('MongoDB connection lost'),
      );

      const bulkResult = await service.uploadFile(Buffer.from('data'), 'ride.fit', 'user-1');

      expect(bulkResult.failed).toHaveLength(1);
      expect(bulkResult.successful).toHaveLength(0);
      expect(bulkResult.failed[0].error).toContain('MongoDB connection lost');
    });
  });
});
