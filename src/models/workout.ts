/**
 * Core workout data models for the Cycle Analyzer feature.
 * These types represent workout records, time-series metrics, and parsed workout data.
 */

/** Supported workout file formats */
export type WorkoutFileFormat = 'fit' | 'tcx' | 'gpx';

/** Origin platform for workout data */
export type DataSource = 'manual' | 'strava' | 'trainingpeaks' | 'garmin';

/** Available metric types for time-series data */
export type MetricType =
  | 'heartRate'
  | 'power'
  | 'cadence'
  | 'speed'
  | 'distance'
  | 'elevation'
  | 'gps'
  | 'temperature';

/** A single workout record stored in the database */
export interface WorkoutRecord {
  id: string;
  userId: string;

  // Summary
  activityType: string;
  subActivityType?: string;
  startTime: Date;
  endTime: Date;
  durationSeconds: number;
  movingTimeSeconds?: number;
  distanceMeters: number;
  elevationGainMeters: number;
  elevationLossMeters?: number;
  calories?: number;

  // Temperature
  avgTemperatureCelsius?: number;
  maxTemperatureCelsius?: number;

  // Averages & Peaks
  avgPowerWatts?: number;
  maxPowerWatts?: number;
  normalizedPowerWatts?: number;
  totalWorkKj?: number;
  ftpWatts?: number;
  intensityFactor?: number;
  tss?: number;
  aerobicDecoupling?: number;
  avgHeartRateBpm?: number;
  maxHeartRateBpm?: number;
  avgCadenceRpm?: number;
  maxCadenceRpm?: number;
  totalPedalRevolutions?: number;
  avgSpeedMps?: number;
  maxSpeedMps?: number;
  aerobicTrainingEffect?: number;
  anaerobicTrainingEffect?: number;

  // Source tracking
  dataSource: DataSource;
  sourceActivityId?: string;
  fileFormat: WorkoutFileFormat;

  // Storage references
  driveFileId: string;
  driveWebViewLink?: string;

  // Metadata
  title?: string;
  description?: string;
  comment?: string;
  tags?: string[];

  createdAt: Date;
  updatedAt: Date;
}

/** Updatable metadata fields on a WorkoutRecord */
export type WorkoutMetadata = Pick<
  WorkoutRecord,
  'title' | 'description' | 'comment' | 'tags' | 'activityType'
>;

/** A single time-series data point within a workout */
export interface MetricDataPoint {
  timestamp: Date;
  workoutId: string;
  activityType: string;
  dataSource: DataSource;

  // Measurements
  heartRateBpm?: number;
  powerWatts?: number;
  cadenceRpm?: number;
  speedMps?: number;
  distanceMeters?: number;
  elevationMeters?: number;
  latitude?: number;
  longitude?: number;
  temperature?: number;
}

/** Summary data for a single lap within a workout */
export interface LapSummary {
  startTime: Date;
  durationSeconds: number;
  distanceMeters: number;
  avgPowerWatts?: number;
  avgHeartRateBpm?: number;
  maxHeartRateBpm?: number;
}

/** Internal representation of a parsed workout file */
export interface ParsedWorkout {
  /** Summary data extracted from file headers/laps */
  summary: {
    activityType: string;
    subActivityType?: string;
    title?: string;
    startTime: Date;
    endTime: Date;
    durationSeconds: number;
    movingTimeSeconds?: number;
    distanceMeters: number;
    elevationGainMeters: number;
    elevationLossMeters?: number;
    calories?: number;
    avgTemperatureCelsius?: number;
    maxTemperatureCelsius?: number;
    normalizedPowerWatts?: number;
    totalWorkKj?: number;
    ftpWatts?: number;
    intensityFactor?: number;
    tss?: number;
    maxCadenceRpm?: number;
    totalPedalRevolutions?: number;
    maxSpeedMps?: number;
    aerobicTrainingEffect?: number;
    anaerobicTrainingEffect?: number;
    laps?: LapSummary[];
  };

  /** Individual data points (time-series) */
  dataPoints: MetricDataPoint[];

  /** Original file format */
  sourceFormat: WorkoutFileFormat;
}
