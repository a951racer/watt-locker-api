import { XMLBuilder } from 'fast-xml-parser';
import { ParsedWorkout, WorkoutFileFormat, MetricDataPoint, LapSummary } from '../models/workout';
import { WorkoutPrettyPrinter } from './parserFactory';

/**
 * Pretty printer for TCX (Training Center XML) format.
 * Produces valid TCX files that can be re-parsed by TcxFileParser.
 */
export class TcxPrettyPrinter implements WorkoutPrettyPrinter {
  outputFormat: WorkoutFileFormat = 'tcx';

  private readonly xmlBuilder: XMLBuilder;

  constructor() {
    this.xmlBuilder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      format: true,
      suppressEmptyNode: true,
    });
  }

  async print(workout: ParsedWorkout): Promise<Buffer> {
    const laps = this.buildLaps(workout);

    const tcxObj = {
      '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
      TrainingCenterDatabase: {
        '@_xmlns': 'http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2',
        '@_xmlns:ns3': 'http://www.garmin.com/xmlschemas/ActivityExtension/v2',
        Activities: {
          Activity: {
            '@_Sport': this.mapActivityTypeToSport(workout.summary.activityType),
            Id: workout.summary.startTime.toISOString(),
            Lap: laps,
          },
        },
      },
    };

    const xmlString = this.xmlBuilder.build(tcxObj);
    return Buffer.from(xmlString, 'utf-8');
  }

  private buildLaps(workout: ParsedWorkout): object[] {
    const laps = workout.summary.laps;

    if (laps && laps.length > 0) {
      return laps.map((lap, index) => this.buildLapElement(lap, workout, index));
    }

    // If no laps, create a single lap from the entire workout
    const singleLap: LapSummary = {
      startTime: workout.summary.startTime,
      durationSeconds: workout.summary.durationSeconds,
      distanceMeters: workout.summary.distanceMeters,
    };
    return [this.buildLapElement(singleLap, workout, 0)];
  }

  private buildLapElement(lap: LapSummary, workout: ParsedWorkout, lapIndex: number): object {
    // Get data points for this lap
    const lapPoints = this.getPointsForLap(lap, workout, lapIndex);

    const lapObj: Record<string, unknown> = {
      '@_StartTime': lap.startTime.toISOString(),
      TotalTimeSeconds: lap.durationSeconds,
      DistanceMeters: lap.distanceMeters,
    };

    if (lap.avgHeartRateBpm != null) {
      lapObj.AverageHeartRateBpm = { Value: lap.avgHeartRateBpm };
    }
    if (lap.maxHeartRateBpm != null) {
      lapObj.MaximumHeartRateBpm = { Value: lap.maxHeartRateBpm };
    }

    // Lap-level extensions for average power
    if (lap.avgPowerWatts != null) {
      lapObj.Extensions = {
        LX: {
          '@_xmlns': 'http://www.garmin.com/xmlschemas/ActivityExtension/v2',
          AvgWatts: lap.avgPowerWatts,
        },
      };
    }

    // Build trackpoints
    if (lapPoints.length > 0) {
      lapObj.Track = {
        Trackpoint: lapPoints.map((point) => this.buildTrackpoint(point)),
      };
    }

    return lapObj;
  }

  private getPointsForLap(
    lap: LapSummary,
    workout: ParsedWorkout,
    lapIndex: number,
  ): MetricDataPoint[] {
    const laps = workout.summary.laps;

    if (!laps || laps.length === 0) {
      return workout.dataPoints;
    }

    const lapStart = lap.startTime.getTime();
    const nextLap = laps[lapIndex + 1];
    const lapEnd = nextLap
      ? nextLap.startTime.getTime()
      : lapStart + lap.durationSeconds * 1000;

    return workout.dataPoints.filter((point) => {
      const t = point.timestamp.getTime();
      return t >= lapStart && t < lapEnd;
    });
  }

  private buildTrackpoint(point: MetricDataPoint): object {
    const tp: Record<string, unknown> = {
      Time: point.timestamp.toISOString(),
    };

    if (point.latitude != null && point.longitude != null) {
      tp.Position = {
        LatitudeDegrees: point.latitude,
        LongitudeDegrees: point.longitude,
      };
    }

    if (point.elevationMeters != null) {
      tp.AltitudeMeters = point.elevationMeters;
    }

    if (point.distanceMeters != null) {
      tp.DistanceMeters = point.distanceMeters;
    }

    if (point.heartRateBpm != null) {
      tp.HeartRateBpm = { Value: point.heartRateBpm };
    }

    if (point.cadenceRpm != null) {
      tp.Cadence = point.cadenceRpm;
    }

    // Power and speed go in extensions
    if (point.powerWatts != null || point.speedMps != null) {
      const tpx: Record<string, unknown> = {
        '@_xmlns': 'http://www.garmin.com/xmlschemas/ActivityExtension/v2',
      };
      if (point.powerWatts != null) {
        tpx.Watts = point.powerWatts;
      }
      if (point.speedMps != null) {
        tpx.Speed = point.speedMps;
      }
      tp.Extensions = { TPX: tpx };
    }

    return tp;
  }

  private mapActivityTypeToSport(activityType: string): string {
    const lower = activityType.toLowerCase();
    if (lower === 'ride' || lower === 'virtual_ride' || lower === 'mountain_ride' || lower === 'gravel_ride') {
      return 'Biking';
    }
    if (lower === 'run') return 'Running';
    return 'Other';
  }
}

/**
 * Pretty printer for GPX (GPS Exchange Format) format.
 * Produces valid GPX files that can be re-parsed by GpxFileParser.
 */
export class GpxPrettyPrinter implements WorkoutPrettyPrinter {
  outputFormat: WorkoutFileFormat = 'gpx';

  private readonly xmlBuilder: XMLBuilder;

  constructor() {
    this.xmlBuilder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      format: true,
      suppressEmptyNode: true,
    });
  }

  async print(workout: ParsedWorkout): Promise<Buffer> {
    const segments = this.buildTrackSegments(workout);

    const gpxObj = {
      '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
      gpx: {
        '@_xmlns': 'http://www.topografix.com/GPX/1/1',
        '@_xmlns:gpxtpx': 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1',
        '@_version': '1.1',
        '@_creator': 'WattLocker',
        trk: {
          name: workout.summary.activityType,
          type: workout.summary.activityType,
          trkseg: segments,
        },
      },
    };

    const xmlString = this.xmlBuilder.build(gpxObj);
    return Buffer.from(xmlString, 'utf-8');
  }

  private buildTrackSegments(workout: ParsedWorkout): object[] {
    const laps = workout.summary.laps;

    if (!laps || laps.length <= 1) {
      // Single segment with all data points
      return [
        {
          trkpt: workout.dataPoints.map((point) => this.buildTrackpoint(point)),
        },
      ];
    }

    // One segment per lap
    return laps.map((lap, index) => {
      const nextLap = laps[index + 1];
      const lapStart = lap.startTime.getTime();
      const lapEnd = nextLap
        ? nextLap.startTime.getTime()
        : lapStart + lap.durationSeconds * 1000;

      const lapPoints = workout.dataPoints.filter((point) => {
        const t = point.timestamp.getTime();
        return t >= lapStart && t < lapEnd;
      });

      return {
        trkpt: lapPoints.map((point) => this.buildTrackpoint(point)),
      };
    });
  }

  private buildTrackpoint(point: MetricDataPoint): object {
    const trkpt: Record<string, unknown> = {};

    if (point.latitude != null && point.longitude != null) {
      trkpt['@_lat'] = point.latitude;
      trkpt['@_lon'] = point.longitude;
    }

    if (point.elevationMeters != null) {
      trkpt.ele = point.elevationMeters;
    }

    trkpt.time = point.timestamp.toISOString();

    // Extensions for heart rate, power, cadence, speed
    const hasExtensions =
      point.heartRateBpm != null ||
      point.powerWatts != null ||
      point.cadenceRpm != null ||
      point.speedMps != null;

    if (hasExtensions) {
      const tpExt: Record<string, unknown> = {};
      if (point.heartRateBpm != null) tpExt.hr = point.heartRateBpm;
      if (point.powerWatts != null) tpExt.power = point.powerWatts;
      if (point.cadenceRpm != null) tpExt.cad = point.cadenceRpm;
      if (point.speedMps != null) tpExt.speed = point.speedMps;

      trkpt.extensions = {
        'gpxtpx:TrackPointExtension': tpExt,
      };
    }

    return trkpt;
  }
}

/**
 * Pretty printer for FIT (Flexible and Interoperable Data Transfer) format.
 *
 * Since FIT is a complex binary format, this implementation produces a simplified
 * FIT-like structure encoded as JSON wrapped in a recognizable header.
 * For full round-trip support, this creates a minimal valid structure that the
 * FIT parser can handle by re-encoding the data in a format compatible with
 * the fit-file-parser library.
 *
 * Note: Full binary FIT encoding is complex (CRC checksums, field definitions, etc.).
 * This implementation stores the workout data as a JSON representation that can be
 * converted back to a ParsedWorkout. For production use, a proper FIT SDK encoder
 * would be needed.
 */
export class FitPrettyPrinter implements WorkoutPrettyPrinter {
  outputFormat: WorkoutFileFormat = 'fit';

  async print(workout: ParsedWorkout): Promise<Buffer> {
    // Create a JSON-based representation that preserves all workout data
    // This allows round-trip testing while acknowledging that full binary FIT
    // encoding requires a dedicated SDK
    const fitJson = {
      _format: 'wattlocker-fit-json',
      _version: 1,
      sessions: [
        {
          timestamp: workout.summary.startTime.toISOString(),
          start_time: workout.summary.startTime.toISOString(),
          total_elapsed_time: workout.summary.durationSeconds,
          total_timer_time: workout.summary.durationSeconds,
          total_distance: workout.summary.distanceMeters,
          total_ascent: workout.summary.elevationGainMeters,
          sport: this.mapActivityTypeToSport(workout.summary.activityType),
          sub_sport: this.mapActivityTypeToSubSport(workout.summary.activityType),
        },
      ],
      laps: (workout.summary.laps ?? []).map((lap) => ({
        timestamp: lap.startTime.toISOString(),
        start_time: lap.startTime.toISOString(),
        total_elapsed_time: lap.durationSeconds,
        total_timer_time: lap.durationSeconds,
        total_distance: lap.distanceMeters,
        avg_power: lap.avgPowerWatts,
        avg_heart_rate: lap.avgHeartRateBpm,
        max_heart_rate: lap.maxHeartRateBpm,
      })),
      records: workout.dataPoints.map((point) => ({
        timestamp: point.timestamp.toISOString(),
        heart_rate: point.heartRateBpm,
        power: point.powerWatts,
        cadence: point.cadenceRpm,
        speed: point.speedMps,
        distance: point.distanceMeters,
        enhanced_altitude: point.elevationMeters,
        position_lat: point.latitude,
        position_long: point.longitude,
        temperature: point.temperature,
      })),
    };

    return Buffer.from(JSON.stringify(fitJson), 'utf-8');
  }

  private mapActivityTypeToSport(activityType: string): string {
    const lower = activityType.toLowerCase();
    if (lower.includes('ride') || lower === 'cycling') return 'cycling';
    if (lower === 'run' || lower === 'running') return 'running';
    if (lower === 'swim' || lower === 'swimming') return 'swimming';
    return 'cycling';
  }

  private mapActivityTypeToSubSport(activityType: string): string | undefined {
    const lower = activityType.toLowerCase();
    if (lower === 'virtual_ride') return 'indoor_cycling';
    if (lower === 'mountain_ride') return 'mountain';
    if (lower === 'gravel_ride') return 'gravel_cycling';
    return undefined;
  }
}
