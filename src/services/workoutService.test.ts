import { WorkoutService } from './workoutService';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { FileStorageAdapter } from '../storage/googleDriveAdapter';
import { WorkoutRecord } from '../models/workout';
import { PaginatedResult } from '../models/api';
import { NotFoundError } from '../utils/errors';

describe('WorkoutService', () => {
  let workoutService: WorkoutService;
  let mockWorkoutRepository: jest.Mocked<IWorkoutRepository>;
  let mockFileStorageAdapter: jest.Mocked<FileStorageAdapter>;

  const userId = 'user-123';
  const otherUserId = 'user-456';

  const mockWorkout: WorkoutRecord = {
    id: 'workout-1',
    userId,
    activityType: 'ride',
    startTime: new Date('2024-06-15T08:00:00Z'),
    endTime: new Date('2024-06-15T09:30:00Z'),
    durationSeconds: 5400,
    distanceMeters: 45000,
    elevationGainMeters: 600,
    avgPowerWatts: 220,
    maxPowerWatts: 450,
    avgHeartRateBpm: 145,
    maxHeartRateBpm: 178,
    avgCadenceRpm: 88,
    avgSpeedMps: 8.3,
    dataSource: 'manual',
    fileFormat: 'fit',
    driveFileId: 'drive-file-abc',
    driveWebViewLink: 'https://drive.google.com/file/d/drive-file-abc/view',
    title: 'Morning Ride',
    description: 'Easy endurance ride',
    tags: ['endurance', 'zone2'],
    createdAt: new Date('2024-06-15T10:00:00Z'),
    updatedAt: new Date('2024-06-15T10:00:00Z'),
  };

  beforeEach(() => {
    mockWorkoutRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findDuplicate: jest.fn(),
      findBySourceActivityId: jest.fn(),
      insertMetrics: jest.fn(),
      queryMetrics: jest.fn(),
    };

    mockFileStorageAdapter = {
      store: jest.fn(),
      retrieve: jest.fn(),
      delete: jest.fn(),
      listFiles: jest.fn(),
      removeFromFolder: jest.fn(),
    };

    workoutService = new WorkoutService(mockWorkoutRepository, mockFileStorageAdapter);
  });

  describe('getWorkout', () => {
    it('should return the workout when it exists and belongs to the user', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);

      const result = await workoutService.getWorkout('workout-1', userId);

      expect(mockWorkoutRepository.findById).toHaveBeenCalledWith('workout-1');
      expect(result).toEqual(mockWorkout);
    });

    it('should throw NotFoundError when workout does not exist', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(null);

      await expect(workoutService.getWorkout('nonexistent', userId)).rejects.toThrow(NotFoundError);
      await expect(workoutService.getWorkout('nonexistent', userId)).rejects.toThrow(
        'Workout not found',
      );
    });

    it('should throw NotFoundError when workout belongs to a different user', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);

      await expect(workoutService.getWorkout('workout-1', otherUserId)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('should include summary metrics and Drive reference in the returned workout', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);

      const result = await workoutService.getWorkout('workout-1', userId);

      expect(result.avgPowerWatts).toBe(220);
      expect(result.maxPowerWatts).toBe(450);
      expect(result.driveFileId).toBe('drive-file-abc');
      expect(result.driveWebViewLink).toBe(
        'https://drive.google.com/file/d/drive-file-abc/view',
      );
    });
  });

  describe('listWorkouts', () => {
    const paginatedResult: PaginatedResult<WorkoutRecord> = {
      items: [mockWorkout],
      pagination: {
        page: 1,
        pageSize: 20,
        totalItems: 1,
        totalPages: 1,
      },
    };

    it('should return paginated workouts with default options', async () => {
      mockWorkoutRepository.findMany.mockResolvedValue(paginatedResult);

      const result = await workoutService.listWorkouts(userId);

      expect(mockWorkoutRepository.findMany).toHaveBeenCalledWith({
        userId,
        page: 1,
        pageSize: 20,
        sortBy: 'date',
        sortOrder: 'desc',
        dateFrom: undefined,
        dateTo: undefined,
        activityType: undefined,
        dataSource: undefined,
      });
      expect(result).toEqual(paginatedResult);
    });

    it('should pass custom pagination options to the repository', async () => {
      mockWorkoutRepository.findMany.mockResolvedValue(paginatedResult);

      await workoutService.listWorkouts(userId, { page: 3, pageSize: 10 });

      expect(mockWorkoutRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 3,
          pageSize: 10,
        }),
      );
    });

    it('should pass sorting options to the repository', async () => {
      mockWorkoutRepository.findMany.mockResolvedValue(paginatedResult);

      await workoutService.listWorkouts(userId, { sortBy: 'distance', sortOrder: 'asc' });

      expect(mockWorkoutRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          sortBy: 'distance',
          sortOrder: 'asc',
        }),
      );
    });

    it('should pass filter options to the repository', async () => {
      mockWorkoutRepository.findMany.mockResolvedValue(paginatedResult);
      const dateFrom = new Date('2024-01-01');
      const dateTo = new Date('2024-12-31');

      await workoutService.listWorkouts(userId, {
        dateFrom,
        dateTo,
        activityType: 'ride',
        dataSource: 'strava',
      });

      expect(mockWorkoutRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          dateFrom,
          dateTo,
          activityType: 'ride',
          dataSource: 'strava',
        }),
      );
    });

    it('should return empty result when no workouts match', async () => {
      const emptyResult: PaginatedResult<WorkoutRecord> = {
        items: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      };
      mockWorkoutRepository.findMany.mockResolvedValue(emptyResult);

      const result = await workoutService.listWorkouts(userId);

      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalItems).toBe(0);
    });
  });

  describe('updateWorkout', () => {
    it('should update title and return the modified workout', async () => {
      const updatedWorkout = { ...mockWorkout, title: 'Updated Title', updatedAt: new Date() };
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);
      mockWorkoutRepository.update.mockResolvedValue(updatedWorkout);

      const result = await workoutService.updateWorkout('workout-1', userId, {
        title: 'Updated Title',
      });

      expect(mockWorkoutRepository.findById).toHaveBeenCalledWith('workout-1');
      expect(mockWorkoutRepository.update).toHaveBeenCalledWith('workout-1', {
        title: 'Updated Title',
      });
      expect(result.title).toBe('Updated Title');
    });

    it('should update description', async () => {
      const updatedWorkout = { ...mockWorkout, description: 'New description' };
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);
      mockWorkoutRepository.update.mockResolvedValue(updatedWorkout);

      const result = await workoutService.updateWorkout('workout-1', userId, {
        description: 'New description',
      });

      expect(mockWorkoutRepository.update).toHaveBeenCalledWith('workout-1', {
        description: 'New description',
      });
      expect(result.description).toBe('New description');
    });

    it('should update tags', async () => {
      const updatedWorkout = { ...mockWorkout, tags: ['intervals', 'hard'] };
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);
      mockWorkoutRepository.update.mockResolvedValue(updatedWorkout);

      const result = await workoutService.updateWorkout('workout-1', userId, {
        tags: ['intervals', 'hard'],
      });

      expect(mockWorkoutRepository.update).toHaveBeenCalledWith('workout-1', {
        tags: ['intervals', 'hard'],
      });
      expect(result.tags).toEqual(['intervals', 'hard']);
    });

    it('should update activityType', async () => {
      const updatedWorkout = { ...mockWorkout, activityType: 'virtual_ride' };
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);
      mockWorkoutRepository.update.mockResolvedValue(updatedWorkout);

      const result = await workoutService.updateWorkout('workout-1', userId, {
        activityType: 'virtual_ride',
      });

      expect(mockWorkoutRepository.update).toHaveBeenCalledWith('workout-1', {
        activityType: 'virtual_ride',
      });
      expect(result.activityType).toBe('virtual_ride');
    });

    it('should throw NotFoundError when workout does not exist', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(null);

      await expect(
        workoutService.updateWorkout('nonexistent', userId, { title: 'New' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw NotFoundError when workout belongs to a different user', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);

      await expect(
        workoutService.updateWorkout('workout-1', otherUserId, { title: 'New' }),
      ).rejects.toThrow(NotFoundError);
      expect(mockWorkoutRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteWorkout', () => {
    it('should delete workout from database without removing from Drive by default', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);
      mockWorkoutRepository.delete.mockResolvedValue(undefined);

      await workoutService.deleteWorkout('workout-1', userId);

      expect(mockWorkoutRepository.findById).toHaveBeenCalledWith('workout-1');
      expect(mockWorkoutRepository.delete).toHaveBeenCalledWith('workout-1');
      expect(mockFileStorageAdapter.delete).not.toHaveBeenCalled();
    });

    it('should delete workout from database and Drive when removeFromDrive is true', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);
      mockWorkoutRepository.delete.mockResolvedValue(undefined);
      mockFileStorageAdapter.delete.mockResolvedValue(undefined);

      await workoutService.deleteWorkout('workout-1', userId, { removeFromDrive: true });

      expect(mockFileStorageAdapter.delete).toHaveBeenCalledWith({
        fileId: 'drive-file-abc',
        fileName: '',
        folderPath: '',
      });
      expect(mockWorkoutRepository.delete).toHaveBeenCalledWith('workout-1');
    });

    it('should not remove from Drive when removeFromDrive is false', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);
      mockWorkoutRepository.delete.mockResolvedValue(undefined);

      await workoutService.deleteWorkout('workout-1', userId, { removeFromDrive: false });

      expect(mockFileStorageAdapter.delete).not.toHaveBeenCalled();
      expect(mockWorkoutRepository.delete).toHaveBeenCalledWith('workout-1');
    });

    it('should throw NotFoundError when workout does not exist', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(null);

      await expect(workoutService.deleteWorkout('nonexistent', userId)).rejects.toThrow(
        NotFoundError,
      );
      expect(mockWorkoutRepository.delete).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError when workout belongs to a different user', async () => {
      mockWorkoutRepository.findById.mockResolvedValue(mockWorkout);

      await expect(workoutService.deleteWorkout('workout-1', otherUserId)).rejects.toThrow(
        NotFoundError,
      );
      expect(mockWorkoutRepository.delete).not.toHaveBeenCalled();
      expect(mockFileStorageAdapter.delete).not.toHaveBeenCalled();
    });

    it('should handle workout with no driveFileId when removeFromDrive is true', async () => {
      const workoutNoDrive = { ...mockWorkout, driveFileId: '' };
      mockWorkoutRepository.findById.mockResolvedValue(workoutNoDrive);
      mockWorkoutRepository.delete.mockResolvedValue(undefined);

      await workoutService.deleteWorkout('workout-1', userId, { removeFromDrive: true });

      expect(mockFileStorageAdapter.delete).not.toHaveBeenCalled();
      expect(mockWorkoutRepository.delete).toHaveBeenCalledWith('workout-1');
    });
  });
});
