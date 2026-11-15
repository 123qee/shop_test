import type { CategoryRequirements, EditableProduct, JoomCategory, JoomIssueDetail, JoomRemoveReason } from '@shared/types';
import { normalizeCategories, normalizeRequirements, requiredAttributes } from './categories.js';
import { config } from '../../config/index.js';
import { logger } from '../../util/logger.js';
import type { TokenRepository } from '../../repositories/token-repository.js';
import { tokenRepository } from '../../repositories/token-repository.js';
import { shopService, shopTokenKey } from '../../services/shop-service.js';
import type { MarketplaceAdapter, MarketplaceStatus, PublishResult, RemoteProduct } from '../types.js';
import { MarketplaceError } from '../types.js';
import { JoomClient } from './client.js';
import {
  extractJoomProductId,
  JOOM_CREATE_PRODUCT_PATH,
  JOOM_REMOVE_PRODUCT_PATH,
  JOOM_REMOVE_VARIANTS_PATH,
  JOOM_UPDATE_PRODUCT_PATH,
  mapToJoomCreatePayload,
  mapToJoomUpdatePayload,
} from './mapper.js';

const MARKETPLACE_ID = 'joom';
const LEGACY_TOKEN_KEY = 'joom';
/** token 过期前多少毫秒就提前刷新 */
const REFRESH_SKEW_MS = 60_000;

export class JoomAdapter implements MarketplaceAdapter {
  readonly id = MARKETPLACE_ID;
  readonly name = 'Joom';
  private readonly client: JoomClient;

  constructor(private readonly tokens: TokenRepository = tokenRepository) {
    this.client = new JoomClient(() => this.getValidAccessToken());
  }

  isConnected(): boolean {
    return Boolean(this.readToken());
  }

  async getStatus(): Promise<MarketplaceStatus> {
    const shops = shopService.getPublic();
    const active = shops.profiles.find((p) => p.id === shops.activeId);
    const t = this.readToken(shops.activeId);
    return {
      connected: Boolean(t),
      env: config.joom.env,
      expiresAt: t?.expiresAt,
      configured: shopService.isConfigured(shops.activeId),
      shopId: active?.id,
      shopName: active?.name,
      storeId: active?.storeId,
      shops: shops.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        configured: shopService.isConfigured(p.id),
        connected: p.connected,
      })),
    };
  }

  getAuthorizeUrl(): string {
    const creds = shopService.getCredentials();
    if (!creds) {
      throw new MarketplaceError('未配置 Joom 凭证，请到设置页填写当前店铺的 Client ID 和 Secret');
    }
    // 授权走 v2 地址；state 带店铺 id，回调时即使切过店也能写回正确档案
    const url = new URL(config.joom.endpoints.oauthV2 + '/oauth/authorize');
    url.searchParams.set('client_id', creds.clientId);
    url.searchParams.set('redirect_uri', config.joom.redirectUri);
    url.searchParams.set('state', creds.shopId);
    return url.toString();
  }

  async handleCallback(params: Record<string, string>): Promise<void> {
    const code = params.code;
    if (!code) throw new MarketplaceError('OAuth 回调缺少 code 参数');
    const shopId = params.state?.trim() || shopService.getActiveId();
    const creds = shopService.getCredentials(shopId);
    if (!creds) {
      throw new MarketplaceError('授权回调对应的店铺缺少 Client ID / Secret');
    }
    const tok = await this.client.exchangeCode(code, creds);
    if (!tok?.access_token) {
      throw new MarketplaceError('换取 access_token 失败:Joom 响应中没有 access_token(响应结构可能与预期不同)');
    }
    this.saveToken(shopId, tok.access_token, tok.refresh_token, tok.expires_in, tok.expiry_time);
    if (shopService.getActiveId() !== shopId) shopService.setActive(shopId);
    logger.info('Joom 连接成功', { env: config.joom.env, shopId, shopName: creds.name });
  }

  async disconnect(): Promise<void> {
    const shopId = shopService.getActiveId();
    this.tokens.clear(shopTokenKey(shopId));
    if (shopId === 'default') this.tokens.clear(LEGACY_TOKEN_KEY);
  }

  async publish(product: EditableProduct): Promise<PublishResult> {
    // storeId 条件必填:商户身份授权时必填、店铺身份授权时省略。
    // 这里不硬性拦截,交由 Joom 校验并把字段级错误透传给前端。
    const payload = mapToJoomCreatePayload(product);
    const data = await this.client.request<unknown>('POST', JOOM_CREATE_PRODUCT_PATH, payload);
    const marketplaceProductId = extractJoomProductId(data);
    return { marketplaceProductId, raw: data };
  }

  private clientForShop(shopId: string): JoomClient {
    return shopId === shopService.getActiveId()
      ? this.client
      : new JoomClient(() => this.getValidAccessToken(shopId));
  }

  async startVideoUpload(
    input: { name: string; size: number; md5: string },
    shopId: string,
  ): Promise<{ id: string; videoId: string; uploadParts: Array<{ id: string; url: string; bytesFrom: number; bytesTo: number }> }> {
    return this.clientForShop(shopId).request('POST', '/videos/uploads/start', input);
  }

  async finishVideoUpload(
    uploadId: string,
    parts: Array<{ id: string; etag: string }>,
    shopId: string,
  ): Promise<void> {
    const query = new URLSearchParams({ id: uploadId }).toString();
    await this.clientForShop(shopId).request('POST', `/videos/uploads/finish?${query}`, { parts });
  }

  async getVideo(videoId: string, shopId: string): Promise<any> {
    const query = new URLSearchParams({ id: videoId }).toString();
    return this.clientForShop(shopId).request('GET', `/videos?${query}`);
  }

  async linkVideo(reference: { id?: string; sku?: string }, videoId: string, shopId: string): Promise<void> {
    const key = reference.id ? 'id' : reference.sku ? 'sku' : '';
    const value = reference.id ?? reference.sku;
    if (!key || !value) throw new MarketplaceError('关联视频缺少 Joom 商品 id 或 SKU');
    const query = new URLSearchParams({ [key]: value }).toString();
    await this.clientForShop(shopId).request('POST', `/products/linkVideo?${query}`, { videoId });
  }

  /**
   * 更新已发布商品。Joom 的 update 接口通过 query 参数中的 id/sku 定位，
   * body 只放可更新字段；未传字段不会被覆盖。
   */
  async update(product: EditableProduct, reference: { id?: string; sku?: string }): Promise<PublishResult> {
    const key = reference.id ? 'id' : reference.sku ? 'sku' : '';
    const value = reference.id ?? reference.sku;
    if (!key || !value) throw new MarketplaceError('更新 Joom 商品缺少商品 id 或 SKU');

    const query = new URLSearchParams({ [key]: value }).toString();
    const { client } = await this.findProductShop(reference);
    const data = await client.request<unknown>('POST', `${JOOM_UPDATE_PRODUCT_PATH}?${query}`, mapToJoomUpdatePayload(product));
    const marketplaceProductId = extractJoomProductId(data) || reference.id || '';
    return { marketplaceProductId, raw: data };
  }

  /**
   * 永久删除 Joom 商品。POST /products/remove，query 用 id 或 sku，
   * body 必须带 reason（stopSelling / legalRequirement）。
   */
  async remove(reference: { id?: string; sku?: string }, reason: JoomRemoveReason): Promise<void> {
    const key = reference.id ? 'id' : reference.sku ? 'sku' : '';
    const value = reference.id ?? reference.sku;
    if (!key || !value) throw new MarketplaceError('删除 Joom 商品缺少商品 id 或 SKU');
    const query = new URLSearchParams({ [key]: value }).toString();
    const { client } = await this.findProductShop(reference);
    await client.request<unknown>('POST', `${JOOM_REMOVE_PRODUCT_PATH}?${query}`, { reason });
  }

  /** 永久删除 Joom 商品中的指定变体。POST /products/removeVariations。 */
  async removeVariants(reference: { id?: string; sku?: string }, variants: Array<{ id?: string; sku?: string }>): Promise<void> {
    const key = reference.id ? 'id' : reference.sku ? 'sku' : '';
    const value = reference.id ?? reference.sku;
    if (!key || !value) throw new MarketplaceError('删除 Joom 变体缺少商品 id 或 SKU');
    if (!variants.length) return;
    const query = new URLSearchParams({ [key]: value }).toString();
    const { client } = await this.findProductShop(reference);
    const body = variants.map((variant) => {
      if (variant.id) return { id: variant.id };
      if (variant.sku) return { sku: variant.sku };
      throw new MarketplaceError('删除 Joom 变体缺少变体 id 或 SKU');
    });
    await client.request<unknown>('POST', `${JOOM_REMOVE_VARIANTS_PATH}?${query}`, body);
  }

  async getProduct(reference: { id?: string; sku?: string }): Promise<RemoteProduct> {
    const key = reference.id ? 'id' : reference.sku ? 'sku' : '';
    const value = reference.id ?? reference.sku;
    if (!key || !value) throw new MarketplaceError('同步 Joom 商品缺少商品 id 或 SKU');
    const { data, shopId } = await this.findProductShop(reference);
    return toRemoteProduct(data, reference, shopId, shopService.getProfile(shopId)?.name);
  }

  /** 已发布商品可能属于非当前选中的店铺；只读查询确认归属后再更新。 */
  private async findProductShop(reference: { id?: string; sku?: string }): Promise<{ client: JoomClient; data: any; shopId: string }> {
    const key = reference.id ? 'id' : 'sku';
    const value = reference.id ?? reference.sku;
    if (!value) throw new MarketplaceError('查询 Joom 商品缺少商品 id 或 SKU');
    const path = `/products?${new URLSearchParams({ [key]: value }).toString()}`;
    const activeId = shopService.getActiveId();
    const shopIds = [activeId, ...shopService.getPublic().profiles.map((shop) => shop.id).filter((id) => id !== activeId)];
    let accessError: unknown;
    for (const shopId of shopIds) {
      if (!this.readToken(shopId)) continue;
      const client = new JoomClient(() => this.getValidAccessToken(shopId));
      try {
        const data = await client.request<any>('GET', path);
        logger.info('已定位 Joom 商品所属店铺', { productId: reference.id, shopId });
        return { client, data, shopId };
      } catch (error) {
        if (!(error instanceof MarketplaceError) || !/Joom 请求失败 \((403|404)\)/.test(error.message)) throw error;
        accessError = error;
      }
    }
    throw accessError ?? new MarketplaceError('已连接的 Joom 店铺均无法读取此商品，请检查店铺授权');
  }

  /** 分页拉取店铺全部商品。GET /products/multi，每页最多 500。 */
  async listProducts(shopId = shopService.getActiveId()): Promise<RemoteProduct[]> {
    const out: RemoteProduct[] = [];
    const seen = new Set<string>();
    const client = shopId === shopService.getActiveId()
      ? this.client
      : new JoomClient(() => this.getValidAccessToken(shopId));
    const shopName = shopService.getProfile(shopId)?.name ?? shopId;
    let path: string | undefined = `/products/multi?${new URLSearchParams({ limit: '500' }).toString()}`;
    let pages = 0;
    while (path) {
      if (pages >= 40) throw new MarketplaceError('Joom 商品列表超过同步页数上限，本次保留上次完整快照');
      if (seen.has(path)) throw new MarketplaceError('Joom 商品列表分页链接重复，本次保留上次完整快照');
      seen.add(path);
      pages++;
      const env: { data?: unknown; paging?: { next?: string } } = await client.requestEnvelope('GET', path);
      for (const row of normalizeProductList(env.data)) {
        out.push(toRemoteProduct(row, undefined, shopId, shopName));
      }
      path = env.paging?.next;
    }
    logger.info('Joom 店铺商品列表已拉取', { count: out.length, pages });
    return out;
  }

  /** 获取全部 Joom 类目(GET /productCategories),已规范化。 */
  async getCategories(): Promise<JoomCategory[]> {
    return normalizeCategories(await this.client.request<unknown>('GET', '/productCategories'));
  }

  /** 获取 Joom 允许的颜色名(GET /productColors)。用于校验 variant.colors。 */
  async getColors(): Promise<unknown> {
    return this.client.request<unknown>('GET', '/productColors');
  }

  /**
   * 某类目要求(requirements + attributeValues 合并),已规范化。
   * 用于后台动态渲染类目属性表单。
   */
  async getCategoryRequirements(id: string, locale?: string): Promise<CategoryRequirements> {
    const reqQs = new URLSearchParams({ id, ...(locale ? { locale } : {}) }).toString();
    const valQs = new URLSearchParams({ id }).toString();
    const [req, values] = await Promise.all([
      this.client.request<unknown>('GET', `/productCategories/requirements?${reqQs}`),
      this.client.request<unknown>('GET', `/productCategories/attributeValues?${valQs}`).catch(() => undefined),
    ]);
    return normalizeRequirements(id, req, values);
  }

  /** 类目必填属性(供发布校验),平台无关方法。 */
  async getRequiredAttributes(categoryId: string): Promise<Array<{ id: string; name: string }>> {
    return requiredAttributes(await this.getCategoryRequirements(categoryId));
  }

  // ---- token 管理 ----

  private readToken(shopId?: string) {
    const id = shopId || shopService.getActiveId();
    return this.tokens.get(shopTokenKey(id)) ?? (id === 'default' ? this.tokens.get(LEGACY_TOKEN_KEY) : null);
  }

  private async getValidAccessToken(shopId = shopService.getActiveId()): Promise<string> {
    const t = this.readToken(shopId);
    if (!t) throw new MarketplaceError('尚未连接 Joom,请先完成授权');
    const expiring = t.expiresAt ? new Date(t.expiresAt).getTime() - Date.now() < REFRESH_SKEW_MS : false;
    if (expiring && t.refreshToken) {
      const creds = shopService.getCredentials(shopId);
      if (!creds) throw new MarketplaceError('当前店铺缺少 Client ID / Secret，无法刷新授权');
      logger.info('Joom token 即将过期,刷新中', { shopId });
      const tok = await this.client.refresh(t.refreshToken, creds);
      this.saveToken(shopId, tok.access_token, tok.refresh_token ?? t.refreshToken, tok.expires_in, tok.expiry_time);
      return tok.access_token;
    }
    return t.accessToken;
  }

  private saveToken(
    shopId: string,
    accessToken: string,
    refreshToken?: string,
    expiresIn?: number,
    expiryTime?: number,
  ): void {
    let expiresAt: string | undefined;
    if (expiryTime) expiresAt = new Date(expiryTime * 1000).toISOString();
    else if (expiresIn) expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    this.tokens.save({
      marketplace: shopTokenKey(shopId),
      env: config.joom.env,
      accessToken,
      refreshToken,
      expiresAt,
    });
  }
}

function normalizeProductList(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.items)) return o.items;
    if (Array.isArray(o.products)) return o.products;
    if (Array.isArray(o.results)) return o.results;
  }
  return [];
}

function toRemoteProduct(data: any, reference?: { id?: string; sku?: string }, shopId?: string, shopName?: string): RemoteProduct {
  const diagnostics = extractJoomIssues(data);
  return {
    id: String(data?.id ?? reference?.id ?? ''),
    shopId,
    shopName,
    state: data?.state,
    updateTimestamp: data?.updateTimestamp,
    hasActiveVersion: Boolean(data?.hasActiveVersion),
    name: data?.name,
    sku: data?.sku ? String(data.sku) : reference?.sku,
    inventory: sumInventory(data),
    issues: diagnostics.summary,
    issueDetails: diagnostics.details,
    raw: data,
  };
}

function sumInventory(raw: any): number {
  const variants = Array.isArray(raw?.variants) ? raw.variants : [];
  return variants.reduce((sum: number, v: any) => sum + (Number(v?.inventory) || 0), 0);
}

function extractJoomIssues(raw: any): { summary?: string; details?: JoomIssueDetail[] } {
  if (!raw || typeof raw !== 'object') return {};
  const details: JoomIssueDetail[] = [];
  const parts: string[] = [];
  const push = (item: JoomIssueDetail) => {
    const message = item.message.trim();
    if (!message) return;
    const key = [item.code, item.field, item.variantSku, message].join('|');
    if (details.some((d) => [d.code, d.field, d.variantSku, d.message].join('|') === key)) return;
    details.push({ ...item, message });
    parts.push(message);
  };
  const walk = (value: unknown) => {
    if (!value) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) push({ message: text });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'object') {
      const o = value as Record<string, unknown>;
      const msg = o.message ?? o.reason ?? o.description ?? o.text ?? o.detail;
      if (msg) push({ message: String(msg), code: stringValue(o.code), field: stringValue(o.field) });
    }
  };
  walk(raw.issues);
  walk(raw.qualityIssues);
  walk(raw.diagnostics);
  walk(raw.review?.issues);
  for (const reason of asArray(raw.review?.reasons)) {
    const translations = asRecord(reason.titleTranslations);
    const title = stringValue(translations?.['zh-CN']) || stringValue(translations?.en) || stringValue(reason.title);
    const note = stringValue(reason.note);
    const message = [title, note].filter(Boolean).join('：') || 'Joom 审核未通过，请查看商品诊断';
    const content = asArray(reason.content)[0] as Record<string, unknown> | undefined;
    push({
      code: stringValue(reason.code),
      title: title || undefined,
      message,
      kind: stringValue(reason.kind),
      field: stringValue(content?.where),
      variantSku: stringValue(content?.variantSku),
      regions: asArray(reason.regions).map(String),
      permanent: typeof reason.isPermanent === 'boolean' ? reason.isPermanent : undefined,
    });
  }
  for (const infraction of asArray(raw.review?.infractions)) {
    push({
      code: stringValue(infraction.code),
      message: stringValue(infraction.description) || stringValue(infraction.note) || 'Joom 商品存在审核问题',
      kind: stringValue(infraction.kind),
      field: stringValue(infraction.where),
      variantSku: stringValue(infraction.variantSku),
      permanent: typeof infraction.isPermanent === 'boolean' ? infraction.isPermanent : undefined,
    });
  }
  walk(raw.moderationComments);
  walk(raw.rejectReason);
  walk(raw.rejectionReason);
  return details.length ? { summary: [...new Set(parts)].join('；'), details } : {};
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
