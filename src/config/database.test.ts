import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';
import { initializeCollections } from './database';

describe('initializeCollections', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    const uri = mongod.getUri();
    client = new MongoClient(uri);
    await client.connect();
    db = client.db('test');
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  afterEach(async () => {
    // Drop the metrics collection between tests to reset state
    const collections = await db.listCollections({ name: 'metrics' }).toArray();
    if (collections.length > 0) {
      await db.dropCollection('metrics');
    }
  });

  it('should create the metrics time-series collection when it does not exist', async () => {
    await initializeCollections(db);

    const collections = await db
      .listCollections({ name: 'metrics' }, { nameOnly: false })
      .toArray();
    expect(collections).toHaveLength(1);

    const collectionInfo = collections[0] as { type: string; options?: { timeseries?: unknown } };
    expect(collectionInfo.type).toBe('timeseries');
    expect(collectionInfo.options?.timeseries).toMatchObject({
      timeField: 'timestamp',
      metaField: 'meta',
      granularity: 'seconds',
    });
  });

  it('should not throw when called multiple times (idempotent)', async () => {
    await initializeCollections(db);
    await expect(initializeCollections(db)).resolves.not.toThrow();

    const collections = await db.listCollections({ name: 'metrics' }).toArray();
    expect(collections).toHaveLength(1);
  });

  it('should not recreate the collection if it already exists', async () => {
    await initializeCollections(db);

    // Insert a document to verify the collection persists
    const metricsCollection = db.collection('metrics');
    await metricsCollection.insertOne({
      timestamp: new Date(),
      meta: { workoutId: 'test-123', activityType: 'ride', dataSource: 'manual' },
      heartRateBpm: 150,
    });

    // Call again — should not drop/recreate
    await initializeCollections(db);

    const count = await metricsCollection.countDocuments();
    expect(count).toBe(1);
  });
});
