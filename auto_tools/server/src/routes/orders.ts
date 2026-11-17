import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  EXPORT_MATERIALS,
  ORDER_COLUMN_KEYS,
  ORDER_STATUSES,
  type OrderColumnKey,
  type OrderSourcesResponse,
} from '@shared/orders';
import { config } from '../config/index.js';
import { asyncHandler } from '../middleware/error.js';
import { localOnly } from '../middleware/local-only.js';
import { OrderInputError } from '../orders/errors.js';
import { orderExportService } from '../orders/export-service.js';
import { orderProfileService } from '../orders/profile-service.js';
import { orderSourceRegistry } from '../orders/registry.js';
import { orderSyncService } from '../orders/sync-service.js';
import { orderExportRepository } from '../repositories/order-export-repository.js';
import { orderRepository, shopKey } from '../repositories/order-repository.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const shopRef = z.object({ platform: z.string().min(1).max(40), shopId: z.string().min(1).max(100) });
const exportMaterial = z.enum(EXPORT_MATERIALS);
const optionalFileName = z.string().trim().max(200).optional().transform((value) => value || undefined);

const querySchema = z.object({
  profileId: z.string().min(1).max(60),
  shops: z.array(shopRef).min(1, '请至少选择一家店铺').max(100),
  statuses: z.array(z.enum(ORDER_STATUSES)).min(1, '请至少选择一个订单状态'),
  from: date.optional(),
  to: date.optional(),
  onlyNew: z.boolean().default(true),
  overrides: z.record(z.string().max(300), z.enum([...EXPORT_MATERIALS, 'unknown'])).default({}),
  selectedImages: z.record(z.string().max(300), z.array(z.string().url().max(4000)).min(1).max(21)).default({}),
});

const syncSchema = z.object({
  shops: z.array(shopRef).min(1, '请至少选择一家店铺').max(100),
  from: date.optional(),
});

const profileSchema = z.object({
  name: z.string().trim().min(1, '请填写方案名称').max(40),
  layout: z.enum(['file-per-material', 'sheet-per-material']),
  fileName: z.string().trim().min(1, '请填写文件名模板').max(200),
  buckets: z.array(z.object({
    material: exportMaterial,
    label: z.string().trim().min(1, '请填写材质显示名').max(20),
    fileName: optionalFileName,
  }))
    .min(1, '至少选择一种单独导出的材质')
    .refine((list) => new Set(list.map((bucket) => bucket.material)).size === list.length, '材质不能重复'),
  unknown: z.object({
    handling: z.enum(['separate', 'skip']),
    label: z.string().trim().min(1, '请填写未识别材质的名称').max(20),
    fileName: optionalFileName,
  }),
  columns: z.array(z.enum(ORDER_COLUMN_KEYS as [OrderColumnKey, ...OrderColumnKey[]])).min(1, '至少选择一列'),
  defaults: z.object({
    shops: z.array(shopRef).max(100),
    statuses: z.array(z.enum(ORDER_STATUSES)).min(1),
    onlyNew: z.boolean(),
  }),
});

const ruleSchema = z.object({
  platform: z.string().min(1).max(40),
  productId: z.string().trim().max(100).optional().transform((value) => value || undefined),
  productSku: z.string().trim().max(200).optional().transform((value) => value || undefined),
  title: z.string().max(500).optional(),
  material: exportMaterial,
}).refine((value) => value.productId || value.productSku, '缺少商品 id 或 SKU，无法记住');

export const ordersRouter = Router();

ordersRouter.use(
  '/orders',
  localOnly('订单数据包含买家姓名、电话和地址，只能在运行工作台的电脑上通过 http://localhost 使用。'),
);

/** 可导出的平台、店铺、授权与同步状态 */
ordersRouter.get('/orders/sources', (_req, res) => {
  const counts = orderRepository.countByShop();
  const states = new Map(orderRepository.listSyncStates().map((state) => [shopKey(state.platform, state.shopId), state]));
  const body: OrderSourcesResponse = {
    lookbackDays: config.orders.syncLookbackDays,
    platforms: orderSourceRegistry.list().map((source) => ({
      platform: source.platform,
      label: source.label,
      shops: source.listShops().map((shop) => {
        const key = shopKey(source.platform, shop.shopId);
        const state = states.get(key);
        return {
          platform: source.platform,
          platformLabel: source.label,
          shopId: shop.shopId,
          shopName: shop.shopName,
          configured: shop.configured,
          connected: shop.connected,
          orderCount: counts.get(key) ?? 0,
          lastSyncedAt: state?.lastSuccessAt,
          lastRunAt: state?.lastRunAt,
          lastError: state?.lastError,
          coveredFrom: state?.coveredFrom,
        };
      }),
    })),
  };
  res.json(body);
});

/** 增量同步所选店铺，返回任务（202），前端轮询进度 */
ordersRouter.post('/orders/sync', (req, res) => {
  const body = syncSchema.parse(req.body);
  res.status(202).json(orderSyncService.enqueue(body.shops, body.from));
});

ordersRouter.get('/orders/sync/:id', (req, res) => {
  const job = orderSyncService.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: '同步任务不存在' });
    return;
  }
  res.json(job);
});

/** 按方案在本地数据上计算：各材质单数、未识别明细、将生成的文件名 */
ordersRouter.post('/orders/preview', (req, res) => {
  res.json(orderExportService.preview(querySchema.parse(req.body)));
});

ordersRouter.post('/orders/exports', asyncHandler(async (req, res) => {
  res.status(201).json(await orderExportService.export(querySchema.parse(req.body)));
}));

ordersRouter.get('/orders/exports', (req, res) => {
  res.json(orderExportService.list(Number(req.query.limit) || 50));
});

ordersRouter.get('/orders/exports/:id/files/:fileId', (req, res, next) => {
  const { path, file } = orderExportService.filePath(req.params.id, req.params.fileId);
  res.download(path, file.name, (error) => {
    if (error && !res.headersSent) next(error);
  });
});

ordersRouter.get('/orders/exports/:id/zip', (req, res) => {
  const { name, buffer } = orderExportService.buildZip(req.params.id);
  res.attachment(name);
  res.type('application/zip');
  res.send(buffer);
});

// ---- 导出方案 ----

ordersRouter.get('/orders/profiles', (_req, res) => {
  res.json(orderProfileService.list());
});

ordersRouter.put('/orders/profiles/:id', (req, res) => {
  const id = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/, '方案 id 不合法').parse(req.params.id);
  const body = profileSchema.parse(req.body);
  res.json(orderProfileService.save({ ...body, id, updatedAt: new Date().toISOString() }));
});

ordersRouter.delete('/orders/profiles/:id', (req, res) => {
  res.json(orderProfileService.remove(req.params.id));
});

// ---- 记住的商品材质 ----

ordersRouter.get('/orders/material-rules', (_req, res) => {
  res.json(orderExportRepository.listRules());
});

ordersRouter.post('/orders/material-rules', (req, res) => {
  res.status(201).json(orderExportRepository.upsertRule(ruleSchema.parse(req.body)));
});

ordersRouter.put('/orders/material-rules/:id', (req, res) => {
  const { material } = z.object({ material: exportMaterial }).parse(req.body);
  const rule = orderExportRepository.updateRuleMaterial(req.params.id, material);
  if (!rule) {
    res.status(404).json({ error: '记住的材质不存在' });
    return;
  }
  res.json(rule);
});

ordersRouter.delete('/orders/material-rules/:id', (req, res) => {
  if (!orderExportRepository.deleteRule(req.params.id)) {
    res.status(404).json({ error: '记住的材质不存在' });
    return;
  }
  res.status(204).end();
});

ordersRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof OrderInputError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  next(error);
});
