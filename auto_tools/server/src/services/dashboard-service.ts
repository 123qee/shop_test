import type { DashboardStats } from '@shared/types';
import { dashboardRepository, type DashboardRepository } from '../repositories/dashboard-repository.js';
import { auditService } from './audit-service.js';
import { syncService } from './sync-service.js';

export class DashboardService {
  constructor(private readonly repo: DashboardRepository = dashboardRepository) {}

  getStats(): DashboardStats {
    const counts = this.repo.getProductCounts();
    const joomStatus = syncService.getShopStatusSummary();
    const byListing: Record<string, number> = { ...joomStatus.byListing };
    return {
      total: counts.total,
      byStatus: counts.byStatus,
      byJoomState: counts.byJoomState,
      byListing,
      joomStatus,
      unsyncedPublished: counts.unsyncedPublished,
      lastShopSyncedAt: joomStatus.lastSyncedAt,
      recentActivity: auditService.list({ limit: 12, includeDetails: false }),
    };
  }
}

export const dashboardService = new DashboardService();
