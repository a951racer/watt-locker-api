import { Db } from 'mongodb';
import { MongoStepTemplateRepository } from '../repositories/stepTemplateRepository';
import { MongoBlockTemplateRepository } from '../repositories/blockTemplateRepository';

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

  // PLAN-057: ensure the Step Template collection index exists (idempotent).
  await new MongoStepTemplateRepository(db).createIndexes();

  // PLAN-058: ensure the Block Template collection index exists (idempotent).
  await new MongoBlockTemplateRepository(db).createIndexes();
}
