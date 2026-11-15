import { getDb } from '../db/index.js';

export interface DashboardProductCounts {
  total: number;
  byStatus: Record<string, number>;
  byJoomState: Record<string, number>;
  unsyncedPublished: number;
}

interface CountRow {
  key: string;
  count: number;
}

function rowsToCounts(rows: CountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

/**
 * Workbench counters are deliberately computed in SQLite. Product JSON can be
 * large, and none of it is needed to count statuses shown on the dashboard.
 */
export class DashboardRepository {
  getProductCounts(): DashboardProductCounts {
    const db = getDb();
    const byStatus = rowsToCounts(db.prepare(`
      SELECT status AS key, COUNT(*) AS count
      FROM products
      GROUP BY status
    `).all() as CountRow[]);
    const byJoomState = rowsToCounts(db.prepare(`
      SELECT joom_state AS key, COUNT(*) AS count
      FROM products
      WHERE joom_state IS NOT NULL AND joom_state <> ''
      GROUP BY joom_state
    `).all() as CountRow[]);
    const unsynced = db.prepare(`
      SELECT COUNT(*) AS count
      FROM products p
      WHERE (p.joom_product_id IS NOT NULL OR p.status = 'published')
        AND NOT EXISTS (
          SELECT 1 FROM joom_shop_listings l WHERE l.product_id = p.id
        )
    `).get() as { count: number };

    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
      byJoomState,
      unsyncedPublished: unsynced.count,
    };
  }
}

export const dashboardRepository = new DashboardRepository();
