import { XMLParser } from 'fast-xml-parser';
import { MetricDataPoint, ParsedWorkout, LapSummary } from '../models/workout';
import { ValidationError } from '../utils/errors';
import { WorkoutParser } from './parserFactory';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Minimal type for a GPX track point element */
interface GpxTrackpoint {
  '@_lat'?: number;
  '@_lon'?: number;
  ele?: number;
  time?: string;
  extensions?: any;
  [key: string]: any;
}

/** Minimal type for a GPX track segment element */
interface GpxTrackSegment {
  trkpt?: GpxTrackpoint | GpxTrackpoint[];
}

/** Minimal type for a GPX track element */
interface GpxTrack {
  name?: string;
  type?: string;
  trkseg?: GpxTrackSegment | GpxTrackSegment[];
  extensions?: any;
  [key: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Parser for GPX (GPS Exchange Format) files.
 * Extracts track segments, waypoints, and extension data (heart rate, power, cadence).
 */
export class GpxFileParser implements WorkoutParser {
  private readonly SUPPORTED_TYPES = ['.gpx', 'gpx', 'application/gpx+xml'];

  private readonly xmlParser: XMLParser;

  constructor() {
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: true,
      parseAttributeValue: true,
      isArray: (name) => {
        // Force these elements to always be arrays for consistent handling
        return ['trk', 'trkseg', 'trkpt'].includes(name);
      },
    });
  }

  /**
   * Parse a GPX file buffer into a structured ParsedWorkout.
   * @throws ValidationError if the buffer cannot be parsed as a valid GPX file
   */
  async parse(buffer: Buffer): Promise<ParsedWorkout> {
    let xmlData: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      const xmlString = buffer.toString('utf-8');
      xmlData = this.xmlParser.parse(xmlString);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValidationError(`Failed to parse GPX file: ${message}`, {
        field: 'file',
        details: { format: 'gpx', reason: message },
      });
    }

    const gpx = xmlData?.gpx;
    if (!gpx) {
      throw new ValidationError('GPX file contains no gpx root element', {
        field: 'file',
        details: { format: 'gpx' },
      });
    }

    const tracks = this.normalizeTracks(gpx.trk);
    if (tracks.length === 0) {
      throw new ValidationError('GPX file contains no track data', {
        field: 'file',
        details: { format: 'gpx' },
      });
    }

    const dataPoints = this.extractDataPoints(tracks);
    if (dataPoints.length === 0) {
      throw new ValidationError('GPX file contains no track points with timestamps', {
        field: 'file',
        details: { format: 'gpx' },
      });
    }

    const lapSummaries = this.extractLapSummaries(tracks, dataPoints);
    const summary = this.buildSummary(tracks, lapSummaries, dataPoints);

    return {
      summary,
      dataPoints,
      sourceFormat: 'gpx',
    };
  }

  /**
   * Check if this parser supports the given file type.
   */
  supports(fileType: string): boolean {
    return this.SUPPORTED_TYPES.includes(fileType.trim().toLowerCase());
  }

  /**
   * Normalize tracks to always be an array.
   */
  private normalizeTracks(trk: GpxTrack | GpxTrack[] | undefined): GpxTrack[] {
    if (!trk) return [];
    if (Array.isArray(trk)) return trk;
    return [trk];
  }

  /**
   * Normalize track segments to always be an array.
   */
  private normalizeTrackSegments(
    trkseg: GpxTrackSegment | GpxTrackSegment[] | undefined,
  ): GpxTrackSegment[] {
    if (!trkseg) return [];
    if (Array.isArray(trkseg)) return trkseg;
    return [trkseg];
  }

  /**
   * Normalize track points to always be an array.
   */
  private normalizeTrackpoints(trkpt: GpxTrackpoint | GpxTrackpoint[] | undefined): GpxTrackpoint[] {
    if (!trkpt) return [];
    if (Array.isArray(trkpt)) return trkpt;
    return [trkpt];
  }

  /**
   * Extract MetricDataPoint[] from all track points across all tracks and segments.
   */
  private extractDataPoints(tracks: GpxTrack[]): MetricDataPoint[] {
    const dataPoints: MetricDataPoint[] = [];

    for (const track of tracks) {
      const segments = this.normalizeTrackSegments(track.trkseg);

      for (const segment of segments) {
        const trackpoints = this.normalizeTrackpoints(segment.trkpt);

        for (const trkpt of trackpoints) {
          if (!trkpt.time) continue;

          const point: MetricDataPoint = {
            timestamp: new Date(trkpt.time),
            workoutId: '', // Will be assigned by the upload service
            activityType: '',
            dataSource: 'manual',
          };

          // GPS coordinates from attributes
          if (trkpt['@_lat'] != null && trkpt['@_lon'] != null) {
            point.latitude = Number(trkpt['@_lat']);
            point.longitude = Number(trkpt['@_lon']);
          }

          // Elevation
          if (trkpt.ele != null) {
            point.elevationMeters = Number(trkpt.ele);
          }

          // Extract metrics from extensions
          this.extractExtensionMetrics(trkpt.extensions, point);

          dataPoints.push(point);
        }
      }
    }

    return dataPoints;
  }

  /**
   * Extract heart rate, power, cadence, and speed from GPX extensions.
   *
   * GPX extensions can appear in several formats:
   * 1. Garmin TrackPointExtension (gpxtpx:TrackPointExtension):
   *    <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>
   * 2. Direct extension elements:
   *    <extensions><hr>140</hr><power>200</power></extensions>
   * 3. Namespaced without prefix:
   *    <extensions><TrackPointExtension><hr>140</hr></TrackPointExtension></extensions>
   */
  private extractExtensionMetrics(
    extensions: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    point: MetricDataPoint,
  ): void {
    if (!extensions || typeof extensions !== 'object') return;

    // Try to find TrackPointExtension (various namespace prefixes)
    const tpExt = this.findTrackPointExtension(extensions);

    if (tpExt) {
      // Heart rate
      const hr = this.findExtensionValue(tpExt, 'hr');
      if (hr != null) point.heartRateBpm = Number(hr);

      // Power
      const power = this.findExtensionValue(tpExt, 'power');
      if (power != null) point.powerWatts = Number(power);

      // Cadence
      const cad = this.findExtensionValue(tpExt, 'cad');
      if (cad != null) point.cadenceRpm = Number(cad);

      // Speed
      const speed = this.findExtensionValue(tpExt, 'speed');
      if (speed != null) point.speedMps = Number(speed);
    }

    // Also check for direct extension elements (Garmin-style flat extensions)
    // These may exist alongside or instead of TrackPointExtension
    if (point.heartRateBpm == null) {
      const hr = this.findExtensionValue(extensions, 'hr');
      if (hr != null) point.heartRateBpm = Number(hr);
    }

    if (point.powerWatts == null) {
      const power = this.findExtensionValue(extensions, 'power');
      if (power != null) point.powerWatts = Number(power);
    }

    if (point.cadenceRpm == null) {
      const cad = this.findExtensionValue(extensions, 'cad');
      if (cad != null) point.cadenceRpm = Number(cad);
    }

    if (point.speedMps == null) {
      const speed = this.findExtensionValue(extensions, 'speed');
      if (speed != null) point.speedMps = Number(speed);
    }
  }

  /**
   * Find the TrackPointExtension element within extensions, handling various namespace prefixes.
   */
  private findTrackPointExtension(extensions: any): any | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!extensions || typeof extensions !== 'object') return null;

    // Direct key
    if (extensions.TrackPointExtension) return extensions.TrackPointExtension;

    // Look for namespaced keys (e.g., gpxtpx:TrackPointExtension, ns3:TrackPointExtension)
    for (const key of Object.keys(extensions)) {
      if (key === 'TrackPointExtension' || key.endsWith(':TrackPointExtension')) {
        return extensions[key];
      }
    }

    return null;
  }

  /**
   * Find a value by key within an object, handling namespace prefixes.
   * For example, finds 'hr' whether it's stored as 'hr', 'gpxtpx:hr', or 'ns3:hr'.
   */
  private findExtensionValue(obj: any, key: string): number | string | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!obj || typeof obj !== 'object') return null;

    // Direct key match
    if (obj[key] != null) return obj[key];

    // Namespaced key match (e.g., gpxtpx:hr, ns3:power)
    for (const objKey of Object.keys(obj)) {
      if (objKey.endsWith(`:${key}`)) {
        return obj[objKey];
      }
    }

    return null;
  }

  /**
   * Extract LapSummary[] from GPX tracks.
   * GPX doesn't have a native lap concept, so each track segment is treated as a lap.
   */
  private extractLapSummaries(tracks: GpxTrack[], allDataPoints: MetricDataPoint[]): LapSummary[] {
    const laps: LapSummary[] = [];
    let pointIndex = 0;

    for (const track of tracks) {
      const segments = this.normalizeTrackSegments(track.trkseg);

      for (const segment of segments) {
        const trackpoints = this.normalizeTrackpoints(segment.trkpt);
        const segmentPoints: MetricDataPoint[] = [];

        // Collect data points for this segment
        for (const trkpt of trackpoints) {
          if (!trkpt.time) continue;
          if (pointIndex < allDataPoints.length) {
            segmentPoints.push(allDataPoints[pointIndex]);
            pointIndex++;
          }
        }

        if (segmentPoints.length === 0) continue;

        const startTime = segmentPoints[0].timestamp;
        const endTime = segmentPoints[segmentPoints.length - 1].timestamp;
        const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

        // Compute distance from GPS coordinates or distance field
        const distanceMeters = this.computeSegmentDistance(segmentPoints);

        const lap: LapSummary = {
          startTime,
          durationSeconds,
          distanceMeters,
        };

        // Compute average heart rate
        const hrPoints = segmentPoints.filter((p) => p.heartRateBpm != null);
        if (hrPoints.length > 0) {
          lap.avgHeartRateBpm = Math.round(
            hrPoints.reduce((sum, p) => sum + p.heartRateBpm!, 0) / hrPoints.length,
          );
          lap.maxHeartRateBpm = Math.max(...hrPoints.map((p) => p.heartRateBpm!));
        }

        // Compute average power
        const powerPoints = segmentPoints.filter((p) => p.powerWatts != null);
        if (powerPoints.length > 0) {
          lap.avgPowerWatts = Math.round(
            powerPoints.reduce((sum, p) => sum + p.powerWatts!, 0) / powerPoints.length,
          );
        }

        laps.push(lap);
      }
    }

    return laps;
  }

  /**
   * Compute distance for a segment using the Haversine formula on GPS coordinates.
   */
  private computeSegmentDistance(points: MetricDataPoint[]): number {
    let totalDistance = 0;

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];

      if (prev.latitude != null && prev.longitude != null && curr.latitude != null && curr.longitude != null) {
        totalDistance += this.haversineDistance(
          prev.latitude,
          prev.longitude,
          curr.latitude,
          curr.longitude,
        );
      }
    }

    return totalDistance;
  }

  /**
   * Calculate distance between two GPS coordinates using the Haversine formula.
   * Returns distance in meters.
   */
  private haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Convert degrees to radians.
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Build the workout summary from track data and data points.
   */
  private buildSummary(
    tracks: GpxTrack[],
    lapSummaries: LapSummary[],
    dataPoints: MetricDataPoint[],
  ): ParsedWorkout['summary'] {
    const startTime = dataPoints[0].timestamp;
    const endTime = dataPoints[dataPoints.length - 1].timestamp;
    const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

    // Compute total distance from lap summaries
    const distanceMeters = lapSummaries.reduce((sum, lap) => sum + lap.distanceMeters, 0);

    // Compute elevation gain from data points
    const elevationGain = this.computeElevationGain(dataPoints);

    // Determine activity type from track metadata
    const activityType = this.determineActivityType(tracks);

    // Extract title from first track's name element
    const title = tracks[0]?.name || undefined;

    return {
      activityType,
      title,
      startTime,
      endTime,
      durationSeconds,
      distanceMeters,
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
   * Determine activity type from GPX track metadata.
   * GPX files may have a <type> element in the track.
   */
  private determineActivityType(tracks: GpxTrack[]): string {
    for (const track of tracks) {
      if (track.type) {
        const typeLower = String(track.type).toLowerCase();
        if (typeLower === 'cycling' || typeLower === 'biking' || typeLower === 'ride') return 'ride';
        if (typeLower === 'running' || typeLower === 'run') return 'run';
        if (typeLower === 'virtual_ride') return 'virtual_ride';
        if (typeLower === '1') return 'ride'; // Strava type code for ride
        if (typeLower === '9') return 'ride'; // Strava type code for virtual ride
        return typeLower;
      }
    }

    // Default to ride for cycling-focused app
    return 'ride';
  }
}
