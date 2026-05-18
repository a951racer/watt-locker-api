import { XMLParser } from 'fast-xml-parser';
import { MetricDataPoint, ParsedWorkout, LapSummary } from '../models/workout';
import { ValidationError } from '../utils/errors';
import { WorkoutParser } from './parserFactory';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Minimal type for a TCX Trackpoint element */
interface TcxTrackpoint {
  Time?: string;
  Position?: {
    LatitudeDegrees?: number;
    LongitudeDegrees?: number;
  };
  AltitudeMeters?: number;
  DistanceMeters?: number;
  HeartRateBpm?: { Value?: number };
  Cadence?: number;
  Extensions?: any;
  [key: string]: any;
}

/** Minimal type for a TCX Lap element */
interface TcxLap {
  '@_StartTime'?: string;
  TotalTimeSeconds?: number;
  DistanceMeters?: number;
  MaximumSpeed?: number;
  Calories?: number;
  AverageHeartRateBpm?: { Value?: number };
  MaximumHeartRateBpm?: { Value?: number };
  Cadence?: number;
  Track?: { Trackpoint?: TcxTrackpoint | TcxTrackpoint[] } | Array<{ Trackpoint?: TcxTrackpoint | TcxTrackpoint[] }>;
  Extensions?: any;
  [key: string]: any;
}

/** Minimal type for a TCX Activity element */
interface TcxActivity {
  '@_Sport'?: string;
  Id?: string;
  Lap?: TcxLap | TcxLap[];
  [key: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Parser for Garmin TCX (Training Center XML) files.
 * Extracts trackpoints, lap summaries, and activity metadata.
 */
export class TcxFileParser implements WorkoutParser {
  private readonly SUPPORTED_TYPES = [
    '.tcx',
    'tcx',
    'application/vnd.garmin.tcx+xml',
    'application/tcx+xml',
  ];

  private readonly xmlParser: XMLParser;

  constructor() {
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: true,
      parseAttributeValue: true,
      isArray: (name) => {
        // Force these elements to always be arrays for consistent handling
        return ['Lap', 'Trackpoint', 'Track'].includes(name);
      },
    });
  }

  /**
   * Parse a TCX file buffer into a structured ParsedWorkout.
   * @throws ValidationError if the buffer cannot be parsed as a valid TCX file
   */
  async parse(buffer: Buffer): Promise<ParsedWorkout> {
    let xmlData: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      const xmlString = buffer.toString('utf-8');
      xmlData = this.xmlParser.parse(xmlString);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(`Failed to parse TCX file: ${message}`, {
        field: 'file',
        details: { format: 'tcx', reason: message },
      });
    }

    const activity = this.extractActivity(xmlData);
    if (!activity) {
      throw new ValidationError('TCX file contains no activity data', {
        field: 'file',
        details: { format: 'tcx' },
      });
    }

    const laps = this.normalizeLaps(activity.Lap);
    if (laps.length === 0) {
      throw new ValidationError('TCX file contains no lap data', {
        field: 'file',
        details: { format: 'tcx' },
      });
    }

    const dataPoints = this.extractDataPoints(laps);
    const lapSummaries = this.extractLapSummaries(laps);
    const summary = this.buildSummary(activity, laps, lapSummaries, dataPoints);

    return {
      summary,
      dataPoints,
      sourceFormat: 'tcx',
    };
  }

  /**
   * Check if this parser supports the given file type.
   */
  supports(fileType: string): boolean {
    return this.SUPPORTED_TYPES.includes(fileType.trim().toLowerCase());
  }

  /**
   * Extract the Activity element from the parsed XML structure.
   */
  private extractActivity(xmlData: any): TcxActivity | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    const tcd = xmlData?.TrainingCenterDatabase;
    if (!tcd) return null;

    const activities = tcd.Activities;
    if (!activities) return null;

    const activity = activities.Activity;
    if (!activity) return null;

    // Activity could be an array if multiple activities exist; take the first
    if (Array.isArray(activity)) {
      return activity[0] ?? null;
    }

    return activity;
  }

  /**
   * Normalize Lap field to always be an array.
   */
  private normalizeLaps(lap: TcxLap | TcxLap[] | undefined): TcxLap[] {
    if (!lap) return [];
    if (Array.isArray(lap)) return lap;
    return [lap];
  }

  /**
   * Normalize Trackpoints from a Track element to always be an array.
   */
  private normalizeTrackpoints(track: TcxLap['Track']): TcxTrackpoint[] {
    if (!track) return [];

    // Track can be an array of Track elements or a single Track element
    const tracks = Array.isArray(track) ? track : [track];
    const trackpoints: TcxTrackpoint[] = [];

    for (const t of tracks) {
      if (!t.Trackpoint) continue;
      if (Array.isArray(t.Trackpoint)) {
        trackpoints.push(...t.Trackpoint);
      } else {
        trackpoints.push(t.Trackpoint);
      }
    }

    return trackpoints;
  }

  /**
   * Extract MetricDataPoint[] from all trackpoints across all laps.
   */
  private extractDataPoints(laps: TcxLap[]): MetricDataPoint[] {
    const dataPoints: MetricDataPoint[] = [];

    for (const lap of laps) {
      const trackpoints = this.normalizeTrackpoints(lap.Track);

      for (const tp of trackpoints) {
        if (!tp.Time) continue;

        const point: MetricDataPoint = {
          timestamp: new Date(tp.Time),
          workoutId: '', // Will be assigned by the upload service
          activityType: '',
          dataSource: 'manual',
        };

        // Heart rate
        if (tp.HeartRateBpm?.Value != null) {
          point.heartRateBpm = Number(tp.HeartRateBpm.Value);
        }

        // Cadence
        if (tp.Cadence != null) {
          point.cadenceRpm = Number(tp.Cadence);
        }

        // Distance
        if (tp.DistanceMeters != null) {
          point.distanceMeters = Number(tp.DistanceMeters);
        }

        // Elevation
        if (tp.AltitudeMeters != null) {
          point.elevationMeters = Number(tp.AltitudeMeters);
        }

        // GPS coordinates
        if (tp.Position?.LatitudeDegrees != null && tp.Position?.LongitudeDegrees != null) {
          point.latitude = Number(tp.Position.LatitudeDegrees);
          point.longitude = Number(tp.Position.LongitudeDegrees);
        }

        // Power from extensions (Garmin TPX namespace)
        const power = this.extractPowerFromExtensions(tp.Extensions);
        if (power != null) {
          point.powerWatts = power;
        }

        // Speed from extensions (Garmin TPX namespace)
        const speed = this.extractSpeedFromExtensions(tp.Extensions);
        if (speed != null) {
          point.speedMps = speed;
        }

        dataPoints.push(point);
      }
    }

    return dataPoints;
  }

  /**
   * Extract power value from TCX Extensions (Garmin TPX format).
   * TCX extensions typically look like:
   * <Extensions><TPX xmlns="..."><Watts>200</Watts></TPX></Extensions>
   * or
   * <Extensions><ns3:TPX><ns3:Watts>200</ns3:Watts></ns3:TPX></Extensions>
   */
  private extractPowerFromExtensions(extensions: any): number | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!extensions) return null;

    // Try various known paths for power data
    const tpx = this.findTPX(extensions);
    if (tpx) {
      if (tpx.Watts != null) return Number(tpx.Watts);
      // Check for namespaced variants
      for (const key of Object.keys(tpx)) {
        if (key.toLowerCase().endsWith(':watts') || key === 'Watts') {
          return Number(tpx[key]);
        }
      }
    }

    return null;
  }

  /**
   * Extract speed value from TCX Extensions (Garmin TPX format).
   */
  private extractSpeedFromExtensions(extensions: any): number | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!extensions) return null;

    const tpx = this.findTPX(extensions);
    if (tpx) {
      if (tpx.Speed != null) return Number(tpx.Speed);
      for (const key of Object.keys(tpx)) {
        if (key.toLowerCase().endsWith(':speed') || key === 'Speed') {
          return Number(tpx[key]);
        }
      }
    }

    return null;
  }

  /**
   * Find the TPX element within extensions, handling various namespace prefixes.
   */
  private findTPX(extensions: any): any | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!extensions || typeof extensions !== 'object') return null;

    // Direct TPX key
    if (extensions.TPX) return extensions.TPX;

    // Look for namespaced TPX keys (e.g., ns3:TPX, ax:TPX)
    for (const key of Object.keys(extensions)) {
      if (key === 'TPX' || key.endsWith(':TPX')) {
        return extensions[key];
      }
    }

    // Sometimes extensions are nested one level deeper
    for (const key of Object.keys(extensions)) {
      const val = extensions[key];
      if (val && typeof val === 'object') {
        if (val.TPX) return val.TPX;
        for (const innerKey of Object.keys(val)) {
          if (innerKey === 'TPX' || innerKey.endsWith(':TPX')) {
            return val[innerKey];
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract LapSummary[] from TCX Lap elements.
   */
  private extractLapSummaries(laps: TcxLap[]): LapSummary[] {
    return laps.map((lap) => {
      const summary: LapSummary = {
        startTime: new Date(lap['@_StartTime'] ?? ''),
        durationSeconds: Number(lap.TotalTimeSeconds ?? 0),
        distanceMeters: Number(lap.DistanceMeters ?? 0),
      };

      if (lap.AverageHeartRateBpm?.Value != null) {
        summary.avgHeartRateBpm = Number(lap.AverageHeartRateBpm.Value);
      }

      if (lap.MaximumHeartRateBpm?.Value != null) {
        summary.maxHeartRateBpm = Number(lap.MaximumHeartRateBpm.Value);
      }

      // Extract average power from lap extensions if available
      const avgPower = this.extractAvgPowerFromLapExtensions(lap.Extensions);
      if (avgPower != null) {
        summary.avgPowerWatts = avgPower;
      }

      return summary;
    });
  }

  /**
   * Extract average power from lap-level extensions.
   */
  private extractAvgPowerFromLapExtensions(extensions: any): number | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!extensions) return null;

    // Look for LX or TPX with AvgWatts
    const lx = this.findLX(extensions);
    if (lx) {
      if (lx.AvgWatts != null) return Number(lx.AvgWatts);
      for (const key of Object.keys(lx)) {
        if (key.toLowerCase().endsWith(':avgwatts') || key === 'AvgWatts') {
          return Number(lx[key]);
        }
      }
    }

    return null;
  }

  /**
   * Find the LX (Lap Extension) element within extensions.
   */
  private findLX(extensions: any): any | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!extensions || typeof extensions !== 'object') return null;

    if (extensions.LX) return extensions.LX;

    for (const key of Object.keys(extensions)) {
      if (key === 'LX' || key.endsWith(':LX')) {
        return extensions[key];
      }
    }

    // Check nested
    for (const key of Object.keys(extensions)) {
      const val = extensions[key];
      if (val && typeof val === 'object') {
        if (val.LX) return val.LX;
        for (const innerKey of Object.keys(val)) {
          if (innerKey === 'LX' || innerKey.endsWith(':LX')) {
            return val[innerKey];
          }
        }
      }
    }

    return null;
  }

  /**
   * Build the workout summary from activity data, laps, and data points.
   */
  private buildSummary(
    activity: TcxActivity,
    laps: TcxLap[],
    lapSummaries: LapSummary[],
    dataPoints: MetricDataPoint[],
  ): ParsedWorkout['summary'] {
    // Compute total duration and distance from laps
    const totalDuration = laps.reduce((sum, lap) => sum + Number(lap.TotalTimeSeconds ?? 0), 0);
    const totalDistance = laps.reduce((sum, lap) => sum + Number(lap.DistanceMeters ?? 0), 0);

    // Start time from first lap's StartTime attribute or first trackpoint
    let startTime: Date;
    if (laps[0]?.['@_StartTime']) {
      startTime = new Date(laps[0]['@_StartTime']);
    } else if (dataPoints.length > 0) {
      startTime = dataPoints[0].timestamp;
    } else {
      startTime = new Date(activity.Id ?? '');
    }

    const endTime = new Date(startTime.getTime() + totalDuration * 1000);

    // Compute elevation gain from data points
    const elevationGain = this.computeElevationGain(dataPoints);

    // Map sport to activity type
    const activityType = this.mapSportToActivityType(activity['@_Sport']);

    return {
      activityType,
      startTime,
      endTime,
      durationSeconds: totalDuration,
      distanceMeters: totalDistance,
      elevationGainMeters: elevationGain,
      laps: lapSummaries.length > 0 ? lapSummaries : undefined,
    };
  }

  /**
   * Compute elevation gain from data points.
   */
  private computeElevationGain(dataPoints: MetricDataPoint[]): number {
    let gain = 0;
    let prevElevation: number | null = null;

    for (const point of dataPoints) {
      if (point.elevationMeters != null) {
        if (prevElevation !== null && point.elevationMeters > prevElevation) {
          gain += point.elevationMeters - prevElevation;
        }
        prevElevation = point.elevationMeters;
      }
    }

    return gain;
  }

  /**
   * Map TCX Sport attribute to a human-readable activity type.
   */
  private mapSportToActivityType(sport?: string): string {
    if (!sport) return 'ride';

    const sportLower = sport.toLowerCase();

    if (sportLower === 'biking' || sportLower === 'cycling') return 'ride';
    if (sportLower === 'running') return 'run';
    if (sportLower === 'other') return 'other';

    return sportLower;
  }
}
