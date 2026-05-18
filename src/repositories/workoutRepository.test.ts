import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { MongoWorkoutRepository } from './workoutRepository';
import { WorkoutRecord, MetricDataPoint } from '../models/workout';

describe('MongoWorkoutRepository', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  let repo: MongoWorkoutRepository;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    const uri = mongod.getUri();
    client = new MongoClient(uri);
    await client.connect();
    db = client.db('test');
    repo = new MongoWorkoutRepository(db);
    await repo.createIndexes();
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await db.collection('workouts').deleteMany({});
    await db.collection('metrics').deleteMany({});
  });

  function makeWorkout(overrides: Partial<WorkoutRecord> = {}): WorkoutRecord {
    return {
      id: '',
      userId: 'user-1',
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
      avgSpeedMps: 8.33,
      dataSource: 'manual',
      fileFormat: 'fit',
      driveFileId: 'drive-file-123',
      driveWebViewLink: 'https://drive.google.com/file/123',
      title: 'Morning Ride',
      description: 'Easy endurance ride',
      tags: ['endurance', 'zone2'],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function makeMetrics(workoutId: string, count: number): MetricDataPoint[] {
    const baseTime = new Date('2024-06-15T08:00:00Z').getTime();
    return Array.from({ length: count }, (_, i) => ({
      timestamp: new Date(baseTime + i * 1000),
      workoutId,
      activityType: 'ride',
      dataSource: 'manual' as const,
      heartRateBpm: 140 + Math.floor(i / 10),
      powerWatts: 200 + (i % 50),
      cadenceRpm: 85 + (i % 10),
      speedMps: 8.0 + (i % 5) * 0.1,
    }));
  }

  describe('create', () => {
    it('should create a workout and return it with an id', async () => {
      const workout = makeWorkout();
      const result = await repo.create(workout);

      expect(result.id).toBeDefined();
      expect(result.id).not.toBe('');
      expect(result.userId).toBe('user-1');
      expect(result.activityType).toBe('ride');
      expect(result.durationSeconds).toBe(5400);
      expect(result.distanceMeters).toBe(45000);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it('should store all fields correctly', async () => {
      const workout = makeWorkout({
        sourceActivityId: 'strava-12345',
        dataSource: 'strava',
      });
      const created = await repo.create(workout);
      const found = await repo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found!.title).toBe('Morning Ride');
      expect(found!.description).toBe('Easy endurance ride');
      expect(found!.tags).toEqual(['endurance', 'zone2']);
      expect(found!.sourceActivityId).toBe('strava-12345');
      expect(found!.dataSource).toBe('strava');
      expect(found!.driveWebViewLink).toBe('https://drive.google.com/file/123');
    });

    it('should handle optional fields being undefined', async () => {
      const workout = makeWorkout({
        avgPowerWatts: undefined,
        maxPowerWatts: undefined,
        title: undefined,
        description: undefined,
        tags: undefined,
        sourceActivityId: undefined,
      });
      const created = await repo.create(workout);
      const found = await repo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found!.avgPowerWatts).toBeUndefined();
      expect(found!.title).toBeUndefined();
    });
  });

  describe('findById', () => {
    it('should return null for non-existent id', async () => {
      const result = await repo.findById('507f1f77bcf86cd799439011');
      expect(result).toBeNull();
    });

    it('should return null for invalid ObjectId', async () => {
      const result = await repo.findById('invalid-id');
      expect(result).toBeNull();
    });

    it('should return the workout when it exists', async () => {
      const created = await repo.create(makeWorkout());
      const found = await repo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.userId).toBe('user-1');
    });
  });

  describe('findMany', () => {
    it('should return empty result when no workouts exist', async () => {
      const result = await repo.findMany({
        userId: 'user-1',
        page: 1,
        pageSize: 10,
      });

      expect(result.items).toHaveLength(0);
      expect(result.pagination.totalItems).toBe(0);
      expect(result.pagination.totalPages).toBe(0);
    });

    it('should return workouts for the specified user only', async () => {
      await repo.create(makeWorkout({ userId: 'user-1' }));
      await repo.create(makeWorkout({ userId: 'user-2' }));
      await repo.create(makeWorkout({ userId: 'user-1', startTime: new Date('2024-06-16T08:00:00Z') }));

      const result = await repo.findMany({
        userId: 'user-1',
        page: 1,
        pageSize: 10,
      });

      expect(result.items).toHaveLength(2);
      expect(result.items.every((w) => w.userId === 'user-1')).toBe(true);
    });

    it('should paginate results correctly', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.create(
          makeWorkout({
            startTime: new Date(`2024-06-${15 + i}T08:00:00Z`),
          }),
        );
      }

      const page1 = await repo.findMany({ userId: 'user-1', page: 1, pageSize: 2 });
      const page2 = await repo.findMany({ userId: 'user-1', page: 2, pageSize: 2 });
      const page3 = await repo.findMany({ userId: 'user-1', page: 3, pageSize: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);
      expect(page3.items).toHaveLength(1);
      expect(page1.pagination.totalItems).toBe(5);
      expect(page1.pagination.totalPages).toBe(3);
    });

    it('should sort by date descending by default', async () => {
      await repo.create(makeWorkout({ startTime: new Date('2024-06-10T08:00:00Z') }));
      await repo.create(makeWorkout({ startTime: new Date('2024-06-20T08:00:00Z') }));
      await repo.create(makeWorkout({ startTime: new Date('2024-06-15T08:00:00Z') }));

      const result = await repo.findMany({ userId: 'user-1', page: 1, pageSize: 10 });

      expect(result.items[0].startTime.getTime()).toBeGreaterThan(
        result.items[1].startTime.getTime(),
      );
      expect(result.items[1].startTime.getTime()).toBeGreaterThan(
        result.items[2].startTime.getTime(),
      );
    });

    it('should sort by duration ascending', async () => {
      await repo.create(makeWorkout({ durationSeconds: 3600 }));
      await repo.create(makeWorkout({ durationSeconds: 1800, startTime: new Date('2024-06-16T08:00:00Z') }));
      await repo.create(makeWorkout({ durationSeconds: 7200, startTime: new Date('2024-06-17T08:00:00Z') }));

      const result = await repo.findMany({
        userId: 'user-1',
        page: 1,
        pageSize: 10,
        sortBy: 'duration',
        sortOrder: 'asc',
      });

      expect(result.items[0].durationSeconds).toBe(1800);
      expect(result.items[1].durationSeconds).toBe(3600);
      expect(result.items[2].durationSeconds).toBe(7200);
    });

    it('should filter by date range', async () => {
      await repo.create(makeWorkout({ startTime: new Date('2024-06-10T08:00:00Z') }));
      await repo.create(makeWorkout({ startTime: new Date('2024-06-15T08:00:00Z') }));
      await repo.create(makeWorkout({ startTime: new Date('2024-06-20T08:00:00Z') }));

      const result = await repo.findMany({
        userId: 'user-1',
        page: 1,
        pageSize: 10,
        dateFrom: new Date('2024-06-12T00:00:00Z'),
        dateTo: new Date('2024-06-18T00:00:00Z'),
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].startTime).toEqual(new Date('2024-06-15T08:00:00Z'));
    });

    it('should filter by activity type', async () => {
      await repo.create(makeWorkout({ activityType: 'ride' }));
      await repo.create(makeWorkout({ activityType: 'virtual_ride', startTime: new Date('2024-06-16T08:00:00Z') }));
      await repo.create(makeWorkout({ activityType: 'ride', startTime: new Date('2024-06-17T08:00:00Z') }));

      const result = await repo.findMany({
        userId: 'user-1',
        page: 1,
        pageSize: 10,
        activityType: 'virtual_ride',
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].activityType).toBe('virtual_ride');
    });

    it('should filter by data source', async () => {
      await repo.create(makeWorkout({ dataSource: 'manual' }));
      await repo.create(
        makeWorkout({
          dataSource: 'strava',
          sourceActivityId: 'strava-1',
          startTime: new Date('2024-06-16T08:00:00Z'),
        }),
      );

      const result = await repo.findMany({
        userId: 'user-1',
        page: 1,
        pageSize: 10,
        dataSource: 'strava',
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].dataSource).toBe('strava');
    });
  });

  describe('update', () => {
    it('should update title', async () => {
      const created = await repo.create(makeWorkout());
      const updated = await repo.update(created.id, { title: 'Updated Title' });

      expect(updated.title).toBe('Updated Title');
      expect(updated.description).toBe('Easy endurance ride');
    });

    it('should update description', async () => {
      const created = await repo.create(makeWorkout());
      const updated = await repo.update(created.id, { description: 'Hard interval session' });

      expect(updated.description).toBe('Hard interval session');
    });

    it('should update tags', async () => {
      const created = await repo.create(makeWorkout());
      const updated = await repo.update(created.id, { tags: ['intervals', 'vo2max'] });

      expect(updated.tags).toEqual(['intervals', 'vo2max']);
    });

    it('should update activityType', async () => {
      const created = await repo.create(makeWorkout());
      const updated = await repo.update(created.id, { activityType: 'virtual_ride' });

      expect(updated.activityType).toBe('virtual_ride');
    });

    it('should update updatedAt timestamp', async () => {
      const created = await repo.create(makeWorkout());
      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await repo.update(created.id, { title: 'New' });

      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    });

    it('should throw for non-existent workout', async () => {
      await expect(
        repo.update('507f1f77bcf86cd799439011', { title: 'Test' }),
      ).rejects.toThrow('Workout not found');
    });

    it('should throw for invalid id', async () => {
      await expect(repo.update('invalid-id', { title: 'Test' })).rejects.toThrow(
        'Workout not found',
      );
    });
  });

  describe('delete', () => {
    it('should delete an existing workout', async () => {
      const created = await repo.create(makeWorkout());
      await repo.delete(created.id);

      const found = await repo.findById(created.id);
      expect(found).toBeNull();
    });

    it('should also delete associated metrics', async () => {
      const created = await repo.create(makeWorkout());
      const metrics = makeMetrics(created.id, 10);
      await repo.insertMetrics(created.id, metrics);

      await repo.delete(created.id);

      const remainingMetrics = await repo.queryMetrics({
        workoutId: created.id,
        timeFrom: new Date('2024-06-15T07:00:00Z'),
        timeTo: new Date('2024-06-15T10:00:00Z'),
      });
      expect(remainingMetrics).toHaveLength(0);
    });

    it('should throw for non-existent workout', async () => {
      await expect(repo.delete('507f1f77bcf86cd799439011')).rejects.toThrow('Workout not found');
    });

    it('should throw for invalid id', async () => {
      await expect(repo.delete('invalid-id')).rejects.toThrow('Workout not found');
    });
  });

  describe('findDuplicate', () => {
    it('should return null when no duplicate exists', async () => {
      await repo.create(makeWorkout());

      const result = await repo.findDuplicate(
        'user-1',
        new Date('2024-07-01T08:00:00Z'),
        3600,
      );
      expect(result).toBeNull();
    });

    it('should find a duplicate with matching startTime and duration', async () => {
      const startTime = new Date('2024-06-15T08:00:00Z');
      await repo.create(makeWorkout({ startTime, durationSeconds: 5400 }));

      const result = await repo.findDuplicate('user-1', startTime, 5400);
      expect(result).not.toBeNull();
      expect(result!.startTime).toEqual(startTime);
      expect(result!.durationSeconds).toBe(5400);
    });

    it('should not match if startTime differs', async () => {
      await repo.create(
        makeWorkout({
          startTime: new Date('2024-06-15T08:00:00Z'),
          durationSeconds: 5400,
        }),
      );

      const result = await repo.findDuplicate(
        'user-1',
        new Date('2024-06-15T08:01:00Z'),
        5400,
      );
      expect(result).toBeNull();
    });

    it('should not match if duration differs', async () => {
      const startTime = new Date('2024-06-15T08:00:00Z');
      await repo.create(makeWorkout({ startTime, durationSeconds: 5400 }));

      const result = await repo.findDuplicate('user-1', startTime, 5401);
      expect(result).toBeNull();
    });

    it('should not match workouts from different users', async () => {
      const startTime = new Date('2024-06-15T08:00:00Z');
      await repo.create(makeWorkout({ userId: 'user-1', startTime, durationSeconds: 5400 }));

      const result = await repo.findDuplicate('user-2', startTime, 5400);
      expect(result).toBeNull();
    });
  });

  describe('insertMetrics', () => {
    it('should insert metric data points', async () => {
      const created = await repo.create(makeWorkout());
      const metrics = makeMetrics(created.id, 5);

      await repo.insertMetrics(created.id, metrics);

      const result = await repo.queryMetrics({
        workoutId: created.id,
        timeFrom: new Date('2024-06-15T07:00:00Z'),
        timeTo: new Date('2024-06-15T10:00:00Z'),
      });

      expect(result).toHaveLength(5);
    });

    it('should handle empty metrics array gracefully', async () => {
      const created = await repo.create(makeWorkout());
      await expect(repo.insertMetrics(created.id, [])).resolves.not.toThrow();
    });

    it('should store meta fields correctly', async () => {
      const created = await repo.create(makeWorkout());
      const metrics: MetricDataPoint[] = [
        {
          timestamp: new Date('2024-06-15T08:00:00Z'),
          workoutId: created.id,
          activityType: 'ride',
          dataSource: 'strava',
          heartRateBpm: 150,
          powerWatts: 250,
        },
      ];

      await repo.insertMetrics(created.id, metrics);

      const result = await repo.queryMetrics({
        workoutId: created.id,
        timeFrom: new Date('2024-06-15T07:00:00Z'),
        timeTo: new Date('2024-06-15T10:00:00Z'),
      });

      expect(result[0].workoutId).toBe(created.id);
      expect(result[0].activityType).toBe('ride');
      expect(result[0].dataSource).toBe('strava');
      expect(result[0].heartRateBpm).toBe(150);
      expect(result[0].powerWatts).toBe(250);
    });
  });

  describe('queryMetrics', () => {
    it('should return metrics within time range', async () => {
      const created = await repo.create(makeWorkout());
      const metrics = makeMetrics(created.id, 100);
      await repo.insertMetrics(created.id, metrics);

      const result = await repo.queryMetrics({
        workoutId: created.id,
        timeFrom: new Date('2024-06-15T08:00:00Z'),
        timeTo: new Date('2024-06-15T08:00:10Z'),
      });

      // Should get 11 points (0-10 seconds inclusive)
      expect(result.length).toBe(11);
    });

    it('should filter by workoutId', async () => {
      const workout1 = await repo.create(makeWorkout());
      const workout2 = await repo.create(
        makeWorkout({ startTime: new Date('2024-06-16T08:00:00Z') }),
      );

      await repo.insertMetrics(workout1.id, makeMetrics(workout1.id, 5));
      await repo.insertMetrics(workout2.id, makeMetrics(workout2.id, 3));

      const result = await repo.queryMetrics({
        workoutId: workout1.id,
        timeFrom: new Date('2024-06-15T07:00:00Z'),
        timeTo: new Date('2024-06-15T10:00:00Z'),
      });

      expect(result).toHaveLength(5);
      expect(result.every((m) => m.workoutId === workout1.id)).toBe(true);
    });

    it('should return metrics sorted by timestamp ascending', async () => {
      const created = await repo.create(makeWorkout());
      const metrics = makeMetrics(created.id, 20);
      await repo.insertMetrics(created.id, metrics);

      const result = await repo.queryMetrics({
        workoutId: created.id,
        timeFrom: new Date('2024-06-15T07:00:00Z'),
        timeTo: new Date('2024-06-15T10:00:00Z'),
      });

      for (let i = 1; i < result.length; i++) {
        expect(result[i].timestamp.getTime()).toBeGreaterThanOrEqual(
          result[i - 1].timestamp.getTime(),
        );
      }
    });

    it('should return empty array when no metrics match', async () => {
      const result = await repo.queryMetrics({
        workoutId: 'non-existent',
        timeFrom: new Date('2024-06-15T07:00:00Z'),
        timeTo: new Date('2024-06-15T10:00:00Z'),
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('indexes', () => {
    it('should enforce unique sparse index on userId + sourceActivityId', async () => {
      await repo.create(
        makeWorkout({
          userId: 'user-1',
          dataSource: 'strava',
          sourceActivityId: 'strava-100',
        }),
      );

      // Inserting another workout with same userId + sourceActivityId should fail
      await expect(
        repo.create(
          makeWorkout({
            userId: 'user-1',
            dataSource: 'strava',
            sourceActivityId: 'strava-100',
            startTime: new Date('2024-06-20T08:00:00Z'),
          }),
        ),
      ).rejects.toThrow();
    });

    it('should allow multiple workouts without sourceActivityId (sparse)', async () => {
      await repo.create(makeWorkout({ sourceActivityId: undefined }));
      await expect(
        repo.create(
          makeWorkout({
            sourceActivityId: undefined,
            startTime: new Date('2024-06-16T08:00:00Z'),
          }),
        ),
      ).resolves.not.toThrow();
    });

    it('should allow same sourceActivityId for different users', async () => {
      await repo.create(
        makeWorkout({
          userId: 'user-1',
          sourceActivityId: 'strava-200',
        }),
      );

      await expect(
        repo.create(
          makeWorkout({
            userId: 'user-2',
            sourceActivityId: 'strava-200',
          }),
        ),
      ).resolves.not.toThrow();
    });
  });
});
