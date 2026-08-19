/**
 * PLAN-020: Migrate existing workout provenance data to SourceArtifact records.
 *
 * For each existing WorkoutDocument with a `driveFileId`, creates a corresponding
 * primary SourceArtifact record representing the existing source file.
 *
 * Properties:
 * - Idempotent: skip if artifact already exists for activityId + driveFileId
 * - Recoverable: interrupted run → subsequent run completes remaining work
 * - Non-destructive: does NOT modify existing WorkoutDocuments
 * - Observable: reports progress and anomalies
 *
 * CLI Safety:
 * - --dry-run: inspect intended changes without modifying data
 * - --execute: perform the migration and write to database
 * - no flag: refuse to run (display usage)
 */

import { Db } from 'mongodb';

/** CLI execution mode */
export type MigrationMode = 'dry-run' | 'execute' | 'none';

/**
 * Parse CLI arguments to determine execution mode.
 */
export function parseCliMode(argv: string[]): MigrationMode {
  if (argv.includes('--dry-run')) return 'dry-run';
  if (argv.includes('--execute')) return 'execute';
  return 'none';
}

export interface MigrationOptions {
  dryRun?: boolean;
}

export interface MigrationResult {
  examined: number;
  qualifying: number;
  created: number;
  skippedExisting: number;
  skippedNoDriveFile: number;
  errors: Array<{ activityId: string; error: string }>;
}

/**
 * Execute the PLAN-020 migration.
 *
 * Scans all WorkoutDocuments. For each with a driveFileId, creates a primary
 * SourceArtifact if one does not already exist for that activityId + driveFileId.
 */
export async function runMigration(
  db: Db,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const dryRun = options.dryRun ?? false;
  const workouts = db.collection('workouts');
  const sourceArtifacts = db.collection('sourceArtifacts');

  const result: MigrationResult = {
    examined: 0,
    qualifying: 0,
    created: 0,
    skippedExisting: 0,
    skippedNoDriveFile: 0,
    errors: [],
  };

  const cursor = workouts.find({});

  for await (const doc of cursor) {
    result.examined++;

    // Only process documents with driveFileId
    if (!doc.driveFileId) {
      result.skippedNoDriveFile++;
      continue;
    }

    result.qualifying++;
    const activityId = doc._id.toHexString();

    try {
      // Idempotency check: skip if artifact already exists for this activityId + driveFileId
      const existing = await sourceArtifacts.findOne({
        activityId,
        driveFileId: doc.driveFileId,
      });

      if (existing) {
        result.skippedExisting++;
        continue;
      }

      if (dryRun) {
        result.created++;
        continue;
      }

      // Build the SourceArtifact document
      const now = new Date();
      const artifactDoc: Record<string, unknown> = {
        userId: doc.userId,
        activityId,
        role: 'primary',
        materialized: true,
        driveFileId: doc.driveFileId,
        originalFileName: doc.title || activityId,
        importedAt: doc.createdAt || now,
        createdAt: now,
        updatedAt: now,
      };

      // Map optional provenance fields (only include if present)
      if (doc.dataSource) artifactDoc.source = doc.dataSource;
      if (doc.fileFormat) artifactDoc.format = doc.fileFormat;
      if (doc.driveWebViewLink) artifactDoc.driveWebViewLink = doc.driveWebViewLink;
      if (doc.sourceActivityId) artifactDoc.sourceActivityId = doc.sourceActivityId;
      if (doc.startTime) artifactDoc.startTime = doc.startTime;
      if (doc.durationSeconds != null) artifactDoc.durationSeconds = doc.durationSeconds;
      if (doc.activityType) artifactDoc.activityType = doc.activityType;

      await sourceArtifacts.insertOne(artifactDoc);
      result.created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Handle duplicate key gracefully (race condition / concurrent run)
      if (message.includes('duplicate key') || message.includes('E11000')) {
        result.skippedExisting++;
      } else {
        result.errors.push({ activityId, error: message });
      }
    }
  }

  return result;
}


/**
 * CLI entry point.
 * --dry-run   Report intended changes without writing.
 * --execute   Perform the migration.
 * (no flag)   Refuse to execute and display usage.
 */
export async function main(): Promise<void> {
  const mode = parseCliMode(process.argv);

  if (mode === 'none') {
    console.log('PLAN-020 Migration: Backfill SourceArtifact records from workout provenance');
    console.log('');
    console.log('Usage:');
    console.log('  npx ts-node src/migrations/020-backfill-source-artifacts.ts --dry-run');
    console.log('  npx ts-node src/migrations/020-backfill-source-artifacts.ts --execute');
    console.log('');
    console.log('  --dry-run   Report intended changes without modifying data.');
    console.log('  --execute   Perform the migration and write to the database.');
    console.log('');
    console.log('Refusing to run without explicit mode. Specify --dry-run or --execute.');
    process.exit(1);
    return;
  }

  const dryRun = mode === 'dry-run';

  // Import config lazily so tests don't require env vars
  const { config } = await import('../config/env');
  const { MongoClient } = await import('mongodb');
  const mongoClient = new MongoClient(config.mongo.uri);

  try {
    console.log('PLAN-020 Migration: Backfill SourceArtifact records');
    console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE (writes enabled)'}`);
    console.log('---');

    await mongoClient.connect();
    const db = mongoClient.db();

    // Ensure source artifact indexes exist
    const { MongoSourceArtifactRepository } = await import('../repositories/sourceArtifactRepository');
    const repo = new MongoSourceArtifactRepository(db);
    await repo.createIndexes();

    const result = await runMigration(db, { dryRun });

    console.log('\n--- Migration Report ---');
    console.log(`Examined:            ${result.examined}`);
    console.log(`Qualifying:          ${result.qualifying}`);
    console.log(`Created:             ${result.created}`);
    console.log(`Skipped (existing):  ${result.skippedExisting}`);
    console.log(`Skipped (no drive):  ${result.skippedNoDriveFile}`);
    console.log(`Errors:              ${result.errors.length}`);

    if (result.errors.length > 0) {
      console.log('\nErrors:');
      for (const e of result.errors) {
        console.log(`  Activity ${e.activityId}: ${e.error}`);
      }
    }

    if (dryRun) {
      console.log('\nDRY RUN complete. No data was modified.');
    } else {
      console.log('\nMigration complete.');
    }
  } finally {
    await mongoClient.close();
  }
}

// Execute if run directly (not when imported by tests)
if (require.main === module) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
