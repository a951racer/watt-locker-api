import { FitFileParser } from './fitParser';
import { ValidationError } from '../utils/errors';

// Mock the fit-file-parser module
jest.mock('fit-file-parser', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      parseAsync: jest.fn(),
    })),
  };
});

import FitParser from 'fit-file-parser';

const MockFitParser = FitParser as jest.MockedClass<typeof FitParser>;

describe('FitFileParser', () => {
  let parser: FitFileParser;
  let mockParseAsync: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    parser = new FitFileParser();
    mockParseAsync = jest.fn();
    MockFitParser.mockImplementation(
      () =>
        ({
          parseAsync: mockParseAsync,
        }) as unknown as InstanceType<typeof FitParser>,
    );
    // Re-create parser after mock setup
    parser = new FitFileParser();
  });

  describe('supports', () => {
    it('should support .fit extension', () => {
      expect(parser.supports('.fit')).toBe(true);
    });

    it('should support fit extension without dot', () => {
      expect(parser.supports('fit')).toBe(true);
    });

    it('should support FIT MIME type application/vnd.ant.fit', () => {
      expect(parser.supports('application/vnd.ant.fit')).toBe(true);
    });

    it('should support FIT MIME type application/fit', () => {
      expect(parser.supports('application/fit')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(parser.supports('.FIT')).toBe(true);
      expect(parser.supports('FIT')).toBe(true);
    });

    it('should trim whitespace', () => {
      expect(parser.supports('  .fit  ')).toBe(true);
    });

    it('should not support other formats', () => {
      expect(parser.supports('.tcx')).toBe(false);
      expect(parser.supports('.gpx')).toBe(false);
      expect(parser.supports('.csv')).toBe(false);
    });
  });

  describe('parse', () => {
    const createMockFitData = (overrides: Record<string, unknown> = {}) => ({
      protocolVersion: 2.0,
      profileVersion: 21.6,
      activity: { timestamp: '2024-01-15T10:00:00.000Z' },
      user_profile: {},
      sessions: [
        {
          timestamp: '2024-01-15T11:00:00.000Z',
          start_time: '2024-01-15T10:00:00.000Z',
          total_elapsed_time: 3600,
          total_timer_time: 3500,
          total_distance: 30000,
          total_ascent: 450,
          sport: 'cycling',
          sub_sport: 'road',
        },
      ],
      records: [
        {
          timestamp: '2024-01-15T10:00:00.000Z',
          heart_rate: 130,
          power: 200,
          cadence: 90,
          speed: 8.33,
          distance: 0,
          enhanced_altitude: 100,
          position_lat: 51.5074,
          position_long: -0.1278,
          temperature: 18,
        },
        {
          timestamp: '2024-01-15T10:01:00.000Z',
          heart_rate: 135,
          power: 210,
          cadence: 92,
          speed: 8.5,
          distance: 500,
          enhanced_altitude: 105,
          position_lat: 51.508,
          position_long: -0.126,
          temperature: 18,
        },
        {
          timestamp: '2024-01-15T10:02:00.000Z',
          heart_rate: 140,
          power: 220,
          cadence: 88,
          speed: 8.7,
          distance: 1020,
          enhanced_altitude: 102,
          position_lat: 51.509,
          position_long: -0.124,
          temperature: 19,
        },
      ],
      laps: [
        {
          timestamp: '2024-01-15T10:30:00.000Z',
          start_time: '2024-01-15T10:00:00.000Z',
          total_elapsed_time: 1800,
          total_distance: 15000,
          avg_power: 205,
          avg_heart_rate: 135,
          max_heart_rate: 155,
        },
        {
          timestamp: '2024-01-15T11:00:00.000Z',
          start_time: '2024-01-15T10:30:00.000Z',
          total_elapsed_time: 1800,
          total_distance: 15000,
          avg_power: 215,
          avg_heart_rate: 142,
          max_heart_rate: 165,
        },
      ],
      ...overrides,
    });

    it('should parse a valid FIT file and return a ParsedWorkout', async () => {
      mockParseAsync.mockResolvedValue(createMockFitData());

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.sourceFormat).toBe('fit');
      expect(result.summary.activityType).toBe('ride');
      expect(result.summary.startTime).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(result.summary.durationSeconds).toBe(3600);
      expect(result.summary.distanceMeters).toBe(30000);
      expect(result.summary.elevationGainMeters).toBe(450);
    });

    it('should extract data points with all available metrics', async () => {
      mockParseAsync.mockResolvedValue(createMockFitData());

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.dataPoints).toHaveLength(3);

      const firstPoint = result.dataPoints[0];
      expect(firstPoint.timestamp).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(firstPoint.heartRateBpm).toBe(130);
      expect(firstPoint.powerWatts).toBe(200);
      expect(firstPoint.cadenceRpm).toBe(90);
      expect(firstPoint.speedMps).toBe(8.33);
      expect(firstPoint.distanceMeters).toBe(0);
      expect(firstPoint.elevationMeters).toBe(100);
      expect(firstPoint.latitude).toBe(51.5074);
      expect(firstPoint.longitude).toBe(-0.1278);
      expect(firstPoint.temperature).toBe(18);
    });

    it('should extract lap summaries', async () => {
      mockParseAsync.mockResolvedValue(createMockFitData());

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.summary.laps).toHaveLength(2);
      const firstLap = result.summary.laps![0];
      expect(firstLap.startTime).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(firstLap.durationSeconds).toBe(1800);
      expect(firstLap.distanceMeters).toBe(15000);
      expect(firstLap.avgPowerWatts).toBe(205);
      expect(firstLap.avgHeartRateBpm).toBe(135);
      expect(firstLap.maxHeartRateBpm).toBe(155);
    });

    it('should handle records with partial metrics', async () => {
      const data = createMockFitData({
        records: [
          {
            timestamp: '2024-01-15T10:00:00.000Z',
            heart_rate: 130,
            // No power, cadence, speed, etc.
          },
          {
            timestamp: '2024-01-15T10:01:00.000Z',
            power: 200,
            // No heart rate, cadence, etc.
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.dataPoints).toHaveLength(2);
      expect(result.dataPoints[0].heartRateBpm).toBe(130);
      expect(result.dataPoints[0].powerWatts).toBeUndefined();
      expect(result.dataPoints[1].powerWatts).toBe(200);
      expect(result.dataPoints[1].heartRateBpm).toBeUndefined();
    });

    it('should prefer enhanced_altitude over altitude', async () => {
      const data = createMockFitData({
        records: [
          {
            timestamp: '2024-01-15T10:00:00.000Z',
            altitude: 95,
            enhanced_altitude: 100,
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.dataPoints[0].elevationMeters).toBe(100);
    });

    it('should fall back to altitude when enhanced_altitude is not available', async () => {
      const data = createMockFitData({
        records: [
          {
            timestamp: '2024-01-15T10:00:00.000Z',
            altitude: 95,
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.dataPoints[0].elevationMeters).toBe(95);
    });

    it('should prefer enhanced_speed over speed', async () => {
      const data = createMockFitData({
        records: [
          {
            timestamp: '2024-01-15T10:00:00.000Z',
            enhanced_speed: 9.5,
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.dataPoints[0].speedMps).toBe(9.5);
    });

    it('should map cycling sport to ride activity type', async () => {
      const data = createMockFitData({
        sessions: [
          {
            timestamp: '2024-01-15T11:00:00.000Z',
            start_time: '2024-01-15T10:00:00.000Z',
            total_elapsed_time: 3600,
            total_distance: 30000,
            total_ascent: 450,
            sport: 'cycling',
            sub_sport: 'road',
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.summary.activityType).toBe('ride');
    });

    it('should map indoor cycling to virtual_ride', async () => {
      const data = createMockFitData({
        sessions: [
          {
            timestamp: '2024-01-15T11:00:00.000Z',
            start_time: '2024-01-15T10:00:00.000Z',
            total_elapsed_time: 3600,
            total_distance: 30000,
            total_ascent: 0,
            sport: 'cycling',
            sub_sport: 'indoor_cycling',
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.summary.activityType).toBe('virtual_ride');
    });

    it('should map running sport to run', async () => {
      const data = createMockFitData({
        sessions: [
          {
            timestamp: '2024-01-15T11:00:00.000Z',
            start_time: '2024-01-15T10:00:00.000Z',
            total_elapsed_time: 1800,
            total_distance: 5000,
            total_ascent: 50,
            sport: 'running',
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.summary.activityType).toBe('run');
    });

    it('should throw ValidationError when parseAsync throws', async () => {
      mockParseAsync.mockRejectedValue(new Error('Invalid FIT header'));

      await expect(parser.parse(Buffer.from('invalid data'))).rejects.toThrow(ValidationError);
      await expect(parser.parse(Buffer.from('invalid data'))).rejects.toThrow(
        /Failed to parse FIT file/,
      );
    });

    it('should throw ValidationError when no data is returned', async () => {
      mockParseAsync.mockResolvedValue(null);

      await expect(parser.parse(Buffer.from('empty'))).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when file has no records and no sessions', async () => {
      mockParseAsync.mockResolvedValue({
        protocolVersion: 2.0,
        profileVersion: 21.6,
        activity: { timestamp: '2024-01-15T10:00:00.000Z' },
        user_profile: {},
        sessions: [],
        records: [],
        laps: [],
      });

      await expect(parser.parse(Buffer.from('no records'))).rejects.toThrow(ValidationError);
      await expect(parser.parse(Buffer.from('no records'))).rejects.toThrow(
        /no activity records/,
      );
    });

    it('should compute summary from records when no sessions are available', async () => {
      const data = createMockFitData({
        sessions: [],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.summary.startTime).toEqual(new Date('2024-01-15T10:00:00.000Z'));
      expect(result.summary.endTime).toEqual(new Date('2024-01-15T10:02:00.000Z'));
      expect(result.summary.durationSeconds).toBe(120);
      expect(result.summary.distanceMeters).toBe(1020);
      // Elevation gain: 100->105 = +5, 105->102 = 0 (descent), total = 5
      expect(result.summary.elevationGainMeters).toBe(5);
      expect(result.summary.activityType).toBe('ride');
    });

    it('should handle laps without optional fields', async () => {
      const data = createMockFitData({
        laps: [
          {
            timestamp: '2024-01-15T10:30:00.000Z',
            start_time: '2024-01-15T10:00:00.000Z',
            total_elapsed_time: 1800,
            total_distance: 15000,
            // No avg_power, avg_heart_rate, max_heart_rate
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.summary.laps).toHaveLength(1);
      expect(result.summary.laps![0].avgPowerWatts).toBeUndefined();
      expect(result.summary.laps![0].avgHeartRateBpm).toBeUndefined();
      expect(result.summary.laps![0].maxHeartRateBpm).toBeUndefined();
    });

    it('should set laps to undefined when no laps are present', async () => {
      const data = createMockFitData({ laps: [] });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.summary.laps).toBeUndefined();
    });

    it('should skip records without timestamps', async () => {
      const data = createMockFitData({
        records: [
          {
            timestamp: '2024-01-15T10:00:00.000Z',
            heart_rate: 130,
          },
          {
            // No timestamp
            heart_rate: 135,
          },
          {
            timestamp: '2024-01-15T10:02:00.000Z',
            heart_rate: 140,
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.dataPoints).toHaveLength(2);
    });

    it('should set workoutId and dataSource defaults on data points', async () => {
      mockParseAsync.mockResolvedValue(createMockFitData());

      const result = await parser.parse(Buffer.from('fake fit data'));

      for (const point of result.dataPoints) {
        expect(point.workoutId).toBe('');
        expect(point.dataSource).toBe('manual');
        expect(point.activityType).toBe('');
      }
    });

    it('should handle GPS coordinates only when both lat and long are present', async () => {
      const data = createMockFitData({
        records: [
          {
            timestamp: '2024-01-15T10:00:00.000Z',
            position_lat: 51.5074,
            // No position_long
          },
          {
            timestamp: '2024-01-15T10:01:00.000Z',
            position_lat: 51.508,
            position_long: -0.126,
          },
        ],
      });
      mockParseAsync.mockResolvedValue(data);

      const result = await parser.parse(Buffer.from('fake fit data'));

      expect(result.dataPoints[0].latitude).toBeUndefined();
      expect(result.dataPoints[0].longitude).toBeUndefined();
      expect(result.dataPoints[1].latitude).toBe(51.508);
      expect(result.dataPoints[1].longitude).toBe(-0.126);
    });
  });
});
