import type { ProductGrouping, ProductMaterial } from '@shared/types';
import type { MaterialSource, PolyesterType } from '@shared/orders';
import { inferMaterialFromText, inferProductGrouping } from '@shared/product-grouping';
import { getDb } from '../db/index.js';
import { orderExportRepository } from '../repositories/order-export-repository.js';
import type { StoredOrderLine } from '../repositories/order-repository.js';
import { orderSourceRegistry } from './registry.js';

export interface MaterialDecision {
  material: ProductMaterial;
  source: MaterialSource;
  /** 写进导出文件「材质判定依据」列，方便抽查 */
  evidence: string;
  polyesterType?: PolyesterType;
}

interface CatalogMaterial {
  material: ProductMaterial;
  /** 用户在商品库里手动改过分组 */
  confirmed: boolean;
}

const HINT_PREVIEW_LENGTH = 60;

function readCatalogMaterial(productId: string): CatalogMaterial | null {
  const db = getDb();
  const row = db.prepare('SELECT grouping FROM products WHERE id = ?').get(productId) as { grouping: string | null } | undefined;
  if (!row) return null;
  let grouping: ProductGrouping | undefined;
  try {
    grouping = row.grouping ? (JSON.parse(row.grouping) as ProductGrouping) : undefined;
    if (!grouping) {
      const collected = db.prepare('SELECT collected FROM products WHERE id = ?').get(productId) as { collected: string } | undefined;
      grouping = collected ? inferProductGrouping(JSON.parse(collected.collected)) : undefined;
    }
  } catch {
    return null;
  }
  return grouping ? { material: grouping.material, confirmed: grouping.source === 'manual' } : null;
}

function shorten(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > HINT_PREVIEW_LENGTH ? `${value.slice(0, HINT_PREVIEW_LENGTH)}…` : value;
}

/**
 * 材质判定链，命中即停：
 * 本次手动指定 → 记住的商品材质 → 商品库人工确认的分组 → 平台商品的材质属性
 * → 商品库自动识别的分组 → 标题关键词 → 未识别。
 * 每次预览/导出新建一个实例，查询结果在本次内缓存。
 */
export function createMaterialClassifier() {
  const rules = new Map<string, ReturnType<typeof orderExportRepository.findRule>>();
  const catalogIds = new Map<string, string | undefined>();
  const catalog = new Map<string, CatalogMaterial | null>();

  function ruleFor(line: StoredOrderLine) {
    const key = [line.platform, line.productId ?? '', line.productSku ?? ''].join('\u0000');
    if (!rules.has(key)) rules.set(key, orderExportRepository.findRule(line.platform, line.productId, line.productSku));
    return rules.get(key) ?? null;
  }

  function catalogFor(line: StoredOrderLine): CatalogMaterial | null {
    const key = [line.platform, line.shopId, line.productId ?? '', line.productSku ?? ''].join('\u0000');
    if (!catalogIds.has(key)) {
      const source = orderSourceRegistry.get(line.platform);
      catalogIds.set(key, source?.findCatalogProductId?.(line, line.shopId));
    }
    const productId = catalogIds.get(key);
    if (!productId) return null;
    if (!catalog.has(productId)) catalog.set(productId, readCatalogMaterial(productId));
    return catalog.get(productId) ?? null;
  }

  return function classify(line: StoredOrderLine, override?: ProductMaterial): MaterialDecision {
    const rule = ruleFor(line);
    if (override) return { material: override, source: 'override', evidence: '本次手动指定', polyesterType: override === 'polyester' ? rule?.polyesterType : undefined };
    if (rule) return { material: rule.material, source: 'rule', evidence: '已记住的商品材质', polyesterType: rule.polyesterType };
    const product = catalogFor(line);
    if (product && product.confirmed && product.material !== 'unknown') {
      return { material: product.material, source: 'catalog-manual', evidence: '商品库分组（人工确认）' };
    }
    if (line.materialHint) {
      const material = inferMaterialFromText(line.materialHint);
      if (material !== 'unknown') {
        return { material, source: 'platform-attribute', evidence: `商品材质属性：${shorten(line.materialHint)}` };
      }
    }
    if (product && product.material !== 'unknown') {
      return { material: product.material, source: 'catalog-auto', evidence: '商品库分组（自动识别）' };
    }
    if (line.title) {
      const material = inferMaterialFromText(line.title);
      if (material !== 'unknown') return { material, source: 'title', evidence: '商品标题关键词' };
    }
    return {
      material: 'unknown',
      source: 'none',
      evidence: product ? '商品库里材质未知' : line.title ? '商品信息里没有材质' : '没有找到商品信息',
    };
  };
}
