import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { FACTORY_DEFAULTS, FACTORY_SIZE_TEMPLATES } from './preset-defaults.js';
import {
  buildTemplateSeed, parseTemplateSeed, planTemplateImport, readSetting,
  stableStringify, TEMPLATE_SETTING_KEYS, writeSettings,
} from '../../scripts/template-seed.js';

export const templateSeedPath = fileURLToPath(new URL('../../seed/templates.json', import.meta.url));
const baselineKey = 'template_seed_baseline';

function isFactoryPresets(value: any): boolean {
  const templates = value?.templates;
  const template = templates?.[0];
  if (templates?.length !== 1 || template.id !== 'default' || template.name !== '默认模板') return false;
  const defaults = { ...template.defaults };
  if (!defaults.description) delete defaults.description;
  const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
  return same({ ...FACTORY_DEFAULTS, ...defaults }, FACTORY_DEFAULTS)
    && (!value.activeId || value.activeId === 'default')
    && (!value.sizeTemplates || same(value.sizeTemplates, FACTORY_SIZE_TEMPLATES))
    && (!value.categoryFavorites || same(value.categoryFavorites, []))
    && (!value.categoryAttributeTemplates || same(value.categoryAttributeTemplates, []));
}

/** 新电脑恢复；拉代码更新仅覆盖仍与上次快照一致的配置，本机修改保留。 */
export function restoreTemplateSeed(db: Database.Database, seedPath = templateSeedPath): string[] {
  if (!fs.existsSync(seedPath)) return [];
  const seed = parseTemplateSeed(JSON.parse(fs.readFileSync(seedPath, 'utf8')));
  const baseline = readSetting(db, baselineKey) as Record<string, unknown> | null;
  const currentPublic = buildTemplateSeed((key) => readSetting(db, key)).settings;
  const steps = planTemplateImport(seed, (key) => readSetting(db, key)).filter((step) => step.changed && (
    step.current === null
    || (step.key === 'presets' && isFactoryPresets(step.current) && readSetting(db, 'collectDefaults') === null)
    || (baseline && step.key in baseline && stableStringify(currentPublic[step.key]) === stableStringify(baseline[step.key]))
  ));
  const replaced = steps.filter((step) => step.current !== null);
  if (replaced.length) {
    const dir = path.join(path.dirname(db.name), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `templates-auto-${Date.now()}.json`), JSON.stringify(Object.fromEntries(replaced.map((step) => [step.key, step.current])), null, 2), { mode: 0o600 });
  }
  writeSettings(db, [
    ...steps.map((step): [string, unknown] => [step.key, step.next]),
    [baselineKey, seed.settings],
  ]);
  return steps.map((step) => step.key);
}

/** 保存模板时原子更新快照；自定义 DB_PATH 需显式执行 templates:export。 */
export function snapshotTemplateSetting(db: Database.Database, key: string, seedPath = templateSeedPath): void {
  if (!(TEMPLATE_SETTING_KEYS as readonly string[]).includes(key)) return;
  const seed = buildTemplateSeed((setting) => readSetting(db, setting));
  const text = `${JSON.stringify(seed, null, 2)}\n`;
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  if (!fs.existsSync(seedPath) || fs.readFileSync(seedPath, 'utf8') !== text) {
    const tempPath = `${seedPath}.tmp`;
    try {
      fs.writeFileSync(tempPath, text, { mode: 0o600 });
      fs.renameSync(tempPath, seedPath);
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }
  writeSettings(db, [[baselineKey, seed.settings]]);
}
