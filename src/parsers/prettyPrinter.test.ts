import { TcxPrettyPrinter, GpxPrettyPrinter, FitPrettyPrinter } from './prettyPrinter';
import { TcxFileParser } from './tcxParser';
import { GpxFileParser } from './gpxParser';
import { ParsedWorkout, MetricDataPoint } from '../models/workout';

describe('TcxPrettyPrinter', () => {
  let printer: TcxPrettyPrinter;
  let parser: TcxFileParser;

  beforeEach(() => {
    printer = new TcxPrettyPrinter();
    parser = new TcxFileParser();
  });

  it('should have outputFormat set to tcx', () => {
    expect(printer.outputFormat).toBe('tcx');
  });

  it('should produce valid TCX XML that can be re-parsed', async () => {
    const workout = createSampleWorkout('tcx');
    const buffer = await printer.print(workout);
    const xmlString = buffer.toString('utf-8');

    // Should contain TCX structure
    expect(xmlString).toContain('TrainingCenterDatabase');
    expect(xmlString).toContain('Activity');
    expect(xmlString).toContain('Lap');
    expect(xmlString).toContain('Trackpoint');

    // Should be re-parseable
    const reparsed = await parser.parse(buffer);
    expect(reparsed.sourceFormat).toBe('tcx');
    expect(reparsed.dataPoints.length).toBe(workout.dataPoints.length);
  });

  it('should preserve heart rate data through round-trip', async () => {
    const workout = createSampleWorkout('tcx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].heartRateBpm != null) {
        expect(reparsed.dataPoints[i].heartRateBpm).toBe(workout.dataPoints[i].heartRateBpm);
      }
    }
  });

  it('should preserve power data through round-trip', async () => {
    const workout = createSampleWorkout('tcx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].powerWatts != null) {
        expect(reparsed.dataPoints[i].powerWatts).toBe(workout.dataPoints[i].powerWatts);
      }
    }
  });

  it('should preserve GPS coordinates through round-trip', async () => {
    const workout = createSampleWorkout('tcx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].latitude != null) {
        expect(reparsed.dataPoints[i].latitude).toBe(workout.dataPoints[i].latitude);
        expect(reparsed.dataPoints[i].longitude).toBe(workout.dataPoints[i].longitude);
      }
    }
  });

  it('should preserve elevation data through round-trip', async () => {
    const workout = createSampleWorkout('tcx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].elevationMeters != null) {
        expect(reparsed.dataPoints[i].elevationMeters).toBe(
          workout.dataPoints[i].elevationMeters,
        );
      }
    }
  });

  it('should preserve cadence data through round-trip', async () => {
    const workout = createSampleWorkout('tcx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].cadenceRpm != null) {
        expect(reparsed.dataPoints[i].cadenceRpm).toBe(workout.dataPoints[i].cadenceRpm);
      }
    }
  });

  it('should preserve speed data through round-trip', async () => {
    const workout = createSampleWorkout('tcx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].speedMps != null) {
        expect(reparsed.dataPoints[i].speedMps).toBe(workout.dataPoints[i].speedMps);
      }
    }
  });

  it('should preserve lap summary data through round-trip', async () => {
    const workout = createSampleWorkout('tcx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    expect(reparsed.summary.laps).toBeDefined();
    expect(reparsed.summary.laps!.length).toBe(workout.summary.laps!.length);

    for (let i = 0; i < workout.summary.laps!.length; i++) {
      const originalLap = workout.summary.laps![i];
      const reparsedLap = reparsed.summary.laps![i];

      expect(reparsedLap.startTime).toEqual(originalLap.startTime);
      expect(reparsedLap.durationSeconds).toBe(originalLap.durationSeconds);
      expect(reparsedLap.distanceMeters).toBe(originalLap.distanceMeters);
    }
  });

  it('should map ride activity type to Biking sport', async () => {
    const workout = createSampleWorkout('tcx');
    workout.summary.activityType = 'ride';
    const buffer = await printer.print(workout);
    const xmlString = buffer.toString('utf-8');
    expect(xmlString).toContain('Sport="Biking"');
  });

  it('should map run activity type to Running sport', async () => {
    const workout = createSampleWorkout('tcx');
    workout.summary.activityType = 'run';
    const buffer = await printer.print(workout);
    const xmlString = buffer.toString('utf-8');
    expect(xmlString).toContain('Sport="Running"');
  });

  it('should handle workout with no laps', async () => {
    const workout = createSampleWorkout('tcx');
    workout.summary.laps = undefined;
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    expect(reparsed.dataPoints.length).toBe(workout.dataPoints.length);
    expect(reparsed.summary.laps).toBeDefined();
    expect(reparsed.summary.laps!.length).toBe(1);
  });

  it('should handle data points with only timestamps', async () => {
    const workout: ParsedWorkout = {
      summary: {
        activityType: 'ride',
        startTime: new Date('2024-01-15T10:00:00.000Z'),
        endTime: new Date('2024-01-15T10:02:00.000Z'),
        durationSeconds: 120,
        distanceMeters: 0,
        elevationGainMeters: 0,
      },
      dataPoints: [
        {
          timestamp: new Date('2024-01-15T10:00:00.000Z'),
          workoutId: '',
          activityType: '',
          dataSource: 'manual',
        },
        {
          timestamp: new Date('2024-01-15T10:02:00.000Z'),
          workoutId: '',
          activityType: '',
          dataSource: 'manual',
        },
      ],
      sourceFormat: 'tcx',
    };

    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);
    expect(reparsed.dataPoints.length).toBe(2);
  });
});

describe('GpxPrettyPrinter', () => {
  let printer: GpxPrettyPrinter;
  let parser: GpxFileParser;

  beforeEach(() => {
    printer = new GpxPrettyPrinter();
    parser = new GpxFileParser();
  });

  it('should have outputFormat set to gpx', () => {
    expect(printer.outputFormat).toBe('gpx');
  });

  it('should produce valid GPX XML that can be re-parsed', async () => {
    const workout = createSampleWorkout('gpx');
    const buffer = await printer.print(workout);
    const xmlString = buffer.toString('utf-8');

    // Should contain GPX structure
    expect(xmlString).toContain('<gpx');
    expect(xmlString).toContain('<trk');
    expect(xmlString).toContain('<trkseg');
    expect(xmlString).toContain('<trkpt');

    // Should be re-parseable
    const reparsed = await parser.parse(buffer);
    expect(reparsed.sourceFormat).toBe('gpx');
    expect(reparsed.dataPoints.length).toBe(workout.dataPoints.length);
  });

  it('should preserve GPS coordinates through round-trip', async () => {
    const workout = createSampleWorkout('gpx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].latitude != null) {
        expect(reparsed.dataPoints[i].latitude).toBe(workout.dataPoints[i].latitude);
        expect(reparsed.dataPoints[i].longitude).toBe(workout.dataPoints[i].longitude);
      }
    }
  });

  it('should preserve elevation data through round-trip', async () => {
    const workout = createSampleWorkout('gpx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].elevationMeters != null) {
        expect(reparsed.dataPoints[i].elevationMeters).toBe(
          workout.dataPoints[i].elevationMeters,
        );
      }
    }
  });

  it('should preserve heart rate data through round-trip', async () => {
    const workout = createSampleWorkout('gpx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].heartRateBpm != null) {
        expect(reparsed.dataPoints[i].heartRateBpm).toBe(workout.dataPoints[i].heartRateBpm);
      }
    }
  });

  it('should preserve power data through round-trip', async () => {
    const workout = createSampleWorkout('gpx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].powerWatts != null) {
        expect(reparsed.dataPoints[i].powerWatts).toBe(workout.dataPoints[i].powerWatts);
      }
    }
  });

  it('should preserve cadence data through round-trip', async () => {
    const workout = createSampleWorkout('gpx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].cadenceRpm != null) {
        expect(reparsed.dataPoints[i].cadenceRpm).toBe(workout.dataPoints[i].cadenceRpm);
      }
    }
  });

  it('should preserve speed data through round-trip', async () => {
    const workout = createSampleWorkout('gpx');
    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);

    for (let i = 0; i < workout.dataPoints.length; i++) {
      if (workout.dataPoints[i].speedMps != null) {
        expect(reparsed.dataPoints[i].speedMps).toBe(workout.dataPoints[i].speedMps);
      }
    }
  });

  it('should handle workout with multiple laps as multiple segments', async () => {
    const workout = createSampleWorkout('gpx');
    const buffer = await printer.print(workout);
    const xmlString = buffer.toString('utf-8');

    // Should have multiple trkseg elements (one per lap)
    const segmentCount = (xmlString.match(/<trkseg>/g) || []).length;
    expect(segmentCount).toBe(workout.summary.laps!.length);
  });

  it('should handle workout with no laps as single segment', async () => {
    const workout = createSampleWorkout('gpx');
    workout.summary.laps = undefined;
    const buffer = await printer.print(workout);
    const xmlString = buffer.toString('utf-8');

    const segmentCount = (xmlString.match(/<trkseg>/g) || []).length;
    expect(segmentCount).toBe(1);
  });

  it('should include activity type in track metadata', async () => {
    const workout = createSampleWorkout('gpx');
    workout.summary.activityType = 'ride';
    const buffer = await printer.print(workout);
    const xmlString = buffer.toString('utf-8');
    expect(xmlString).toContain('<type>ride</type>');
  });

  it('should handle data points without GPS coordinates', async () => {
    const workout: ParsedWorkout = {
      summary: {
        activityType: 'ride',
        startTime: new Date('2024-01-15T10:00:00.000Z'),
        endTime: new Date('2024-01-15T10:02:00.000Z'),
        durationSeconds: 120,
        distanceMeters: 1000,
        elevationGainMeters: 0,
      },
      dataPoints: [
        {
          timestamp: new Date('2024-01-15T10:00:00.000Z'),
          workoutId: '',
          activityType: '',
          dataSource: 'manual',
          heartRateBpm: 130,
          powerWatts: 200,
        },
        {
          timestamp: new Date('2024-01-15T10:02:00.000Z'),
          workoutId: '',
          activityType: '',
          dataSource: 'manual',
          heartRateBpm: 140,
          powerWatts: 210,
        },
      ],
      sourceFormat: 'gpx',
    };

    const buffer = await printer.print(workout);
    const reparsed = await parser.parse(buffer);
    expect(reparsed.dataPoints.length).toBe(2);
    expect(reparsed.dataPoints[0].heartRateBpm).toBe(130);
    expect(reparsed.dataPoints[1].powerWatts).toBe(210);
  });
});

describe('FitPrettyPrinter', () => {
  let printer: FitPrettyPrinter;

  beforeEach(() => {
    printer = new FitPrettyPrinter();
  });

  it('should have outputFormat set to fit', () => {
    expect(printer.outputFormat).toBe('fit');
  });

  it('should produce a JSON buffer with correct format marker', async () => {
    const workout = createSampleWorkout('fit');
    const buffer = await printer.print(workout);
    const json = JSON.parse(buffer.toString('utf-8'));

    expect(json._format).toBe('wattlocker-fit-json');
    expect(json._version).toBe(1);
  });

  it('should include session data', async () => {
    const workout = createSampleWorkout('fit');
    const buffer = await printer.print(workout);
    const json = JSON.parse(buffer.toString('utf-8'));

    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0].start_time).toBe(workout.summary.startTime.toISOString());
    expect(json.sessions[0].total_elapsed_time).toBe(workout.summary.durationSeconds);
    expect(json.sessions[0].total_distance).toBe(workout.summary.distanceMeters);
    expect(json.sessions[0].total_ascent).toBe(workout.summary.elevationGainMeters);
  });

  it('should include lap data', async () => {
    const workout = createSampleWorkout('fit');
    const buffer = await printer.print(workout);
    const json = JSON.parse(buffer.toString('utf-8'));

    expect(json.laps).toHaveLength(workout.summary.laps!.length);
    expect(json.laps[0].start_time).toBe(workout.summary.laps![0].startTime.toISOString());
    expect(json.laps[0].total_elapsed_time).toBe(workout.summary.laps![0].durationSeconds);
    expect(json.laps[0].total_distance).toBe(workout.summary.laps![0].distanceMeters);
  });

  it('should include record data with all metrics', async () => {
    const workout = createSampleWorkout('fit');
    const buffer = await printer.print(workout);
    const json = JSON.parse(buffer.toString('utf-8'));

    expect(json.records).toHaveLength(workout.dataPoints.length);

    const firstRecord = json.records[0];
    expect(firstRecord.timestamp).toBe(workout.dataPoints[0].timestamp.toISOString());
    expect(firstRecord.heart_rate).toBe(workout.dataPoints[0].heartRateBpm);
    expect(firstRecord.power).toBe(workout.dataPoints[0].powerWatts);
    expect(firstRecord.cadence).toBe(workout.dataPoints[0].cadenceRpm);
    expect(firstRecord.speed).toBe(workout.dataPoints[0].speedMps);
    expect(firstRecord.distance).toBe(workout.dataPoints[0].distanceMeters);
    expect(firstRecord.enhanced_altitude).toBe(workout.dataPoints[0].elevationMeters);
    expect(firstRecord.position_lat).toBe(workout.dataPoints[0].latitude);
    expect(firstRecord.position_long).toBe(workout.dataPoints[0].longitude);
  });

  it('should map ride activity type to cycling sport', async () => {
    const workout = createSampleWorkout('fit');
    workout.summary.activityType = 'ride';
    const buffer = await printer.print(workout);
    const json = JSON.parse(buffer.toString('utf-8'));
    expect(json.sessions[0].sport).toBe('cycling');
  });

  it('should map virtual_ride to indoor_cycling sub_sport', async () => {
    const workout = createSampleWorkout('fit');
    workout.summary.activityType = 'virtual_ride';
    const buffer = await printer.print(workout);
    const json = JSON.parse(buffer.toString('utf-8'));
    expect(json.sessions[0].sport).toBe('cycling');
    expect(json.sessions[0].sub_sport).toBe('indoor_cycling');
  });

  it('should handle workout with no laps', async () => {
    const workout = createSampleWorkout('fit');
    workout.summary.laps = undefined;
    const buffer = await printer.print(workout);
    const json = JSON.parse(buffer.toString('utf-8'));
    expect(json.laps).toHaveLength(0);
  });
});

// Helper function to create a sample ParsedWorkout for testing
function createSampleWorkout(sourceFormat: 'fit' | 'tcx' | 'gpx'): ParsedWorkout {
  const startTime = new Date('2024-01-15T10:00:00.000Z');

  const dataPoints: MetricDataPoint[] = [
    {
      timestamp: new Date('2024-01-15T10:00:00.000Z'),
      workoutId: '',
      activityType: '',
      dataSource: 'manual',
      heartRateBpm: 130,
      powerWatts: 200,
      cadenceRpm: 90,
      speedMps: 8.33,
      distanceMeters: 0,
      elevationMeters: 100,
      latitude: 51.5074,
      longitude: -0.1278,
    },
    {
      timestamp: new Date('2024-01-15T10:01:00.000Z'),
      workoutId: '',
      activityType: '',
      dataSource: 'manual',
      heartRateBpm: 135,
      powerWatts: 210,
      cadenceRpm: 92,
      speedMps: 8.5,
      distanceMeters: 500,
      elevationMeters: 105,
      latitude: 51.508,
      longitude: -0.126,
    },
    {
      timestamp: new Date('2024-01-15T10:02:00.000Z'),
      workoutId: '',
      activityType: '',
      dataSource: 'manual',
      heartRateBpm: 140,
      powerWatts: 220,
      cadenceRpm: 88,
      speedMps: 8.7,
      distanceMeters: 1020,
      elevationMeters: 102,
      latitude: 51.509,
      longitude: -0.124,
    },
    {
      timestamp: new Date('2024-01-15T10:30:00.000Z'),
      workoutId: '',
      activityType: '',
      dataSource: 'manual',
      heartRateBpm: 145,
      powerWatts: 230,
      cadenceRpm: 90,
      speedMps: 9.0,
      distanceMeters: 15000,
      elevationMeters: 110,
      latitude: 51.51,
      longitude: -0.122,
    },
  ];

  return {
    summary: {
      activityType: 'ride',
      startTime,
      endTime: new Date('2024-01-15T11:00:00.000Z'),
      durationSeconds: 3600,
      distanceMeters: 30000,
      elevationGainMeters: 15,
      laps: [
        {
          startTime: new Date('2024-01-15T10:00:00.000Z'),
          durationSeconds: 1800,
          distanceMeters: 15000,
          avgHeartRateBpm: 135,
          maxHeartRateBpm: 140,
          avgPowerWatts: 210,
        },
        {
          startTime: new Date('2024-01-15T10:30:00.000Z'),
          durationSeconds: 1800,
          distanceMeters: 15000,
          avgHeartRateBpm: 145,
          maxHeartRateBpm: 150,
          avgPowerWatts: 230,
        },
      ],
    },
    dataPoints,
    sourceFormat,
  };
}
