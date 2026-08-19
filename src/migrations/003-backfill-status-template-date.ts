/**
 * PLAN-003: Backfill status, template, and date for existing WorkoutDocuments.
 *
 * This migration establishes the Activity lifecycle fields on all existing documents:
 * - status → 'completed' (where absent)
 * - template → false (where absent)
 * - date → calendar date derived from startTime in user's timezone (where absent)
 *
 * Properties:
 * - Idempotent: safe to run repeatedly; second run makes no changes
 * - Recoverable: interrupted run → subsequent run completes remaining work
 * - Non-destructive: does not overwrite existing values
 * - Observable: reports progress and anomalies
 *
 * Records missing both startTime and date are reported but not assigned fabricated dates.
 *
 * CLI Safety:
 * - --dry-run: inspect intended changes without modifying data
 * - --execute: perform the migration and write to database
 * - no flag: refuse to run (display usage)
 */

import { MongoClient, Db, Collection } from 'mongodb';
import { config } from '../config/env';

/** CLI execution mode */
export type MigrationMode = 'dry-run' | 'execute' | 'none';

/**
 * Parse CLI arguments to determine execution mode.
 * Exported for testing.
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
  totalExamined: number;
  documentsChanged: number;
  documentsUnchanged: number;
  statusPopulated: number;
  templatePopulated: number;
  datePopulated: number;
  skippedMissingStartTime: string[]; // document IDs
  errors: Array<{ id: string; error: string }>;
}

/**
 * Determine the user's timezone from their settings document.
 * Falls back to 'America/Chicago' if no setting found.
 */
async function getUserTimezone(db: Db, userId: string): Promise<string> {
  const settings = await db.collection('settings').findOne({ userId });
  return (settings?.timezone as string) ?? 'America/Chicago';
}

/**
 * Derive the calendar date from a UTC timestamp in the given timezone.
 * Returns YYYY-MM-DD string.
 */
function deriveCalendarDate(startTime: Date, timezone: string): string {
  return startTime.toLocaleDateString('en-CA', { timeZone: timezone });
}

/**
 * Execute the PLAN-003 migration.
 *
 * Processes documents missing ANY of: status, template, date.
 * Establishes correct values without overwriting existing data.
 */
export async function runMigration(
  db: Db,
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const { dryRun = false } = options;
  const workouts: Collection = db.collection('workouts');

  const result: MigrationResult = {
    totalExamined: 0,
    documentsChanged: 0,
    documentsUnchanged: 0,
    statusPopulated: 0,
    templatePopulated: 0,
    datePopulated: 0,
    skippedMissingStartTime: [],
    errors: [],
  };

  // Cache user timezones to avoid repeated lookups
  const timezoneCache = new Map<string, string>();

  // Find documents missing at least one migration-managed field
  const cursor = workouts.find({
    $or: [
      { status: { $exists: false } },
      { template: { $exists: false } },
      { date: { $exists: false } },
    ],
  });

  for await (const doc of cursor) {
    result.totalExamined++;
    const docId = doc._id.toHexString();

    try {
      const $set: Record<string, unknown> = {};
      let needsUpdate = false;

      // Status: populate if absent
      if (doc.status === undefined || doc.status === null) {
        $set.status = 'completed';
        result.statusPopulated++;
        needsUpdate = true;
      }

      // Template: populate if absent
      if (doc.template === undefined || doc.template === null) {
        $set.template = false;
        result.templatePopulated++;
        needsUpdate = true;
      }

      // Date: populate if absent
      if (doc.date === undefined || doc.date === null) {
        if (doc.startTime) {
          // Get user timezone (cached)
          const userId = doc.userId as string;
          if (!timezoneCache.has(userId)) {
            timezoneCache.set(userId, await getUserTimezone(db, userId));
          }
          const timezone = timezoneCache.get(userId)!;

          const startTime = doc.startTime instanceof Date
            ? doc.startTime
            : new Date(doc.startTime as string);

          $set.date = deriveCalendarDate(startTime, timezone);
          result.datePopulated++;
          needsUpdate = true;
        } else {
          // No startTime and no existing date — cannot derive; report and skip date
          result.skippedMissingStartTime.push(docId);
          // Still populate status/template if needed, just not date
        }
      }

      if (!needsUpdate) {
        result.documentsUnchanged++;
        continue;
      }

      // Add updatedAt
      $set.updatedAt = new Date();

      if (dryRun) {
        result.documentsChanged++;
      } else {
        await workouts.updateOne({ _id: doc._id }, { $set });
        result.documentsChanged++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ id: docId, error: message });
    }
  }

  return result;
}

/**
 * CLI entry point for running the migration directly.
 *
 * Usage:
 *   npx ts-node src/migrations/003-backfill-status-template-date.ts --dry-run
 *   npx ts-node src/migrations/003-backfill-status-template-date.ts --execute
 *
 * --dry-run   Inspect/report intended changes without modifying data.
 * --execute   Perform the migration and modify data.
 * (no flag)   Refuse to execute and display usage.
 */
async function main(): Promise<void> {
  const mode = parseCliMode(process.argv);

  if (mode === 'none') {
    console.log('PLAN-003 Migration: Backfill status, template, date');
    console.log('');
    console.log('Usage:');
    console.log('  npx ts-node src/migrations/003-backfill-status-template-date.ts --dry-run');
    console.log('  npx ts-node src/migrations/003-backfill-status-template-date.ts --execute');
    console.log('');
    console.log('  --dry-run   Report intended changes without modifying data.');
    console.log('  --execute   Perform the migration and write to the database.');
    console.log('');
    console.log('Refusing to run without explicit mode. Specify --dry-run or --execute.');
    process.exit(1);
    return;
  }

  const dryRun = mode === 'dry-run';
  const mongoClient = new MongoClient(config.mongo.uri);

  try {
    console.log(`PLAN-003 Migration: Backfill status, template, date`);
    console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE (writes enabled)'}`);
    console.log(`Database: ${config.mongo.uri}`);
    console.log('---');

    await mongoClient.connect();
    const db = mongoClient.db();

    const result = await runMigration(db, { dryRun });

    console.log('\n--- Migration Report ---');
    console.log(`Total examined:          ${result.totalExamined}`);
    console.log(`Documents changed:       ${result.documentsChanged}`);
    console.log(`Documents unchanged:     ${result.documentsUnchanged}`);
    console.log(`Status populated:        ${result.statusPopulated}`);
    console.log(`Template populated:      ${result.templatePopulated}`);
    console.log(`Date populated:          ${result.datePopulated}`);
    console.log(`Skipped (no startTime):  ${result.skippedMissingStartTime.length}`);
    console.log(`Errors:                  ${result.errors.length}`);

    if (result.skippedMissingStartTime.length > 0) {
      console.log('\nRecords missing startTime (date not assigned):');
      result.skippedMissingStartTime.forEach(id => console.log(`  - ${id}`));
    }

    if (result.errors.length > 0) {
      console.log('\nErrors:');
      result.errors.forEach(({ id, error }) => console.log(`  - ${id}: ${error}`));
    }

    if (dryRun) {
      console.log('\n[DRY RUN] No documents were modified.');
    }

    process.exit(result.errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await mongoClient.close();
  }
}

// Run if executed directly (not imported as module)
if (require.main === module) {
  main();
}
