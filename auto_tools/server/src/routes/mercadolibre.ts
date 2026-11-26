import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { asyncHandler } from '../middleware/error.js';
import { mercadoLibreService } from '../services/mercadolibre-service.js';

export const mercadoLibreRouter = Router();

const siteIdSchema = z.enum(['MLC', 'MLM', 'MCO']);

mercadoLibreRouter.get('/mercadolibre/config', (_req, res) => {
  res.json(mercadoLibreService.getConfig());
});

mercadoLibreRouter.put('/mercadolibre/config', asyncHandler(async (req, res) => {
  res.json(mercadoLibreService.saveConfig({
    clientId: typeof req.body?.clientId === 'string' ? req.body.clientId : undefined,
    clientSecret: typeof req.body?.clientSecret === 'string' ? req.body.clientSecret : undefined,
    redirectUri: typeof req.body?.redirectUri === 'string' ? req.body.redirectUri : undefined,
    notificationUrl: typeof req.body?.notificationUrl === 'string' ? req.body.notificationUrl : undefined,
  }));
}));

mercadoLibreRouter.get('/mercadolibre/status', (_req, res) => {
  res.json(mercadoLibreService.getConfig());
});

mercadoLibreRouter.get('/mercadolibre/auth', (_req, res) => {
  res.redirect(mercadoLibreService.getAuthorizeUrl());
});

mercadoLibreRouter.get('/mercadolibre/callback', asyncHandler(async (req, res) => {
  await mercadoLibreService.handleCallback(req.query as Record<string, string>);
  res.redirect(`${config.webOrigin}/mercadolibre?mercadolibre=connected`);
}));

mercadoLibreRouter.post('/mercadolibre/accounts/:accountId/disconnect', asyncHandler(async (req, res) => {
  await mercadoLibreService.disconnect(req.params.accountId);
  res.status(204).end();
}));

mercadoLibreRouter.post('/mercadolibre/accounts/:accountId/refresh', asyncHandler(async (req, res) => {
  res.json(await mercadoLibreService.refreshAccount(req.params.accountId));
}));

mercadoLibreRouter.get('/mercadolibre/accounts/:accountId/sites', asyncHandler(async (req, res) => {
  res.json(await mercadoLibreService.getSites(req.params.accountId));
}));

mercadoLibreRouter.get('/mercadolibre/templates', (_req, res) => {
  res.json(mercadoLibreService.getTemplates());
});

mercadoLibreRouter.put('/mercadolibre/templates/:id', (req, res) => {
  const body = req.body ?? {};
  const siteIdsResult = z.array(siteIdSchema).min(1).safeParse(body.siteIds);
  if (!siteIdsResult.success) return res.status(400).json({ error: '至少选择一个适用站点' });
  const siteIds = siteIdsResult.data;
  const template = {
    id: req.params.id,
    name: String(body.name || '').trim(),
    siteIds,
    titleTemplate: body.titleTemplate ? String(body.titleTemplate) : undefined,
    descriptionTemplate: body.descriptionTemplate ? String(body.descriptionTemplate) : undefined,
    categoryId: body.categoryId ? String(body.categoryId) : undefined,
    attributes: Array.isArray(body.attributes) ? body.attributes : [],
    currency: String(body.currency || 'USD').toUpperCase(),
    logisticType: String(body.logisticType || 'remote'),
    listingTypeId: body.listingTypeId ? String(body.listingTypeId) : undefined,
    priceMode: z.enum(['set', 'multiply', 'net_proceeds']).parse(body.priceMode || 'set'),
    priceValue: Number(body.priceValue ?? 0),
    language: z.enum(['source', 'english', 'spanish', 'portuguese']).parse(body.language || 'source'),
  } as const;
  if (!template.name) return res.status(400).json({ error: '模板名称不能为空' });
  res.json(mercadoLibreService.saveTemplate(template));
});

mercadoLibreRouter.delete('/mercadolibre/templates/:id', (req, res) => {
  res.json(mercadoLibreService.deleteTemplate(req.params.id));
});

mercadoLibreRouter.get('/mercadolibre/categories/attributes', asyncHandler(async (req, res) => {
  const accountId = String(req.query.accountId || '');
  const categoryId = String(req.query.categoryId || '');
  if (!accountId || !categoryId) return res.status(400).json({ error: '缺少 accountId 或 categoryId' });
  res.json(await mercadoLibreService.getCategoryAttributes(accountId, categoryId));
}));

mercadoLibreRouter.get('/mercadolibre/categories', asyncHandler(async (req, res) => {
  const accountId = String(req.query.accountId || '');
  const siteId = siteIdSchema.parse(String(req.query.siteId || ''));
  if (!accountId) return res.status(400).json({ error: '缺少 accountId' });
  res.json(await mercadoLibreService.getCategories(accountId, siteId));
}));

mercadoLibreRouter.get('/mercadolibre/categories/predict', asyncHandler(async (req, res) => {
  const accountId = String(req.query.accountId || '');
  const siteId = siteIdSchema.parse(String(req.query.siteId || ''));
  const title = String(req.query.title || '');
  if (!accountId || !title.trim()) return res.status(400).json({ error: '缺少 accountId 或 title' });
  res.json(await mercadoLibreService.predictCategory(accountId, siteId, title));
}));

mercadoLibreRouter.get('/mercadolibre/listing-index', (_req, res) => {
  res.json(mercadoLibreService.listListingIndex());
});

mercadoLibreRouter.get('/mercadolibre/listings', (req, res) => {
  res.json(mercadoLibreService.listListings(req.query.productId ? String(req.query.productId) : undefined));
});

mercadoLibreRouter.post('/mercadolibre/listings', (req, res) => {
  const productId = String(req.body?.productId || '');
  const accountId = String(req.body?.accountId || '');
  const sites = z.array(siteIdSchema).min(1).parse(req.body?.siteIds);
  const templateIds = req.body?.templateIds && typeof req.body.templateIds === 'object' ? req.body.templateIds : undefined;
  if (!productId || !accountId) return res.status(400).json({ error: '缺少 productId 或 accountId' });
  res.status(201).json(mercadoLibreService.createDrafts(productId, accountId, sites, templateIds));
});

mercadoLibreRouter.get('/mercadolibre/listings/:id', (req, res) => {
  res.json(mercadoLibreService.getListing(req.params.id));
});

mercadoLibreRouter.put('/mercadolibre/listings/:id', (req, res) => {
  res.json(mercadoLibreService.updateListing(req.params.id, req.body ?? {}));
});

mercadoLibreRouter.delete('/mercadolibre/listings/:id/images', (req, res) => {
  const imageUrl = z.string().trim().min(1, '缺少要删除的图片').parse(req.body?.imageUrl);
  res.json(mercadoLibreService.deleteSharedImage(req.params.id, imageUrl));
});

mercadoLibreRouter.post('/mercadolibre/listings/:id/validate', (req, res) => {
  res.json(mercadoLibreService.validateListing(req.params.id));
});

mercadoLibreRouter.post('/mercadolibre/listings/:id/publish', asyncHandler(async (req, res) => {
  res.json(await mercadoLibreService.publish(req.params.id));
}));

mercadoLibreRouter.post('/mercadolibre/listings/:id/status', asyncHandler(async (req, res) => {
  const status = z.enum(['active', 'paused']).parse(req.body?.status);
  res.json(await mercadoLibreService.setStatus(req.params.id, status));
}));

mercadoLibreRouter.post('/mercadolibre/listings/:id/sync', asyncHandler(async (req, res) => {
  res.json(await mercadoLibreService.sync(req.params.id));
}));

mercadoLibreRouter.post('/mercadolibre/notifications', asyncHandler(async (req, res) => {
  // Mercado Libre retries when the callback does not acknowledge quickly.
  res.status(200).json({ ok: true });
  await mercadoLibreService.handleNotification(req.body);
}));
