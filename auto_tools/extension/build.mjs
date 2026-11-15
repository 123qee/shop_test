import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(__dirname, 'dist');
const watch = process.argv.includes('--watch');

/** 每次构建的唯一标识(本地时间),用于确认加载的是最新代码 */
function makeBuildId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const BUILD_ID = makeBuildId();

// 每个入口单独打包为 IIFE / ESM
// ESM 入口(扩展页面/脚本)
const entries = {
  content: 'src/content/index.ts',
  erp: 'src/erp/aliexpress-form.ts',
  background: 'src/background/index.ts',
  popup: 'src/popup/popup.ts',
  options: 'src/options/options.ts',
};

// 主世界注入脚本:必须是 IIFE(以 <script src> 注入页面)
const iifeEntries = {
  injected: 'src/injected/aliexpress.ts',
};

/** 拷贝静态资源到 dist */
function copyStatic() {
  fs.mkdirSync(outdir, { recursive: true });
  for (const f of ['src/popup/popup.html', 'src/options/options.html']) {
    const base = path.basename(f);
    fs.copyFileSync(path.join(__dirname, f), path.join(outdir, base));
  }
  // manifest:注入 version_name(带 build 号),chrome://extensions 里可直接看到
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  manifest.version_name = `${manifest.version}+${BUILD_ID}`;
  fs.writeFileSync(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // 图标(占位:若 icons 目录存在则拷贝)
  const iconsDir = path.join(__dirname, 'icons');
  if (fs.existsSync(iconsDir)) {
    fs.cpSync(iconsDir, path.join(outdir, 'icons'), { recursive: true });
  }
  const assetsDir = path.join(__dirname, 'assets');
  if (fs.existsSync(assetsDir)) {
    fs.cpSync(assetsDir, path.join(outdir, 'assets'), { recursive: true });
  }
}

const common = {
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  sourcemap: watch,
  logLevel: 'info',
  alias: { '@shared': path.resolve(__dirname, '../shared') },
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
};

async function run() {
  copyStatic();
  const ctxs = await Promise.all([
    ...Object.entries(entries).map(([name, entry]) =>
      esbuild.context({
        ...common,
        entryPoints: [path.join(__dirname, entry)],
        outfile: path.join(outdir, `${name}.js`),
      }),
    ),
    ...Object.entries(iifeEntries).map(([name, entry]) =>
      esbuild.context({
        ...common,
        format: 'iife',
        entryPoints: [path.join(__dirname, entry)],
        outfile: path.join(outdir, `${name}.js`),
      }),
    ),
  ]);
  if (watch) {
    await Promise.all(ctxs.map((c) => c.watch()));
    // 监听静态文件变化
    fs.watch(path.join(__dirname, 'src'), { recursive: true }, copyStatic);
    fs.watch(path.join(__dirname, 'manifest.json'), copyStatic);
    console.log('extension: watching...');
  } else {
    await Promise.all(ctxs.map((c) => c.rebuild()));
    await Promise.all(ctxs.map((c) => c.dispose()));
    console.log('extension: build done ->', outdir);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
