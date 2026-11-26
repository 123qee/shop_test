import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkNode, inspectDependencies, prepareDependencies, prepareWeb, needsWebBuild, webFingerprint,
} from './startup.mjs';

const nativeCheck = () => {};
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-tools-startup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const kind of ['server', 'web']) {
    const manifest = { name: kind, dependencies: { example: '^1.0.0' } };
    write(path.join(base, kind, 'package.json'), manifest);
    write(path.join(base, kind, 'package-lock.json'), {
      lockfileVersion: 3, packages: { '': manifest, 'node_modules/example': { version: '1.0.0' } },
    });
    write(path.join(base, kind, 'node_modules/example/package.json'), { version: '1.0.0' });
  }
  write(path.join(base, 'web/src/main.ts'), 'export const greeting = "hello";');
  write(path.join(base, 'shared/types.ts'), 'export type ID = string;');
  return base;
}
function recorder() {
  const calls = [];
  const npm = (directory, args) => {
    calls.push([path.basename(directory), ...args]);
    if (args[0] === 'run') write(path.join(directory, 'dist/index.html'), '<html>built</html>');
  };
  return { calls, npm, nativeCheck };
}

test('requires supported Node versions before startup', () => {
  assert.throws(() => checkNode('18.20.8'), /需要 Node.js 22/);
  assert.doesNotThrow(() => checkNode('22.0.0'));
  assert.doesNotThrow(() => checkNode('24.0.0'));
});

test('installs once from lock, then validates and reuses dependencies', t => {
  const base = fixture(t);
  const options = recorder();
  assert.equal(prepareDependencies(base, 'server', { ...options, platform: 'darwin' }), true);
  assert.equal(prepareDependencies(base, 'server', options), false);
  assert.deepEqual(options.calls, [['server', 'ci']]);
  const directory = path.join(base, 'server');
  write(path.join(directory, 'node_modules/example/package.json'), { version: '0.9.0' });
  assert.match(inspectDependencies(directory, 'server', { nativeCheck }).reason, /版本不匹配/);
  fs.rmSync(path.join(directory, 'node_modules/example'), { recursive: true });
  assert.equal(inspectDependencies(directory, 'server', { nativeCheck }).ok, false);
});

test('detects lock changes even when dependency versions stay unchanged', t => {
  const base = fixture(t);
  prepareDependencies(base, 'server', recorder());
  const file = path.join(base, 'server/package-lock.json');
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  lock.packages['node_modules/example'].integrity = 'sha512-new-lock-entry';
  write(file, lock);
  assert.match(inspectDependencies(path.join(base, 'server'), 'server', { nativeCheck }).reason, /锁文件或 Node 环境已变化/);
});

test('native ABI failures invalidate an otherwise matching installation', t => {
  const base = fixture(t);
  prepareDependencies(base, 'server', recorder());
  const result = inspectDependencies(path.join(base, 'server'), 'server', {
    nativeCheck() { throw new Error('NODE_MODULE_VERSION 108 does not match 137'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ABI 不兼容/);
});

test('retains Windows native dependency repair and never records a failed installation', t => {
  const base = fixture(t);
  const options = recorder();
  prepareDependencies(base, 'server', { ...options, platform: 'win32' });
  assert.deepEqual(options.calls, [['server', 'ci', '--ignore-scripts'], ['server', 'rebuild', 'esbuild', 'sharp']]);
  fs.rmSync(path.join(base, 'web/node_modules'), { recursive: true });
  assert.throws(() => prepareDependencies(base, 'web', { ...options, npm() { throw new Error('offline'); } }), /offline/);
  assert.equal(fs.existsSync(path.join(base, 'web/node_modules/.startup-dependencies.json')), false);
});

test('web build detects changed source, shared code, config, public files and deletion', t => {
  const base = fixture(t);
  const options = recorder();
  assert.equal(prepareWeb(base, options), true);
  assert.equal(prepareWeb(base, options), false);
  assert.deepEqual(options.calls, [['web', 'ci'], ['web', 'run', 'build']]);
  for (const file of ['web/src/main.ts', 'shared/types.ts', 'web/vite.config.ts', 'web/public/logo.txt']) {
    write(path.join(base, file), 'changed-' + file);
    assert.equal(needsWebBuild(base), true, file);
    prepareWeb(base, options);
    assert.equal(needsWebBuild(base), false, file);
  }
  fs.rmSync(path.join(base, 'web/public/logo.txt'));
  assert.equal(needsWebBuild(base), true);
});

test('timestamps and build outputs do not invalidate web input fingerprint', t => {
  const base = fixture(t);
  const before = webFingerprint(base);
  fs.utimesSync(path.join(base, 'web/src/main.ts'), new Date(0), new Date(0));
  write(path.join(base, 'web/dist/index.html'), 'build output');
  write(path.join(base, 'web/tsconfig.tsbuildinfo'), 'incremental compiler state');
  assert.equal(webFingerprint(base), before);
});

test('missing output or forced rebuild is handled; build failure cannot retain a fresh marker', t => {
  const base = fixture(t);
  const options = recorder();
  prepareWeb(base, options);
  prepareWeb(base, { ...options, force: true });
  assert.equal(options.calls.filter(call => call[1] === 'run').length, 2);
  assert.throws(() => prepareWeb(base, { ...options, force: true, npm() { throw new Error('build failed'); } }), /build failed/);
  assert.equal(needsWebBuild(base), true);
  prepareWeb(base, options);
  fs.rmSync(path.join(base, 'web/dist/index.html'));
  assert.equal(needsWebBuild(base), true);
});

test('package manifest and lockfile disagreement is reported', t => {
  const base = fixture(t);
  write(path.join(base, 'server/package.json'), { dependencies: { example: '^2.0.0' } });
  const result = inspectDependencies(path.join(base, 'server'), 'server', { nativeCheck });
  assert.match(result.reason, /package.json 与锁文件不一致/);
});

test('Vite environment overrides invalidate the web build without persisting their values', t => {
  const base = fixture(t);
  const key = 'VITE_STARTUP_TEST';
  const previous = process.env[key];
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  process.env[key] = 'first';
  const first = webFingerprint(base);
  process.env[key] = 'second';
  assert.notEqual(webFingerprint(base), first);
});
