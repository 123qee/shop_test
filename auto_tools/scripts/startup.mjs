import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyMarker = '.startup-dependencies.json';
const buildMarker = '.startup-build.json';

export function checkNode(version = process.versions.node) {
  if (Number(version.split('.')[0]) < 22) {
    throw new Error(`需要 Node.js 22 或更高版本，推荐使用项目 .nvmrc 中的 Node.js 24；当前为 ${version}`);
  }
}

function hash(parts) {
  const digest = crypto.createHash('sha256');
  for (const part of parts) digest.update(String(Buffer.byteLength(part))).update(':').update(part);
  return digest.digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readMarker(file) {
  try { return readJson(file); } catch { return null; }
}

export function dependencyFingerprint(directory) {
  return hash([
    fs.readFileSync(path.join(directory, 'package.json')),
    fs.readFileSync(path.join(directory, 'package-lock.json')),
    `${process.versions.node.split('.')[0]}:${process.versions.modules}:${process.platform}:${process.arch}`,
  ]);
}

function supports(values, current) {
  return !values || (!values.includes(`!${current}`) &&
    (values.every(value => value.startsWith('!')) || values.includes(current)));
}

function checkNative(directory, kind) {
  const require = createRequire(path.join(directory, 'package.json'));
  // 实际加载原生模块，不能仅凭 node_modules 目录判断 Node ABI 是否兼容。
  if (kind === 'server') {
    const db = require('better-sqlite3')(':memory:');
    try { db.prepare('SELECT 1').get(); } finally { db.close(); }
    require('sharp');
    require.resolve('tsx');
  } else {
    require('rollup');
  }
  require('esbuild').transformSync('const ready = true;', { loader: 'js' });
}

export function inspectDependencies(directory, kind, { nativeCheck = checkNative, requireMarker = true } = {}) {
  try {
    const manifest = readJson(path.join(directory, 'package.json'));
    const lock = readJson(path.join(directory, 'package-lock.json'));
    if (!lock.packages?.['']) return { ok: false, reason: '缺少可用的 package-lock.json' };
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const sorted = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
      if (sorted(manifest[key]) !== sorted(lock.packages[''][key])) {
        return { ok: false, reason: 'package.json 与锁文件不一致，请先更新并提交锁文件' };
      }
    }
    for (const [relative, expected] of Object.entries(lock.packages)) {
      if (!relative || !supports(expected.os, process.platform) || !supports(expected.cpu, process.arch)) continue;
      // 本项目使用 npm registry 依赖；安装的完整依赖树必须匹配锁文件。
      const installed = readMarker(path.join(directory, relative, 'package.json'));
      if (!installed && expected.optional) continue;
      if (!installed || installed.version !== expected.version) {
        return { ok: false, reason: `依赖缺少或版本不匹配：${relative.replace(/^node_modules\//, '')}` };
      }
    }
    nativeCheck(directory, kind);
    const fingerprint = dependencyFingerprint(directory);
    if (requireMarker && readMarker(path.join(directory, 'node_modules', dependencyMarker))?.fingerprint !== fingerprint) {
      return { ok: false, reason: '锁文件或 Node 环境已变化，或尚未记录安装指纹' };
    }
    return { ok: true, fingerprint };
  } catch (error) {
    // 不输出环境变量、请求信息或完整模块错误（可能包含机器路径）。
    const abi = /NODE_MODULE_VERSION|different Node\.js|compiled against/.test(String(error));
    return { ok: false, reason: abi ? '原生模块与当前 Node.js ABI 不兼容' : '依赖文件缺失、损坏或原生模块无法加载' };
  }
}

function runNpm(directory, args) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  // 绝对路径调用此脚本时，也让 npm 及其子进程沿用当前 Node，避免安装到另一套 ABI。
  env[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${env[pathKey] || ''}`;
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: directory, env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) throw new Error(`npm ${args.join(' ')} 执行失败`);
}

export function prepareDependencies(base, kind, { npm = runNpm, nativeCheck = checkNative, platform = process.platform } = {}) {
  const directory = path.join(base, kind);
  const before = inspectDependencies(directory, kind, { nativeCheck });
  if (before.ok) return false;
  console.log(`${kind}：${before.reason}，正在按锁文件安装依赖…`);
  if (kind === 'server' && platform === 'win32') {
    // 保留 Windows/npm 10 修复：SQLite 已随包提供预编译文件，避免误触发 node-gyp。
    npm(directory, ['ci', '--ignore-scripts']);
    npm(directory, ['rebuild', 'esbuild', 'sharp']);
  } else {
    npm(directory, ['ci']);
  }
  const after = inspectDependencies(directory, kind, { nativeCheck, requireMarker: false });
  if (!after.ok) throw new Error(`${kind} 安装后检查未通过：${after.reason}`);
  fs.writeFileSync(path.join(directory, 'node_modules', dependencyMarker), JSON.stringify({ fingerprint: after.fingerprint }));
  return true;
}

export function webFingerprint(base) {
  const parts = [`web-build-v1:${process.versions.node.split('.')[0]}`];
  parts.push(JSON.stringify(Object.entries(process.env)
    .filter(([key]) => key.startsWith('VITE_') || key === 'NODE_ENV')
    .sort(([a], [b]) => a.localeCompare(b))));
  function visit(directory, prefix) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', '.git', '.DS_Store'].includes(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
      const file = path.join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(file, relative);
      else if (entry.isFile()) parts.push(relative, fs.readFileSync(file));
    }
  }
  visit(path.join(base, 'web'), 'web');
  visit(path.join(base, 'shared'), 'shared');
  return hash(parts);
}

export function needsWebBuild(base) {
  const dist = path.join(base, 'web', 'dist');
  return !fs.existsSync(path.join(dist, 'index.html')) ||
    readMarker(path.join(dist, buildMarker))?.fingerprint !== webFingerprint(base);
}

export function prepareWeb(base, { force = false, npm = runNpm, nativeCheck = checkNative } = {}) {
  prepareDependencies(base, 'web', { npm, nativeCheck });
  if (!force && !needsWebBuild(base)) {
    console.log('网页源码与构建一致，跳过构建。');
    return false;
  }
  const fingerprint = webFingerprint(base);
  const directory = path.join(base, 'web');
  const marker = path.join(directory, 'dist', buildMarker);
  fs.rmSync(marker, { force: true });
  console.log('网页源码、共享代码或配置已变化，正在构建…');
  npm(directory, ['run', 'build']);
  if (!fs.existsSync(path.join(directory, 'dist', 'index.html'))) throw new Error('网页构建未生成 dist/index.html');
  fs.writeFileSync(marker, JSON.stringify({ fingerprint }));
  return true;
}

function main() {
  checkNode();
  const command = process.argv[2];
  if (command === 'check-node') {
    console.log(`Node.js ${process.versions.node}（ABI ${process.versions.modules}）`);
  } else if (command === 'prepare-server') {
    prepareDependencies(root, 'server');
  } else if (command === 'prepare-web-deps') {
    prepareDependencies(root, 'web');
  } else if (command === 'prepare-web') {
    prepareWeb(root, { force: process.argv.includes('--force') });
  } else if (command === 'doctor') {
    console.log(`Node.js ${process.versions.node}（ABI ${process.versions.modules}）`);
    let failed = false;
    for (const kind of ['server', 'web']) {
      const result = inspectDependencies(path.join(root, kind), kind);
      console.log(`${kind}：${result.ok ? '依赖检查通过' : result.reason}`);
      failed ||= !result.ok;
    }
    const stale = needsWebBuild(root);
    console.log(`网页：${stale ? '需要构建；正常启动时会自动处理' : '构建与源码一致'}`);
    process.exitCode = failed || stale ? 1 : 0;
  } else {
    throw new Error('用法：node scripts/startup.mjs check-node|doctor|prepare-server|prepare-web-deps|prepare-web [--force]');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
