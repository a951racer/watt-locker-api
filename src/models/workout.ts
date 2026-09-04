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

/** Activity lifecycle status */
export type ActivityStatus = 'planned' | 'completed' | 'skipped';

/**
 * Per-step intensity metric for a planned Activity Step.
 * Mirrors the UI `IntensityMetric` (watt-locker-ui/src/utils/tssCalculator.ts).
 */
export type StepIntensityMetric = 'power_ftp' | 'hr_threshold' | 'hr_max' | 'power_watts';

/**
 * PLAN-056: How a canonical Activity Step's duration is expressed.
 * Exactly one of time/distance applies per step.
 */
export type StepDurationType = 'time' | 'distance';

/**
 * Canonical Activity Step ("segment") shape stored inside a workout's
 * `segments` array.
 *
 * NOTE: The server persists `segments` verbatim (it is authored and consumed by
 * the UI planner), so every field is optional here — this interface documents
 * and lightly types the JSON rather than enforcing a strict schema. It mirrors
 * the UI `PlanSegment` type. PLAN-056 added the optional `name`, the explicit
 * `durationType`, and the distance-based `distanceMeters` fields; `durationSeconds`
 * remains for time-based steps and legacy activities (which have no
 * `durationType` and are treated as time-based).
 */
export interface PlanSegment {
  name?: string;
  type?: 'warmup' | 'interval' | 'recovery' | 'cooldown' | 'steady';
  durationType?: StepDurationType;
  durationSeconds?: number;
  distanceMeters?: number;
  intensityMetric?: StepIntensityMetric;
  powerMin?: number;
  powerMax?: number;
  hrMin?: number;
  hrMax?: number;
  cadenceMin?: number;
  cadenceMax?: number;
  notes?: string;
  repeatId?: string;
  repeatCount?: number;
}

/** A single workout record stored in the database */
export interface WorkoutRecord {
  id: string;
  userId: string;

  // Lifecycle
  status: ActivityStatus | null;
  template: boolean;
  date: string | null; // YYYY-MM-DD calendar date, null for templates

  // Planned values
  plannedDurationSeconds?: number;
  plannedDistanceMeters?: number;
  plannedTss?: number;
  plannedIf?: number;
  plannedTssOverride?: boolean;
  plannedIfOverride?: boolean;

  // Summary
  activityType: string;
  subActivityType?: string;
  startTime?: Date;
  endTime?: Date;
  durationSeconds?: number;
  movingTimeSeconds?: number;
  distanceMeters?: number;
  elevationGainMeters?: number;
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
  ftpUsed?: number;
  intensityFactor?: number;
  tss?: number;
  aerobicDecoupling?: number;
  maxPowers?: Record<string, number>; // key = duration in seconds, value = max avg watts
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
  dataSource?: DataSource;
  sourceActivityId?: string;
  fileFormat?: WorkoutFileFormat;

  // Storage references
  driveFileId?: string;
  driveWebViewLink?: string;

  // Metadata
  title?: string;
  description?: string;
  comment?: string;
  tags?: string[];

  // Planning-specific fields
  segments?: PlanSegment[];
  targetSpeed?: number;
  targetPowerMin?: number;
  targetPowerMax?: number;
  targetHrMin?: number;
  targetHrMax?: number;
  targetCadenceMin?: number;
  targetCadenceMax?: number;
  referenceMetric?: { type: string; value: number };
  equipment?: unknown;
  eventId?: string;

  createdAt: Date;
  updatedAt: Date;
}

/** Updatable metadata fields on a WorkoutRecord */
export type WorkoutMetadata = Pick<
  WorkoutRecord,
  'title' | 'description' | 'comment' | 'tags' | 'activityType'
>;

/** Extended updatable fields for planning-aware updates */
export interface ActivityUpdateFields {
  // Common editable fields (all statuses)
  title?: string;
  description?: string;
  comment?: string;
  tags?: string[];
  activityType?: string;
  // Planned/skipped only
  date?: string;
  plannedDurationSeconds?: number;
  plannedDistanceMeters?: number;
  segments?: PlanSegment[];
  targetPowerMin?: number;
  targetPowerMax?: number;
  targetHrMin?: number;
  targetHrMax?: number;
  targetCadenceMin?: number;
  targetCadenceMax?: number;
  targetSpeed?: number;
  plannedTss?: number;
  plannedIf?: number;
  plannedTssOverride?: boolean;
  plannedIfOverride?: boolean;
  referenceMetric?: { type: string; value: number };
  equipment?: { equipmentId: string; configurationId: string } | null;
  eventId?: string;
  // Completed only
  rpe?: number;
  movingTimeSeconds?: number;
}

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
