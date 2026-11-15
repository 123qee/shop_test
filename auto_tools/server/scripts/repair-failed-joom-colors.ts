import { foldColorKey, normalizeJoomColorList, splitColorParts } from '../../shared/listing-language.js';
import type { EditableProduct, ProductRecord } from '../../shared/types.js';
import { getDb } from '../src/db/index.js';
import { productRepository } from '../src/repositories/product-repository.js';
import { auditService } from '../src/services/audit-service.js';

const apply = process.argv.includes('--apply');

const COLOR_MAP = new Map<string, string>(
  Object.entries({
    'ANTIQ W USA': 'Beige',
    'MID BLUE': 'Blue',
    'ANTHRACITE GREY': 'Grey',
    'Dark Night Navy': 'Navy',
    Egret: 'Cream',
    'GREY MARL': 'Grey',
    'TNF BLACK': 'Black',
    'TNF WHITE': 'White',
    'SOLAR POWER': 'Yellow',
    STONE: 'Beige',
    'Whisper White': 'Ivory',
    'Roasted Cashew SS26': 'Beige',
    'WHITE DUNE': 'White',
    'True Navy': 'Navy',
    'MID GREEN': 'Green',
    'Bright White': 'White',
    'Open Green': 'Green',
    'Beige Overflow': 'Beige',
    'ice blue': 'Blue',
    'COCONUT MILK': 'Cream',
    SAGE: 'Green',
    NEVIS: 'White',
    'SILVER LINING': 'Cream',
    'Ivory Petal': 'Ivory',
    'White & Dark Navy': 'White & Navy',
    'Wet Weather': 'Grey',
    'GREY MARLE': 'Grey',
    Java: 'Brown',
    'EVENING BLUE': 'Navy',
    'CHOCOLATE TORTE': 'Brown',
    'ROSE BROWN': 'Pink',
    'BLACK BEAUTY': 'Black',
    'Light & Pastel Grey': 'Grey',
    'Open Blue': 'Blue',
    'Open White': 'White',
    'OXBLOOD RED': 'Burgundy',
    JAVA: 'Brown',
    'B WHITE S CHERRY': 'White',
    'Canteen ESPRESSO': 'Brown',
    'B WHITE FORTTEL': 'White',
    'Huckleberry TTP': 'Purple',
    Cypress: 'Khaki',
    Wax: 'Cream',
    Bracken: 'Brown',
    'Ocean Cavern': 'Navy',
    'halo green': 'Green',
    'DUSTY OLIVE': 'Khaki',
    'Subdued Blue': 'Blue',
    Calico: 'Beige',
    'Moonlight Iris': 'Blue',
    S: 'Beige',
    'Desert Sky': 'Navy',
    Stone: 'Beige',
    'Sweet Blue': 'Blue',
    'EA LOGO BLACK': 'Black',
    'CERAMIC WHITE': 'White',
    'CRUISE NAVY': 'Navy',
    'ANTIQUE GREEN': 'Green',
    'ERIN GREEN': 'Green',
    'NEWPORT NAVY': 'Navy',
    'DARK COBALT & White': 'Navy & White',
  }).map(([from, to]) => [foldColorKey(from), to]),
);

interface FailedRow {
  product_id: string;
  error: string | null;
}

interface Change {
  record: ProductRecord;
  edited: EditableProduct;
  changedVariants: number;
  replacements: Array<{ from: string; to: string }>;
}

async function officialColors(): Promise<string[]> {
  const response = await fetch('http://localhost:8787/api/joom/colors');
  if (!response.ok) throw new Error(`Cannot load Joom colors from the local server (${response.status})`);
  const colors = normalizeJoomColorList(await response.json());
  if (!colors.length) throw new Error('Joom returned an empty color list');
  return colors;
}

function withoutColors(product: EditableProduct): string {
  return JSON.stringify({
    ...product,
    variants: product.variants.map(({ colors: _colors, ...variant }) => variant),
  });
}

async function main() {
  const db = getDb();
  const latestJob = db.prepare('SELECT id FROM publish_jobs ORDER BY created_at DESC LIMIT 1').get() as { id: string } | undefined;
  if (!latestJob) throw new Error('No publish job found');
  const failedRows = db
    .prepare(`SELECT product_id, error FROM publish_job_items WHERE job_id = ? AND status = 'failed' ORDER BY position`)
    .all(latestJob.id) as FailedRow[];
  const colorFailures = failedRows.filter((row) => row.error?.includes('颜色不是 Joom 允许的色名'));
  if (!colorFailures.length) throw new Error('No failed products with invalid Joom colors found in the latest publish job');
  if (colorFailures.length !== failedRows.length) throw new Error('The latest job contains non-color failures; refusing a mixed repair');

  const official = await officialColors();
  const officialSet = new Set(official.map(foldColorKey));
  for (const target of new Set(COLOR_MAP.values())) {
    for (const part of splitColorParts(target)) {
      if (!officialSet.has(foldColorKey(part))) throw new Error(`Mapped color is not in Joom's official list: ${part}`);
    }
  }

  const changes: Change[] = [];
  const replacementCounts = new Map<string, number>();
  for (const row of colorFailures) {
    const record = productRepository.get(row.product_id);
    if (!record?.edited) throw new Error(`Product has no editable draft: ${row.product_id}`);
    const before = record.edited;
    let changedVariants = 0;
    const replacements: Array<{ from: string; to: string }> = [];
    const variants = before.variants.map((variant) => {
      const original = variant.colors?.trim() || '';
      const mapped = COLOR_MAP.get(foldColorKey(original));
      if (!mapped) throw new Error(`Missing color mapping for ${row.product_id}: ${original}`);
      if (mapped === original) return variant;
      changedVariants += 1;
      replacements.push({ from: original, to: mapped });
      replacementCounts.set(`${original} -> ${mapped}`, (replacementCounts.get(`${original} -> ${mapped}`) || 0) + 1);
      return { ...variant, colors: mapped };
    });
    const edited = { ...before, variants };
    if (edited.variants.length !== before.variants.length) throw new Error(`Variant count changed for ${row.product_id}`);
    if (withoutColors(edited) !== withoutColors(before)) throw new Error(`A non-color field changed for ${row.product_id}`);
    changes.push({ record, edited, changedVariants, replacements });
  }

  if (apply) {
    db.transaction(() => {
      for (const change of changes) {
        const saved = productRepository.update(change.record.id, { edited: change.edited, status: 'edited', lastError: '' });
        if (!saved) throw new Error(`Failed to update product ${change.record.id}`);
        if (!saved.edited || saved.edited.variants.length !== change.record.edited!.variants.length) {
          throw new Error(`Variant count changed after saving ${change.record.id}`);
        }
        auditService.record({
          productId: change.record.id,
          action: 'batch.normalizeColors',
          summary: `修复发布失败色名，仅修改 ${change.changedVariants} 个变体的颜色`,
          before: change.record.edited,
          after: change.edited,
        });
      }
    })();
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        jobId: latestJob.id,
        products: changes.length,
        variants: changes.reduce((sum, change) => sum + change.record.edited!.variants.length, 0),
        changedVariants: changes.reduce((sum, change) => sum + change.changedVariants, 0),
        replacements: [...replacementCounts.entries()].map(([mapping, count]) => ({ mapping, count })),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
