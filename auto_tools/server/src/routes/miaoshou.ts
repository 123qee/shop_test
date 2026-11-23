import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { isLocalRequest } from '../middleware/local-only.js';
import { MiaoshouError } from '../marketplaces/miaoshou/client.js';
import { miaoshouService as service } from '../services/miaoshou-service.js';
import { MIAOSHOU_SITES } from '../../../shared/miaoshou.js';
import type { MiaoshouTemplate } from '../../../shared/miaoshou.js';
import { PRODUCT_GROUPS, PRODUCT_MATERIALS } from '../../../shared/product-grouping.js';

const text = z.string().max(500);
const id = z.string().regex(/^\d+$/).max(30);
const optionalId = z.union([id, z.literal('')]);
const amount = z.number().finite().min(0).max(1e9).nullable();
const price = z.number().finite().positive().max(1e9);
const positive = price.nullable();
const prices = z.object({ CL: price.optional(), MX: price.optional(), CO: price.optional(), BR: price.optional() }).strict();
const titles = z.object({ CL: text.optional(), MX: text.optional(), CO: text.optional(), BR: text.optional() }).strict();
const fields = z.object({
  shopId: optionalId, sites: z.array(z.enum(MIAOSHOU_SITES)).max(4).refine(s => new Set(s).size === s.length, '站点不能重复'), categoryId: optionalId,
  netProceeds: positive, sitePrices: prices, siteTitles: titles,
  description: z.string().max(50000), attributes: z.array(z.object({ name: text.min(1), values: z.array(z.object({ name: text }).strict()).max(100) }).strict()).max(200),
  warrantyType: z.enum(['', 'sellerWarranty', 'factoryWarranty', 'noWarranty']), warrantyTime: z.number().int().min(0).max(10000).nullable(), warrantyTimeUnit: z.enum(['days', 'months', 'years']),
  stock: z.number().int().min(0).max(1e9).nullable(), weightKg: positive, lengthCm: positive, widthCm: positive, heightCm: positive,
  optionMappings: z.record(text).refine(o => Object.keys(o).length <= 30), sizeMap: z.record(text).refine(o => Object.keys(o).length <= 200),
}).strict();
const variant = z.object({ sku: text, options: z.record(text), images: z.array(z.string().url().max(4000)).max(100), stock: z.number().int().nonnegative().nullable(), sourcePrice: amount, sizeGridRowId: text }).strict();
const editable = fields.extend({ title: z.string().max(500), images: z.array(z.string().url().max(4000)).max(300), variants: z.array(variant).max(10000) }).partial().strict();
const template = fields.extend({ name: text.trim().min(1), groupId: z.custom<MiaoshouTemplate['groupId']>(v => typeof v === 'string' && (!v || PRODUCT_GROUPS.some(g => g.id === v))), material: z.custom<MiaoshouTemplate['material']>(v => typeof v === 'string' && (!v || PRODUCT_MATERIALS.some(m => m.id === v))) }).strict();
const version = z.number().int().positive();
const bodyVersion = z.object({ version }).strict();
export const miaoshouRouter = Router();
miaoshouRouter.use('/miaoshou', (req, res, next) => { if (!isLocalRequest(req)) { res.status(403).json({ error: '妙手分拣与应用配置仅允许本机访问' }); return; } next(); });
miaoshouRouter.get('/miaoshou/workspace', asyncHandler(async (_req, res) => res.json(service.workspace())));
miaoshouRouter.put('/miaoshou/config', asyncHandler(async (req, res) => res.json(service.saveConfig(z.object({ appKey: z.string().trim().max(200).optional(), appSecret: z.string().trim().max(500).optional(), defaultShopId: optionalId.optional(), defaultSites: z.array(z.enum(MIAOSHOU_SITES)).min(1).max(4).optional() }).strict().parse(req.body)))));
miaoshouRouter.post('/miaoshou/test-connection', asyncHandler(async (_req, res) => res.json({ shops: await service.shops() })));
miaoshouRouter.get('/miaoshou/shops/:shopId/sites', asyncHandler(async (req, res) => res.json(await service.sites(id.parse(req.params.shopId)))));
miaoshouRouter.get('/miaoshou/categories', asyncHandler(async (_req, res) => res.json(await service.categories())));
miaoshouRouter.get('/miaoshou/rules', asyncHandler(async (req, res) => res.json(await service.rules(id.parse(req.query.shopId), id.parse(req.query.categoryId)))));
miaoshouRouter.put('/miaoshou/templates/:id', asyncHandler(async (req, res) => {
  const body = template.parse(req.body);
  res.json(service.saveTemplate({ ...body, id: z.string().uuid().parse(req.params.id) }));
}));
miaoshouRouter.delete('/miaoshou/templates/:id', asyncHandler(async (req, res) => { service.deleteTemplate(req.params.id); res.status(204).end(); }));
miaoshouRouter.post('/miaoshou/drafts', asyncHandler(async (req, res) => { const { productId } = z.object({ productId: z.string().uuid() }).strict().parse(req.body); res.json(service.open(productId)); }));
miaoshouRouter.get('/miaoshou/drafts/:id', asyncHandler(async (req, res) => res.json(service.get(req.params.id))));
miaoshouRouter.patch('/miaoshou/drafts/:id', asyncHandler(async (req, res) => {
  const body = z.object({ version, patch: editable }).strict().parse(req.body);
  res.json(service.update(req.params.id, body.version, body.patch));
}));
miaoshouRouter.post('/miaoshou/drafts/:id/decision', asyncHandler(async (req, res) => {
  const body = z.object({ version, action: z.enum(['ready', 'skipped', 'pending']), templateId: z.string().uuid().optional() }).strict().parse(req.body);
  res.json(service.decide(req.params.id, body.version, body.action, body.templateId));
}));
miaoshouRouter.post('/miaoshou/undo/:id', asyncHandler(async (req, res) => res.json(service.undo(req.params.id))));
miaoshouRouter.post('/miaoshou/drafts/:id/validate', asyncHandler(async (req, res) => res.json({ issues: await service.validate(req.params.id) })));
miaoshouRouter.post('/miaoshou/submit', asyncHandler(async (req, res) => {
  const { items } = z.object({ items: z.array(z.object({ id: z.string().uuid(), version }).strict()).min(1).max(100).refine(a => new Set(a.map(i => i.id)).size === a.length, '商品不能重复') }).strict().parse(req.body);
  res.status(202).json(service.enqueue(items));
}));
miaoshouRouter.post('/miaoshou/drafts/:id/reconcile', asyncHandler(async (req, res) => {
  const body = z.object({ version, remoteId: id }).strict().parse(req.body);
  res.json(await service.reconcile(req.params.id, body.version, body.remoteId));
}));
miaoshouRouter.get('/miaoshou/drafts/:id/review-candidates', asyncHandler(async (req, res) => {
  res.json(await service.reviewCandidates(req.params.id, z.coerce.number().int().positive().parse(req.query.version)));
}));
miaoshouRouter.post('/miaoshou/drafts/:id/release', asyncHandler(async (req, res) => {
  const body = bodyVersion.extend({ checkedNotCreated: z.literal(true) }).parse(req.body);
  res.json(service.release(req.params.id, body.version));
}));
miaoshouRouter.use((error: unknown, _req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
  if (error instanceof MiaoshouError) { res.status(error.status).json({ error: error.message }); return; } next(error);
});
