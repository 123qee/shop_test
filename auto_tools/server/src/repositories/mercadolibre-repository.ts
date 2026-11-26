import type {
  MercadoLibreAccountPublic,
  MercadoLibreListingDraft,
  MercadoLibreListingIndexItem,
  MercadoLibreSellerModel,
  MercadoLibreSitePublic,
} from '@shared/types';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';

interface AccountRow {
  id: string;
  user_id: string;
  nickname: string | null;
  model: string;
  tags: string;
  sites: string;
  created_at: string;
  updated_at: string;
}

interface ListingRow {
  id: string;
  product_id: string;
  account_id: string | null;
  site_id: string;
  template_id: string | null;
  status: string;
  draft: string;
  remote: string | null;
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export class MercadoLibreRepository {
  upsertAccount(input: {
    userId: string;
    nickname?: string;
    model: MercadoLibreSellerModel;
    tags: string[];
    sites: MercadoLibreSitePublic[];
  }): MercadoLibreAccountPublic {
    const existing = getDb().prepare(`SELECT id FROM mercadolibre_accounts WHERE user_id = ?`).get(input.userId) as { id: string } | undefined;
    const id = existing?.id ?? uuid();
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO mercadolibre_accounts (id, user_id, nickname, model, tags, sites, created_at, updated_at)
       VALUES (@id, @userId, @nickname, @model, @tags, @sites, @createdAt, @updatedAt)
       ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname, model = excluded.model,
       tags = excluded.tags, sites = excluded.sites, updated_at = excluded.updated_at`,
    ).run({
      id,
      userId: input.userId,
      nickname: input.nickname ?? null,
      model: input.model,
      tags: JSON.stringify(input.tags),
      sites: JSON.stringify(input.sites),
      createdAt: now,
      updatedAt: now,
    });
    return this.getAccount(id)!;
  }

  getAccount(id: string): MercadoLibreAccountPublic | null {
    const row = getDb().prepare(`SELECT * FROM mercadolibre_accounts WHERE id = ?`).get(id) as AccountRow | undefined;
    return row ? this.accountPublic(row, false) : null;
  }

  listAccounts(connectedAccountIds = new Set<string>(), expiresAtByAccount = new Map<string, string | undefined>()): MercadoLibreAccountPublic[] {
    const rows = getDb().prepare(`SELECT * FROM mercadolibre_accounts ORDER BY created_at ASC`).all() as AccountRow[];
    return rows.map((row) => this.accountPublic(row, connectedAccountIds.has(row.id), expiresAtByAccount.get(row.id)));
  }

  deleteAccount(id: string): void {
    getDb().prepare(`DELETE FROM mercadolibre_accounts WHERE id = ?`).run(id);
  }

  createListing(draft: Omit<MercadoLibreListingDraft, 'id' | 'createdAt' | 'updatedAt'>): MercadoLibreListingDraft {
    const id = uuid();
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO mercadolibre_listings
       (id, product_id, account_id, site_id, template_id, status, draft, remote, last_error, last_synced_at, created_at, updated_at)
       VALUES (@id, @productId, @accountId, @siteId, @templateId, @status, @draft, @remote, @lastError, @lastSyncedAt, @createdAt, @updatedAt)`,
    ).run({
      id,
      productId: draft.productId,
      accountId: draft.accountId ?? null,
      siteId: draft.siteId,
      templateId: draft.templateId ?? null,
      status: draft.status,
      draft: JSON.stringify({ ...draft, id, createdAt: now, updatedAt: now }),
      remote: draft.remote ? JSON.stringify(draft.remote) : null,
      lastError: draft.lastError ?? null,
      lastSyncedAt: draft.lastSyncedAt ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return this.getListing(id)!;
  }

  getListing(id: string): MercadoLibreListingDraft | null {
    const row = getDb().prepare(`SELECT * FROM mercadolibre_listings WHERE id = ?`).get(id) as ListingRow | undefined;
    return row ? this.listingPublic(row) : null;
  }

  listListings(productId?: string): MercadoLibreListingDraft[] {
    const rows = productId
      ? getDb().prepare(`SELECT * FROM mercadolibre_listings WHERE product_id = ? ORDER BY site_id`).all(productId)
      : getDb().prepare(`SELECT * FROM mercadolibre_listings ORDER BY updated_at DESC`).all();
    return (rows as ListingRow[]).map((row) => this.listingPublic(row));
  }

  listListingIndex(): MercadoLibreListingIndexItem[] {
    // Extract only management fields in SQLite; do not materialize complete drafts in Node.
    return getDb().prepare(`
      WITH listings AS (
        SELECT id, product_id, site_id, status, updated_at, last_error,
          CASE WHEN json_valid(draft) THEN draft ELSE '{}' END AS data
        FROM mercadolibre_listings
      )
      SELECT id, product_id AS productId, site_id AS siteId, status,
        COALESCE(json_extract(data, '$.title'), '') AS title,
        json_extract(data, '$.categoryId') AS categoryId,
        updated_at AS updatedAt, last_error AS lastError,
        COALESCE((SELECT group_concat(json_extract(value, '$.sku'), ' ')
          FROM json_each(data, '$.variants') WHERE json_type(value, '$.sku') = 'text'), '') AS skuSearchText
      FROM listings ORDER BY updated_at DESC, id
    `).all().map((row) => {
      const item = row as MercadoLibreListingIndexItem;
      return { ...item, categoryId: item.categoryId ?? undefined, lastError: item.lastError ?? undefined,
        skuSearchText: item.skuSearchText?.toLowerCase() };
    });
  }

  findListing(productId: string, accountId: string | undefined, siteId: string): MercadoLibreListingDraft | null {
    const row = getDb().prepare(
      `SELECT * FROM mercadolibre_listings WHERE product_id = ? AND account_id IS ? AND site_id = ?`,
    ).get(productId, accountId ?? null, siteId) as ListingRow | undefined;
    return row ? this.listingPublic(row) : null;
  }

  updateListing(id: string, patch: Partial<MercadoLibreListingDraft> & { lastError?: string }): MercadoLibreListingDraft | null {
    const current = this.getListing(id);
    if (!current) return null;
    const next = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    getDb().prepare(
      `UPDATE mercadolibre_listings SET template_id = ?, status = ?, draft = ?, remote = ?, last_error = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.templateId ?? null,
      next.status,
      JSON.stringify(next),
      next.remote ? JSON.stringify(next.remote) : null,
      next.lastError ?? null,
      next.lastSyncedAt ?? null,
      next.updatedAt,
      id,
    );
    return this.getListing(id);
  }

  deleteListing(id: string): void {
    getDb().prepare(`DELETE FROM mercadolibre_listings WHERE id = ?`).run(id);
  }

  getPictureMapping(sourceUrl: string): string | undefined {
    const row = getDb().prepare(`SELECT picture_id FROM mercadolibre_picture_mappings WHERE source_url = ?`).get(sourceUrl) as { picture_id: string } | undefined;
    return row?.picture_id;
  }

  savePictureMapping(sourceUrl: string, pictureId: string): void {
    getDb().prepare(
      `INSERT INTO mercadolibre_picture_mappings (source_url, picture_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(source_url) DO UPDATE SET picture_id = excluded.picture_id, updated_at = excluded.updated_at`,
    ).run(sourceUrl, pictureId, new Date().toISOString());
  }

  private accountPublic(row: AccountRow, connected: boolean, expiresAt?: string): MercadoLibreAccountPublic {
    return {
      id: row.id,
      userId: row.user_id,
      nickname: row.nickname ?? undefined,
      model: row.model as MercadoLibreSellerModel,
      tags: parseJson<string[]>(row.tags, []),
      sites: parseJson<MercadoLibreSitePublic[]>(row.sites, []),
      connected,
      expiresAt,
    };
  }

  private listingPublic(row: ListingRow): MercadoLibreListingDraft {
    const parsed = parseJson<MercadoLibreListingDraft>(row.draft, {} as MercadoLibreListingDraft);
    return {
      ...parsed,
      id: row.id,
      productId: row.product_id,
      accountId: row.account_id ?? undefined,
      siteId: row.site_id as MercadoLibreListingDraft['siteId'],
      templateId: row.template_id ?? undefined,
      status: row.status as MercadoLibreListingDraft['status'],
      remote: row.remote ? parseJson(row.remote, parsed.remote) : parsed.remote,
      lastError: row.last_error ?? undefined,
      lastSyncedAt: row.last_synced_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const mercadoLibreRepository = new MercadoLibreRepository();
