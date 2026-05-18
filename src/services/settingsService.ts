import { UserSettings } from '../models/settings';
import { ISettingsRepository } from '../repositories/settingsRepository';

/** SettingsService interface for user settings operations */
export interface ISettingsService {
  getSettings(userId: string): Promise<UserSettings>;
  updateSettings(userId: string, updates: Partial<UserSettings>): Promise<UserSettings>;
}

export class SettingsService implements ISettingsService {
  constructor(private readonly settingsRepository: ISettingsRepository) {}

  /**
   * Get user settings, creating defaults if none exist.
   * If no settings are found for the user, an upsert with empty updates
   * triggers default creation in the repository layer.
   */
  async getSettings(userId: string): Promise<UserSettings> {
    const existing = await this.settingsRepository.findByUserId(userId);
    if (existing) {
      return existing;
    }

    // Create settings with defaults via upsert with no overrides
    return this.settingsRepository.upsert(userId, {});
  }

  /**
   * Update user settings with a partial update. Persists immediately.
   * Only the provided fields are updated; others remain unchanged.
   */
  async updateSettings(
    userId: string,
    updates: Partial<UserSettings>,
  ): Promise<UserSettings> {
    // Strip userId and updatedAt from updates — these are managed internally
    const { userId: _uid, updatedAt: _ts, ...settingsUpdates } = updates;

    return this.settingsRepository.upsert(userId, settingsUpdates);
  }
}
