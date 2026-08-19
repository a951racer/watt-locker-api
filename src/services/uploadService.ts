/**
 * Upload service implementing the single file upload pipeline.
 * Pipeline: validate format → parse file → check duplicate → store in Drive → save to DB
 */

import { ParsedWorkout } from '../models/workout';
import { UploadResult, WorkoutSummary, BulkUploadResult, FailedUpload, IntakeResult } from '../models/upload';
import { ParserFactory } from '../parsers/parserFactory';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { ISourceArtifactRepository } from '../repositories/sourceArtifactRepository';
import { FileStorageAdapter, FileMetadata, GoogleDriveAdapter, GoogleDriveAdapterConfig } from '../storage/googleDriveAdapter';
import { ISettingsService } from './settingsService';
import { ValidationError, ConflictError } from '../utils/errors';
import { WorkoutRecord } from '../models/workout';
import { config } from '../config/env';
import { extractArchive, shouldExtractArchive } from '../utils/archiveExtractor';
import { lookupFtp } from '../utils/ftpLookup';
import { computeMaxPowers } from '../utils/powerCurve';

/** Options for single file upload */
export interface UploadOptions {
  dataSource?: 'manual' | 'strava' | 'trainingpeaks' | 'garmin';
  sourceActivityId?: string;
}

/** Input for bulk upload */
export interface FileInput {
  buffer: Buffer;
  fileName: string;
}

/** Options for bulk upload */
export interface BulkUploadOptions {
  dataSource?: 'manual' | 'strava' | 'trainingpeaks' | 'garmin';
}

/** Upload service interface */
export interface IUploadService {
  uploadFile(
    file: Buffer,
    fileName: string,
    userId: string,
    options?: UploadOptions,
  ): Promise<BulkUploadResult>;
  uploadSingle(
    file: Buffer,
    fileName: string,
    userId: string,
    options?: UploadOptions,
  ): Promise<UploadResult>;
  uploadBulk(
    files: FileInput[],
    userId: string,
    options?: BulkUploadOptions,
  ): Promise<BulkUploadResult>;
  ingestFromInbox(userId: string): Promise<BulkUploadResult>;
  intakeUpload(
    file: Buffer,
    fileName: string,
    userId: string,
    options?: UploadOptions,
  ): Promise<IntakeResult>;
  materializeActivity(
    activityId: string,
    userId: string,
    fileBuffer: Buffer,
    fileName: string,
    artifactId: string,
  ): Promise<void>;
  clearActivityMaterialization(activityId: string, userId: string): Promise<void>;
}

/** Logger interface for dependency injection */
export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}

/** Default console logger */
const defaultLogger: Logger = {
  warn: (message, meta) => console.warn(message, meta),
  error: (message, meta) => console.error(message, meta),
  info: (message, meta) => console.info(message, meta),
};

/**
 * Upload service that orchestrates the file upload pipeline.
 */
export class UploadService implements IUploadService {
  constructor(
    private readonly parserFactory: ParserFactory,
    private readonly workoutRepository: IWorkoutRepository,
    private readonly fileStorageAdapter: FileStorageAdapter,
    private readonly settingsService: ISettingsService,
    private readonly logger: Logger = defaultLogger,
    private readonly sourceArtifactRepository?: ISourceArtifactRepository,
  ) {}

  /**
   * Create a per-user Google Drive adapter from their stored OAuth token.
   * Returns null if the user hasn't connected Google Drive.
   */
  private async getUserDriveAdapter(userId: string): Promise<FileStorageAdapter | null> {
    try {
      const settings = await this.settingsService.getSettings(userId);
      const gdriveSource = settings.connectedSources?.find(
        (s) => s.oauthTokenEncrypted?.startsWith('gdrive:')
      );

      if (!gdriveSource?.oauthTokenEncrypted) {
        return null;
      }

      // Extract and decrypt the refresh token
      // Format: "gdrive:enc:<base64>"
      const encryptedPart = gdriveSource.oauthTokenEncrypted.replace('gdrive:', '');
      const base64Token = encryptedPart.replace('enc:', '');
      const refreshToken = Buffer.from(base64Token, 'base64').toString('utf-8');

      const adapterConfig: GoogleDriveAdapterConfig = {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri: config.google.redirectUri,
        tokens: {
          accessToken: '', // Will be refreshed automatically
          refreshToken,
        },
        basePath: settings.driveStoragePath || 'WattLocker',
      };

      return new GoogleDriveAdapter(adapterConfig);
    } catch (err) {
      this.logger.warn('Failed to create user Drive adapter', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Upload a file that may be an archive or a single workout file.
   * If it's an archive (.zip, .gz), extracts workout files and processes each.
   * If it's a single workout file, processes it directly.
   * Returns a BulkUploadResult for archives, or wraps single result.
   */
  async uploadFile(
    file: Buffer,
    fileName: string,
    userId: string,
    options?: UploadOptions,
  ): Promise<BulkUploadResult> {
    if (shouldExtractArchive(fileName)) {
      const extractedFiles = extractArchive(file, fileName);
      this.logger.info('Archive extracted', {
        fileName,
        filesFound: extractedFiles.length,
      });

      if (extractedFiles.length === 0) {
        return { total: 0, successful: [], failed: [{ fileName, error: 'No workout files found in archive', errorCode: 'NO_WORKOUT_FILES' }], inProgress: 0 };
      }

      return this.uploadBulk(
        extractedFiles.map((f) => ({ buffer: f.buffer, fileName: f.fileName })),
        userId,
        { dataSource: options?.dataSource },
      );
    }

    // Single file — wrap in bulk result
    try {
      const result = await this.uploadSingle(file, fileName, userId, options);
      return { total: 1, successful: [result], failed: [], inProgress: 0 };
    } catch (error) {
      return {
        total: 1,
        successful: [],
        failed: [{ fileName, error: error instanceof Error ? error.message : String(error), errorCode: this.getErrorCode(error) }],
        inProgress: 0,
      };
    }
  }

  /**
   * Upload a single workout file through the full pipeline:
   * 1. Validate file format (via ParserFactory)
   * 2. Intake: store file, create SourceArtifact, detect duplicates, match planned activities
   * 3. Materialize: parse metrics and populate the matched/new activity
   *
   * When a SourceArtifact repository is available, uses the intake+materialize pipeline
   * which supports planned activity matching and preserves planned values.
   * Falls back to the legacy create-new-activity path otherwise.
   */
  async uploadSingle(
    file: Buffer,
    fileName: string,
    userId: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    // Use the intake+materialize pipeline when SourceArtifact repository is available
    if (this.sourceArtifactRepository) {
      return this.uploadWithMatching(file, fileName, userId, options);
    }

    // Legacy path: always creates a new completed activity (no matching)
    return this.uploadLegacy(file, fileName, userId, options);
  }

  /**
   * New ingestion pipeline with planned-activity matching.
   * 1. Intake (store file, create artifact, detect duplicates, match planned activities)
   * 2. Materialize (full parse + metrics onto matched or new activity)
   */
  private async uploadWithMatching(
    file: Buffer,
    fileName: string,
    userId: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    // Step 1: Intake — creates SourceArtifact, detects duplicates, matches planned activities
    const intake = await this.intakeUpload(file, fileName, userId, options);

    // Step 2: Handle duplicate — source file already archived
    if (intake.duplicate) {
      // Already imported — do not create anything new
      return {
        workoutId: intake.activityId || '',
        driveFileId: intake.driveFileId,
        summary: {
          activityType: intake.activityType || 'ride',
          startTime: intake.startTime || new Date(),
          durationSeconds: intake.durationSeconds || 0,
          distanceMeters: 0,
        },
        matchedExisting: !!intake.activityId,
        duplicate: true,
      };
    }

    // Step 3: If matched to an existing planned activity, materialize onto it
    if (intake.matched && intake.activityId) {
      await this.materializeActivity(intake.activityId, userId, file, fileName, intake.artifactId);
      return {
        workoutId: intake.activityId,
        driveFileId: intake.driveFileId,
        summary: {
          activityType: intake.activityType || 'ride',
          startTime: intake.startTime || new Date(),
          durationSeconds: intake.durationSeconds || 0,
          distanceMeters: 0,
        },
        matchedExisting: true,
      };
    }

    // Step 4: No match — create a new completed activity and materialize onto it
    const fileExtension = this.extractExtension(fileName);
    const parser = this.parserFactory.getParser(fileExtension);
    const parsedWorkout: ParsedWorkout = await parser.parse(file);

    // Derive calendar date
    const settings = await this.settingsService.getSettings(userId);
    const userTimezone = settings.timezone ?? 'America/Chicago';
    const activityDate = parsedWorkout.summary.startTime.toLocaleDateString('en-CA', { timeZone: userTimezone });

    // Create a minimal new activity
    const newActivity = await this.workoutRepository.create({
      userId,
      status: 'completed',
      template: false,
      date: activityDate,
      activityType: parsedWorkout.summary.activityType,
      dataSource: options?.dataSource ?? 'manual',
    } as WorkoutRecord);

    // Associate the artifact with the new activity
    await this.sourceArtifactRepository!.update(intake.artifactId, {
      activityId: newActivity.id,
    });

    // Materialize full workout data onto the new activity
    await this.materializeActivity(newActivity.id, userId, file, fileName, intake.artifactId);

    return {
      workoutId: newActivity.id,
      driveFileId: intake.driveFileId,
      summary: this.buildSummary(parsedWorkout),
      matchedExisting: false,
    };
  }

  /**
   * Legacy upload path — always creates a new completed activity.
   * Used when SourceArtifact repository is not available.
   */
  private async uploadLegacy(
    file: Buffer,
    fileName: string,
    userId: string,
    options?: UploadOptions,
  ): Promise<UploadResult> {
    // 1. Validate format — throws ValidationError if unsupported
    const fileExtension = this.extractExtension(fileName);
    const parser = this.parserFactory.getParser(fileExtension);

    // 2. Parse file
    const parsedWorkout: ParsedWorkout = await parser.parse(file);

    // 3. Check for duplicates
    const duplicate = await this.workoutRepository.findDuplicate(
      userId,
      parsedWorkout.summary.startTime,
      parsedWorkout.summary.durationSeconds,
    );

    if (duplicate) {
      throw new ConflictError(
        `Duplicate workout detected: a workout with the same start time and duration already exists (id: ${duplicate.id})`,
        { details: { existingWorkoutId: duplicate.id } },
      );
    }

    // 4. Store raw file in Google Drive (use per-user adapter if available)
    const mimeType = this.getMimeType(fileExtension);

    const fileMetadata: FileMetadata = {
      fileName,
      mimeType,
      workoutDate: parsedWorkout.summary.startTime,
      dataSource: options?.dataSource ?? 'manual',
    };

    let storageRef: { fileId: string; webViewLink?: string; folderPath?: string };
    const userDriveAdapter = await this.getUserDriveAdapter(userId);
    const adapter = userDriveAdapter ?? this.fileStorageAdapter;

    this.logger.info('Drive upload attempt', {
      userId,
      fileName,
      hasUserAdapter: !!userDriveAdapter,
    });

    try {
      storageRef = await adapter.store(file, fileMetadata);
      this.logger.info('Drive upload succeeded', { userId, fileName, fileId: storageRef.fileId });
    } catch (err) {
      // Drive not configured or failed — proceed without file storage
      this.logger.warn('Drive storage skipped', {
        userId,
        fileName,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      storageRef = { fileId: 'local', webViewLink: undefined, folderPath: undefined };
    }

    // 5. Save workout record + metrics to DB
    // If DB write fails after Drive upload, log the orphaned file
    try {
      const workoutRecord = await this.createWorkoutRecord(
        userId,
        parsedWorkout,
        storageRef.fileId,
        storageRef.webViewLink,
        options,
      );

      // Insert time-series metrics
      if (parsedWorkout.dataPoints.length > 0) {
        await this.workoutRepository.insertMetrics(workoutRecord.id, parsedWorkout.dataPoints);
      }

      return {
        workoutId: workoutRecord.id,
        driveFileId: storageRef.fileId,
        summary: this.buildSummary(parsedWorkout),
      };
    } catch (error) {
      // Log orphaned Drive file for cleanup
      this.logger.error('DB write failed after successful Drive upload. Orphaned file detected.', {
        driveFileId: storageRef.fileId,
        fileName,
        userId,
        folderPath: storageRef.folderPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * PLAN-021: Intake upload — lightweight source file ingestion.
   * Validates → uploads to Drive → light parses → creates SourceArtifact.
   * Does NOT perform full materialization, dedup, or Activity matching.
   */
  async intakeUpload(
    file: Buffer,
    fileName: string,
    userId: string,
    options?: UploadOptions,
  ): Promise<IntakeResult> {
    if (!this.sourceArtifactRepository) {
      throw new ValidationError('Intake upload is not configured (missing source artifact repository)');
    }

    // 1. Validate format
    const fileExtension = this.extractExtension(fileName);
    const parser = this.parserFactory.getParser(fileExtension);

    // 2. Store file in Drive FIRST (before SourceArtifact creation)
    const mimeType = this.getMimeType(fileExtension);
    const fileMetadata: FileMetadata = {
      fileName,
      mimeType,
      workoutDate: new Date(), // Placeholder — real date from light parse
      dataSource: options?.dataSource ?? 'manual',
    };

    const userDriveAdapter = await this.getUserDriveAdapter(userId);
    const adapter = userDriveAdapter ?? this.fileStorageAdapter;

    let storageRef: { fileId: string; webViewLink?: string };
    let fileContentFallback: Buffer | undefined;
    try {
      storageRef = await adapter.store(file, fileMetadata);
      this.logger.info('Drive storage succeeded during intake', { userId, fileName, fileId: storageRef.fileId });
    } catch (err) {
      // Drive not configured or failed — store binary in MongoDB as fallback
      const driveConfigured = !!userDriveAdapter;
      if (driveConfigured) {
        this.logger.warn('Drive storage failed; using MongoDB source fallback', {
          userId, fileName, error: err instanceof Error ? err.message : String(err),
        });
      } else {
        this.logger.info('Drive not configured; using MongoDB source fallback', { userId, fileName });
      }
      storageRef = { fileId: 'local', webViewLink: undefined };
      fileContentFallback = file;
    }

    // 3. Light parse — extract only startTime, durationSeconds, activityType
    let startTime: Date | undefined;
    let durationSeconds: number | undefined;
    let activityType: string | undefined;

    try {
      if (parser.parseLightMetadata) {
        const meta = await parser.parseLightMetadata(file);
        startTime = meta.startTime;
        durationSeconds = meta.durationSeconds;
        activityType = meta.activityType;
      } else {
        // Fallback: full parse but only use summary (for parsers without light method)
        const parsed = await parser.parse(file);
        startTime = parsed.summary.startTime;
        durationSeconds = parsed.summary.durationSeconds;
        activityType = parsed.summary.activityType;
      }
    } catch {
      // Light parse failure: proceed without metadata (file is already stored)
      this.logger.warn('Light parse failed during intake', { userId, fileName });
    }

    // 4. PLAN-022: Duplicate detection — check BEFORE creating SourceArtifact
    if (startTime && durationSeconds != null) {
      const existing = await this.sourceArtifactRepository.findDuplicateCandidate(userId, startTime, durationSeconds);
      if (existing) {
        // Already imported — do not create another artifact
        this.logger.info('Duplicate source file detected during intake', {
          userId, fileName, existingArtifactId: existing.id, existingActivityId: existing.activityId,
        });
        return {
          artifactId: existing.id,
          driveFileId: existing.driveFileId,
          originalFileName: fileName,
          startTime,
          durationSeconds,
          activityType,
          duplicate: true,
          matched: false,
          activityId: existing.activityId,
          role: 'secondary',
          materialized: existing.materialized,
        };
      }
    }

    // 5. Create SourceArtifact (only for genuinely new source files)
    const artifact = await this.sourceArtifactRepository.create({
      userId,
      activityId: null,
      role: 'primary',
      materialized: false,
      source: (options?.dataSource ?? 'manual') as 'manual' | 'strava' | 'garmin' | 'trainingpeaks',
      format: fileExtension as 'fit' | 'tcx' | 'gpx',
      originalFileName: fileName,
      importedAt: new Date(),
      driveFileId: storageRef.fileId,
      driveWebViewLink: storageRef.webViewLink,
      fileContent: fileContentFallback,
      startTime,
      durationSeconds,
      activityType,
    });

    // 6. PLAN-023: Activity matching (only for non-duplicates with startTime)
    let isMatched = false;
    let finalActivityId: string | null = null;
    if (startTime) {
      // Derive candidateDate from startTime in user's timezone
      const settings = await this.settingsService.getSettings(userId);
      const candidateDate = startTime.toLocaleDateString('en-CA', { timeZone: settings.timezone });

      // Query planned Activities for that date and activityType
      const candidates = await this.workoutRepository.findPlannedCandidates(userId, candidateDate, activityType);

      if (candidates.length > 0) {
        // Single or multiple: pick first by creation order (sorted by createdAt ASC in repository)
        const matched = candidates[0];
        finalActivityId = matched.id;
        isMatched = true;
        await this.sourceArtifactRepository.update(artifact.id, {
          activityId: matched.id,
        });
      }
    }

    return {
      artifactId: artifact.id,
      driveFileId: storageRef.fileId,
      originalFileName: fileName,
      startTime,
      durationSeconds,
      activityType,
      duplicate: false,
      matched: isMatched,
      activityId: finalActivityId,
      role: 'primary' as const,
      materialized: false,
    };
  }

  /**
   * Upload multiple files, processing each independently.
   * Individual failures do not abort the batch.
   */
  async uploadBulk(
    files: FileInput[],
    userId: string,
    options?: BulkUploadOptions,
  ): Promise<BulkUploadResult> {
    const successful: UploadResult[] = [];
    const failed: FailedUpload[] = [];

    // Expand any archives in the file list
    const expandedFiles: FileInput[] = [];
    for (const fileInput of files) {
      if (shouldExtractArchive(fileInput.fileName)) {
        const extracted = extractArchive(fileInput.buffer, fileInput.fileName);
        this.logger.info('Archive extracted in bulk', {
          fileName: fileInput.fileName,
          filesFound: extracted.length,
        });
        expandedFiles.push(...extracted.map((f) => ({ buffer: f.buffer, fileName: f.fileName })));
      } else {
        expandedFiles.push(fileInput);
      }
    }

    for (const fileInput of expandedFiles) {
      try {
        const result = await this.uploadSingle(fileInput.buffer, fileInput.fileName, userId, {
          dataSource: options?.dataSource,
        });
        successful.push(result);
      } catch (error) {
        failed.push({
          fileName: fileInput.fileName,
          error: error instanceof Error ? error.message : String(error),
          errorCode: this.getErrorCode(error),
        });
      }
    }

    return {
      total: expandedFiles.length,
      successful,
      failed,
      inProgress: 0,
    };
  }

  /**
   * Ingest files from the user's Google Drive inbox folder.
   * Successfully processed files are removed from inbox.
   * Failed files remain in inbox for retry.
   */
  async ingestFromInbox(userId: string): Promise<BulkUploadResult> {
    const settings = await this.settingsService.getSettings(userId);

    // Use per-user Drive adapter for inbox access
    const userDriveAdapter = await this.getUserDriveAdapter(userId);
    const adapter = userDriveAdapter ?? this.fileStorageAdapter;

    const inboxFiles = await adapter.listFiles(settings.driveInboxPath);

    this.logger.info('Inbox ingestion started', {
      userId,
      inboxPath: settings.driveInboxPath,
      filesFound: inboxFiles.length,
    });

    const successful: UploadResult[] = [];
    const failed: FailedUpload[] = [];

    for (const fileRef of inboxFiles) {
      try {
        const fileBuffer = await adapter.retrieve(fileRef);

        if (shouldExtractArchive(fileRef.fileName)) {
          // Archive file — extract and process each workout
          const extracted = extractArchive(fileBuffer, fileRef.fileName);
          this.logger.info('Inbox archive extracted', {
            fileName: fileRef.fileName,
            filesFound: extracted.length,
          });
          for (const extractedFile of extracted) {
            try {
              const result = await this.uploadSingle(extractedFile.buffer, extractedFile.fileName, userId);
              successful.push(result);
            } catch (error) {
              failed.push({
                fileName: extractedFile.fileName,
                error: error instanceof Error ? error.message : String(error),
                errorCode: this.getErrorCode(error),
              });
            }
          }
        } else {
          const result = await this.uploadSingle(fileBuffer, fileRef.fileName, userId);
          successful.push(result);
        }

        // Remove successfully processed file from inbox
        await adapter.removeFromFolder(fileRef);
      } catch (error) {
        failed.push({
          fileName: fileRef.fileName,
          error: error instanceof Error ? error.message : String(error),
          errorCode: this.getErrorCode(error),
        });
      }
    }

    return {
      total: inboxFiles.length,
      successful,
      failed,
      inProgress: 0,
    };
  }

  /**
   * PLAN-024: Materialize an Activity from a source file.
   * Parses the file, computes all metrics, and updates the existing Activity
   * with actual values while preserving any planned values.
   */
  async materializeActivity(
    activityId: string,
    userId: string,
    fileBuffer: Buffer,
    fileName: string,
    artifactId: string,
  ): Promise<void> {
    // 1. Parse the file
    const fileExtension = this.extractExtension(fileName);
    const parser = this.parserFactory.getParser(fileExtension);
    const parsedWorkout: ParsedWorkout = await parser.parse(fileBuffer);

    // 2. Compute all metrics
    const avgPower = this.computeAverage(parsedWorkout.dataPoints, 'powerWatts');
    const maxPower = this.computeMax(parsedWorkout.dataPoints, 'powerWatts');
    const normalizedPower = parsedWorkout.summary.normalizedPowerWatts ?? this.computeNormalizedPower(parsedWorkout.dataPoints);

    const settings = await this.settingsService.getSettings(userId);
    const ftpUsed = lookupFtp(parsedWorkout.summary.startTime, settings.ftpHistory, parsedWorkout.summary.ftpWatts);

    const ftpFromHistory = settings.ftpHistory && settings.ftpHistory.length > 0 &&
      [...settings.ftpHistory].some(e => new Date(e.effectiveDate).getTime() <= parsedWorkout.summary.startTime.getTime());
    const tss = ftpFromHistory
      ? this.computeTSS(normalizedPower, parsedWorkout.summary.movingTimeSeconds ?? parsedWorkout.summary.durationSeconds, ftpUsed)
      : (parsedWorkout.summary.tss ?? this.computeTSS(normalizedPower, parsedWorkout.summary.movingTimeSeconds ?? parsedWorkout.summary.durationSeconds, ftpUsed));
    const intensityFactor = normalizedPower ? Math.round((normalizedPower / ftpUsed) * 1000) / 1000 : undefined;
    const aerobicDecoupling = this.computeAerobicDecoupling(parsedWorkout.dataPoints);
    const avgHr = this.computeAverage(parsedWorkout.dataPoints, 'heartRateBpm');
    const maxHr = this.computeMax(parsedWorkout.dataPoints, 'heartRateBpm');
    const avgCadence = this.computeAverage(parsedWorkout.dataPoints, 'cadenceRpm');
    const avgSpeed = this.computeAvgSpeed(parsedWorkout.summary.distanceMeters, parsedWorkout.summary.movingTimeSeconds, parsedWorkout.summary.durationSeconds);

    const powerValues = parsedWorkout.dataPoints
      .map(dp => dp.powerWatts)
      .filter((v): v is number => v != null);
    const maxPowers = powerValues.length >= 5 ? computeMaxPowers(powerValues) : undefined;

    // 3. Derive Activity.date from startTime + user timezone
    const userTimezone = settings.timezone ?? 'America/Chicago';
    const activityDate = parsedWorkout.summary.startTime.toLocaleDateString('en-CA', { timeZone: userTimezone });

    // 4. Update the Activity with actual values while PRESERVING planned values
    // Use a targeted $set that only sets actual/derived fields
    const $set: Record<string, unknown> = {
      status: 'completed',
      date: activityDate,
      activityType: parsedWorkout.summary.activityType,
      startTime: parsedWorkout.summary.startTime,
      endTime: parsedWorkout.summary.endTime,
      durationSeconds: parsedWorkout.summary.durationSeconds,
      distanceMeters: parsedWorkout.summary.distanceMeters,
      elevationGainMeters: parsedWorkout.summary.elevationGainMeters,
      fileFormat: parsedWorkout.sourceFormat,
      updatedAt: new Date(),
    };

    // Optional actual fields
    if (parsedWorkout.summary.subActivityType !== undefined) $set.subActivityType = parsedWorkout.summary.subActivityType;
    if (parsedWorkout.summary.movingTimeSeconds !== undefined) $set.movingTimeSeconds = parsedWorkout.summary.movingTimeSeconds;
    if (parsedWorkout.summary.elevationLossMeters !== undefined) $set.elevationLossMeters = parsedWorkout.summary.elevationLossMeters;
    if (parsedWorkout.summary.calories !== undefined) $set.calories = parsedWorkout.summary.calories;
    if (parsedWorkout.summary.avgTemperatureCelsius !== undefined) $set.avgTemperatureCelsius = parsedWorkout.summary.avgTemperatureCelsius;
    if (parsedWorkout.summary.maxTemperatureCelsius !== undefined) $set.maxTemperatureCelsius = parsedWorkout.summary.maxTemperatureCelsius;
    if (parsedWorkout.summary.totalWorkKj !== undefined) $set.totalWorkKj = parsedWorkout.summary.totalWorkKj;
    if (parsedWorkout.summary.maxCadenceRpm !== undefined) $set.maxCadenceRpm = parsedWorkout.summary.maxCadenceRpm;
    if (parsedWorkout.summary.totalPedalRevolutions !== undefined) $set.totalPedalRevolutions = parsedWorkout.summary.totalPedalRevolutions;
    if (parsedWorkout.summary.maxSpeedMps !== undefined) $set.maxSpeedMps = parsedWorkout.summary.maxSpeedMps;
    if (parsedWorkout.summary.aerobicTrainingEffect !== undefined) $set.aerobicTrainingEffect = parsedWorkout.summary.aerobicTrainingEffect;
    if (parsedWorkout.summary.anaerobicTrainingEffect !== undefined) $set.anaerobicTrainingEffect = parsedWorkout.summary.anaerobicTrainingEffect;
    if (avgPower !== undefined) $set.avgPowerWatts = avgPower;
    if (maxPower !== undefined) $set.maxPowerWatts = maxPower;
    if (normalizedPower !== undefined) $set.normalizedPowerWatts = normalizedPower;
    if (tss !== undefined) $set.tss = tss;
    if (intensityFactor !== undefined) $set.intensityFactor = intensityFactor;
    if (normalizedPower !== undefined) $set.ftpUsed = ftpUsed;
    if (aerobicDecoupling !== undefined) $set.aerobicDecoupling = aerobicDecoupling;
    if (maxPowers !== undefined) $set.maxPowers = maxPowers;
    if (avgHr !== undefined) $set.avgHeartRateBpm = avgHr;
    if (maxHr !== undefined) $set.maxHeartRateBpm = maxHr;
    if (avgCadence !== undefined) $set.avgCadenceRpm = avgCadence;
    if (avgSpeed !== undefined) $set.avgSpeedMps = avgSpeed;

    // Directly update via the workouts collection to avoid overwriting planned fields
    // The repository.update method only sets known fields — we need raw access
    // Use findOneAndUpdate through the repository's update method won't work here
    // because it doesn't support all these fields. We'll use a raw-style update.
    // However, IWorkoutRepository doesn't expose raw $set — we'll add a method or use update.
    // The simplest approach: use the existing update which accepts Partial<WorkoutMetadata> | ActivityUpdateFields
    // But that won't cover all fields. We need to use the workoutRepository directly.
    // Since MongoWorkoutRepository's update does not cover all actual fields (power metrics etc.),
    // we'll chain updateStatus + updatePowerMetrics + updateMaxPowers + a general update.
    // Actually, looking at the create method — it accepts a full WorkoutRecord.
    // The cleanest approach: add a materialize-specific update or use findOneAndUpdate directly.
    // For now, let's use the combination approach that leverages existing interface methods.

    // Load existing activity to preserve planned values (verify it exists)
    const existing = await this.workoutRepository.findById(activityId);
    if (!existing) {
      throw new ValidationError(`Activity not found: ${activityId}`);
    }

    // Build a minimal update using updateStatus + updatePowerMetrics + updateMaxPowers
    // plus the general update for metadata fields.
    // Actually we need a raw update — let's extend IWorkoutRepository with materializeUpdate.
    // Instead, let's use the fact that MongoWorkoutRepository has access to the collection.
    // The pragmatic solution: call multiple repository methods in sequence.

    // Step A: Update status
    await this.workoutRepository.updateStatus(activityId, 'completed');

    // Step B: Update power metrics
    if (tss !== undefined || intensityFactor !== undefined) {
      await this.workoutRepository.updatePowerMetrics(activityId, { tss, intensityFactor, ftpUsed });
    }

    // Step C: Update max powers
    if (maxPowers !== undefined) {
      await this.workoutRepository.updateMaxPowers(activityId, maxPowers);
    }

    // Step D: Update avg speed
    if (avgSpeed !== undefined) {
      await this.workoutRepository.updateAvgSpeed(activityId, avgSpeed);
    }

    // Step E: For remaining actual fields, use the general update with a comprehensive $set
    // We'll use the raw-update approach via a new repository method: materializeUpdate
    await this.workoutRepository.materializeUpdate(activityId, $set);

    // 5. Replace metric observations (delete old, insert new)
    await this.workoutRepository.deleteMetrics(activityId);
    if (parsedWorkout.dataPoints.length > 0) {
      await this.workoutRepository.insertMetrics(activityId, parsedWorkout.dataPoints);
    }

    // 6. Mark the SourceArtifact as materialized=true
    if (this.sourceArtifactRepository) {
      await this.sourceArtifactRepository.update(artifactId, { materialized: true });
    }
  }

  /**
   * PLAN-024: Clear materialized data from an Activity.
   * Removes actual/derived fields and metric observations.
   * Preserves planned values and metadata.
   */
  async clearActivityMaterialization(activityId: string, userId: string): Promise<void> {
    const activity = await this.workoutRepository.findById(activityId);
    if (!activity) {
      throw new ValidationError(`Activity not found: ${activityId}`);
    }

    if (activity.userId !== userId) {
      throw new ValidationError(`Activity not found: ${activityId}`);
    }

    // Determine new status
    const hasPlannedValues = !!(activity.plannedDurationSeconds || activity.plannedTss);
    const newStatus = hasPlannedValues ? 'planned' : 'completed';

    // Clear actual/derived fields via materializeUpdate with null/$unset approach
    const clearFields: Record<string, unknown> = {
      status: newStatus,
      startTime: null,
      endTime: null,
      durationSeconds: null,
      movingTimeSeconds: null,
      distanceMeters: null,
      elevationGainMeters: null,
      elevationLossMeters: null,
      calories: null,
      avgTemperatureCelsius: null,
      maxTemperatureCelsius: null,
      avgPowerWatts: null,
      maxPowerWatts: null,
      normalizedPowerWatts: null,
      totalWorkKj: null,
      ftpWatts: null,
      ftpUsed: null,
      intensityFactor: null,
      tss: null,
      aerobicDecoupling: null,
      maxPowers: null,
      avgHeartRateBpm: null,
      maxHeartRateBpm: null,
      avgCadenceRpm: null,
      maxCadenceRpm: null,
      totalPedalRevolutions: null,
      avgSpeedMps: null,
      maxSpeedMps: null,
      aerobicTrainingEffect: null,
      anaerobicTrainingEffect: null,
      fileFormat: null,
      dataSource: null,
      sourceActivityId: null,
      driveFileId: null,
      driveWebViewLink: null,
      updatedAt: new Date(),
    };

    await this.workoutRepository.clearMaterialization(activityId, clearFields);

    // Remove metric observations
    await this.workoutRepository.deleteMetrics(activityId);
  }

  /** Extract file extension from filename (e.g., "ride.fit" → "fit") */
  private extractExtension(fileName: string): string {
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot === -1) {
      throw new ValidationError(`File has no extension: "${fileName}". Supported formats: fit, tcx, gpx`, {
        field: 'fileName',
      });
    }
    return fileName.substring(lastDot + 1).toLowerCase();
  }

  /** Map file extension to MIME type */
  private getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      fit: 'application/vnd.ant.fit',
      tcx: 'application/vnd.garmin.tcx+xml',
      gpx: 'application/gpx+xml',
    };
    return mimeTypes[extension] ?? 'application/octet-stream';
  }

  /** Create a WorkoutRecord from parsed data */
  private async createWorkoutRecord(
    userId: string,
    parsed: ParsedWorkout,
    driveFileId: string,
    driveWebViewLink?: string,
    options?: UploadOptions,
  ): Promise<WorkoutRecord> {
    const record: Omit<WorkoutRecord, 'id' | 'createdAt' | 'updatedAt'> = {
      userId,
      status: 'completed',
      template: false,
      date: '', // Placeholder — set below after settings/timezone are available
      activityType: parsed.summary.activityType,
      subActivityType: parsed.summary.subActivityType,
      title: parsed.summary.title,
      startTime: parsed.summary.startTime,
      endTime: parsed.summary.endTime,
      durationSeconds: parsed.summary.durationSeconds,
      movingTimeSeconds: parsed.summary.movingTimeSeconds,
      distanceMeters: parsed.summary.distanceMeters,
      elevationGainMeters: parsed.summary.elevationGainMeters,
      elevationLossMeters: parsed.summary.elevationLossMeters,
      calories: parsed.summary.calories,
      avgTemperatureCelsius: parsed.summary.avgTemperatureCelsius,
      maxTemperatureCelsius: parsed.summary.maxTemperatureCelsius,
      totalWorkKj: parsed.summary.totalWorkKj,
      ftpWatts: parsed.summary.ftpWatts,
      intensityFactor: parsed.summary.intensityFactor,
      maxCadenceRpm: parsed.summary.maxCadenceRpm,
      totalPedalRevolutions: parsed.summary.totalPedalRevolutions,
      maxSpeedMps: parsed.summary.maxSpeedMps,
      aerobicTrainingEffect: parsed.summary.aerobicTrainingEffect,
      anaerobicTrainingEffect: parsed.summary.anaerobicTrainingEffect,
      dataSource: options?.dataSource ?? 'manual',
      sourceActivityId: options?.sourceActivityId,
      fileFormat: parsed.sourceFormat,
      driveFileId,
      driveWebViewLink,
    };

    // Extract averages/peaks from data points if available
    const avgPower = this.computeAverage(parsed.dataPoints, 'powerWatts');
    const maxPower = this.computeMax(parsed.dataPoints, 'powerWatts');
    const normalizedPower = parsed.summary.normalizedPowerWatts ?? this.computeNormalizedPower(parsed.dataPoints);
    this.logger.info('NP computation', {
      totalDataPoints: parsed.dataPoints.length,
      pointsWithPower: parsed.dataPoints.filter(dp => dp.powerWatts != null).length,
      avgPower,
      maxPower,
      normalizedPower,
      source: parsed.summary.normalizedPowerWatts != null ? 'file' : 'computed',
    });

    // Look up FTP from user history, device, or default
    const settings = await this.settingsService.getSettings(userId);
    const ftpUsed = lookupFtp(parsed.summary.startTime, settings.ftpHistory, parsed.summary.ftpWatts);

    // If FTP came from user history, always recompute TSS (device TSS used wrong FTP).
    // Only trust file TSS when no user history covers this date.
    const ftpFromHistory = settings.ftpHistory && settings.ftpHistory.length > 0 &&
      [...settings.ftpHistory].some(e => new Date(e.effectiveDate).getTime() <= parsed.summary.startTime.getTime());
    const tss = ftpFromHistory
      ? this.computeTSS(normalizedPower, parsed.summary.movingTimeSeconds ?? parsed.summary.durationSeconds, ftpUsed)
      : (parsed.summary.tss ?? this.computeTSS(normalizedPower, parsed.summary.movingTimeSeconds ?? parsed.summary.durationSeconds, ftpUsed));
    const intensityFactor = normalizedPower ? Math.round((normalizedPower / ftpUsed) * 1000) / 1000 : undefined;
    const aerobicDecoupling = this.computeAerobicDecoupling(parsed.dataPoints);
    const avgHr = this.computeAverage(parsed.dataPoints, 'heartRateBpm');
    const maxHr = this.computeMax(parsed.dataPoints, 'heartRateBpm');
    const avgCadence = this.computeAverage(parsed.dataPoints, 'cadenceRpm');
    const avgSpeed = this.computeAvgSpeed(parsed.summary.distanceMeters, parsed.summary.movingTimeSeconds, parsed.summary.durationSeconds);

    // Compute max powers (power curve)
    const powerValues = parsed.dataPoints
      .map(dp => dp.powerWatts)
      .filter((v): v is number => v != null);
    const maxPowers = powerValues.length >= 5 ? computeMaxPowers(powerValues) : undefined;

    // Derive Activity calendar date using user's timezone
    const userTimezone = settings.timezone ?? 'America/Chicago';
    const activityDate = parsed.summary.startTime.toLocaleDateString('en-CA', { timeZone: userTimezone });

    const fullRecord = {
      ...record,
      date: activityDate,
      ...(avgPower !== undefined && { avgPowerWatts: avgPower }),
      ...(maxPower !== undefined && { maxPowerWatts: maxPower }),
      ...(normalizedPower !== undefined && { normalizedPowerWatts: normalizedPower }),
      ...(tss !== undefined && { tss }),
      ...(intensityFactor !== undefined && { intensityFactor }),
      ...(normalizedPower !== undefined && { ftpUsed }),
      ...(aerobicDecoupling !== undefined && { aerobicDecoupling }),
      ...(maxPowers !== undefined && { maxPowers }),
      ...(avgHr !== undefined && { avgHeartRateBpm: avgHr }),
      ...(maxHr !== undefined && { maxHeartRateBpm: maxHr }),
      ...(avgCadence !== undefined && { avgCadenceRpm: avgCadence }),
      ...(avgSpeed !== undefined && { avgSpeedMps: avgSpeed }),
    } as WorkoutRecord;

    return this.workoutRepository.create(fullRecord);
  }

  /** Build a WorkoutSummary from parsed data */
  private buildSummary(parsed: ParsedWorkout): WorkoutSummary {
    return {
      activityType: parsed.summary.activityType,
      startTime: parsed.summary.startTime,
      durationSeconds: parsed.summary.durationSeconds,
      distanceMeters: parsed.summary.distanceMeters,
    };
  }

  /** Compute average of a numeric field from data points (ignoring undefined) */
  private computeAverage(
    dataPoints: ParsedWorkout['dataPoints'],
    field: keyof ParsedWorkout['dataPoints'][0],
  ): number | undefined {
    const values = dataPoints
      .map((dp) => dp[field] as number | undefined)
      .filter((v): v is number => v !== undefined);

    if (values.length === 0) return undefined;
    return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
  }

  /**
   * Compute average speed from distance and time.
   * Uses moving time when available, falls back to elapsed duration.
   * Returns speed in m/s rounded to 2 decimal places.
   */
  private computeAvgSpeed(
    distanceMeters: number,
    movingTimeSeconds?: number,
    durationSeconds?: number,
  ): number | undefined {
    const timeSeconds = movingTimeSeconds ?? durationSeconds;
    if (!timeSeconds || timeSeconds <= 0 || !distanceMeters || distanceMeters <= 0) return undefined;
    return Math.round((distanceMeters / timeSeconds) * 100) / 100;
  }

  /** Compute max of a numeric field from data points (ignoring undefined) */
  private computeMax(
    dataPoints: ParsedWorkout['dataPoints'],
    field: keyof ParsedWorkout['dataPoints'][0],
  ): number | undefined {
    const values = dataPoints
      .map((dp) => dp[field] as number | undefined)
      .filter((v): v is number => v !== undefined);

    if (values.length === 0) return undefined;
    return Math.max(...values);
  }

  /**
   * Compute Normalized Power (NP) from time-series power data.
   * Algorithm: 30-second rolling average → raise to 4th power → average → 4th root.
   * Assumes ~1 second recording intervals between data points.
   */
  private computeNormalizedPower(dataPoints: ParsedWorkout['dataPoints']): number | undefined {
    const powerValues = dataPoints
      .map((dp) => dp.powerWatts)
      .filter((v): v is number => v !== undefined);

    // Need at least 30 seconds of data
    if (powerValues.length < 30) return undefined;

    // Step 1: Compute 30-second rolling averages
    const rollingAverages: number[] = [];
    for (let i = 29; i < powerValues.length; i++) {
      let sum = 0;
      for (let j = i - 29; j <= i; j++) {
        sum += powerValues[j];
      }
      rollingAverages.push(sum / 30);
    }

    if (rollingAverages.length === 0) return undefined;

    // Step 2: Raise each rolling average to the 4th power
    // Step 3: Average the 4th powers
    let sum4th = 0;
    for (const avg of rollingAverages) {
      sum4th += Math.pow(avg, 4);
    }
    const mean4th = sum4th / rollingAverages.length;

    // Step 4: Take the 4th root
    const np = Math.pow(mean4th, 0.25);

    return Math.round(np);
  }

  /**
   * Compute TSS (Training Stress Score).
   * TSS = (duration_s × NP × IF) / (FTP × 3600) × 100
   * where IF = NP / FTP
   * Simplified: TSS = (duration_s × NP²) / (FTP² × 3600) × 100
   */
  private computeTSS(
    normalizedPower: number | undefined,
    durationSeconds: number,
    ftp: number,
  ): number | undefined {
    if (!normalizedPower || durationSeconds <= 0) return undefined;

    const tss = (durationSeconds * Math.pow(normalizedPower, 2)) / (Math.pow(ftp, 2) * 3600) * 100;
    return Math.round(tss * 10) / 10;
  }

  /**
   * Compute Aerobic Decoupling (Pw:Hr).
   * Compares the power:HR ratio of the first half vs second half of the workout.
   * Formula: ((P1/HR1 - P2/HR2) / (P1/HR1)) × 100
   * A positive value means power:HR drifted down (cardiac drift / fatigue).
   * Requires both power and HR data for at least 60 data points.
   */
  private computeAerobicDecoupling(dataPoints: ParsedWorkout['dataPoints']): number | undefined {
    // Filter to points that have both power and HR
    const validPoints = dataPoints.filter(
      (dp) => dp.powerWatts != null && dp.heartRateBpm != null && dp.heartRateBpm > 0
    );

    if (validPoints.length < 60) return undefined;

    const midpoint = Math.floor(validPoints.length / 2);
    const firstHalf = validPoints.slice(0, midpoint);
    const secondHalf = validPoints.slice(midpoint);

    const avgPower1 = firstHalf.reduce((sum, dp) => sum + dp.powerWatts!, 0) / firstHalf.length;
    const avgHR1 = firstHalf.reduce((sum, dp) => sum + dp.heartRateBpm!, 0) / firstHalf.length;
    const avgPower2 = secondHalf.reduce((sum, dp) => sum + dp.powerWatts!, 0) / secondHalf.length;
    const avgHR2 = secondHalf.reduce((sum, dp) => sum + dp.heartRateBpm!, 0) / secondHalf.length;

    if (avgHR1 === 0 || avgHR2 === 0) return undefined;

    const ratio1 = avgPower1 / avgHR1;
    const ratio2 = avgPower2 / avgHR2;

    if (ratio1 === 0) return undefined;

    const decoupling = ((ratio1 - ratio2) / ratio1) * 100;
    return Math.round(decoupling * 100) / 100; // 2 decimal places
  }

  /** Get error code from an error instance */
  private getErrorCode(error: unknown): string {
    if (error && typeof error === 'object' && 'code' in error) {
      return (error as { code: string }).code;
    }
    return 'UNKNOWN_ERROR';
  }
}
