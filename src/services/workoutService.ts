/**
 * Workout CRUD service implementing get, list, update, and delete operations.
 * Enforces user ownership on all operations and integrates with Google Drive
 * for optional file removal on delete.
 */

import { WorkoutRecord, WorkoutMetadata } from '../models/workout';
import { PaginatedResult } from '../models/api';
import { IWorkoutRepository, WorkoutQuery } from '../repositories/workoutRepository';
import { FileStorageAdapter, StorageReference } from '../storage/googleDriveAdapter';
import { NotFoundError } from '../utils/errors';

/** Options for listing workouts */
export interface ListWorkoutsOptions {
  page?: number;
  pageSize?: number;
  sortBy?: 'date' | 'duration' | 'distance';
  sortOrder?: 'asc' | 'desc';
  dateFrom?: Date;
  dateTo?: Date;
  activityType?: string;
  dataSource?: string;
}

/** Options for deleting a workout */
export interface DeleteWorkoutOptions {
  removeFromDrive?: boolean;
}

/** Workout service interface */
export interface IWorkoutService {
  getWorkout(workoutId: string, userId: string): Promise<WorkoutRecord>;
  listWorkouts(userId: string, options?: ListWorkoutsOptions): Promise<PaginatedResult<WorkoutRecord>>;
  updateWorkout(
    workoutId: string,
    userId: string,
    updates: Partial<WorkoutMetadata>,
  ): Promise<WorkoutRecord>;
  deleteWorkout(
    workoutId: string,
    userId: string,
    options?: DeleteWorkoutOptions,
  ): Promise<void>;
}

/**
 * Workout CRUD service that enforces user ownership and orchestrates
 * database and file storage operations.
 */
export class WorkoutService implements IWorkoutService {
  constructor(
    private readonly workoutRepository: IWorkoutRepository,
    private readonly fileStorageAdapter: FileStorageAdapter,
  ) {}

  /**
   * Fetch a single workout by ID.
   * Includes summary metrics and Drive reference.
   * Throws NotFoundError if workout doesn't exist or doesn't belong to the user.
   */
  async getWorkout(workoutId: string, userId: string): Promise<WorkoutRecord> {
    const workout = await this.workoutRepository.findById(workoutId);

    if (!workout || workout.userId !== userId) {
      throw new NotFoundError('Workout not found');
    }

    return workout;
  }

  /**
   * List workouts for a user with pagination, sorting, and filtering.
   * Results are sorted by date descending by default.
   */
  async listWorkouts(
    userId: string,
    options?: ListWorkoutsOptions,
  ): Promise<PaginatedResult<WorkoutRecord>> {
    const query: WorkoutQuery = {
      userId,
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
      sortBy: options?.sortBy ?? 'date',
      sortOrder: options?.sortOrder ?? 'desc',
      dateFrom: options?.dateFrom,
      dateTo: options?.dateTo,
      activityType: options?.activityType,
      dataSource: options?.dataSource,
    };

    return this.workoutRepository.findMany(query);
  }

  /**
   * Update workout metadata fields (title, description, tags, activityType).
   * Throws NotFoundError if workout doesn't exist or doesn't belong to the user.
   */
  async updateWorkout(
    workoutId: string,
    userId: string,
    updates: Partial<WorkoutMetadata>,
  ): Promise<WorkoutRecord> {
    // Verify ownership before updating
    const workout = await this.workoutRepository.findById(workoutId);

    if (!workout || workout.userId !== userId) {
      throw new NotFoundError('Workout not found');
    }

    return this.workoutRepository.update(workoutId, updates);
  }

  /**
   * Delete a workout from the database.
   * Optionally removes the associated file from Google Drive based on user preference.
   * Throws NotFoundError if workout doesn't exist or doesn't belong to the user.
   */
  async deleteWorkout(
    workoutId: string,
    userId: string,
    options?: DeleteWorkoutOptions,
  ): Promise<void> {
    // Verify ownership before deleting
    const workout = await this.workoutRepository.findById(workoutId);

    if (!workout || workout.userId !== userId) {
      throw new NotFoundError('Workout not found');
    }

    // Optionally remove from Google Drive
    if (options?.removeFromDrive && workout.driveFileId) {
      const storageRef: StorageReference = {
        fileId: workout.driveFileId,
        fileName: '',
        folderPath: '',
      };
      await this.fileStorageAdapter.delete(storageRef);
    }

    // Remove from database (also removes associated metrics)
    await this.workoutRepository.delete(workoutId);
  }
}
