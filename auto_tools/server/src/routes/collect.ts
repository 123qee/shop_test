import { Router } from 'express';
import { z } from 'zod';
import { isBatchProductUrl } from '@shared/collect-batches';
import { collectBatches } from '../repositories/collect-batch-repository.js';
import type { CollectResponse } from '@shared/types';
import { collectService } from '../services/collect-service.js';
import { asyncHandler } from '../middleware/error.js';
import { collectedProductSchema, collectRequestSchema } from './schemas.js';

export const collectRouter = Router();

const batchUrl = z.string().min(1).max(8192);
const urlsSchema = z.array(batchUrl).min(1);
const trackedCollectSchema = collectRequestSchema.extend({
  batch: z.object({ id: z.string().uuid(), url: batchUrl }).optional(),
});

collectRouter.post('/collect/batches', asyncHandler(async (req, res) => {
  const { source, urls, templateId } = z.object({
    source: collectedProductSchema.shape.source, urls: urlsSchema, templateId: z.string().min(1).optional(),
  }).parse(req.body);
  if (urls.some(url => !isBatchProductUrl(source, url))) return res.status(400).json({ error: '部分商品链接不属于本批来源平台' });
  res.status(201).json({ id: collectBatches.create(source, urls, templateId) });
}));

collectRouter.get('/collect/batches', asyncHandler(async (req, res) => {
  const offset = z.coerce.number().int().nonnegative().default(0).parse(req.query.offset);
  res.json(collectBatches.list(offset, 25));
}));

collectRouter.get('/collect/batches/:id', asyncHandler(async (req, res) => {
  const result = collectBatches.get(req.params.id);
  if (!result) return res.status(404).json({ error: '采集批次不存在' });
  res.json(result);
}));

collectRouter.get('/collect/batches/:id/products', asyncHandler(async (req, res) => {
  const productIds = collectBatches.productIds(req.params.id);
  if (!productIds) return res.status(404).json({ error: '采集批次不存在' });
  res.json({ id: req.params.id, productIds });
}));

collectRouter.post('/collect/batches/:id/failures', asyncHandler(async (req, res) => {
  const { urls, reason } = z.object({ urls: urlsSchema, reason: z.string().min(1).max(1000) }).parse(req.body);
  if (!collectBatches.failures(req.params.id, urls, reason)) return res.status(404).json({ error: '采集批次不存在' });
  res.sendStatus(204);
}));

/** 插件采集上报入口。 */
collectRouter.post(
  '/collect',
  asyncHandler(async (req, res) => {
    const { product, templateId, templateSource, batch } = trackedCollectSchema.parse(req.body);
    if (batch && !collectBatches.contains(batch.id, batch.url, product.source)) {
      return res.status(400).json({ error: '商品与采集批次不匹配' });
    }
    const result = await collectService.collect(product, templateId, { templateSource });
    const body: CollectResponse = {
      id: result.record.id,
      ...(result.duplicate ? { duplicate: true } : {}),
      ...(result.template ? { template: result.template } : {}),
    };
    if (batch) collectBatches.success(batch.id, batch.url, body);
    res.status(201).json(body);
  }),
);
