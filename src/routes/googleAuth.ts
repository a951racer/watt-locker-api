import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { google } from 'googleapis';
import { ISettingsService } from '../services/settingsService';
import { config } from '../config/env';
import { successResponse } from '../utils/response';
import { ValidationError, AuthenticationError } from '../utils/errors';
import { ConnectedSource } from '../models/settings';

/** Google Drive OAuth scopes required for file operations */
const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

/**
 * Interface for the Google OAuth2 client to enable testing with mocks.
 */
export interface IGoogleOAuth2Client {
  generateAuthUrl(options: {
    access_type: string;
    scope: string[];
    state?: string;
    prompt?: string;
  }): string;
  getToken(code: string): Promise<{ tokens: { refresh_token?: string | null } }>;
}

/**
 * Factory function to create a real Google OAuth2 client.
 * Can be overridden in tests via dependency injection.
 */
export function createOAuth2Client(): IGoogleOAuth2Client {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

/**
 * Encrypt a token for storage. Uses base64 encoding with a marker prefix.
 * In production, replace with AES-256-GCM or similar symmetric encryption
 * using a server-side key from environment variables.
 */
export function encryptToken(token: string): string {
  return `enc:${Buffer.from(token).toString('base64')}`;
}

/**
 * Creates the Google OAuth router with injected dependencies.
 * Provides endpoints to initiate and complete the Google Drive OAuth flow.
 */
export function createGoogleAuthRouter(
  settingsService: ISettingsService,
  authMiddleware: RequestHandler,
  oauth2ClientFactory: () => IGoogleOAuth2Client = createOAuth2Client,
): Router {
  const router = Router();

  /**
   * GET /api/auth/google
   * Initiates the Google OAuth flow by generating an authorization URL.
   * Requires JWT authentication. Returns the URL for the client to redirect to.
   */
  router.get('/', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const oauth2Client = oauth2ClientFactory();

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: GOOGLE_DRIVE_SCOPES,
        state: userId,
        prompt: 'consent',
      });

      res.status(200).json(successResponse({ authUrl }));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/auth/google/callback
   * Handles the OAuth callback from Google.
   * Exchanges the authorization code for tokens and stores the encrypted
   * refresh token in user settings via the settings service.
   */
  router.get('/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, state, error } = req.query;

      if (error) {
        throw new AuthenticationError(`Google OAuth error: ${String(error)}`);
      }

      if (!code || typeof code !== 'string') {
        throw new ValidationError('Authorization code is required', { field: 'code' });
      }

      if (!state || typeof state !== 'string') {
        throw new ValidationError('State parameter is required', { field: 'state' });
      }

      const userId = state;
      const oauth2Client = oauth2ClientFactory();

      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {
        throw new AuthenticationError(
          'No refresh token received. Please revoke access and try again.',
        );
      }

      const encryptedToken = encryptToken(tokens.refresh_token);

      // Update user settings with the encrypted Google Drive refresh token
      const currentSettings = await settingsService.getSettings(userId);
      const existingSources = currentSettings.connectedSources || [];

      // Remove any existing Google Drive entry and add the new one
      const filteredSources: ConnectedSource[] = existingSources.filter(
        (s) => !(s.oauthTokenEncrypted && s.oauthTokenEncrypted.startsWith('gdrive:')),
      );

      const googleDriveSource: ConnectedSource = {
        provider: 'manual',
        connected: true,
        connectedAt: new Date(),
        oauthTokenEncrypted: `gdrive:${encryptedToken}`,
      };

      await settingsService.updateSettings(userId, {
        connectedSources: [...filteredSources, googleDriveSource],
      });

      res.status(200).json(
        successResponse({
          message: 'Google Drive connected successfully',
          connected: true,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
