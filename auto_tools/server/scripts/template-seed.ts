import type Database from 'better-sqlite3';
import { presetsConfigSchema } from '../src/routes/schemas.js';

/**
 * 模板配置的导出/导入逻辑，命令行入口见 scripts/templates.ts。
 *
 * 模板存在数据库的 settings 表里，而 server/data/ 不进 git。
 * 把下面这些 key 导出成 seed/templates.json 随仓库提交，换电脑后再导入回数据库。
 */

/** 随仓库同步的 settings key。带密钥的 aiConfig、shops、mercadolibreConfig 不在其中。 */
export const TEMPLATE_SETTING_KEYS = [
  'presets',
  'groupTemplateBindings',
  'mercadolibreTemplates',
  'aliexpress_auto_fill',
  'order_export_profiles',
] as const;

export type TemplateSettingKey = (typeof TEMPLATE_SETTING_KEYS)[number];

export const TEMPLATE_SETTING_LABELS: Record<TemplateSettingKey, string> = {
  presets: '预设模板、尺码模板、类目收藏',
  groupTemplateBindings: '分组与模板的绑定',
  mercadolibreTemplates: '美客多模板',
  aliexpress_auto_fill: '速卖通自动填写配置',
  order_export_profiles: '订单导出配置',
};

/** 只属于本机的字段：导出时去掉，导入时沿用数据库里原来的值。 */
const LOCAL_ONLY_FIELDS: Partial<Record<TemplateSettingKey, readonly string[]>> = {
  presets: ['picuiToken'],
};

/** 兜底检查：字段名像密钥的不许出现在导出文件里，防止以后新增字段时被误提交。 */
const SECRET_FIELD = /token|secret|passw|cookie|api_?key|access_?key|private_?key|authorization/i;

const SEED_VERSION = 1;
const SEED_NOTE = '由 npm run templates:export 从本机数据库导出，不含密钥，请勿手改。'
  + '换电脑后在 server 目录执行 npm run templates:import 预览，确认后执行 npm run templates:import -- --apply 写入。';

export interface TemplateSeed {
  version: typeof SEED_VERSION;
  note: string;
  settings: Partial<Record<TemplateSettingKey, unknown>>;
}

/** 按 key 读取数据库里的配置，没有时返回 null。 */
export type ReadSetting = (key: TemplateSettingKey) => unknown;

export interface ImportStep {
  key: TemplateSettingKey;
  /** 数据库里现在的值，没有时为 null */
  current: unknown;
  /** 导入后的值 */
  next: unknown;
  changed: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTemplateKey = (key: string): key is TemplateSettingKey =>
  (TEMPLATE_SETTING_KEYS as readonly string[]).includes(key);

/** 与字段顺序无关的序列化，用来判断导入前后是否真的有变化。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    const fields = Object.keys(value).filter((field) => value[field] !== undefined).sort();
    return `{${fields.map((field) => `${JSON.stringify(field)}:${stableStringify(value[field])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 找出字段名像密钥且有值的位置，例如 .presets.picuiToken。 */
export function findSecretPaths(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findSecretPaths(item, `${at}[${index}]`));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([field, child]) => {
    const childAt = `${at}.${field}`;
    const hasValue = child !== null && child !== undefined && child !== '';
    return [...(SECRET_FIELD.test(field) && hasValue ? [childAt] : []), ...findSecretPaths(child, childAt)];
  });
}

function withoutLocalFields(key: TemplateSettingKey, value: unknown): unknown {
  const fields = LOCAL_ONLY_FIELDS[key];
  if (!fields || !isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([field]) => !fields.includes(field)));
}

/** 导出：读出模板配置并去掉本机字段；仍有疑似密钥时直接报错，不生成文件。 */
export function buildTemplateSeed(read: ReadSetting): TemplateSeed {
  const settings: TemplateSeed['settings'] = {};
  for (const key of TEMPLATE_SETTING_KEYS) {
    const value = read(key);
    if (value !== null && value !== undefined) settings[key] = withoutLocalFields(key, value);
  }
  const secrets = findSecretPaths(settings);
  if (secrets.length) {
    throw new Error(`导出内容里有疑似密钥的字段：${secrets.join('、')}。已停止导出；如果是本机专用字段，请加到 LOCAL_ONLY_FIELDS。`);
  }
  return { version: SEED_VERSION, note: SEED_NOTE, settings };
}

/** 每个 key 的格式检查：有问题返回描述，没问题返回 null。 */
const CHECKS: Record<TemplateSettingKey, (value: unknown) => string | null> = {
  presets: (value) => {
    // 只用后端保存预设时的规则做校验，写入的仍是文件里的原值（parse 结果会丢掉规则外的字段）。
    const result = presetsConfigSchema.safeParse(value);
    return result.success ? null : result.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}：${issue.message}`).join('；');
  },
  groupTemplateBindings: (value) => (Array.isArray(value) ? null : '应为数组'),
  mercadolibreTemplates: (value) => (Array.isArray(value) ? null : '应为数组'),
  aliexpress_auto_fill: (value) => (isRecord(value) ? null : '应为对象'),
  order_export_profiles: (value) => (Array.isArray(value) ? null : '应为数组'),
};

/** 导入前校验文件：只接受模板相关的 key，防止手改文件后把别的配置写进数据库。 */
export function parseTemplateSeed(raw: unknown): TemplateSeed {
  if (!isRecord(raw) || raw.version !== SEED_VERSION || !isRecord(raw.settings)) {
    throw new Error(`模板文件格式不对：version 应为 ${SEED_VERSION}，并包含 settings 对象`);
  }
  const settings: TemplateSeed['settings'] = {};
  for (const [key, value] of Object.entries(raw.settings)) {
    if (!isTemplateKey(key)) throw new Error(`模板文件里有不支持的配置项 ${key}，只允许：${TEMPLATE_SETTING_KEYS.join('、')}`);
    const problem = CHECKS[key](value);
    if (problem) throw new Error(`模板文件里的 ${key} 格式不对：${problem}`);
    settings[key] = value;
  }
  return { version: SEED_VERSION, note: typeof raw.note === 'string' ? raw.note : SEED_NOTE, settings };
}

/** 导入：算出每个 key 导入后的值。文件里没有的 key 不动；本机字段沿用数据库里的值。 */
export function planTemplateImport(seed: TemplateSeed, read: ReadSetting): ImportStep[] {
  return TEMPLATE_SETTING_KEYS.filter((key) => key in seed.settings).map((key) => {
    const current = read(key) ?? null;
    let next = withoutLocalFields(key, seed.settings[key]);
    const kept = (LOCAL_ONLY_FIELDS[key] ?? []).filter((field) => isRecord(current) && current[field] !== undefined);
    if (isRecord(next) && isRecord(current) && kept.length) {
      next = { ...next, ...Object.fromEntries(kept.map((field) => [field, current[field]])) };
    }
    return { key, current, next, changed: stableStringify(current) !== stableStringify(next) };
  });
}

function templatesOf(presets: unknown): Array<Record<string, unknown>> {
  return isRecord(presets) && Array.isArray(presets.templates) ? presets.templates.filter(isRecord) : [];
}

/** 预设模板里的模板名。 */
export function templateNames(presets: unknown): string[] {
  return templatesOf(presets).map((template) => String(template.name));
}

/** 按模板 id 对比，列出导入会新增、更新、移除哪些预设模板；改了名的显示为“旧名 → 新名”。 */
export function describePresetsChange(current: unknown, next: unknown) {
  const before = new Map(templatesOf(current).map((template) => [String(template.id), template]));
  const after = new Map(templatesOf(next).map((template) => [String(template.id), template]));
  const name = (template: Record<string, unknown>) => String(template.name);
  const changed: string[] = [];
  for (const [id, template] of after) {
    const old = before.get(id);
    if (!old || stableStringify(old) === stableStringify(template)) continue;
    changed.push(name(old) === name(template) ? name(template) : `${name(old)} → ${name(template)}`);
  }
  return {
    added: [...after].filter(([id]) => !before.has(id)).map(([, template]) => name(template)),
    changed,
    removed: [...before].filter(([id]) => !after.has(id)).map(([, template]) => name(template)),
  };
}

export function ensureSettingsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

/** 读一个配置，没有时返回 null；JSON 损坏时报错，不当作没有。 */
export function readSetting(db: Database.Database, key: string): unknown {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    throw new Error(`数据库里的配置 ${key} 不是合法的 JSON`);
  }
}

/** 在一个事务里写入，写法和 SqliteSettingsRepository.set 一致。 */
export function writeSettings(db: Database.Database, entries: Array<[string, unknown]>): void {
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  db.transaction(() => {
    for (const [key, value] of entries) upsert.run(key, JSON.stringify(value));
  })();
}
