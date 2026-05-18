import { Collection, Db } from 'mongodb';
import { UserSettings } from '../models/settings';

/** Stored settings document shape in MongoDB */
export interface SettingsDocument {
  userId: string;
  driveStoragePath: string;
  driveInboxPath: string;
  connectedSources: UserSettings['connectedSources'];
  updatedAt: Date;
}

/** Default values for new user settings */
const SETTINGS_DEFAULTS = {
  driveStoragePath: 'WattLocker',
  driveInboxPath: 'WattLocker/Inbox',
  connectedSources: [],
};

/** Settings repository interface for database access abstraction */
export interface ISettingsRepository {
  findByUserId(userId: string): Promise<UserSettings | null>;
  upsert(userId: string, settings: Partial<Omit<UserSettings, 'userId'>>): Promise<UserSettings>;
}

/** MongoDB implementation of the settings repository */
export class MongoSettingsRepository implements ISettingsRepository {
  private collection: Collection<SettingsDocument>;

  constructor(db: Db) {
    this.collection = db.collection('settings');
  }

  /** Ensure required indexes exist on the settings collection */
  async createIndexes(): Promise<void> {
    await this.collection.createIndex({ userId: 1 }, { unique: true });
  }

  async findByUserId(userId: string): Promise<UserSettings | null> {
    const doc = await this.collection.findOne({ userId });
    if (!doc) return null;

    return {
      userId: doc.userId,
      driveStoragePath: doc.driveStoragePath,
      driveInboxPath: doc.driveInboxPath,
      connectedSources: doc.connectedSources,
      updatedAt: doc.updatedAt,
    };
  }

  async upsert(
    userId: string,
    settings: Partial<Omit<UserSettings, 'userId'>>,
  ): Promise<UserSettings> {
    const now = new Date();

    // Build $set with only the provided fields plus updatedAt
    const $set: Record<string, unknown> = { updatedAt: now };
    if (settings.driveStoragePath !== undefined) {
      $set.driveStoragePath = settings.driveStoragePath;
    }
    if (settings.driveInboxPath !== undefined) {
      $set.driveInboxPath = settings.driveInboxPath;
    }
    if (settings.connectedSources !== undefined) {
      $set.connectedSources = settings.connectedSources;
    }

    // $setOnInsert only includes fields NOT already in $set to avoid conflicts
    const $setOnInsert: Record<string, unknown> = { userId };
    if ($set.driveStoragePath === undefined) {
      $setOnInsert.driveStoragePath = SETTINGS_DEFAULTS.driveStoragePath;
    }
    if ($set.driveInboxPath === undefined) {
      $setOnInsert.driveInboxPath = SETTINGS_DEFAULTS.driveInboxPath;
    }
    if ($set.connectedSources === undefined) {
      $setOnInsert.connectedSources = SETTINGS_DEFAULTS.connectedSources;
    }

    const result = await this.collection.findOneAndUpdate(
      { userId },
      { $set, $setOnInsert },
      { upsert: true, returnDocument: 'after' },
    );

    const doc = result!;
    return {
      userId: doc.userId,
      driveStoragePath: doc.driveStoragePath,
      driveInboxPath: doc.driveInboxPath,
      connectedSources: doc.connectedSources,
      updatedAt: doc.updatedAt,
    };
  }
}
