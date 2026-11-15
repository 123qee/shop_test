import { getDb } from '../db/index.js';

/** settings 表的通用 JSON 读写(key -> 任意 JSON 值)。 */
export interface SettingsRepository {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
}

export class SqliteSettingsRepository implements SettingsRepository {
  get<T>(key: string): T | null {
    const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  set<T>(key: string, value: T): void {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }
}

export const settingsRepository: SettingsRepository = new SqliteSettingsRepository();
