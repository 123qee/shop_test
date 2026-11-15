import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { settingsService } from '../services/settings-service.js';
import { aiConfigService } from '../services/ai-config-service.js';
import { aiConfigSchema, picuiConfigSchema, presetsConfigSchema, shopActiveSchema, shopsConfigSchema } from './schemas.js';
import { shopService } from '../services/shop-service.js';
import { publishJobService } from '../services/publish-job-service.js';
import { z } from 'zod';
import { isProductGroup, isProductMaterial } from '@shared/product-grouping';
import { aliexpressAutoFillService } from '../services/aliexpress-auto-fill-service.js';

export const settingsRouter = Router();

const aliExpressAutoFillPayload = z.object({
  fields: z.array(z.object({ id: z.string().min(1).max(80), value: z.string().max(500), enabled: z.boolean() })).min(1).max(100),
});

settingsRouter.get('/aliexpress/auto-fill', asyncHandler(async (_req, res) => {
  res.json(aliexpressAutoFillService.get());
}));

settingsRouter.put('/aliexpress/auto-fill', asyncHandler(async (req, res) => {
  const payload = aliExpressAutoFillPayload.parse(req.body);
  const current = aliexpressAutoFillService.get();
  const allowedIds = new Set(current.fields.map(field => field.id));
  const suppliedIds = new Set(payload.fields.map(field => field.id));
  if (suppliedIds.size !== payload.fields.length || suppliedIds.size !== allowedIds.size || [...suppliedIds].some(id => !allowedIds.has(id))) {
    return res.status(400).json({ error: '字段列表不完整或包含未知字段，请刷新后重试' });
  }
  const updates = new Map(payload.fields.map(field => [field.id, field]));
  res.json(aliexpressAutoFillService.save({
    fields: current.fields.map(field => ({ ...field, ...updates.get(field.id)! })),
    updatedAt: null,
  }));
}));

settingsRouter.get('/settings/group-templates', asyncHandler(async (_req, res) => {
  res.json(settingsService.getGroupTemplateBindings());
}));

settingsRouter.put('/settings/group-templates', asyncHandler(async (req, res) => {
  const binding = z.object({
    groupId: z.custom<import('@shared/types').ProductGroupId>((v) => isProductGroup(v) && v !== 'pending'),
    material: z.custom<import('@shared/types').ProductMaterial | 'all'>((v) => v === 'all' || (isProductMaterial(v) && v !== 'unknown')),
    templateId: z.string().min(1).nullable(),
  }).parse(req.body);
  if (binding.templateId && !settingsService.getConfig().templates.some((t) => t.id === binding.templateId)) return res.status(400).json({ error: '预设模板不存在，请刷新后重试' });
  res.json(settingsService.saveGroupTemplateBinding(binding));
}));

/** 读取预设配置(多模板 + 默认模板 id) */
settingsRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json(settingsService.getConfig());
  }),
);

/** 保存预设配置 */
settingsRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const config = presetsConfigSchema.parse(req.body);
    res.json(settingsService.saveConfig(config));
  }),
);

/** PICUI 配置（只返回是否已配置和脱敏提示，不返回完整 token）。 */
settingsRouter.get(
  '/settings/picui',
  asyncHandler(async (_req, res) => {
    res.json(settingsService.getPicuiPublic());
  }),
);

settingsRouter.put(
  '/settings/picui',
  asyncHandler(async (req, res) => {
    const { token } = picuiConfigSchema.parse(req.body);
    res.json(settingsService.savePicuiToken(token));
  }),
);

/** 多店铺档案（不回传完整 Secret）。 */
settingsRouter.get(
  '/shops',
  asyncHandler(async (_req, res) => {
    res.json(shopService.getPublic());
  }),
);

settingsRouter.put(
  '/shops',
  asyncHandler(async (req, res) => {
    if (publishJobService.hasActive()) return res.status(409).json({ error: '发布任务进行中，请完成后再修改店铺' });
    const body = shopsConfigSchema.parse(req.body);
    res.json(shopService.save(body));
  }),
);

settingsRouter.post(
  '/shops/active',
  asyncHandler(async (req, res) => {
    const { id } = shopActiveSchema.parse(req.body);
    if (id !== shopService.getActiveId() && publishJobService.hasActive()) return res.status(409).json({ error: '发布任务进行中，请完成后再切换店铺' });
    res.json(shopService.setActive(id));
  }),
);

/** DeepSeek 配置（不回传完整 Key）。 */
settingsRouter.get(
  '/ai/config',
  asyncHandler(async (_req, res) => {
    res.json(aiConfigService.getPublic());
  }),
);

settingsRouter.put(
  '/ai/config',
  asyncHandler(async (req, res) => {
    const body = aiConfigSchema.parse(req.body);
    res.json(aiConfigService.save(body));
  }),
);
