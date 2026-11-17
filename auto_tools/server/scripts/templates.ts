/**
 * 模板配置导出/导入。server/data/ 不进 git，模板要随仓库同步就靠这个脚本。
 *
 *   npm run templates:export              从数据库导出到 seed/templates.json（只读数据库）
 *   npm run templates:import              预览导入会改哪些配置，不写数据库
 *   npm run templates:import -- --apply   写入数据库，写之前把原来的值备份到数据库目录下的 backups/
 *
 * 数据库和后端用同一个：DB_PATH（默认 ./data/app.db，相对 server 目录）。
 * 要用别处的数据库：DB_PATH=/绝对路径/app.db npm run templates:export
 */
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTemplateSeed,
  describePresetsChange,
  ensureSettingsTable,
  parseTemplateSeed,
  planTemplateImport,
  readSetting,
  TEMPLATE_SETTING_KEYS,
  TEMPLATE_SETTING_LABELS,
  templateNames,
  writeSettings,
  type TemplateSeed,
} from './template-seed.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 和后端一样读 server/.env；命令行里设置的 DB_PATH 优先（dotenv 不覆盖已有的环境变量）。
dotenv.config({ path: path.join(serverDir, '.env') });
const dbPath = path.resolve(serverDir, process.env.DB_PATH || './data/app.db');
const seedPath = path.join(serverDir, 'seed', 'templates.json');

function readSeedFromDatabase(): TemplateSeed {
  if (!fs.existsSync(dbPath)) throw new Error(`找不到数据库：${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return buildTemplateSeed((key) => readSetting(db, key));
  } finally {
    db.close();
  }
}

function runExport() {
  const seed = readSeedFromDatabase();
  const text = `${JSON.stringify(seed, null, 2)}\n`;
  const unchanged = fs.existsSync(seedPath) && fs.readFileSync(seedPath, 'utf8') === text;
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  fs.writeFileSync(seedPath, text);

  console.log(`数据库：${dbPath}`);
  console.log(`已导出到：${seedPath}${unchanged ? '（和上次导出的内容一样）' : ''}`);
  for (const key of TEMPLATE_SETTING_KEYS) {
    console.log(`  ${TEMPLATE_SETTING_LABELS[key]}：${key in seed.settings ? '已导出' : '数据库里没有，跳过'}`);
  }
  const names = templateNames(seed.settings.presets);
  console.log(`预设模板 ${names.length} 个：${names.join('、')}`);
}

/** 预览时不改任何文件：数据库还不存在就用空的内存库代替。 */
function openDatabase(apply: boolean): Database.Database {
  if (apply) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    ensureSettingsTable(db);
    return db;
  }
  if (fs.existsSync(dbPath)) return new Database(dbPath, { readonly: true, fileMustExist: true });
  const db = new Database(':memory:');
  ensureSettingsTable(db);
  return db;
}

function runImport(apply: boolean) {
  if (!fs.existsSync(seedPath)) {
    throw new Error(`找不到模板文件：${seedPath}。请先在有模板的电脑上执行 npm run templates:export 并提交。`);
  }
  const seed = parseTemplateSeed(JSON.parse(fs.readFileSync(seedPath, 'utf8')));
  console.log(`数据库：${dbPath}${fs.existsSync(dbPath) ? '' : '（还不存在，加 --apply 时会新建）'}`);
  const db = openDatabase(apply);
  try {
    const steps = planTemplateImport(seed, (key) => readSetting(db, key));
    for (const step of steps) {
      const action = !step.changed ? '没有变化' : step.current === null ? '新增' : '覆盖';
      console.log(`  ${TEMPLATE_SETTING_LABELS[step.key]}：${action}`);
      if (step.key !== 'presets' || !step.changed) continue;
      const diff = describePresetsChange(step.current, step.next);
      if (diff.added.length) console.log(`    新增模板：${diff.added.join('、')}`);
      if (diff.changed.length) console.log(`    更新模板：${diff.changed.join('、')}`);
      if (diff.removed.length) console.log(`    本机有、文件里没有，会被移除的模板：${diff.removed.join('、')}`);
    }

    const changed = steps.filter((step) => step.changed);
    if (!changed.length) {
      console.log('数据库里的模板已经和文件一致，不需要导入。');
      return;
    }
    if (!apply) {
      console.log('\n以上只是预览，没有写入数据库。确认后执行：npm run templates:import -- --apply');
      return;
    }
    const replaced = changed.filter((step) => step.current !== null);
    if (replaced.length) {
      const backupDir = path.join(path.dirname(dbPath), 'backups');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `templates-before-import-${stamp}.json`);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(backupPath, `${JSON.stringify(Object.fromEntries(replaced.map((step) => [step.key, step.current])), null, 2)}\n`);
      console.log(`原来的配置已备份到：${backupPath}`);
    }
    writeSettings(db, changed.map((step): [string, unknown] => [step.key, step.next]));
    console.log(`已写入 ${changed.length} 项配置。后端正在运行的话，刷新网页即可看到。`);
  } finally {
    db.close();
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'export') runExport();
  else if (command === 'import') runImport(args.includes('--apply'));
  else throw new Error('用法：npm run templates:export，或 npm run templates:import [-- --apply]');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
