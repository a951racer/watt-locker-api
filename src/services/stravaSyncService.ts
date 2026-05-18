import { config } from '../config/env';
import { ISettingsService } from './settingsService';
import { IUploadService } from './uploadService';
import { IWorkoutRepository } from '../repositories/workoutRepository';
import { ConnectedSource } from '../models/settings';
import { BulkUploadResult, UploadResult, FailedUpload } from '../models/upload';
import { AuthenticationError, ValidationError } from '../utils/errors';
import { RateLimiter } from '../utils/rateLimiter';

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

/** Strava webhook event payload */
export interface StravaWebhookEvent {
  object_type: 'activity' | 'athlete';
  object_id: number;
  aspect_type: 'create' | 'update' | 'delete';
  owner_id: number;
  subscription_id: number;
  event_time: number;
}

/** Strava OAuth token response */
export interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete: {
    id: number;
  };
}

/** Strava activity download result */
export interface StravaActivityDownload {
  buffer: Buffer;
  fileName: string;
}

/** Strava activity summary from the list activities endpoint */
export interface StravaActivitySummary {
  id: number;
  name: string;
  type: string;
  start_date: string;
  elapsed_time: number;
  distance: number;
}

/** Interface for Strava HTTP client to enable testing with mocks */
export interface IStravaHttpClient {
  exchangeToken(code: string): Promise<StravaTokenResponse>;
  downloadActivity(activityId: string, accessToken: string): Promise<StravaActivityDownload>;
  listActivities(accessToken: string, page?: number, perPage?: number): Promise<StravaActivitySummary[]>;
}

/** StravaSyncService interface for Strava integration operations */
export interface IStravaSyncService {
  /** Handle incoming webhook event from Strava */
  handleWebhookEvent(event: StravaWebhookEvent): Promise<void>;

  /** Manually trigger sync of all missing activities */
  syncHistorical(userId: string): Promise<BulkUploadResult>;

  /** Register webhook subscription with Strava */
  registerWebhook(callbackUrl: string): Promise<void>;

  /** Validate webhook verification request */
  verifyWebhook(challenge: string, verifyToken: string): string;

  /** Initiate Strava OAuth flow — returns the authorization URL */
  getAuthorizationUrl(userId: string): string;

  /** Handle OAuth callback — exchange code for tokens and store them */
  handleOAuthCallback(code: string, userId: string): Promise<void>;
}

/**
 * Encrypt a token for storage. Uses base64 encoding with a marker prefix.
 * In production, replace with AES-256-GCM or similar symmetric encryption
 * using a server-side key from environment variables.
 */
export function encryptStravaToken(token: string): string {
  return `enc:${Buffer.from(token).toString('base64')}`;
}

/**
 * Decrypt a token from storage. Reverses the base64 encoding with marker prefix.
 * In production, replace with AES-256-GCM or similar symmetric decryption.
 */
export function decryptStravaToken(encrypted: string): string {
  if (!encrypted.startsWith('enc:')) {
    throw new AuthenticationError('Invalid encrypted token format');
  }
  return Buffer.from(encrypted.slice(4), 'base64').toString();
}

/** Stored token data structure for Strava OAuth tokens */
export interface StravaTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  athleteId: number;
}

/** Default Strava OAuth scopes */
const STRAVA_SCOPES = 'read,activity:read_all';

/** Strava OAuth authorization URL base */
const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';

/** Strava OAuth token URL */
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

/** Strava API base URL */
const STRAVA_API_BASE = 'https://www.strava.com/api/v3';

/**
 * Default Strava HTTP client implementation using fetch.
 */
export class StravaHttpClient implements IStravaHttpClient {
  async exchangeToken(code: string): Promise<StravaTokenResponse> {
    const response = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.strava.clientId,
        client_secret: config.strava.clientSecret,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      throw new AuthenticationError('Failed to exchange Strava authorization code for tokens');
    }

    return response.json() as Promise<StravaTokenResponse>;
  }

  /**
   * List athlete activities from Strava with pagination.
   */
  async listActivities(
    accessToken: string,
    page: number = 1,
    perPage: number = 50,
  ): Promise<StravaActivitySummary[]> {
    const url = `${STRAVA_API_BASE}/athlete/activities?page=${page}&per_page=${perPage}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new AuthenticationError('Strava authentication failed when listing activities');
      }
      throw new Error(`Failed to list Strava activities: HTTP ${status}`);
    }

    return response.json() as Promise<StravaActivitySummary[]>;
  }

  /**
   * Download the original workout file from Strava.
   * Uses the export_original endpoint which returns the file in its original format (FIT/TCX).
   */
  async downloadActivity(
    activityId: string,
    accessToken: string,
  ): Promise<StravaActivityDownload> {
    const url = `${STRAVA_API_BASE}/activities/${activityId}/export_original`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new AuthenticationError(
          `Strava authentication failed when downloading activity ${activityId}`,
        );
      }
      throw new Error(
        `Failed to download Strava activity ${activityId}: HTTP ${status}`,
      );
    }

    // Determine file name from Content-Disposition header or default to .fit
    const contentDisposition = response.headers.get('content-disposition') || '';
    let fileName = `strava_${activityId}.fit`;

    const filenameMatch = contentDisposition.match(/filename[*]?=["']?([^"';\s]+)/i);
    if (filenameMatch) {
      fileName = filenameMatch[1];
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return { buffer, fileName };
  }
}

export class StravaSyncService implements IStravaSyncService {
  private readonly logger: Logger;
  private readonly rateLimiter?: RateLimiter;

  constructor(
    private readonly settingsService: ISettingsService,
    private readonly stravaHttpClient: IStravaHttpClient = new StravaHttpClient(),
    private readonly workoutRepository?: IWorkoutRepository,
    private readonly uploadService?: IUploadService,
    logger?: Logger,
    rateLimiter?: RateLimiter,
  ) {
    this.logger = logger ?? defaultLogger;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Generate the Strava OAuth authorization URL.
   * Includes the userId in the state parameter for callback identification.
   */
  getAuthorizationUrl(userId: string): string {
    const params = new URLSearchParams({
      client_id: config.strava.clientId,
      redirect_uri: config.strava.redirectUri,
      response_type: 'code',
      scope: STRAVA_SCOPES,
      state: userId,
    });

    return `${STRAVA_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Handle the OAuth callback from Strava.
   * Exchanges the authorization code for access/refresh tokens,
   * encrypts them, and stores them in user settings.
   */
  async handleOAuthCallback(code: string, userId: string): Promise<void> {
    if (!code) {
      throw new ValidationError('Authorization code is required', { field: 'code' });
    }

    const tokenResponse = await this.stravaHttpClient.exchangeToken(code);

    const encryptedAccessToken = encryptStravaToken(tokenResponse.access_token);
    const encryptedRefreshToken = encryptStravaToken(tokenResponse.refresh_token);

    // Store both tokens as a JSON string, encrypted
    const tokenData = JSON.stringify({
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      expiresAt: tokenResponse.expires_at,
      athleteId: tokenResponse.athlete.id,
    });

    const encryptedTokenData = encryptStravaToken(tokenData);

    // Update user settings with the Strava connection
    const currentSettings = await this.settingsService.getSettings(userId);
    const existingSources = currentSettings.connectedSources || [];

    // Remove any existing Strava entry and add the new one
    const filteredSources: ConnectedSource[] = existingSources.filter(
      (s) => s.provider !== 'strava',
    );

    const stravaSource: ConnectedSource = {
      provider: 'strava',
      connected: true,
      connectedAt: new Date(),
      oauthTokenEncrypted: `strava:${encryptedTokenData}`,
    };

    await this.settingsService.updateSettings(userId, {
      connectedSources: [...filteredSources, stravaSource],
    });
  }

  /**
   * Validate webhook verification request from Strava.
   * Returns the challenge string if the verify token matches.
   */
  verifyWebhook(challenge: string, verifyToken: string): string {
    if (verifyToken !== config.strava.webhookVerifyToken) {
      throw new AuthenticationError('Invalid webhook verify token');
    }
    return challenge;
  }

  /**
   * Handle incoming webhook event from Strava.
   * Only processes 'activity' + 'create' events.
   * Checks for duplicates by sourceActivityId, then downloads and ingests.
   */
  async handleWebhookEvent(event: StravaWebhookEvent): Promise<void> {
    // Only process activity creation events
    if (event.object_type !== 'activity' || event.aspect_type !== 'create') {
      this.logger.info('Ignoring non-create activity webhook event', {
        object_type: event.object_type,
        aspect_type: event.aspect_type,
        object_id: event.object_id,
      });
      return;
    }

    const sourceActivityId = String(event.object_id);
    const ownerAthleteId = String(event.owner_id);

    this.logger.info('Processing Strava webhook event', {
      object_id: event.object_id,
      owner_id: event.owner_id,
      aspect_type: event.aspect_type,
    });

    // Check for duplicates using the workout repository
    if (!this.workoutRepository) {
      this.logger.warn('Workout repository not configured, skipping webhook event processing');
      return;
    }

    // Check if this activity has already been ingested
    const existingWorkout = await this.workoutRepository.findBySourceActivityId(
      ownerAthleteId,
      sourceActivityId,
    );

    if (existingWorkout) {
      this.logger.info('Skipping duplicate Strava activity', {
        sourceActivityId,
        existingWorkoutId: existingWorkout.id,
        ownerAthleteId,
      });
      return;
    }

    // Ensure upload service is available
    if (!this.uploadService) {
      this.logger.warn('Upload service not configured, skipping activity download', {
        sourceActivityId,
        ownerAthleteId,
      });
      return;
    }

    // Look up the user's Strava access token from settings
    let accessToken: string;
    try {
      accessToken = await this.getStravaAccessToken(ownerAthleteId);
    } catch (error) {
      this.logger.error('Failed to retrieve Strava access token for activity download', {
        sourceActivityId,
        ownerAthleteId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Download the original workout file from Strava
    this.logger.info('Downloading Strava activity', {
      sourceActivityId,
      ownerAthleteId,
    });

    let download: StravaActivityDownload;
    try {
      download = await this.stravaHttpClient.downloadActivity(sourceActivityId, accessToken);
    } catch (error) {
      this.logger.error('Failed to download Strava activity', {
        sourceActivityId,
        ownerAthleteId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Pass through the standard upload pipeline
    try {
      const result = await this.uploadService.uploadSingle(
        download.buffer,
        download.fileName,
        ownerAthleteId,
        {
          dataSource: 'strava',
          sourceActivityId,
        },
      );

      this.logger.info('Successfully ingested Strava activity', {
        sourceActivityId,
        ownerAthleteId,
        workoutId: result.workoutId,
        driveFileId: result.driveFileId,
      });
    } catch (error) {
      this.logger.error('Failed to ingest Strava activity through upload pipeline', {
        sourceActivityId,
        ownerAthleteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Retrieve the decrypted Strava access token for a given athlete ID.
   * Looks up the user's settings by athlete ID (using ownerAthleteId as userId
   * in the simplified approach) and decrypts the stored token.
   */
  private async getStravaAccessToken(ownerAthleteId: string): Promise<string> {
    const settings = await this.settingsService.getSettings(ownerAthleteId);

    const stravaSource = settings.connectedSources.find(
      (s) => s.provider === 'strava' && s.connected,
    );

    if (!stravaSource || !stravaSource.oauthTokenEncrypted) {
      throw new AuthenticationError(
        `No Strava connection found for athlete ${ownerAthleteId}`,
      );
    }

    // The token is stored as "strava:enc:<base64 of JSON with encrypted tokens>"
    const tokenPrefix = 'strava:';
    const encryptedPayload = stravaSource.oauthTokenEncrypted.startsWith(tokenPrefix)
      ? stravaSource.oauthTokenEncrypted.slice(tokenPrefix.length)
      : stravaSource.oauthTokenEncrypted;

    // Decrypt the outer envelope
    const tokenDataJson = decryptStravaToken(encryptedPayload);

    // Parse the token data JSON
    let tokenData: StravaTokenData;
    try {
      tokenData = JSON.parse(tokenDataJson);
    } catch {
      throw new AuthenticationError('Failed to parse stored Strava token data');
    }

    // Decrypt the actual access token
    const accessToken = decryptStravaToken(tokenData.accessToken);

    return accessToken;
  }

  /**
   * Manually trigger sync of all missing activities from Strava.
   * Fetches all activities from Strava (paginated), filters out already-ingested ones,
   * and downloads/ingests the remaining with rate limiting.
   */
  async syncHistorical(userId: string): Promise<BulkUploadResult> {
    if (!this.workoutRepository || !this.uploadService) {
      this.logger.warn('Workout repository or upload service not configured, cannot sync');
      return { total: 0, successful: [], failed: [], inProgress: 0 };
    }

    // Get the user's Strava access token
    let accessToken: string;
    try {
      accessToken = await this.getStravaAccessToken(userId);
    } catch (error) {
      this.logger.error('Failed to retrieve Strava access token for historical sync', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { total: 0, successful: [], failed: [], inProgress: 0 };
    }

    // Fetch all activities from Strava (paginated)
    this.logger.info('Starting historical sync from Strava', { userId });
    const allActivities: StravaActivitySummary[] = [];
    let page = 1;
    const perPage = 50;

    const rateLimiter = this.rateLimiter ?? new RateLimiter();

    try {
      while (true) {
        // Rate limit the list request
        await this.waitForRateLimit(rateLimiter);
        rateLimiter.recordRequest();

        const activities = await this.stravaHttpClient.listActivities(accessToken, page, perPage);
        if (activities.length === 0) {
          break;
        }
        allActivities.push(...activities);
        page++;
      }
    } catch (error) {
      this.logger.error('Failed to fetch activity list from Strava', {
        userId,
        page,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue with whatever activities we've fetched so far
    }

    if (allActivities.length === 0) {
      this.logger.info('No activities found on Strava', { userId });
      return { total: 0, successful: [], failed: [], inProgress: 0 };
    }

    // Filter out already-ingested activities
    const activitiesToSync: StravaActivitySummary[] = [];
    for (const activity of allActivities) {
      const existing = await this.workoutRepository.findBySourceActivityId(
        userId,
        String(activity.id),
      );
      if (!existing) {
        activitiesToSync.push(activity);
      }
    }

    this.logger.info('Filtered activities for sync', {
      userId,
      totalOnStrava: allActivities.length,
      toSync: activitiesToSync.length,
      alreadyIngested: allActivities.length - activitiesToSync.length,
    });

    if (activitiesToSync.length === 0) {
      return { total: 0, successful: [], failed: [], inProgress: 0 };
    }

    // Download and ingest remaining activities with rate limiting
    const successful: UploadResult[] = [];
    const failed: FailedUpload[] = [];

    for (const activity of activitiesToSync) {
      const sourceActivityId = String(activity.id);

      try {
        // Rate limit the download request
        await this.waitForRateLimit(rateLimiter);
        rateLimiter.recordRequest();

        const download = await this.stravaHttpClient.downloadActivity(sourceActivityId, accessToken);

        const result = await this.uploadService.uploadSingle(
          download.buffer,
          download.fileName,
          userId,
          {
            dataSource: 'strava',
            sourceActivityId,
          },
        );

        successful.push(result);

        this.logger.info('Successfully synced Strava activity', {
          userId,
          sourceActivityId,
          workoutId: result.workoutId,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failed.push({
          fileName: `strava_${sourceActivityId}`,
          error: errorMessage,
          errorCode: 'SYNC_FAILED',
        });

        this.logger.error('Failed to sync Strava activity', {
          userId,
          sourceActivityId,
          error: errorMessage,
        });
      }
    }

    return {
      total: activitiesToSync.length,
      successful,
      failed,
      inProgress: 0,
    };
  }

  /**
   * Wait until the rate limiter allows a request.
   * Uses a simple polling approach with the wait time from the rate limiter.
   */
  private async waitForRateLimit(rateLimiter: RateLimiter): Promise<void> {
    while (!rateLimiter.canMakeRequest()) {
      const waitTime = rateLimiter.getWaitTime();
      if (waitTime > 0) {
        this.logger.info('Rate limit reached, waiting', { waitTimeMs: waitTime });
        await this.delay(waitTime);
      }
    }
  }

  /**
   * Delay utility for rate limiting. Can be overridden in tests.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Register webhook subscription with Strava.
   * Stub implementation — full logic in task 11.2.
   */
  async registerWebhook(_callbackUrl: string): Promise<void> {
    // Stub: will be implemented in task 11.2
  }
}
