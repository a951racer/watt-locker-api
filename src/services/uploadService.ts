/**
 * Upload service implementing the single file upload pipeline.
 * Pipeline: validate format → parse file → check duplicate → store in Drive → save to DB
 */

import { ParsedWorkout } from '../models/workout';
import { UploadResult, WorkoutSummary, BulkUploadResult, FailedUpload } from '../models/upload';
import { ParserFactory } from '../parsers/parserFactory';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { FileStorageAdapter, FileMetadata, GoogleDriveAdapter, GoogleDriveAdapterConfig } from '../storage/googleDriveAdapter';
import { ISettingsService } from './settingsService';
import { ValidationError, ConflictError } from '../utils/errors';
import { WorkoutRecord } from '../models/workout';
import { config } from '../config/env';
import { extractArchive, shouldExtractArchive } from '../utils/archiveExtractor';
import { lookupFtp } from '../utils/ftpLookup';

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
   * 2. Parse file to get structured workout data
   * 3. Check for duplicates (same user, startTime, durationSeconds)
   * 4. Store raw file in Google Drive
   * 5. Save workout record + metrics to DB
   *
   * Transactional guarantee: if Drive upload succeeds but DB write fails,
   * the orphaned Drive file is logged for cleanup.
   */
  async uploadSingle(
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
    const avgSpeed = this.computeAverage(parsed.dataPoints, 'speedMps');

    const fullRecord = {
      ...record,
      ...(avgPower !== undefined && { avgPowerWatts: avgPower }),
      ...(maxPower !== undefined && { maxPowerWatts: maxPower }),
      ...(normalizedPower !== undefined && { normalizedPowerWatts: normalizedPower }),
      ...(tss !== undefined && { tss }),
      ...(intensityFactor !== undefined && { intensityFactor }),
      ...(normalizedPower !== undefined && { ftpUsed }),
      ...(aerobicDecoupling !== undefined && { aerobicDecoupling }),
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
