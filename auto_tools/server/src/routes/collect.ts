import { Router } from 'express';
import type { CollectResponse } from '@shared/types';
import { collectService } from '../services/collect-service.js';
import { asyncHandler } from '../middleware/error.js';
import { collectRequestSchema } from './schemas.js';

export const collectRouter = Router();

/** 插件采集上报入口。 */
collectRouter.post(
  '/collect',
  asyncHandler(async (req, res) => {
    const { product, templateId, templateSource } = collectRequestSchema.parse(req.body);
    const result = await collectService.collect(product, templateId, { templateSource });
    const body: CollectResponse = {
      id: result.record.id,
      ...(result.duplicate ? { duplicate: true } : {}),
      ...(result.template ? { template: result.template } : {}),
    };
    res.status(201).json(body);
  }),
);
