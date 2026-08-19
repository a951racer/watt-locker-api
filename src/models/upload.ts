/**
 * Upload result types for single and bulk workout file uploads.
 */

/** Result of a successful single file upload */
export interface UploadResult {
  workoutId: string;
  driveFileId: string;
  summary: WorkoutSummary;
  matchedExisting?: boolean;
  duplicate?: boolean;
}

/** Brief summary of a workout included in upload results */
export interface WorkoutSummary {
  activityType: string;
  startTime: Date;
  durationSeconds: number;
  distanceMeters: number;
}

/** Result of a bulk upload operation */
export interface BulkUploadResult {
  total: number;
  successful: UploadResult[];
  failed: FailedUpload[];
  inProgress: number;
}

/** Details of a failed file upload within a bulk operation */
export interface FailedUpload {
  fileName: string;
  error: string;
  errorCode: string;
}

/** Result of a successful intake (PLAN-021 — no materialization) */
export interface IntakeResult {
  artifactId: string;
  driveFileId: string;
  originalFileName: string;
  startTime?: Date;
  durationSeconds?: number;
  activityType?: string;
  duplicate: boolean;
  matched: boolean;
  activityId: string | null;
  role: 'primary' | 'secondary';
  materialized: boolean;
}
