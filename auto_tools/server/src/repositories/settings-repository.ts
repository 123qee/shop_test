import path from 'node:path';
import { config } from '../config/index.js';
import { snapshotTemplateSetting, templateSeedPath } from '../services/template-sync.js';
import { logger } from '../util/logger.js';
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
    if (config.dbPath === path.resolve(path.dirname(templateSeedPath), '../data/app.db')) {
      try { snapshotTemplateSetting(getDb(), key); }
      catch (error) {
        logger.error('模板已保存到本机，但仓库快照更新失败，请执行 templates:export', { message: error instanceof Error ? error.message : String(error) });
        throw new Error('配置已保存到本机，但模板快照更新失败，请检查文件权限后重新保存，或执行 npm run templates:export');
      }
    }
  }
}

export const settingsRepository: SettingsRepository = new SqliteSettingsRepository();
