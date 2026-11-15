import { Router } from 'express';
import type { ProductStatus } from '@shared/types';
import { asyncHandler } from '../middleware/error.js';
import { publishService } from '../services/publish-service.js';
import { aiTitlePreviewSchema, batchRemoveRemoteSchema, editableProductSchema, productVideoSchema } from './schemas.js';
import { z } from 'zod';
import { batchService } from '../services/batch-service.js';
import { syncService } from '../services/sync-service.js';
import { auditService } from '../services/audit-service.js';
import { checkProductImages } from '../services/image-service.js';
import { productService } from '../services/product-service.js';
import { aiTitleService } from '../services/ai-title-service.js';
import { loadOfficialJoomColors } from '../services/listing-language.js';
import { publishJobService } from '../services/publish-job-service.js';
import { isProductGroup, isProductMaterial } from '@shared/product-grouping';
import { settingsService } from '../services/settings-service.js';
import { joomVideoService } from '../services/joom-video-service.js';
import { templateDecisionService } from '../services/template-decision-service.js';

export const productsRouter = Router();

productsRouter.get('/products/video-backfill-candidates', asyncHandler(async (req, res) => {
  const source = req.query.source ? String(req.query.source) : undefined;
  const allowed = ['aliexpress', 'allegro', 'amazon', 'asos', 'george', 'joom', 'mercadolibre', 'wildberries'];
  if (source && !allowed.includes(source)) return res.status(400).json({ error: '无效的采集来源' });
  res.json(productService.videoBackfillCandidates({
    source: source as any,
    since: req.query.since ? String(req.query.since) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  }));
}));

productsRouter.put('/products/:id/videos', asyncHandler(async (req, res) => {
  if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在发布，请完成后再补采视频' });
  const body = z.object({ videos: z.array(productVideoSchema).max(10) }).parse(req.body);
  const record = await productService.backfillVideos(req.params.id, body.videos);
  if (!record) return res.status(404).json({ error: '商品不存在' });
  res.json(record);
}));

productsRouter.post('/products/:id/video/retry', asyncHandler(async (req, res) => {
  res.json(await joomVideoService.retry(req.params.id));
}));

productsRouter.get('/products/publish-jobs', asyncHandler(async (_req, res) => {
  res.json(publishJobService.recent());
}));

productsRouter.get('/products/publish-jobs/:jobId', asyncHandler(async (req, res) => {
  const job = publishJobService.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: '发布任务不存在' });
  res.json(job);
}));

productsRouter.post('/products/publish-jobs', asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) as string[] : [];
  res.status(202).json(publishJobService.enqueue(ids));
}));

productsRouter.post('/products/publish-jobs/:jobId/pause', asyncHandler(async (req, res) => {
  const job = publishJobService.pause(req.params.jobId);
  if (!job) return res.status(404).json({ error: '发布任务不存在' });
  res.json(job);
}));

/** 列表(可按 status 过滤) */
productsRouter.get(
  '/products',
  asyncHandler(async (req, res) => {
    const status = req.query.status as ProductStatus | undefined;
    res.json(productService.list(status));
  }),
);

productsRouter.get('/products/joom-status', asyncHandler(async (_req, res) => {
  res.json(syncService.getShopStatusSummary());
}));

productsRouter.post(
  '/products/:id/rollback/:logId',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在排队或发布，请完成后再恢复历史版本' });
    const restored = productService.rollback(req.params.id, req.params.logId);
    if (!restored) return res.status(400).json({ error: '该历史记录不可恢复或商品不存在' });
    res.json(restored);
  }),
);

/** 详情:返回记录 + 可编辑草稿(edited 或采集派生默认值) */
productsRouter.get(
  '/products/:id',
  asyncHandler(async (req, res) => {
    const record = productService.get(req.params.id);
    if (!record) return res.status(404).json({ error: '商品不存在' });
    res.json({ record, editable: productService.getEditable(record) });
  }),
);

/** 切换预设模板:按新模板重新生成草稿(覆盖未保存编辑) */
productsRouter.post(
  '/products/:id/template',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在排队或发布，请完成后再切换模板' });
    const templateId = String(req.body?.templateId || '');
    if (!templateId) return res.status(400).json({ error: '缺少 templateId' });
    if (!settingsService.getConfig().templates.some((t) => t.id === templateId)) return res.status(400).json({ error: '预设模板不存在，请刷新后重试' });
    const result = productService.setTemplate(req.params.id, templateId);
    if (!result) return res.status(404).json({ error: '商品不存在' });
    res.json(result);
  }),
);

/** 分拣:确认当前模板,或换成另一个模板并确认。body { templateId } */
productsRouter.post(
  '/products/:id/template-decision',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在排队或发布，请完成后再确认模板' });
    const { templateId } = z.object({ templateId: z.string().min(1) }).parse(req.body);
    res.json(templateDecisionService.decide(req.params.id, templateId));
  }),
);

/** 撤销最近一次分拣(商品之后又被修改时拒绝)。 */
productsRouter.post(
  '/products/:id/template-decision/undo',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在排队或发布，不能撤销' });
    res.json({ record: templateDecisionService.undo(req.params.id) });
  }),
);

/** 分拣时删除一张图片(只改可编辑草稿)。body { imageUrl } */
productsRouter.delete(
  '/products/:id/images',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在排队或发布，请完成后再修改图片' });
    const { imageUrl } = z.object({ imageUrl: z.string().trim().min(1, '缺少要删除的图片') }).parse(req.body);
    const record = productService.removeDraftImage(req.params.id, imageUrl);
    if (!record) return res.status(404).json({ error: '商品不存在' });
    res.json(record);
  }),
);

/** 分拣时调整图片顺序(只改可编辑草稿,第一张为主图)。body { imageUrls } 必须是当前草稿的同一组图片。 */
productsRouter.put(
  '/products/:id/images/order',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在排队或发布，请完成后再修改图片' });
    const { imageUrls } = z.object({ imageUrls: z.array(z.string().min(1)).min(1, '缺少图片顺序') }).parse(req.body);
    const record = productService.reorderDraftImages(req.params.id, imageUrls);
    if (!record) return res.status(404).json({ error: '商品不存在' });
    res.json(record);
  }),
);

/** 手动应用当前模板的预设(不落库,返回套用后的可编辑草稿供前端检查) */
productsRouter.post(
  '/products/:id/apply-preset',
  asyncHandler(async (req, res) => {
    const result = productService.applyPresetTo(req.params.id);
    if (!result) return res.status(404).json({ error: '商品不存在' });
    res.json(result);
  }),
);

/** 保存编辑 */
productsRouter.put(
  '/products/:id',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在排队或发布，请完成后再修改' });
    const edited = editableProductSchema.parse(req.body);
    const record = productService.saveEdited(req.params.id, edited, req.body?.templateConfirmed === true);
    if (!record) return res.status(404).json({ error: '商品不存在' });
    res.json(record);
  }),
);

/** 删除 */
productsRouter.delete(
  '/products/:id',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在排队或发布，请完成后再删除' });
    const ok = productService.delete(req.params.id);
    if (!ok) return res.status(404).json({ error: '商品不存在' });
    res.status(204).end();
  }),
);

/** 移入废弃箱：本地归档，不影响已发布到 Joom 的商品。 */
productsRouter.post(
  '/products/:id/discard',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品正在排队或发布，请完成后再移入废弃箱' });
    const discarded = productService.discard(req.params.id);
    if (!discarded) return res.status(400).json({ error: '商品不存在或已在废弃箱中' });
    res.json(discarded);
  }),
);

/** 从废弃箱恢复商品。 */
productsRouter.post(
  '/products/:id/restore',
  asyncHandler(async (req, res) => {
    const restored = productService.restore(req.params.id);
    if (!restored) return res.status(400).json({ error: '商品不存在或不在废弃箱中' });
    res.json(restored);
  }),
);

/** 批量校验:body { ids: string[], marketplaceId? } */
productsRouter.post(
  '/products/batch/validate',
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    if (!ids.length) return res.status(400).json({ error: '缺少 ids' });
    const marketplaceId = (req.body?.marketplaceId as string) || 'joom';
    res.json(await publishService.validateMany(ids, marketplaceId));
  }),
);

/** 批量发布:body { ids: string[], marketplaceId? } */
productsRouter.post(
  '/products/batch/publish',
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    if (!ids.length) return res.status(400).json({ error: '缺少 ids' });
    if (ids.some((id) => publishJobService.isProductActive(id))) return res.status(409).json({ error: '所选商品已有后台发布任务，请等待任务完成' });
    const marketplaceId = (req.body?.marketplaceId as string) || 'joom';
    res.json(await publishService.publishMany(ids, marketplaceId));
  }),
);

/** 批量修复当前线上重复变体。body { ids?, marketplaceId?, dryRun? } */
productsRouter.post(
  '/products/batch/repair-duplicate-variants',
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : undefined;
    const marketplaceId = (req.body?.marketplaceId as string) || 'joom';
    const dryRun = req.body?.dryRun === true;
    res.json(await publishService.repairDuplicateVariantsMany(ids, marketplaceId, dryRun));
  }),
);

/** 批量从 Joom 删除线上商品。不可恢复。body { ids, remoteIds?, reason, deleteLocal? } */
productsRouter.post(
  '/products/batch/remove-remote',
  asyncHandler(async (req, res) => {
    const body = batchRemoveRemoteSchema.parse(req.body);
    if (body.ids.some((id) => publishJobService.isProductActive(id))) return res.status(409).json({ error: '所选商品有后台发布任务，请完成后再删除线上商品' });
    res.json(
      await publishService.removeMany(
        body.ids,
        { reason: body.reason, deleteLocal: body.deleteLocal, extraRemoteIds: body.remoteIds },
        body.marketplaceId || 'joom',
      ),
    );
  }),
);

/** 批量 AI 改标题：只生成预览，不落库。 */
productsRouter.post(
  '/products/batch/ai-titles',
  asyncHandler(async (req, res) => {
    const body = aiTitlePreviewSchema.parse(req.body);
    res.json(await aiTitleService.generate(body));
  }),
);

/** 批量运营操作:价格、库存、敏感货、套用模板。 */
productsRouter.post(
  '/products/batch/operate',
  asyncHandler(async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
    if (ids.some((id) => publishJobService.isProductActive(id))) return res.status(409).json({ error: '所选商品中有正在排队或发布的商品，请完成后再修改' });
    let operation = req.body?.operation;
    if (!ids.length) return res.status(400).json({ error: '缺少 ids' });
    if (!operation?.type) return res.status(400).json({ error: '缺少 operation.type' });
    if (operation.type === 'grouping') {
      if (!isProductGroup(operation.groupId) || (operation.material !== undefined && !isProductMaterial(operation.material))) return res.status(400).json({ error: '分组或材质无效' });
      operation = { type: 'grouping', groupId: operation.groupId, material: operation.material };
      if (req.body?.syncRemote) return res.status(400).json({ error: '调整分组只修改本地商品' });
    }
    if (operation.type === 'normalizeColors') {
      operation = { type: 'normalizeColors', officialColors: await loadOfficialJoomColors() };
    }
    const items = batchService.run(ids, operation);
    if (req.body?.syncRemote) {
      const remoteIds = ids.filter((id) => productService.get(id)?.joomProductId);
      const remoteResults = await publishService.publishMany(remoteIds, 'joom');
      for (const remote of remoteResults) {
        if (!remote.ok) {
          const item = items.find((x) => x.id === remote.id);
          if (item) { item.ok = false; item.error = remote.error ?? 'Joom 更新失败'; }
        }
      }
    }
    res.json(items);
  }),
);

/** 整店同步 Joom 状态：只更新店铺快照，不覆盖本地草稿。 */
productsRouter.post(
  '/products/sync-shop',
  asyncHandler(async (req, res) => {
    res.json(await syncService.syncShop((req.body?.marketplaceId as string) || 'joom'));
  }),
);

/** 批量同步 Joom 状态。 */
productsRouter.post(
  '/products/batch/sync',
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: '缺少 ids' });
    res.json(await syncService.syncMany(ids, (req.body?.marketplaceId as string) || 'joom'));
  }),
);

/** 单个商品同步 Joom 状态。 */
productsRouter.post(
  '/products/:id/sync',
  asyncHandler(async (req, res) => {
    res.json(await syncService.sync(req.params.id, (req.body?.marketplaceId as string) || 'joom'));
  }),
);

/** 图片中心：检查 URL 可达性、类型和重复。 */
productsRouter.post(
  '/products/:id/image-check',
  asyncHandler(async (req, res) => {
    const record = productService.get(req.params.id);
    if (!record) return res.status(404).json({ error: '商品不存在' });
    res.json(await checkProductImages(productService.getEditable(record)));
  }),
);

/** 商品操作历史。 */
productsRouter.get(
  '/products/:id/audit-logs',
  asyncHandler(async (req, res) => {
    if (!productService.get(req.params.id)) return res.status(404).json({ error: '商品不存在' });
    res.json(auditService.list({ productId: req.params.id, limit: Number(req.query.limit) || 50 }));
  }),
);

/** 发布前校验(不调用 Joom):返回 issues + 是否可发布 */
productsRouter.post(
  '/products/:id/validate',
  asyncHandler(async (req, res) => {
    const marketplaceId = (req.body?.marketplaceId as string) || 'joom';
    const issues = await publishService.validate(req.params.id, marketplaceId);
    res.json({ issues, ok: !issues.some((i) => i.severity === 'error') });
  }),
);

/** 发布到目标平台(默认 joom) */
productsRouter.post(
  '/products/:id/publish',
  asyncHandler(async (req, res) => {
    if (publishJobService.isProductActive(req.params.id)) return res.status(409).json({ error: '该商品已有后台发布任务，请等待任务完成' });
    const marketplaceId = (req.body?.marketplaceId as string) || 'joom';
    const record = await publishService.publish(req.params.id, marketplaceId);
    res.json(record);
  }),
);
