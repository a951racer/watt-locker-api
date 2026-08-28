/**
 * PLAN-044 Regression Tests: Actual Normalized Power source selection.
 *
 * Watt Locker must prefer its OWN stream-computed NP when sufficient power data
 * exists, falling back to the FIT device/session-reported NP only when the
 * stream computation is unavailable (< 30 power samples).
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db, ObjectId } from 'mongodb';
import { UploadService } from './uploadService';
import { MongoWorkoutRepository } from '../repositories/workoutRepository';
import { MongoSourceArtifactRepository } from '../repositories/sourceArtifactRepository';
import { MongoSettingsRepository } from '../repositories/settingsRepository';
import { SettingsService } from './settingsService';
import { DefaultParserFactory } from '../parsers/parserFactory';
import { ParsedWorkout, MetricDataPoint, WorkoutRecord } from '../models/workout';
import { FileStorageAdapter } from '../storage/googleDriveAdapter';

const START = new Date('2027-06-15T14:00:00Z');

/** Build N power samples all at a constant wattage (stream NP will equal that wattage). */
function constantPowerPoints(count: number, watts: number): MetricDataPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(START.getTime() + i * 1000),
    workoutId: '',
    activityType: 'ride',
    dataSource: 'manual' as const,
    powerWatts: watts,
  }));
}

const mockDriveAdapter: FileStorageAdapter = {
  store: jest.fn().mockResolvedValue({ fileId: 'drive-test', fileName: 'f.fit', folderPath: '/x', webViewLink: undefined }),
  retrieve: jest.fn().mockResolvedValue(Buffer.from('fake')),
  delete: jest.fn(),
  listFiles: jest.fn().mockResolvedValue([]),
  removeFromFolder: jest.fn(),
} as any;

describe('PLAN-044: Actual NP source selection', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let workoutRepo: MongoWorkoutRepository;
  let artifactRepo: MongoSourceArtifactRepository;
  let settingsRepo: MongoSettingsRepository;
  let uploadService: UploadService;
  let mockParser: any;
  let mockParserFactory: DefaultParserFactory;

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
    const settingsService = new SettingsService(settingsRepo);
    // FTP history so ftpUsed = 270 for the activity date
    await settingsRepo.upsert('user-1', {
      timezone: 'America/Chicago',
      ftpHistory: [{ effectiveDate: new Date('2024-01-01'), ftpWatts: 270 }],
    });

    mockParser = {
      parse: jest.fn(),
      parseLightMetadata: jest.fn().mockResolvedValue({ startTime: START, durationSeconds: 3600, activityType: 'ride' }),
      supports: jest.fn().mockReturnValue(true),
    };
    mockParserFactory = new DefaultParserFactory();
    (mockParserFactory as any).parsers = new Map([['fit', mockParser]]);

    uploadService = new UploadService(
      mockParserFactory,
      workoutRepo,
      mockDriveAdapter,
      settingsService,
      undefined,
      artifactRepo,
    );
  }, 60_000);

  afterAll(async () => { await client.close(); await mongod.stop(); });

  // --- Direct unit tests on the private selection helper ---
  function selectNP(parsed: ParsedWorkout): number | undefined {
    return (uploadService as any).selectNormalizedPower(parsed);
  }

  function buildParsed(overrides: Partial<ParsedWorkout['summary']>, dataPoints: MetricDataPoint[]): ParsedWorkout {
    return {
      summary: {
        activityType: 'ride',
        startTime: START,
        endTime: new Date(START.getTime() + 3600000),
        durationSeconds: 3600,
        movingTimeSeconds: 3500,
        distanceMeters: 30000,
        elevationGainMeters: 100,
        ...overrides,
      },
      dataPoints,
      sourceFormat: 'fit',
    } as ParsedWorkout;
  }

  describe('Test 1 — Stream NP wins over device NP', () => {
    it('prefers stream-computed NP (200) over device NP (201)', () => {
      // Constant 200W stream → stream NP = 200. Device says 201.
      const parsed = buildParsed({ normalizedPowerWatts: 201 }, constantPowerPoints(120, 200));
      expect(selectNP(parsed)).toBe(200);
    });
  });

  describe('Test 4 — Device NP fallback when insufficient stream data', () => {
    it('uses device NP when fewer than 30 power samples exist', () => {
      // Only 10 power samples → computeNormalizedPower returns undefined → fall back to device NP
      const parsed = buildParsed({ normalizedPowerWatts: 201 }, constantPowerPoints(10, 200));
      expect(selectNP(parsed)).toBe(201);
    });
  });

  describe('Test 5 — Neither NP source available', () => {
    it('returns undefined when stream cannot compute and no device NP', () => {
      const parsed = buildParsed({}, constantPowerPoints(10, 200)); // <30 samples, no device NP
      expect(selectNP(parsed)).toBeUndefined();
    });
  });

  // --- Integration tests through materializeActivity ---
  describe('Test 2 & 3 — IF and TSS use the selected (stream) NP', () => {
    it('persists NP=200, IF from 200/270, TSS from 200 + moving time', async () => {
      // Create a planned activity to materialize onto
      const planned = await workoutRepo.create({
        userId: 'user-1', status: 'planned', template: false, date: '2027-06-15',
        activityType: 'ride',
      } as WorkoutRecord);
      const artifact = await artifactRepo.create({
        userId: 'user-1', activityId: planned.id, role: 'primary', materialized: false,
        source: 'manual', format: 'fit', originalFileName: 'ride.fit',
        importedAt: new Date(), driveFileId: 'drive-x',
      });

      // Parsed workout: constant 200W stream, device NP=201, moving time 5581.806s
      mockParser.parse.mockResolvedValue(buildParsed(
        { normalizedPowerWatts: 201, movingTimeSeconds: 5581.806, durationSeconds: 5810.182 },
        constantPowerPoints(120, 200),
      ));

      await uploadService.materializeActivity(planned.id, 'user-1', Buffer.from('fake'), 'ride.fit', artifact.id);

      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(planned.id) });
      // Stream NP (200) preferred over device NP (201)
      expect(doc!.normalizedPowerWatts).toBe(200);
      // IF = round(200/270, 3) = 0.741
      expect(doc!.intensityFactor).toBe(0.741);
      // TSS = (5581.806 × 200²) / (270² × 3600) × 100 ≈ 85.1
      expect(doc!.tss).toBeCloseTo(85.1, 0);
    });
  });

  describe('Test 6 — Moving time remains the TSS duration', () => {
    it('uses movingTimeSeconds not durationSeconds for TSS', async () => {
      const planned = await workoutRepo.create({
        userId: 'user-1', status: 'planned', template: false, date: '2027-06-15',
        activityType: 'ride',
      } as WorkoutRecord);
      const artifact = await artifactRepo.create({
        userId: 'user-1', activityId: planned.id, role: 'primary', materialized: false,
        source: 'manual', format: 'fit', originalFileName: 'ride2.fit',
        importedAt: new Date(), driveFileId: 'drive-y',
      });

      // moving=3600 (1h), elapsed=7200 (2h). At NP=270=FTP, IF=1.0.
      // TSS with moving (3600) = 100; TSS with elapsed (7200) = 200.
      mockParser.parse.mockResolvedValue(buildParsed(
        { movingTimeSeconds: 3600, durationSeconds: 7200 },
        constantPowerPoints(120, 270),
      ));

      await uploadService.materializeActivity(planned.id, 'user-1', Buffer.from('fake'), 'ride2.fit', artifact.id);

      const doc = await db.collection('workouts').findOne({ _id: new ObjectId(planned.id) });
      expect(doc!.normalizedPowerWatts).toBe(270);
      // Confirms moving time (3600) used → TSS ≈ 100, not 200
      expect(doc!.tss).toBeCloseTo(100, 0);
    });
  });
});
