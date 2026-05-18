/**
 * User settings and connected data source models.
 */

import { DataSource } from './workout';

/** A connected external data source (e.g., Strava, Garmin) */
export interface ConnectedSource {
  provider: DataSource;
  connected: boolean;
  connectedAt?: Date;
  oauthTokenEncrypted?: string;
}

/** User-configurable settings */
export interface UserSettings {
  userId: string;

  // Google Drive paths
  driveStoragePath: string;
  driveInboxPath: string;

  // Connected data sources
  connectedSources: ConnectedSource[];

  updatedAt: Date;
}
