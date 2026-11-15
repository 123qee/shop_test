import type { AuditLogEntry } from '@shared/types';
import { auditRepository, type AuditRepository } from '../repositories/audit-repository.js';

export class AuditService {
  constructor(private readonly repo: AuditRepository = auditRepository) {}
  record(entry: Omit<AuditLogEntry, 'id' | 'createdAt'>): AuditLogEntry { return this.repo.add(entry); }
  list(options?: { productId?: string; limit?: number; includeDetails?: boolean }): AuditLogEntry[] { return this.repo.list(options); }
  get(id: string): AuditLogEntry | null { return this.repo.get(id); }
}

export const auditService = new AuditService();
