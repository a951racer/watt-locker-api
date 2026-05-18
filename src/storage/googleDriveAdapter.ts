/**
 * Google Drive storage adapter implementing the FileStorageAdapter interface.
 * Uses Google Drive API v3 via the googleapis library for file operations.
 * Handles OAuth 2.0 token management with automatic refresh.
 */

import { google, drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Readable } from 'stream';

/**
 * Metadata describing a file to be stored.
 */
export interface FileMetadata {
  fileName: string;
  mimeType: string;
  workoutDate: Date;
  dataSource: string;
}

/**
 * Reference to a stored file in Google Drive.
 */
export interface StorageReference {
  fileId: string;
  fileName: string;
  folderPath: string;
  webViewLink?: string;
}

/**
 * OAuth tokens required for Google Drive access.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiryDate?: number;
}

/**
 * Callback invoked when tokens are refreshed, allowing the caller
 * to persist the updated tokens.
 */
export type TokenRefreshCallback = (tokens: OAuthTokens) => Promise<void>;

/**
 * Configuration for the Google Drive adapter.
 */
export interface GoogleDriveAdapterConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokens: OAuthTokens;
  basePath: string;
  onTokenRefresh?: TokenRefreshCallback;
}

/**
 * Interface for file storage operations.
 */
export interface FileStorageAdapter {
  store(file: Buffer, metadata: FileMetadata): Promise<StorageReference>;
  retrieve(reference: StorageReference): Promise<Buffer>;
  delete(reference: StorageReference): Promise<void>;
  listFiles(folderPath: string): Promise<StorageReference[]>;
  removeFromFolder(reference: StorageReference): Promise<void>;
}

/**
 * Google Drive implementation of the FileStorageAdapter interface.
 * Organizes files in year/month folder structure and handles OAuth token refresh.
 */
export class GoogleDriveAdapter implements FileStorageAdapter {
  private readonly oauth2Client: OAuth2Client;
  private readonly drive: drive_v3.Drive;
  private readonly basePath: string;
  private readonly onTokenRefresh?: TokenRefreshCallback;

  constructor(config: GoogleDriveAdapterConfig) {
    this.basePath = config.basePath;
    this.onTokenRefresh = config.onTokenRefresh;

    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri,
    );

    this.oauth2Client.setCredentials({
      access_token: config.tokens.accessToken,
      refresh_token: config.tokens.refreshToken,
      expiry_date: config.tokens.expiryDate,
    });

    this.oauth2Client.on('tokens', (tokens) => {
      this.handleTokenRefresh(tokens);
    });

    this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
  }

  /**
   * Store a file in Google Drive, organizing it into year/month folders.
   * Creates folders if they don't exist.
   */
  async store(file: Buffer, metadata: FileMetadata): Promise<StorageReference> {
    const folderPath = this.deriveFolderPath(metadata.workoutDate);
    const folderId = await this.ensureFolderPath(folderPath);

    const response = await this.drive.files.create({
      requestBody: {
        name: metadata.fileName,
        mimeType: metadata.mimeType,
        parents: [folderId],
      },
      media: {
        mimeType: metadata.mimeType,
        body: Readable.from(file),
      },
      fields: 'id,name,webViewLink',
    });

    return {
      fileId: response.data.id!,
      fileName: response.data.name!,
      folderPath,
      webViewLink: response.data.webViewLink ?? undefined,
    };
  }

  /**
   * Retrieve a file from Google Drive by its file ID.
   */
  async retrieve(reference: StorageReference): Promise<Buffer> {
    const response = await this.drive.files.get(
      { fileId: reference.fileId, alt: 'media' },
      { responseType: 'arraybuffer' },
    );

    return Buffer.from(response.data as ArrayBuffer);
  }

  /**
   * Delete a file from Google Drive permanently.
   */
  async delete(reference: StorageReference): Promise<void> {
    await this.drive.files.delete({ fileId: reference.fileId });
  }

  /**
   * List all files in a given folder path.
   * Resolves the folder path to a folder ID, then lists its contents.
   */
  async listFiles(folderPath: string): Promise<StorageReference[]> {
    const folderId = await this.resolveFolderPath(folderPath);
    if (!folderId) {
      return [];
    }

    const references: StorageReference[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'nextPageToken, files(id, name, webViewLink)',
        pageToken,
      });

      const files = response.data.files ?? [];
      for (const file of files) {
        references.push({
          fileId: file.id!,
          fileName: file.name!,
          folderPath,
          webViewLink: file.webViewLink ?? undefined,
        });
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return references;
  }

  /**
   * Remove a file from its folder (used for inbox cleanup after processing).
   * This permanently deletes the file from Drive.
   */
  async removeFromFolder(reference: StorageReference): Promise<void> {
    await this.drive.files.delete({ fileId: reference.fileId });
  }

  /**
   * Derive the folder path for a workout based on its date.
   * Format: {basePath}/YYYY/MM
   */
  private deriveFolderPath(workoutDate: Date): string {
    const year = workoutDate.getFullYear().toString();
    const month = (workoutDate.getMonth() + 1).toString().padStart(2, '0');
    return `${this.basePath}/${year}/${month}`;
  }

  /**
   * Ensure a folder path exists in Google Drive, creating folders as needed.
   * Returns the ID of the deepest folder.
   */
  private async ensureFolderPath(folderPath: string): Promise<string> {
    const parts = folderPath.split('/').filter((p) => p.length > 0);
    let parentId = 'root';

    for (const part of parts) {
      const existingId = await this.findFolder(part, parentId);
      if (existingId) {
        parentId = existingId;
      } else {
        parentId = await this.createFolder(part, parentId);
      }
    }

    return parentId;
  }

  /**
   * Resolve a folder path to its Google Drive folder ID.
   * Returns null if any part of the path doesn't exist.
   */
  private async resolveFolderPath(folderPath: string): Promise<string | null> {
    const parts = folderPath.split('/').filter((p) => p.length > 0);
    let parentId = 'root';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const folderIds = await this.findAllFolders(part, parentId);
      console.log(`[Drive] resolveFolderPath: looking for "${part}" in parent "${parentId}" → found ${folderIds.length} match(es)`);

      if (folderIds.length === 0) {
        return null;
      }

      if (folderIds.length === 1) {
        parentId = folderIds[0];
      } else {
        // Multiple matches — try to resolve the full remaining path from each candidate
        const remainingParts = parts.slice(i + 1);
        let resolved = false;

        for (const candidateId of folderIds) {
          const result = await this.tryResolvePath(candidateId, remainingParts);
          if (result) {
            // This candidate leads to the full path — use it
            return result;
          }
        }

        if (!resolved) {
          // None resolved fully, fall back to first match
          parentId = folderIds[0];
        }
      }
    }

    return parentId;
  }

  /**
   * Try to resolve remaining path parts starting from a given parent.
   * Returns the final folder ID if successful, null otherwise.
   */
  private async tryResolvePath(parentId: string, parts: string[]): Promise<string | null> {
    let currentId = parentId;
    for (const part of parts) {
      const folderId = await this.findFolder(part, currentId);
      if (!folderId) return null;
      currentId = folderId;
    }
    return currentId;
  }

  /**
   * Find all folders by name within a parent folder.
   */
  private async findAllFolders(name: string, parentId: string): Promise<string[]> {
    const response = await this.drive.files.list({
      q: `name = '${name}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
      pageSize: 10,
    });

    const files = response.data.files ?? [];
    return files.map(f => f.id!);
  }

  /**
   * Find a folder by name within a parent folder.
   */
  private async findFolder(name: string, parentId: string): Promise<string | null> {
    const response = await this.drive.files.list({
      q: `name = '${name}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
      pageSize: 1,
    });

    const files = response.data.files ?? [];
    return files.length > 0 ? files[0].id! : null;
  }

  /**
   * Create a new folder in Google Drive.
   */
  private async createFolder(name: string, parentId: string): Promise<string> {
    const response = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
    });

    return response.data.id!;
  }

  /**
   * Handle token refresh events from the OAuth2 client.
   */
  private handleTokenRefresh(tokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
  }): void {
    if (this.onTokenRefresh && tokens.access_token) {
      const credentials = this.oauth2Client.credentials;
      const updatedTokens: OAuthTokens = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? credentials.refresh_token ?? '',
        expiryDate: tokens.expiry_date ?? undefined,
      };
      // Fire and forget — caller handles persistence
      void this.onTokenRefresh(updatedTokens);
    }
  }
}
