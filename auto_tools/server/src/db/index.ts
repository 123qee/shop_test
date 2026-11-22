import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../util/logger.js';
import { collectionKeys } from './collection-keys.js';

let db: Database.Database | null = null;

/** 获取单例数据库连接(首次调用时建库并跑迁移)。 */
export function getDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  logger.info('数据库已就绪', { path: config.dbPath });
  return db;
}

/**
 * 迁移:每条建表/变更语句幂等(IF NOT EXISTS)。
 * 后续新增字段/表时在此追加,保持向前兼容。
 */
function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS collect_batches (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, template_id TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collect_batches_created ON collect_batches(created_at);
    CREATE TABLE IF NOT EXISTS collect_batch_items (
      batch_id TEXT NOT NULL REFERENCES collect_batches(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      product_id TEXT REFERENCES products(id) ON DELETE SET NULL, reason TEXT,
      PRIMARY KEY (batch_id, url), UNIQUE (batch_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_collect_batch_items_product ON collect_batch_items(product_id);
    CREATE TABLE IF NOT EXISTS personal_projects (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_tasks (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES personal_projects(id),
      data TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_personal_tasks_project ON personal_tasks(project_id);
    CREATE TABLE IF NOT EXISTS personal_task_completions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES personal_tasks(id),
      occurrence_date TEXT NOT NULL, completed_at TEXT NOT NULL,
      UNIQUE(task_id, occurrence_date)
    );
    CREATE TABLE IF NOT EXISTS products (
      id           TEXT PRIMARY KEY,
      status       TEXT NOT NULL,
      collected    TEXT NOT NULL,           -- JSON: CollectedProduct
      edited       TEXT,                     -- JSON: EditableProduct | null
      joom_product_id TEXT,
      last_error   TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
    CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at);

    -- Current Joom listings are stored per shop, including listings that are not in the local catalog.
    CREATE TABLE IF NOT EXISTS joom_shop_listings (
      shop_id TEXT NOT NULL,
      joom_product_id TEXT NOT NULL,
      product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
      shop_name TEXT NOT NULL DEFAULT '',
      sku TEXT,
      name TEXT,
      state TEXT,
      joom_updated_at TEXT,
      inventory INTEGER NOT NULL DEFAULT 0,
      has_active_version INTEGER NOT NULL DEFAULT 0,
      issues TEXT,
      issue_details TEXT,
      present INTEGER NOT NULL DEFAULT 1,
      last_synced_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, joom_product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_joom_shop_listings_product ON joom_shop_listings(product_id);
    CREATE INDEX IF NOT EXISTS idx_joom_shop_listings_shop_present ON joom_shop_listings(shop_id, present);

    CREATE TABLE IF NOT EXISTS joom_shop_syncs (
      shop_id TEXT PRIMARY KEY,
      shop_name TEXT NOT NULL,
      last_synced_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS publish_jobs (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publish_job_items (
      job_id TEXT NOT NULL REFERENCES publish_jobs(id),
      product_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      joom_product_id TEXT,
      position INTEGER NOT NULL,
      PRIMARY KEY (job_id, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_publish_job_items_status ON publish_job_items(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_job_items_active_product
      ON publish_job_items(product_id) WHERE status IN ('queued', 'running');

    -- 各目标平台的 OAuth token,按 marketplace 区分(未来多平台复用)
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      marketplace   TEXT PRIMARY KEY,        -- e.g. 'joom'
      env           TEXT NOT NULL,           -- production | sandbox
      access_token  TEXT NOT NULL,
      refresh_token TEXT,
      expires_at    TEXT,                     -- ISO
      updated_at    TEXT NOT NULL
    );

    -- 键值配置(如默认 storeId 等)
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_product ON audit_logs(product_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

    -- Mercado Libre accounts and platform-owned drafts. Joom's legacy columns remain untouched.
    CREATE TABLE IF NOT EXISTS mercadolibre_accounts (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL UNIQUE,
      nickname      TEXT,
      model         TEXT NOT NULL DEFAULT 'unknown',
      tags          TEXT NOT NULL DEFAULT '[]',
      sites         TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mercadolibre_listings (
      id            TEXT PRIMARY KEY,
      product_id    TEXT NOT NULL,
      account_id    TEXT,
      site_id       TEXT NOT NULL,
      template_id   TEXT,
      status        TEXT NOT NULL DEFAULT 'draft',
      draft         TEXT NOT NULL,
      remote        TEXT,
      last_error    TEXT,
      last_synced_at TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(product_id, account_id, site_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ml_listings_product ON mercadolibre_listings(product_id);
    CREATE INDEX IF NOT EXISTS idx_ml_listings_status ON mercadolibre_listings(status);

    CREATE TABLE IF NOT EXISTS mercadolibre_picture_mappings (
      source_url    TEXT PRIMARY KEY,
      picture_id    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    -- 订单导出：各平台订单统一存储，uid = 平台:店铺:订单号。时间均为 UTC ISO。
    CREATE TABLE IF NOT EXISTS orders (
      uid         TEXT PRIMARY KEY,
      platform    TEXT NOT NULL,
      shop_id     TEXT NOT NULL,
      order_id    TEXT NOT NULL,
      shop_name   TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL,
      raw_status  TEXT NOT NULL DEFAULT '',
      ordered_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      currency    TEXT,
      address     TEXT,                    -- JSON: OrderAddress（买家信息，仅本机）
      tracking    TEXT,                    -- JSON: OrderTracking
      raw         TEXT,                    -- 平台原始返回
      synced_at   TEXT NOT NULL,
      UNIQUE(platform, shop_id, order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_orders_shop_ordered ON orders(platform, shop_id, ordered_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS order_lines (
      uid          TEXT PRIMARY KEY,         -- 订单 uid + '#' + line_id
      order_uid    TEXT NOT NULL REFERENCES orders(uid) ON DELETE CASCADE,
      line_id      TEXT NOT NULL,
      product_id   TEXT,
      product_sku  TEXT,
      variant_id   TEXT,
      variant_sku  TEXT,
      title        TEXT,
      color        TEXT,
      size         TEXT,
      image_url    TEXT,
      quantity     INTEGER NOT NULL,
      unit_price   REAL,
      amount       REAL,
      material_hint TEXT,
      is_gift      INTEGER NOT NULL DEFAULT 0,
      position     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_uid);

    CREATE TABLE IF NOT EXISTS order_sync_state (
      platform        TEXT NOT NULL,
      shop_id         TEXT NOT NULL,
      synced_until    TEXT,                 -- 下次增量从这里（减重叠）开始
      covered_from    TEXT,                 -- 本地已覆盖的最早更新时间
      last_run_at     TEXT,
      last_success_at TEXT,
      last_error      TEXT,
      PRIMARY KEY (platform, shop_id)
    );

    CREATE TABLE IF NOT EXISTS order_sync_jobs (
      id          TEXT PRIMARY KEY,
      status      TEXT NOT NULL,
      params      TEXT NOT NULL,
      progress    TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      finished_at TEXT
    );

    -- 订单里只有商品/变体 id，标题、颜色、尺码、材质原文从平台商品接口读取后缓存
    CREATE TABLE IF NOT EXISTS order_product_cache (
      platform    TEXT NOT NULL,
      shop_id     TEXT NOT NULL,
      product_id  TEXT NOT NULL,
      data        TEXT NOT NULL,
      fetched_at  TEXT NOT NULL,
      PRIMARY KEY (platform, shop_id, product_id)
    );

    -- 预览里「记住」的商品材质，只用于订单导出，不回写商品库分组
    CREATE TABLE IF NOT EXISTS order_material_rules (
      id          TEXT PRIMARY KEY,
      platform    TEXT NOT NULL,
      product_id  TEXT,
      product_sku TEXT,
      title       TEXT,
      material    TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_order_material_rules_product
      ON order_material_rules(platform, product_id) WHERE product_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_order_material_rules_sku ON order_material_rules(platform, product_sku);

    CREATE TABLE IF NOT EXISTS order_exports (
      id            TEXT PRIMARY KEY,
      profile_id    TEXT NOT NULL,
      profile_name  TEXT NOT NULL,
      query         TEXT NOT NULL,
      summary       TEXT NOT NULL,
      files         TEXT NOT NULL,
      zip_name      TEXT NOT NULL,
      files_expired INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_order_exports_created ON order_exports(created_at);

    -- 按方案记录已导出的订单行；同一订单在不同方案里各算各的
    CREATE TABLE IF NOT EXISTS order_export_marks (
      profile_id  TEXT NOT NULL,
      line_uid    TEXT NOT NULL,
      export_id   TEXT NOT NULL,
      material    TEXT NOT NULL,
      exported_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, line_uid)
    );
    CREATE INDEX IF NOT EXISTS idx_order_export_marks_line ON order_export_marks(line_uid);
  `);

  // 增量列(SQLite 无 ADD COLUMN IF NOT EXISTS,先探测)
  addColumnIfMissing(d, 'order_lines', 'image_urls', 'TEXT');
  addColumnIfMissing(d, 'order_material_rules', 'polyester_type', 'TEXT');
  addColumnIfMissing(d, 'products', 'template_id', 'TEXT');
  addColumnIfMissing(d, 'products', 'grouping', 'TEXT');
  addColumnIfMissing(d, 'products', 'template_confirmed', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(d, 'products', 'joom_state', 'TEXT');
  addColumnIfMissing(d, 'products', 'joom_updated_at', 'TEXT');
  addColumnIfMissing(d, 'products', 'last_synced_at', 'TEXT');
  addColumnIfMissing(d, 'products', 'joom_inventory', 'INTEGER');
  addColumnIfMissing(d, 'products', 'joom_has_active_version', 'INTEGER');
  addColumnIfMissing(d, 'products', 'joom_issues', 'TEXT');
  addColumnIfMissing(d, 'products', 'joom_issue_details', 'TEXT');
  addColumnIfMissing(d, 'products', 'joom_video', 'TEXT');
  addColumnIfMissing(d, 'products', 'edited_at', 'TEXT');
  // Index existing JSON in place so old records and edits through other SQLite clients stay searchable.
  // sourceId leads its index so it also supports the cross-platform SKU collision check.
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_collect_id
      ON products(${collectionKeys.sourceId}, ${collectionKeys.source}, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_products_collect_url
      ON products(${collectionKeys.source}, ${collectionKeys.url}, created_at DESC) WHERE status <> 'discarded';
    CREATE INDEX IF NOT EXISTS idx_products_generated_sku
      ON products(${collectionKeys.generatedSku});
    CREATE INDEX IF NOT EXISTS idx_products_edited_sku
      ON products(${collectionKeys.editedSku});
  `);
  // 订单按 Joom 商品 id / SKU 找本地商品（读取材质）。products 行里有大段 JSON，无索引时每次查询约 1.5 秒。
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_joom_product_id ON products(joom_product_id);
    CREATE INDEX IF NOT EXISTS idx_joom_shop_listings_joom_product ON joom_shop_listings(joom_product_id);
    CREATE INDEX IF NOT EXISTS idx_joom_shop_listings_sku ON joom_shop_listings(sku);
  `);
  // Recover shop ownership where a successful publish job recorded both the store and
  // the product's current Joom id. Legacy snapshots without this evidence remain unassigned.
  d.exec(`
    INSERT OR IGNORE INTO joom_shop_listings (
      shop_id, joom_product_id, product_id, shop_name, state, inventory,
      has_active_version, present, last_synced_at
    )
    SELECT j.shop_id, i.joom_product_id, i.product_id, '', 'notFound', 0, 0, 0, j.created_at
    FROM publish_job_items i
    JOIN publish_jobs j ON j.id = i.job_id
    JOIN products p ON p.id = i.product_id AND p.joom_product_id = i.joom_product_id
    WHERE i.status = 'succeeded' AND COALESCE(i.joom_product_id, '') <> ''
  `);
  // A legacy global notFound flag came from checking one active shop against every
  // local product. Keep it only where a publish job proves the owning shop.
  d.exec(`
    UPDATE products
    SET joom_state = NULL, joom_updated_at = NULL, last_synced_at = NULL,
        joom_inventory = NULL, joom_has_active_version = NULL,
        joom_issues = NULL, joom_issue_details = NULL
    WHERE joom_state = 'notFound'
      AND NOT EXISTS (
        SELECT 1 FROM joom_shop_listings l WHERE l.product_id = products.id
      )
  `);
  d.exec(`
    UPDATE products
    SET edited_at = updated_at
    WHERE edited IS NOT NULL AND edited_at IS NULL
  `);

  addColumnIfMissing(d, 'publish_job_items', 'submission', 'TEXT');
  // Recover the latest unresolved attempt from versions that only recorded a text error.
  d.exec(`
    UPDATE publish_job_items AS item SET status = 'needs_review'
    WHERE status = 'failed'
      AND (error LIKE '服务在发布过程中重启%' OR lower(error) LIKE '%already%exists%')
      AND EXISTS (SELECT 1 FROM products WHERE id = item.product_id)
      AND NOT EXISTS (
        SELECT 1 FROM publish_job_items newer
        JOIN publish_jobs j ON j.id = newer.job_id
        WHERE newer.product_id = item.product_id
        AND j.rowid > (SELECT rowid FROM publish_jobs WHERE id = item.job_id)
      )
  `);
  // Derived cross-page filters. Keep dependent writes and invalidation atomic, including changes made by other processes.
  d.exec(`
    CREATE TABLE IF NOT EXISTS product_catalog_index (
      product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE, summary TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_catalog_version (id INTEGER PRIMARY KEY CHECK(id = 1), version TEXT NOT NULL);
    INSERT OR IGNORE INTO product_catalog_version VALUES (1, lower(hex(randomblob(16))));
  `);
  const bump = 'UPDATE product_catalog_version SET version = lower(hex(randomblob(16))) WHERE id = 1;';
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    d.exec(`
      CREATE TRIGGER IF NOT EXISTS catalog_products_${operation} AFTER ${operation} ON products BEGIN
        DELETE FROM product_catalog_index WHERE product_id = ${row}.id;
        ${bump}
      END;
      CREATE TRIGGER IF NOT EXISTS catalog_listings_${operation} AFTER ${operation} ON joom_shop_listings BEGIN
        DELETE FROM product_catalog_index WHERE product_id = ${row}.product_id
          ${operation === 'UPDATE' ? 'OR product_id = OLD.product_id' : ''};
        ${bump}
      END;
      CREATE TRIGGER IF NOT EXISTS catalog_presets_${operation} AFTER ${operation} ON settings
      WHEN ${row}.key = 'presets' ${operation === 'UPDATE' ? 'AND OLD.value IS NOT NEW.value' : ''} BEGIN
        DELETE FROM product_catalog_index;
        ${bump}
      END;
    `);
  }

}

/** 若列不存在则新增,保证向前兼容。 */
function addColumnIfMissing(d: Database.Database, table: string, column: string, type: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
