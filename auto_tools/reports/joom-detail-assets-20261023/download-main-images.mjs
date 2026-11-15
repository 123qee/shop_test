import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const reportPath = resolve('reports/joom-detail-images-candidates-30-20261023.html');
const databasePath = resolve('server/data/app.db');
const outputDir = resolve('reports/joom-detail-assets-20261023/main');
const html = await readFile(reportPath, 'utf8');
const candidates = [...html.matchAll(/<article><img src="[^"]+"><b>(\d+) · [^<]+<\/b><div class="id">([^<]+)<\/div>/g)]
  .map(([, sequence, productId]) => ({ sequence, productId }));

if (candidates.length !== 30) {
  throw new Error(`Expected 30 candidates, found ${candidates.length}`);
}

const ids = candidates.map(({ productId }) => `'${productId}'`).join(',');
const query = `
  SELECT
    joom_product_id AS productId,
    json_extract(collected, '$.images[0]') AS imageUrl
  FROM products
  WHERE joom_product_id IN (${ids});
`;
const rows = JSON.parse(execFileSync('sqlite3', ['-json', databasePath, query], { encoding: 'utf8' }));
const imageByProduct = new Map(rows.map(({ productId, imageUrl }) => [productId, imageUrl]));

await mkdir(outputDir, { recursive: true });

for (const { sequence, productId } of candidates) {
  const url = imageByProduct.get(productId);
  if (!url) {
    throw new Error(`${productId}: missing main image URL`);
  }
  const extension = basename(new URL(url).pathname).split('.').pop() || 'jpeg';
  const outputPath = resolve(outputDir, `${sequence}-${productId}.${extension}`);
  try {
    await access(outputPath);
    console.log(`skip ${outputPath}`);
    continue;
  } catch {
    // Download missing main image.
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${productId}: ${response.status} ${response.statusText}`);
  }
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  console.log(outputPath);
}
