import { Db } from 'mongodb';

/**
 * Initialize MongoDB collections required by the application.
 * Creates the `metrics` time-series collection if it does not already exist.
 * Safe to call on every application startup (idempotent).
 */
export async function initializeCollections(db: Db): Promise<void> {
  const collections = await db.listCollections({ name: 'metrics' }).toArray();

  if (collections.length === 0) {
    await db.createCollection('metrics', {
      timeseries: {
        timeField: 'timestamp',
        metaField: 'meta',
        granularity: 'seconds',
      },
    });
  }
}
