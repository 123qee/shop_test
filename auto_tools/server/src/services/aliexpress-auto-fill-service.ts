import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { ALIEXPRESS_AUTO_FILL_DEFAULTS, type AliExpressAutoFillConfig } from '../../../shared/aliexpress-auto-fill.js';

const CONFIG_KEY = 'aliexpress_auto_fill';

export class AliExpressAutoFillService {
  constructor(private database: () => Database.Database = getDb) {}

  get(): AliExpressAutoFillConfig {
    const row = this.database().prepare('SELECT value FROM settings WHERE key = ?').get(CONFIG_KEY) as { value: string } | undefined;
    if (!row) return structuredClone(ALIEXPRESS_AUTO_FILL_DEFAULTS);
    try {
      const config = JSON.parse(row.value) as AliExpressAutoFillConfig;
      return this.normalize(config, config.updatedAt ?? null);
    } catch {
      return structuredClone(ALIEXPRESS_AUTO_FILL_DEFAULTS);
    }
  }

  save(config: AliExpressAutoFillConfig): AliExpressAutoFillConfig {
    const normalized = this.normalize(config, new Date().toISOString());
    this.database().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(CONFIG_KEY, JSON.stringify(normalized));
    return normalized;
  }

  private normalize(config: AliExpressAutoFillConfig, updatedAt: string | null): AliExpressAutoFillConfig {
    const current = new Map((config.fields ?? []).map(field => [field.id, field]));
    const fields = ALIEXPRESS_AUTO_FILL_DEFAULTS.fields.map(defaultField => {
      const saved = current.get(defaultField.id);
      return saved ? { ...defaultField, value: saved.value, enabled: saved.enabled } : { ...defaultField };
    });
    return { fields, updatedAt };
  }
}

export const aliexpressAutoFillService = new AliExpressAutoFillService();
