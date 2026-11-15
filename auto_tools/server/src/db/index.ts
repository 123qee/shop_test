import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../util/logger.js';

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
  `);

  // 增量列(SQLite 无 ADD COLUMN IF NOT EXISTS,先探测)
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

  // 兼容已发生过的重复商品错误：服务升级后也自动归档，不再进入未发布列表。
  d.exec(`
    UPDATE products
    SET status = 'discarded'
    WHERE status = 'failed'
      AND lower(COALESCE(last_error, '')) LIKE '%already%exists%'
  `);
}

/** 若列不存在则新增,保证向前兼容。 */
function addColumnIfMissing(d: Database.Database, table: string, column: string, type: string) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
