/**
 * PLAN-043: Average cadence calculation tests.
 * Verifies that zero-cadence samples (coasting) are excluded from the average.
 */
import { UploadService } from './uploadService';
import { ISourceArtifactRepository, SourceArtifactRecord } from '../repositories/sourceArtifactRepository';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { ParserFactory } from '../parsers/parserFactory';
import { FileStorageAdapter } from '../storage/googleDriveAdapter';
import { ISettingsService } from './settingsService';

const mockParserFactory: ParserFactory = {
  getParser: jest.fn(),
  registerParser: jest.fn(),
} as any;

const mockDriveAdapter: FileStorageAdapter = {
  store: jest.fn().mockResolvedValue({ fileId: 'drive-1', fileName: 'f.fit', folderPath: '/x', webViewLink: undefined }),
  retrieve: jest.fn(),
  delete: jest.fn(),
  listFiles: jest.fn().mockResolvedValue([]),
  removeFromFolder: jest.fn(),
} as any;

const mockWorkoutRepository: Partial<IWorkoutRepository> = {
  create: jest.fn().mockResolvedValue({ id: 'w1' }),
  findById: jest.fn().mockResolvedValue({ id: 'w1', userId: 'u1' }),
  insertMetrics: jest.fn(),
  deleteMetrics: jest.fn(),
  findPlannedCandidates: jest.fn().mockResolvedValue([]),
  updateStatus: jest.fn(),
  updatePowerMetrics: jest.fn(),
  updateMaxPowers: jest.fn(),
  updateAvgSpeed: jest.fn(),
  materializeUpdate: jest.fn(),
};

const mockSettingsService: Partial<ISettingsService> = {
  getSettings: jest.fn().mockResolvedValue({
    userId: 'u1', driveStoragePath: '/u', driveInboxPath: '/i',
    connectedSources: [], timezone: 'America/Chicago', updatedAt: new Date(),
    ftpHistory: [{ effectiveDate: new Date('2024-01-01'), ftpWatts: 250 }],
  }),
};

const mockSourceArtifactRepository: ISourceArtifactRepository = {
  createIndexes: jest.fn(),
  create: jest.fn().mockResolvedValue({ id: 'a1' } as SourceArtifactRecord),
  findById: jest.fn(),
  findByActivityId: jest.fn(),
  findDuplicateCandidate: jest.fn().mockResolvedValue(null),
  update: jest.fn().mockResolvedValue({} as SourceArtifactRecord),
  findPrimaryByActivityId: jest.fn().mockResolvedValue(null),
  findUnassociated: jest.fn().mockResolvedValue([]),
  disassociateByActivityId: jest.fn().mockResolvedValue(0),
};

describe('PLAN-043: Average Cadence Calculation', () => {
  let service: UploadService;

  beforeEach(() => {
    service = new UploadService(
      mockParserFactory,
      mockWorkoutRepository as IWorkoutRepository,
      mockDriveAdapter,
      mockSettingsService as ISettingsService,
      undefined,
      mockSourceArtifactRepository,
    );
  });

  // Access private method for testing via prototype
  function computeAvgCadence(dataPoints: Array<{ cadenceRpm?: number }>): number | undefined {
    return (service as any).computeAvgCadence(dataPoints);
  }

  it('excludes zero-cadence samples (coasting)', () => {
    const dataPoints = [
      { cadenceRpm: 90 },
      { cadenceRpm: 0 },
      { cadenceRpm: 85 },
      { cadenceRpm: 0 },
      { cadenceRpm: 88 },
    ];
    // Expected: (90 + 85 + 88) / 3 = 87.67 → 88
    expect(computeAvgCadence(dataPoints)).toBe(88);
  });

  it('works correctly when no zeros present', () => {
    const dataPoints = [
      { cadenceRpm: 90 },
      { cadenceRpm: 85 },
      { cadenceRpm: 88 },
    ];
    // Expected: (90 + 85 + 88) / 3 = 87.67 → 88
    expect(computeAvgCadence(dataPoints)).toBe(88);
  });

  it('returns undefined when all cadence samples are zero', () => {
    const dataPoints = [
      { cadenceRpm: 0 },
      { cadenceRpm: 0 },
      { cadenceRpm: 0 },
    ];
    expect(computeAvgCadence(dataPoints)).toBeUndefined();
  });

  it('ignores undefined cadence and excludes zeros', () => {
    const dataPoints = [
      { cadenceRpm: 90 },
      { cadenceRpm: undefined },
      { cadenceRpm: 0 },
      { cadenceRpm: 80 },
      {},
    ];
    // Only 90 and 80 are valid non-zero: (90+80)/2 = 85
    expect(computeAvgCadence(dataPoints as any)).toBe(85);
  });

  it('returns undefined when no cadence data exists', () => {
    const dataPoints = [
      { cadenceRpm: undefined },
      {},
    ];
    expect(computeAvgCadence(dataPoints as any)).toBeUndefined();
  });

  // Verify computeAverage still includes zeros for power (unchanged behavior)
  it('computeAverage still includes zero power values', () => {
    const computeAverage = (service as any).computeAverage.bind(service);
    const dataPoints = [
      { powerWatts: 200 },
      { powerWatts: 0 },
      { powerWatts: 150 },
    ];
    // Should include the zero: (200 + 0 + 150) / 3 = 116.67 → 117
    expect(computeAverage(dataPoints, 'powerWatts')).toBe(117);
  });
});
