import { reviewTemplates } from '@shared/template-fit';
import { settingsService } from './settings-service.js';
import { productRepository } from '../repositories/product-repository.js';
import { inferProductGrouping } from '@shared/product-grouping';
import { classifyJoomListing } from '@shared/joom-listing';
import { summarizeJoomIssues } from '@shared/joom-review';
import type { CatalogIndexResponse, ProductIndexItem, ProductListCard, ProductSortCandidate } from '@shared/product-catalog';
import type { ProductRecord } from '@shared/types';
import { getDb } from '../db/index.js';
import { productService } from './product-service.js';

function listingBucket(listing: NonNullable<ProductRecord['joomListings']>[number]) {
  return classifyJoomListing({ joomState: listing.state, joomInventory: listing.inventory, joomHasActiveVersion: listing.hasActiveVersion });
}

function indexItem(record: ProductRecord): ProductIndexItem {
  const { collected, edited, joomListings = [] } = record;
  const buckets = joomListings.length ? joomListings.map(listingBucket) : [classifyJoomListing(record)];
  return {
    id: record.id, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt, editedAt: record.editedAt,
    collected: { title: collected.title, source: collected.source, sourceProductId: collected.sourceProductId,
      generatedSku: collected.generatedSku, store: collected.store?.name ? { name: collected.store.name } : undefined },
    edited: edited ? { title: edited.title, sku: edited.sku } : null,
    grouping: record.grouping ?? inferProductGrouping(collected), templateConfirmed: record.templateConfirmed, joomProductId: record.joomProductId,
    qualityGrade: record.qualityScore?.grade, languageRisk: record.languageRisk,
    listingBuckets: [...new Set(buckets.filter((bucket) => bucket !== undefined))],
    hasShopListings: joomListings.length > 0,
    reviewReasons: summarizeJoomIssues(record.joomIssueDetails, record.joomIssues).map((group) => group.key),
    sourceSkuSearchText: [...new Set(collected.variants.map((variant) => variant.sourceSkuId?.toLowerCase()).filter(Boolean))].join(' '),
  };
}

/** Rebuild only missing summaries. A transaction gives version, membership and derived values one snapshot. */
export function productCatalogIndex(knownVersion?: string): CatalogIndexResponse {
  const db = getDb();
  return db.transaction(() => {
    const revision = db.prepare('SELECT version FROM product_catalog_version WHERE id = 1').pluck();
    const version = revision.get() as string;
    if (knownVersion === version) return { version };
    const missing = db.prepare(`
      SELECT p.id FROM products p LEFT JOIN product_catalog_index i ON i.product_id = p.id WHERE i.product_id IS NULL
    `).pluck().all() as string[];
    const save = db.prepare('INSERT INTO product_catalog_index(product_id, summary) VALUES (?, ?)');
    for (let i = 0; i < missing.length; i += 100) {
      for (const record of productService.byIds(missing.slice(i, i + 100))) {
        save.run(record.id, JSON.stringify(indexItem(record)));
      }
    }
    const rows = db.prepare(`
      SELECT i.summary FROM products p JOIN product_catalog_index i ON i.product_id = p.id
      ORDER BY p.created_at DESC, p.rowid DESC
    `).pluck().all() as string[];
    return { version: revision.get() as string, items: rows.map((row): ProductIndexItem => JSON.parse(row)) };
  })();
}

export function productCatalogCards(ids: string[]): ProductListCard[] {
  return productService.byIds(ids).map((record) => {
    const { collected, edited } = record;
    const sourceImages = new Set([...collected.images, ...collected.variants.flatMap((variant) => variant.image ? [variant.image] : [])]);
    return {
      ...indexItem(record), templateId: record.templateId, lastError: record.lastError, lastSyncedAt: record.lastSyncedAt,
      joomInventory: record.joomInventory, joomState: record.joomState, joomHasActiveVersion: record.joomHasActiveVersion,
      joomIssues: record.joomIssues, joomIssueDetails: record.joomIssueDetails,
      listings: (record.joomListings ?? []).map((listing) => ({ shopId: listing.shopId, bucket: listingBucket(listing) })),
      score: record.qualityScore?.score, image: (edited ?? collected).images[0], price: edited ? edited.variants[0]?.price ?? 0 : collected.price?.value ?? 0,
      currency: edited ? edited.currency : collected.price?.currency ?? '', sourceImage: sourceImages.values().next().value,
      sourceUrl: collected.sourceUrl,
      imageCount: sourceImages.size, variantCount: collected.variants.length,
    };
  });
}

export function productSortCandidates(ids: string[]): ProductSortCandidate[] {
  const { templates } = settingsService.getConfig();
  const bindings = settingsService.getGroupTemplateBindings();
  const validTemplates = new Set(templates.map((template) => template.id));
  return productRepository.byIds(ids)
    .filter((record) => ['collected', 'edited', 'failed'].includes(record.status)
      && !(record.templateConfirmed && validTemplates.has(record.templateId ?? '')))
    .map((record) => {
      const { suggestion } = reviewTemplates(record.collected, templates, {
        grouping: record.grouping, bindings, preferredId: record.templateId,
      });
      return {
        id: record.id, source: record.collected.source, createdAt: record.createdAt, templateId: record.templateId,
        image: record.edited?.images[0] ?? record.collected.images[0],
        suggestion: suggestion ? { templateId: suggestion.templateId, confidence: suggestion.confidence } : undefined,
      };
    });
}
