import { Router } from 'express';
import { config } from '../config/index.js';
import { asyncHandler } from '../middleware/error.js';
import { marketplaceRegistry } from '../marketplaces/registry.js';
import { JoomAdapter } from '../marketplaces/joom/adapter.js';

export const joomRouter = Router();

function joomAdapter(): JoomAdapter {
  return marketplaceRegistry.require('joom') as JoomAdapter;
}

/** 连接状态 */
joomRouter.get(
  '/joom/status',
  asyncHandler(async (_req, res) => {
    const adapter = marketplaceRegistry.require('joom');
    res.json(await adapter.getStatus());
  }),
);

/** 发起授权:302 跳转到 Joom 授权页 */
joomRouter.get(
  '/joom/auth',
  asyncHandler(async (_req, res) => {
    const adapter = marketplaceRegistry.require('joom');
    res.redirect(adapter.getAuthorizeUrl());
  }),
);

/** OAuth 回调:换 token,然后跳回网页后台 */
joomRouter.get(
  '/joom/callback',
  asyncHandler(async (req, res) => {
    const adapter = marketplaceRegistry.require('joom');
    await adapter.handleCallback(req.query as Record<string, string>);
    res.redirect(`${config.webOrigin}/?joom=connected`);
  }),
);

/** 断开连接 */
joomRouter.post(
  '/joom/disconnect',
  asyncHandler(async (_req, res) => {
    const adapter = marketplaceRegistry.require('joom');
    await adapter.disconnect();
    res.status(204).end();
  }),
);

/** 类目列表(GET /productCategories),供后台选择 categoryId */
joomRouter.get(
  '/joom/categories',
  asyncHandler(async (_req, res) => {
    res.json(await joomAdapter().getCategories());
  }),
);

/** 允许的颜色名(GET /productColors) */
joomRouter.get(
  '/joom/colors',
  asyncHandler(async (_req, res) => {
    res.json(await joomAdapter().getColors());
  }),
);

/** 某类目要求(合并 requirements + attributeValues),供动态渲染属性表单 */
joomRouter.get(
  '/joom/categories/requirements',
  asyncHandler(async (req, res) => {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: '缺少类目 id' });
    const locale = req.query.locale ? String(req.query.locale) : undefined;
    res.json(await joomAdapter().getCategoryRequirements(id, locale));
  }),
);
