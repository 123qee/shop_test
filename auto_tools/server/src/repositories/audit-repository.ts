import type { AuditLogEntry } from '@shared/types';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';

export interface AuditRepository {
  add(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): AuditLogEntry;
  list(options?: { productId?: string; limit?: number; includeDetails?: boolean }): AuditLogEntry[];
  get(id: string): AuditLogEntry | null;
}

interface Row {
  id: string;
  product_id: string | null;
  action: string;
  summary: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

function parse(value: string | null): unknown {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

function toEntry(row: Row): AuditLogEntry {
  return {
    id: row.id,
    productId: row.product_id ?? undefined,
    action: row.action,
    summary: row.summary,
    before: parse(row.before_json),
    after: parse(row.after_json),
    createdAt: row.created_at,
  };
}

export class SqliteAuditRepository implements AuditRepository {
  add(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): AuditLogEntry {
    const row: AuditLogEntry = { ...entry, id: uuid(), createdAt: new Date().toISOString() };
    getDb().prepare(`INSERT INTO audit_logs (id, product_id, action, summary, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.productId ?? null, row.action, row.summary,
      row.before === undefined ? null : JSON.stringify(row.before),
      row.after === undefined ? null : JSON.stringify(row.after), row.createdAt,
    );
    return row;
  }

  list(options: { productId?: string; limit?: number; includeDetails?: boolean } = {}): AuditLogEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const columns = options.includeDetails === false
      ? 'id, product_id, action, summary, created_at'
      : '*';
    const rows = options.productId
      ? getDb().prepare(`SELECT ${columns} FROM audit_logs WHERE product_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(options.productId, limit)
      : getDb().prepare(`SELECT ${columns} FROM audit_logs ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit);
    return (rows as Row[]).map(toEntry);
  }

  get(id: string): AuditLogEntry | null {
    const row = getDb().prepare(`SELECT * FROM audit_logs WHERE id = ?`).get(id) as Row | undefined;
    return row ? toEntry(row) : null;
  }
}

export const auditRepository: AuditRepository = new SqliteAuditRepository();
