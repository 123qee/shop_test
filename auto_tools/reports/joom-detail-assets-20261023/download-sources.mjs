import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const reportPath = resolve('reports/joom-detail-images-candidates-30-20261023.html');
const outputDir = resolve('reports/joom-detail-assets-20261023/sources');
const html = await readFile(reportPath, 'utf8');
const articles = [...html.matchAll(/<article><img src="([^"]+)"><b>(\d+) · [^<]+<\/b><div class="id">([^<]+)<\/div>/g)];

if (articles.length !== 30) {
  throw new Error(`Expected 30 candidates, found ${articles.length}`);
}

await mkdir(outputDir, { recursive: true });

for (const [, url, sequence, productId] of articles) {
  const extension = basename(new URL(url).pathname).split('.').pop() || 'jpeg';
  const outputPath = resolve(outputDir, `${sequence}-${productId}.${extension}`);
  try {
    await access(outputPath);
    console.log(`skip ${outputPath}`);
    continue;
  } catch {
    // Download missing source image.
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${productId}: ${response.status} ${response.statusText}`);
  }
  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  console.log(outputPath);
}
