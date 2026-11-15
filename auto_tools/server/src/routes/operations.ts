import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { dashboardService } from '../services/dashboard-service.js';
import { auditService } from '../services/audit-service.js';

export const operationsRouter = Router();

operationsRouter.get('/dashboard', asyncHandler(async (_req, res) => res.json(dashboardService.getStats())));
operationsRouter.get('/audit-logs', asyncHandler(async (req, res) => {
  res.json(auditService.list({ limit: Number(req.query.limit) || 100 }));
}));
