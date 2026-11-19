import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { MarketplaceError } from '../marketplaces/types.js';
import { PublishValidationError } from '../services/validation.js';
import { AiNotConfiguredError } from '../services/ai-title-service.js';
import { PublishJobInputError } from '../services/publish-job-service.js';
import { PublishShopError } from '../services/shop-service.js';
import { PresetConflictError } from '../services/settings-service.js';
import { TemplateDecisionError } from '../services/template-decision-service.js';
import { DraftImageError } from '../services/product-service.js';
import { logger } from '../util/logger.js';

/** 统一错误响应,输出 shared 的 ApiError 结构。 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof PresetConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof TemplateDecisionError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof DraftImageError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof PublishJobInputError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof PublishShopError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof AiNotConfiguredError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof PublishValidationError) {
    res.status(400).json({ error: err.message, issues: err.issues });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: '请求参数校验失败',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof MarketplaceError) {
    res.status(502).json({ error: err.message, details: err.details });
    return;
  }
  const message = err instanceof Error ? err.message : '未知错误';
  logger.error('未处理错误', { message });
  res.status(500).json({ error: message });
}

/** 包裹 async 路由,自动把 reject 转到 errorHandler。 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
