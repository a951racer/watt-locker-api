import FitParser from 'fit-file-parser';
import { MetricDataPoint, ParsedWorkout, LapSummary } from '../models/workout';
import { ValidationError } from '../utils/errors';
import { WorkoutParser } from './parserFactory';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Minimal type for FIT record elements */
interface FitRecord {
  [key: string]: any;
  timestamp?: string;
}

/** Minimal type for FIT lap elements */
interface FitLap {
  [key: string]: any;
  timestamp?: string;
}

/** Minimal type for the parsed FIT file structure */
interface FitData {
  records?: FitRecord[];
  laps?: FitLap[];
  sessions?: FitRecord[];
  activity?: FitRecord;
  [key: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Parser for Garmin FIT (Flexible and Interoperable Data Transfer) binary files.
 * Extracts activity records, sensor data, and lap summaries.
 */
export class FitFileParser implements WorkoutParser {
  private readonly SUPPORTED_TYPES = [
    '.fit',
    'fit',
    'application/vnd.ant.fit',
    'application/fit',
  ];

  /**
   * Parse a FIT file buffer into a structured ParsedWorkout.
   * @throws ValidationError if the buffer cannot be parsed as a valid FIT file
   */
  async parse(buffer: Buffer): Promise<ParsedWorkout> {
    const fitParser = new FitParser({
      force: true,
      speedUnit: 'm/s',
      lengthUnit: 'm',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
      mode: 'list',
    });

    let parsedFit: FitData;
    try {
      parsedFit = (await fitParser.parseAsync(buffer as unknown as ArrayBuffer)) as FitData;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(`Failed to parse FIT file: ${message}`, {
        field: 'file',
        details: { format: 'fit', reason: message },
      });
    }

    if (!parsedFit) {
      throw new ValidationError('Failed to parse FIT file: no data returned', {
        field: 'file',
        details: { format: 'fit' },
      });
    }

    const records = parsedFit.records ?? [];
    const laps = parsedFit.laps ?? [];
    const sessions = parsedFit.sessions ?? [];

    if (records.length === 0 && sessions.length === 0) {
      throw new ValidationError('FIT file contains no activity records', {
        field: 'file',
        details: { format: 'fit' },
      });
    }

    const dataPoints = this.extractDataPoints(records);
    const lapSummaries = this.extractLapSummaries(laps);
    const summary = this.buildSummary(sessions, records, lapSummaries);

    return {
      summary,
      dataPoints,
      sourceFormat: 'fit',
    };
  }

  /**
   * Check if this parser supports the given file type.
   */
  supports(fileType: string): boolean {
    return this.SUPPORTED_TYPES.includes(fileType.trim().toLowerCase());
  }

  /**
   * Extract MetricDataPoint[] from FIT record messages.
   */
  private extractDataPoints(records: FitRecord[]): MetricDataPoint[] {
    return records
      .filter((record): record is FitRecord & { timestamp: string } => !!record.timestamp)
      .map((record) => {
        const point: MetricDataPoint = {
          timestamp: new Date(record.timestamp),
          workoutId: '', // Will be assigned by the upload service
          activityType: '',
          dataSource: 'manual',
        };

        if (record.heart_rate != null) {
          point.heartRateBpm = Number(record.heart_rate);
        }

        if (record.power != null) {
          point.powerWatts = Number(record.power);
        }

        if (record.cadence != null) {
          point.cadenceRpm = Number(record.cadence);
        }

        if (record.speed != null) {
          point.speedMps = Number(record.speed);
        } else if (record.enhanced_speed != null) {
          point.speedMps = Number(record.enhanced_speed);
        }

        if (record.distance != null) {
          point.distanceMeters = Number(record.distance);
        }

        // Elevation: prefer enhanced_altitude over altitude
        if (record.enhanced_altitude != null) {
          point.elevationMeters = Number(record.enhanced_altitude);
        } else if (record.altitude != null) {
          point.elevationMeters = Number(record.altitude);
        }

        // GPS coordinates
        if (record.position_lat != null && record.position_long != null) {
          point.latitude = Number(record.position_lat);
          point.longitude = Number(record.position_long);
        }

        if (record.temperature != null) {
          point.temperature = Number(record.temperature);
        }

        return point;
      });
  }

  /**
   * Extract LapSummary[] from FIT lap messages.
   */
  private extractLapSummaries(laps: FitLap[]): LapSummary[] {
    return laps
      .filter((lap): lap is FitLap & { timestamp: string } => !!lap.timestamp)
      .map((lap) => {
        const summary: LapSummary = {
          startTime: new Date(lap.start_time ?? lap.timestamp),
          durationSeconds: Number(lap.total_elapsed_time ?? lap.total_timer_time ?? 0),
          distanceMeters: Number(lap.total_distance ?? 0),
        };

        if (lap.avg_power != null) {
          summary.avgPowerWatts = Number(lap.avg_power);
        }

        if (lap.avg_heart_rate != null) {
          summary.avgHeartRateBpm = Number(lap.avg_heart_rate);
        }

        if (lap.max_heart_rate != null) {
          summary.maxHeartRateBpm = Number(lap.max_heart_rate);
        }

        return summary;
      });
  }

  /**
   * Build the workout summary from session data and records.
   */
  private buildSummary(
    sessions: FitRecord[],
    records: FitRecord[],
    laps: LapSummary[],
  ): ParsedWorkout['summary'] {
    // Prefer session-level summary data if available
    const session = sessions.length > 0 ? sessions[0] : null;

    let startTime: Date;
    let endTime: Date;
    let durationSeconds: number;
    let distanceMeters: number;
    let elevationGainMeters: number;
    let activityType: string;

    if (session) {
      startTime = new Date(session.start_time ?? session.timestamp);
      durationSeconds = Number(session.total_elapsed_time ?? session.total_timer_time ?? 0);
      endTime = new Date(startTime.getTime() + durationSeconds * 1000);
      distanceMeters = Number(session.total_distance ?? 0);
      elevationGainMeters = Number(session.total_ascent ?? 0);
      activityType = this.mapSportToActivityType(session.sport, session.sub_sport);
    } else {
      // Fall back to computing from records
      const timestamps = records
        .filter((r): r is FitRecord & { timestamp: string } => !!r.timestamp)
        .map((r) => new Date(r.timestamp).getTime());

      startTime = new Date(Math.min(...timestamps));
      endTime = new Date(Math.max(...timestamps));
      durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;
      distanceMeters = this.computeTotalDistance(records);
      elevationGainMeters = this.computeElevationGain(records);
      activityType = 'ride';
    }

    // Extract pre-computed metrics from session if available
    const sessionNP = session?.normalized_power != null ? Number(session.normalized_power) : undefined;
    const sessionTSS = session?.training_stress_score != null ? Number(session.training_stress_score) : undefined;
    const movingTimeSeconds = session?.total_timer_time != null ? Number(session.total_timer_time) : undefined;
    const elevationLossMeters = session?.total_descent != null ? Number(session.total_descent) : undefined;
    const calories = session?.total_calories != null ? Number(session.total_calories) : undefined;
    const avgTemp = session?.avg_temperature != null ? Number(session.avg_temperature) : undefined;
    const maxTemp = session?.max_temperature != null ? Number(session.max_temperature) : undefined;
    const totalWorkKj = session?.total_work != null ? Math.round(Number(session.total_work) / 1000) : undefined;
    const ftpWatts = session?.threshold_power != null ? Number(session.threshold_power) : undefined;
    const intensityFactor = session?.intensity_factor != null ? Number(session.intensity_factor) : undefined;
    const maxCadenceRpm = session?.max_cadence != null ? Number(session.max_cadence) : undefined;
    const totalPedalRevolutions = session?.total_cycles != null ? Number(session.total_cycles) : undefined;
    const maxSpeedMps = session?.max_speed != null ? Number(session.max_speed) : (session?.enhanced_max_speed != null ? Number(session.enhanced_max_speed) : undefined);
    const subActivityType = session?.sub_sport != null ? String(session.sub_sport) : undefined;
    const aerobicTrainingEffect = session?.total_training_effect != null ? Number(session.total_training_effect) : undefined;
    const anaerobicTrainingEffect = session?.total_anaerobic_training_effect != null ? Number(session.total_anaerobic_training_effect) : undefined;

    return {
      activityType,
      subActivityType,
      startTime,
      endTime,
      durationSeconds,
      movingTimeSeconds,
      distanceMeters,
      elevationGainMeters,
      elevationLossMeters,
      calories,
      avgTemperatureCelsius: avgTemp,
      maxTemperatureCelsius: maxTemp,
      normalizedPowerWatts: sessionNP,
      totalWorkKj,
      ftpWatts,
      intensityFactor,
      tss: sessionTSS,
      maxCadenceRpm,
      totalPedalRevolutions,
      maxSpeedMps,
      aerobicTrainingEffect,
      anaerobicTrainingEffect,
      laps: laps.length > 0 ? laps : undefined,
    };
  }

  /**
   * Map FIT sport/sub_sport fields to a human-readable activity type.
   */
  private mapSportToActivityType(sport?: string, subSport?: string): string {
    if (!sport) return 'ride';

    const sportLower = String(sport).toLowerCase();

    if (sportLower === 'cycling') {
      if (subSport) {
        const subSportLower = String(subSport).toLowerCase();
        if (subSportLower === 'indoor_cycling' || subSportLower === 'spin') {
          return 'virtual_ride';
        }
        if (subSportLower === 'mountain') {
          return 'mountain_ride';
        }
        if (subSportLower === 'gravel_cycling') {
          return 'gravel_ride';
        }
      }
      return 'ride';
    }

    if (sportLower === 'running') return 'run';
    if (sportLower === 'swimming') return 'swim';
    if (sportLower === 'walking') return 'walk';

    return sportLower;
  }

  /**
   * Compute total distance from the last record's distance field.
   */
  private computeTotalDistance(records: FitRecord[]): number {
    for (let i = records.length - 1; i >= 0; i--) {
      if (records[i].distance != null) {
        return Number(records[i].distance);
      }
    }
    return 0;
  }

  /**
   * Compute elevation gain from record altitude data.
   */
  private computeElevationGain(records: FitRecord[]): number {
    let gain = 0;
    let prevAltitude: number | null = null;

    for (const record of records) {
      const altitude = record.enhanced_altitude ?? record.altitude;
      if (altitude != null) {
        const alt = Number(altitude);
        if (prevAltitude !== null && alt > prevAltitude) {
          gain += alt - prevAltitude;
        }
        prevAltitude = alt;
      }
    }

    return gain;
  }
}
