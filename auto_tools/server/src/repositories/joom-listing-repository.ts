import type {
  JoomShopListingSnapshot,
  JoomShopStatusCounts,
  JoomShopStatusSummary,
  ShopStatusItem,
} from '@shared/types';
import { classifyJoomListing } from '@shared/joom-listing';
import { getDb } from '../db/index.js';
import type { RemoteProduct } from '../marketplaces/types.js';

interface ListingRow {
  shop_id: string;
  joom_product_id: string;
  product_id: string | null;
  shop_name: string;
  sku: string | null;
  name: string | null;
  state: string | null;
  joom_updated_at: string | null;
  inventory: number;
  has_active_version: number;
  issues: string | null;
  issue_details: string | null;
  present: number;
  last_synced_at: string;
}

interface SyncRow {
  shop_id: string;
  shop_name: string;
  last_synced_at: string | null;
  last_error: string | null;
}

interface SummaryListingRow {
  shop_id: string;
  product_id: string | null;
  state: string | null;
  inventory: number;
  has_active_version: number;
}

const KNOWN_JOOM_STATES = new Set(['active', 'archived', 'disabledByJoom', 'disabledByMerchant', 'locked', 'pending', 'rejected', 'warning', 'notFound']);

export interface JoomShopListingInput {
  remote: RemoteProduct;
  productId?: string;
}

const emptyCounts = (): JoomShopStatusCounts => ({
  active: 0,
  oos: 0,
  error: 0,
  optimize: 0,
  pending: 0,
  offline: 0,
  unknown: 0,
});

function rowToSnapshot(row: ListingRow): JoomShopListingSnapshot {
  return {
    shopId: row.shop_id,
    shopName: row.shop_name,
    joomProductId: row.joom_product_id,
    productId: row.product_id ?? undefined,
    sku: row.sku ?? undefined,
    name: row.name ?? undefined,
    state: row.state ?? undefined,
    updateTimestamp: row.joom_updated_at ?? undefined,
    inventory: row.inventory,
    hasActiveVersion: Boolean(row.has_active_version),
    issues: row.issues ?? undefined,
    issueDetails: row.issue_details ? JSON.parse(row.issue_details) : undefined,
    present: Boolean(row.present),
    lastSyncedAt: row.last_synced_at,
  };
}

function addToCounts(counts: JoomShopStatusCounts, listing: Pick<JoomShopListingSnapshot, 'state' | 'inventory' | 'hasActiveVersion'>) {
  if (!listing.state || !KNOWN_JOOM_STATES.has(listing.state)) {
    counts.unknown++;
    return;
  }
  const bucket = classifyJoomListing({
    joomState: listing.state,
    joomInventory: listing.inventory,
    joomHasActiveVersion: listing.hasActiveVersion,
  });
  counts[bucket ?? 'unknown']++;
}

export class JoomListingRepository {
  listForProducts(productIds: string[]): Map<string, JoomShopListingSnapshot[]> {
    const result = new Map<string, JoomShopListingSnapshot[]>();
    if (!productIds.length) return result;
    const uniqueIds = [...new Set(productIds)];
    // Keep well below SQLite's host-parameter limit and use the product_id index.
    for (let start = 0; start < uniqueIds.length; start += 500) {
      const chunk = uniqueIds.slice(start, start + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = getDb().prepare(
        `SELECT * FROM joom_shop_listings WHERE product_id IN (${placeholders}) ORDER BY shop_id, joom_product_id`,
      ).all(...chunk) as ListingRow[];
      for (const row of rows) {
        if (!row.product_id) continue;
        const entries = result.get(row.product_id) ?? [];
        entries.push(rowToSnapshot(row));
        result.set(row.product_id, entries);
      }
    }
    return result;
  }

  listAll(): JoomShopListingSnapshot[] {
    return (getDb().prepare('SELECT * FROM joom_shop_listings ORDER BY shop_id, joom_product_id').all() as ListingRow[])
      .map(rowToSnapshot);
  }

  /** 发布回执确认了店铺与商品的对应关系，保留上次同步得到的审核状态和库存。 */
  linkPublishedProduct(shopId: string, shopName: string, remoteId: string, productId: string, name: string, sku?: string): void {
    getDb().prepare(`
      INSERT INTO joom_shop_listings (shop_id, shop_name, joom_product_id, product_id, name, sku, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, joom_product_id) DO UPDATE SET product_id = excluded.product_id, present = 1
    `).run(shopId, shopName, remoteId, productId, name, sku ?? null, new Date().toISOString());
  }

  markAbsent(shopId: string, remoteId: string): void {
    getDb().prepare('UPDATE joom_shop_listings SET present = 0, last_synced_at = ? WHERE shop_id = ? AND joom_product_id = ?')
      .run(new Date().toISOString(), shopId, remoteId);
  }

  upsertShopListing(shopId: string, shopName: string, remote: RemoteProduct, productId: string | undefined, syncedAt: string): void {
    if (!remote.id) return;
    getDb().prepare(`
      INSERT INTO joom_shop_listings (
        shop_id, joom_product_id, product_id, shop_name, sku, name, state,
        joom_updated_at, inventory, has_active_version, issues, issue_details,
        present, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(shop_id, joom_product_id) DO UPDATE SET
        product_id = excluded.product_id,
        shop_name = excluded.shop_name,
        sku = excluded.sku,
        name = excluded.name,
        state = excluded.state,
        joom_updated_at = excluded.joom_updated_at,
        inventory = excluded.inventory,
        has_active_version = excluded.has_active_version,
        issues = excluded.issues,
        issue_details = excluded.issue_details,
        present = 1,
        last_synced_at = excluded.last_synced_at
    `).run(
      shopId,
      remote.id,
      productId ?? null,
      shopName,
      remote.sku ?? null,
      remote.name ?? null,
      remote.state ?? null,
      remote.updateTimestamp ?? null,
      remote.inventory ?? 0,
      remote.hasActiveVersion ? 1 : 0,
      remote.issues ?? null,
      remote.issueDetails?.length ? JSON.stringify(remote.issueDetails) : null,
      syncedAt,
    );
  }

  /** Replace one shop's full remote snapshot after a successful, fully paginated read. */
  replaceShopSnapshot(shopId: string, shopName: string, listings: JoomShopListingInput[], syncedAt: string): void {
    const db = getDb();
    const previous = db.prepare(
      'SELECT * FROM joom_shop_listings WHERE shop_id = ?',
    ).all(shopId) as ListingRow[];
    const incomingIds = new Set(listings.map(({ remote }) => remote.id).filter(Boolean));
    const upsert = db.prepare(`
      INSERT INTO joom_shop_listings (
        shop_id, joom_product_id, product_id, shop_name, sku, name, state,
        joom_updated_at, inventory, has_active_version, issues, issue_details,
        present, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(shop_id, joom_product_id) DO UPDATE SET
        product_id = excluded.product_id,
        shop_name = excluded.shop_name,
        sku = excluded.sku,
        name = excluded.name,
        state = excluded.state,
        joom_updated_at = excluded.joom_updated_at,
        inventory = excluded.inventory,
        has_active_version = excluded.has_active_version,
        issues = excluded.issues,
        issue_details = excluded.issue_details,
        present = 1,
        last_synced_at = excluded.last_synced_at
    `);
    const markMissing = db.prepare(`
      UPDATE joom_shop_listings
      SET state = 'notFound', inventory = 0, has_active_version = 0,
          issues = '店铺整店同步未返回此商品', issue_details = NULL,
          present = 0, last_synced_at = ?
      WHERE shop_id = ? AND joom_product_id = ?
    `);
    const saveSync = db.prepare(`
      INSERT INTO joom_shop_syncs (shop_id, shop_name, last_synced_at, last_error)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(shop_id) DO UPDATE SET
        shop_name = excluded.shop_name,
        last_synced_at = excluded.last_synced_at,
        last_error = NULL
    `);

    db.transaction(() => {
      for (const { remote, productId } of listings) {
        if (!remote.id) continue;
        upsert.run(
          shopId,
          remote.id,
          productId ?? null,
          shopName,
          remote.sku ?? null,
          remote.name ?? null,
          remote.state ?? null,
          remote.updateTimestamp ?? null,
          remote.inventory ?? 0,
          remote.hasActiveVersion ? 1 : 0,
          remote.issues ?? null,
          remote.issueDetails?.length ? JSON.stringify(remote.issueDetails) : null,
          syncedAt,
        );
      }
      for (const row of previous) {
        if (!incomingIds.has(row.joom_product_id)) markMissing.run(syncedAt, shopId, row.joom_product_id);
      }
      saveSync.run(shopId, shopName, syncedAt);
    })();
  }

  recordShopSyncError(shopId: string, shopName: string, error: string): void {
    getDb().prepare(`
      INSERT INTO joom_shop_syncs (shop_id, shop_name, last_error)
      VALUES (?, ?, ?)
      ON CONFLICT(shop_id) DO UPDATE SET shop_name = excluded.shop_name, last_error = excluded.last_error
    `).run(shopId, shopName, error);
  }

  getSummary(profiles: Array<Pick<ShopStatusItem, 'id' | 'name' | 'connected'>>): JoomShopStatusSummary {
    // The dashboard only needs counters. Avoid reading names, issues and large
    // issue_details JSON blobs for every remote listing.
    const rows = getDb().prepare(`
      SELECT shop_id, product_id, state, inventory, has_active_version
      FROM joom_shop_listings
      WHERE present = 1
    `).all() as SummaryListingRow[];
    const syncRows = getDb().prepare('SELECT * FROM joom_shop_syncs').all() as SyncRow[];
    const syncByShop = new Map(syncRows.map((row) => [row.shop_id, row]));
    const shops = profiles.map((profile) => {
      const sync = syncByShop.get(profile.id);
      const shopRows = rows.filter((row) => row.shop_id === profile.id);
      const byListing = emptyCounts();
      for (const row of shopRows) addToCounts(byListing, {
        state: row.state ?? undefined,
        inventory: row.inventory,
        hasActiveVersion: Boolean(row.has_active_version),
      });
      return {
        shopId: profile.id,
        shopName: profile.name || sync?.shop_name || profile.id,
        connected: profile.connected,
        total: shopRows.length,
        unmatchedRemote: shopRows.filter((row) => !row.product_id).length,
        byListing,
        lastSyncedAt: sync?.last_synced_at ?? undefined,
        lastError: sync?.last_error ?? undefined,
      };
    });
    const counts = emptyCounts();
    for (const shop of shops) {
      for (const key of Object.keys(counts) as Array<keyof JoomShopStatusCounts>) counts[key] += shop.byListing[key];
    }
    const lastSyncedAt = shops.reduce<string | undefined>((latest, shop) => {
      if (!shop.lastSyncedAt) return latest;
      return !latest || shop.lastSyncedAt > latest ? shop.lastSyncedAt : latest;
    }, undefined);
    return {
      total: shops.reduce((sum, shop) => sum + shop.total, 0),
      unmatchedRemote: shops.reduce((sum, shop) => sum + shop.unmatchedRemote, 0),
      byListing: counts,
      lastSyncedAt,
      shops,
    };
  }
}

export const joomListingRepository = new JoomListingRepository();
