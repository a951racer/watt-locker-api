/**
 * PLAN-037B: Ingestion regression tests — no Google Drive configured.
 * These tests use a throwing storage adapter (simulating production without Drive OAuth)
 * to verify that ingestion completes successfully without Drive storage.
 */
import { UploadService } from './uploadService';
import { MongoWorkoutRepository } from '../repositories/workoutRepository';
import { MongoSourceArtifactRepository } from '../repositories/sourceArtifactRepository';
import { MongoSettingsRepository } from '../repositories/settingsRepository';
import { SettingsService } from './settingsService';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { WorkoutRecord } from '../models/workout';

/**
 * No-op storage adapter that THROWS on store — exactly like production
 * when the user has not configured Google Drive OAuth.
 */
const throwingStorageAdapter = {
  store: jest.fn().mockImplementation(() => {
    throw new Error('Google Drive storage adapter is not configured. Please connect Google Drive in settings.');
  }),
  retrieve: jest.fn().mockImplementation(() => { throw new Error('Not configured'); }),
  delete: jest.fn().mockImplementation(() => { throw new Error('Not configured'); }),
  listFiles: jest.fn().mockResolvedValue([]),
  removeFromFolder: jest.fn().mockImplementation(() => { throw new Error('Not configured'); }),
};

const mockParsedWorkout = {
  summary: {
    activityType: 'ride',
    startTime: new Date('2026-08-04T14:00:00Z'),
    endTime: new Date('2026-08-04T15:30:00Z'),
    durationSeconds: 5400,
    movingTimeSeconds: 5200,
    distanceMeters: 40000,
    elevationGainMeters: 300,
    title: 'TrainingPeaks Export',
  },
  dataPoints: [],
  sourceFormat: 'fit' as const,
};

const mockParser = {
  parse: jest.fn().mockResolvedValue(mockParsedWorkout),
  parseLightMetadata: jest.fn().mockResolvedValue({
    startTime: mockParsedWorkout.summary.startTime,
    durationSeconds: mockParsedWorkout.summary.durationSeconds,
    activityType: mockParsedWorkout.summary.activityType,
  }),
};

describe('PLAN-037B: Ingestion Without Google Drive', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let workoutRepo: MongoWorkoutRepository;
  let artifactRepo: MongoSourceArtifactRepository;
  let settingsRepo: MongoSettingsRepository;
  let settingsService: SettingsService;
  let uploadService: UploadService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db();

    workoutRepo = new MongoWorkoutRepository(db);
    await workoutRepo.createIndexes();
    artifactRepo = new MongoSourceArtifactRepository(db);
    await artifactRepo.createIndexes();
    settingsRepo = new MongoSettingsRepository(db);

    settingsService = new SettingsService(settingsRepo);
    await settingsRepo.upsert('user-1', {
      timezone: 'America/Chicago',
      ftpHistory: [{ effectiveDate: new Date('2024-01-01'), ftpWatts: 250 }],
    });

    const parserFactory = { getParser: jest.fn().mockReturnValue(mockParser) } as any;

    // Use the THROWING storage adapter — exactly like production without Drive
    uploadService = new UploadService(
      parserFactory,
      workoutRepo,
      throwingStorageAdapter as any,
      settingsService,
      undefined,
      artifactRepo,
    );
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    await db.collection('workouts').deleteMany({});
    await db.collection('sourceArtifacts').deleteMany({});
    jest.clearAllMocks();
    throwingStorageAdapter.store.mockImplementation(() => {
      throw new Error('Google Drive storage adapter is not configured.');
    });
    mockParser.parse.mockResolvedValue(mockParsedWorkout);
    mockParser.parseLightMetadata.mockResolvedValue({
      startTime: mockParsedWorkout.summary.startTime,
      durationSeconds: mockParsedWorkout.summary.durationSeconds,
      activityType: mockParsedWorkout.summary.activityType,
    });
  });

  describe('No-Drive Unmatched Import', () => {
    it('creates a completed activity even when Drive throws', async () => {
      const result = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout.fit',
        'user-1',
      );

      expect(result.workoutId).toBeDefined();
      expect(result.matchedExisting).toBe(false);

      // Verify the activity is persisted and retrievable
      const activity = await workoutRepo.findById(result.workoutId);
      expect(activity).not.toBeNull();
      expect(activity!.status).toBe('completed');
      expect(activity!.durationSeconds).toBe(5400);
      expect(activity!.distanceMeters).toBe(40000);
      expect(activity!.activityType).toBe('ride');
    });

    it('creates a SourceArtifact with fileContent when Drive unavailable', async () => {
      const fileBuffer = Buffer.from('fake-fit-data-binary');
      const result = await uploadService.uploadSingle(fileBuffer, 'workout.fit', 'user-1');

      const artifacts = await db.collection('sourceArtifacts').find({ userId: 'user-1' }).toArray();
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].driveFileId).toBe('local');
      expect(artifacts[0].activityId).toBe(result.workoutId);
      // Source binary is durably retained in MongoDB
      expect(artifacts[0].fileContent).toBeDefined();
      expect(Buffer.from(artifacts[0].fileContent.buffer).toString()).toBe('fake-fit-data-binary');
    });
  });

  describe('No-Drive Matched Import', () => {
    it('matches and materializes onto a planned activity without Drive', async () => {
      // Create a planned activity for Aug 4, 2026
      const planned = await workoutRepo.create({
        userId: 'user-1',
        status: 'planned',
        template: false,
        date: '2026-08-04',
        activityType: 'ride',
        title: 'Sweet Spot Intervals',
        plannedDurationSeconds: 5400,
        plannedTss: 96,
        plannedIf: 0.86,
      } as WorkoutRecord);

      const result = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout.fit',
        'user-1',
      );

      // Should match the existing planned activity
      expect(result.workoutId).toBe(planned.id);
      expect(result.matchedExisting).toBe(true);

      // Verify it's now completed with both planned and actual data
      const completed = await workoutRepo.findById(planned.id);
      expect(completed!.status).toBe('completed');
      expect(completed!.plannedDurationSeconds).toBe(5400);
      expect(completed!.plannedTss).toBe(96);
      expect(completed!.plannedIf).toBe(0.86);
      expect(completed!.durationSeconds).toBe(5400);
      expect(completed!.distanceMeters).toBe(40000);

      // Only ONE activity
      const count = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
      expect(count).toBe(1);
    });
  });

  describe('No-Drive Duplicate Import', () => {
    it('detects duplicate without Drive and does not create second artifact', async () => {
      // First import
      const result1 = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout1.fit',
        'user-1',
      );

      // Second import (same startTime + duration)
      const result2 = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout2.fit',
        'user-1',
      );

      expect(result2.workoutId).toBe(result1.workoutId);
      expect(result2.duplicate).toBe(true);

      // Only one activity
      const count = await db.collection('workouts').countDocuments({ userId: 'user-1', template: false });
      expect(count).toBe(1);

      // Only one artifact
      const artifacts = await db.collection('sourceArtifacts').find({ userId: 'user-1' }).toArray();
      expect(artifacts.length).toBe(1);
    });
  });

  describe('Drive-Configured Path Still Works', () => {
    it('stores Drive reference without fileContent when adapter succeeds', async () => {
      // Override the throwing adapter for this test only
      throwingStorageAdapter.store.mockResolvedValueOnce({
        fileId: 'drive-file-real',
        webViewLink: 'https://drive.google.com/real',
      });

      const result = await uploadService.uploadSingle(
        Buffer.from('fake-fit-data'),
        'workout.fit',
        'user-1',
      );

      expect(result.workoutId).toBeDefined();

      // Verify artifact has the real Drive reference and NO fileContent
      const artifacts = await db.collection('sourceArtifacts').find({ userId: 'user-1' }).toArray();
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].driveFileId).toBe('drive-file-real');
      expect(artifacts[0].fileContent).toBeUndefined();
    });
  });
});
