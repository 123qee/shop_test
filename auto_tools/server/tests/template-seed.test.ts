import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTemplateSeed,
  describePresetsChange,
  ensureSettingsTable,
  parseTemplateSeed,
  planTemplateImport,
  readSetting,
  writeSettings,
} from '../scripts/template-seed';

const defaults = { currency: 'USD', priceMode: 'fixed', priceMultiplier: 1, fixedPrice: 5, inventory: 999, attributes: { material: 'Cotton' } };
const presets = (templates: Array<{ id: string; name: string }>, extra: Record<string, unknown> = {}) => ({
  templates: templates.map((template) => ({ ...template, defaults })),
  activeId: templates[0].id,
  sizeTemplates: [{ id: 'men-standard', name: '男装 2XS-3XL', sizes: ['S', 'M', 'L'] }],
  categoryFavorites: [],
  categoryAttributeTemplates: [],
  ...extra,
});
const adultTee = { id: 'default', name: '成人棉短袖' };
const adultHoodie = { id: 'tpl_hoodie', name: '成人连帽卫衣无拉链棉' };
const bindings = [
  { groupId: 'men-short', material: 'all', templateId: 'default' },
  { groupId: 'men-sweat', material: 'cotton', templateId: 'tpl_hoodie' },
];

/** 模拟一台电脑上 settings 表里的内容 */
const settingsOf = (rows: Record<string, unknown>) => (key: string) => rows[key] ?? null;
/** 模拟提交到仓库、再在另一台电脑上读出来的文件 */
const viaFile = (seed: unknown) => parseTemplateSeed(JSON.parse(JSON.stringify(seed)));

test('导出只包含模板配置，不含图床 Token 和其他密钥', () => {
  const seed = buildTemplateSeed(settingsOf({
    presets: presets([adultTee, adultHoodie], { picuiToken: 'picui-local-token' }),
    groupTemplateBindings: bindings,
    aiConfig: { apiKey: 'sk-local' },
    shops: { profiles: [{ id: 'joom', clientSecret: 'shop-secret' }] },
  }));

  assert.deepEqual(Object.keys(seed.settings), ['presets', 'groupTemplateBindings']);
  assert.doesNotMatch(JSON.stringify(seed), /picui-local-token|sk-local|shop-secret/);
  assert.deepEqual(seed.settings.presets, presets([adultTee, adultHoodie]));
});

test('模板配置里出现疑似密钥的字段时停止导出', () => {
  assert.throws(
    () => buildTemplateSeed(settingsOf({ aliexpress_auto_fill: { fields: [{ id: 'store', apiKey: 'abc' }] } })),
    /aliexpress_auto_fill\.fields\[0\]\.apiKey/,
  );
});

test('导入文件只接受模板配置，并按后端规则校验预设模板', () => {
  assert.throws(() => parseTemplateSeed({ version: 1, settings: { aiConfig: { apiKey: 'x' } } }), /aiConfig/);
  assert.throws(() => parseTemplateSeed({ version: 1, settings: { presets: { templates: [], activeId: 'default' } } }), /presets/);
  assert.throws(() => parseTemplateSeed({ version: 1, settings: { groupTemplateBindings: {} } }), /groupTemplateBindings/);
  assert.throws(() => parseTemplateSeed({ version: 2, settings: {} }), /version/);
});

test('导入沿用本机的图床 Token，文件里没有的配置不动，内容相同时不算变化', () => {
  const seed = viaFile(buildTemplateSeed(settingsOf({ presets: presets([adultTee, adultHoodie], { picuiToken: 'from-source' }) })));

  const same = planTemplateImport(seed, settingsOf({
    presets: presets([adultTee, adultHoodie], { picuiToken: 'local' }),
    groupTemplateBindings: bindings,
  }));
  assert.deepEqual(same.map((step) => [step.key, step.changed]), [['presets', false]]);

  const [step] = planTemplateImport(seed, settingsOf({
    presets: presets([{ id: 'default', name: '默认模板' }, { id: 'tpl_local', name: '本机自建模板' }], { picuiToken: 'local' }),
  }));
  assert.equal(step.changed, true);
  assert.equal((step.next as { picuiToken?: string }).picuiToken, 'local');
  assert.deepEqual(describePresetsChange(step.current, step.next), {
    added: ['成人连帽卫衣无拉链棉'],
    changed: ['默认模板 → 成人棉短袖'],
    removed: ['本机自建模板'],
  });
});

test('写入数据库后，后端读到的模板和分组绑定与来源一致，图床 Token 仍是本机的', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-template-seed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'test.db');
  process.env.DB_PATH = dbPath;

  const seed = viaFile(buildTemplateSeed(settingsOf({
    presets: presets([adultTee, adultHoodie], { picuiToken: 'from-source' }),
    groupTemplateBindings: bindings,
  })));

  // 新电脑：后端启动过一次，只有出厂的默认模板和本机自己的图床 Token
  const db = new Database(dbPath);
  ensureSettingsTable(db);
  writeSettings(db, [['presets', presets([{ id: 'default', name: '默认模板' }], { picuiToken: 'local-token' })]]);
  const steps = planTemplateImport(seed, (key) => readSetting(db, key));
  writeSettings(db, steps.filter((step) => step.changed).map((step): [string, unknown] => [step.key, step.next]));
  db.close();

  const { settingsService } = await import('../src/services/settings-service');
  assert.deepEqual(settingsService.getConfig().templates.map((template) => template.name), ['成人棉短袖', '成人连帽卫衣无拉链棉']);
  assert.deepEqual(settingsService.getGroupTemplateBindings(), bindings);
  assert.equal(settingsService.getPicuiToken(), 'local-token');
});
