import crypto from 'node:crypto';
import type {
  CollectedProduct,
  MercadoLibreAccountPublic,
  MercadoLibreAttribute,
  MercadoLibreConfigPublic,
  MercadoLibreListingDraft,
  MercadoLibreListingIndexItem,
  MercadoLibreSellerModel,
  MercadoLibreSiteId,
  MercadoLibreTemplate,
  MercadoLibreValidationResponse,
} from '@shared/types';
import { config } from '../config/index.js';
import { MarketplaceError } from '../marketplaces/types.js';
import { MercadoLibreClient, type MercadoLibreTokenResponse } from '../marketplaces/mercadolibre/client.js';
import { mercadoLibreRepository } from '../repositories/mercadolibre-repository.js';
import { tokenRepository } from '../repositories/token-repository.js';
import { settingsRepository } from '../repositories/settings-repository.js';
import { productRepository } from '../repositories/product-repository.js';
import { getDb } from '../db/index.js';
import { productService } from './product-service.js';
import { mercadoLibreConfigService } from './mercadolibre-config-service.js';
import { logger } from '../util/logger.js';

const TEMPLATE_KEY = 'mercadolibreTemplates';
const TOKEN_PREFIX = 'mercadolibre:';
const REFRESH_SKEW_MS = 60_000;

interface OAuthState { createdAt: number; }

export class MercadoLibreService {
  private readonly oauthStates = new Map<string, OAuthState>();

  getConfig(): MercadoLibreConfigPublic {
    return {
      ...mercadoLibreConfigService.getPublic(),
      connectedAccounts: this.listAccounts(),
    };
  }

  saveConfig(input: { clientId?: string; clientSecret?: string; redirectUri?: string; notificationUrl?: string }) {
    mercadoLibreConfigService.save(input);
    return this.getConfig();
  }

  getAuthorizeUrl(): string {
    const credentials = mercadoLibreConfigService.getCredentials();
    if (!credentials) throw new MarketplaceError('请先在设置中填写 Mercado Libre App ID、Secret 和 Redirect URI');
    const state = crypto.randomBytes(24).toString('hex');
    this.oauthStates.set(state, { createdAt: Date.now() });
    const url = new URL(config.mercadolibre.authUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('redirect_uri', credentials.redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async handleCallback(params: Record<string, string>): Promise<MercadoLibreAccountPublic> {
    const code = params.code?.trim();
    const state = params.state?.trim();
    if (!code) throw new MarketplaceError('美客多回调缺少 code');
    if (!state || !this.consumeState(state)) throw new MarketplaceError('美客多 OAuth state 无效或已过期');

    const tokenClient = new MercadoLibreClient(async () => '');
    const token = await tokenClient.exchangeCode(code);
    if (!token.access_token) throw new MarketplaceError('美客多授权响应中没有 access_token');

    const pendingKey = `${TOKEN_PREFIX}pending:${state}`;
    this.saveToken(pendingKey, token);
    try {
      const context = await new MercadoLibreClient(() => Promise.resolve(token.access_token)).getSellerContext();
      const account = mercadoLibreRepository.upsertAccount({
        userId: context.userId,
        nickname: context.nickname,
        model: context.model,
        tags: context.tags,
        sites: context.sites,
      });
      const finalKey = this.tokenKey(account.id);
      this.saveToken(finalKey, token);
      logger.info('Mercado Libre 连接成功', { accountId: account.id, userId: account.userId, model: account.model });
      return { ...account, connected: true, expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined };
    } finally {
      tokenRepository.clear(pendingKey);
    }
  }

  listAccounts(): MercadoLibreAccountPublic[] {
    const accounts = mercadoLibreRepository.listAccounts();
    const connected = new Set<string>();
    const expires = new Map<string, string | undefined>();
    for (const account of accounts) {
      const token = tokenRepository.get(this.tokenKey(account.id));
      if (token) {
        connected.add(account.id);
        expires.set(account.id, token.expiresAt);
      }
    }
    return mercadoLibreRepository.listAccounts(connected, expires);
  }

  async disconnect(accountId: string): Promise<void> {
    tokenRepository.clear(this.tokenKey(accountId));
  }

  async refreshAccount(accountId: string): Promise<MercadoLibreAccountPublic> {
    await this.getValidAccessToken(accountId);
    return this.listAccounts().find((account) => account.id === accountId) ?? (() => { throw new MarketplaceError('美客多卖家不存在'); })();
  }

  async getSites(accountId: string) {
    const account = this.requireAccount(accountId);
    await this.getValidAccessToken(account.id);
    const client = await this.clientFor(account.id);
    const context = await client.getSellerContext();
    return mercadoLibreRepository.upsertAccount({ ...context });
  }

  getTemplates(): MercadoLibreTemplate[] {
    // 模板结构按新版本的多站点模型读取；旧结构不参与新配置。
    return (settingsRepository.get<MercadoLibreTemplate[]>(TEMPLATE_KEY) ?? []).filter((template) => Array.isArray(template.siteIds));
  }

  saveTemplate(template: MercadoLibreTemplate): MercadoLibreTemplate[] {
    const current = this.getTemplates().filter((item) => item.id !== template.id);
    const next = [...current, template];
    settingsRepository.set(TEMPLATE_KEY, next);
    return next;
  }

  deleteTemplate(id: string): MercadoLibreTemplate[] {
    const next = this.getTemplates().filter((template) => template.id !== id);
    settingsRepository.set(TEMPLATE_KEY, next);
    return next;
  }

  async getCategoryAttributes(accountId: string, categoryId: string): Promise<unknown> {
    const client = await this.clientFor(accountId);
    return client.getCategoryAttributes(categoryId);
  }

  async getCategories(accountId: string, siteId: MercadoLibreSiteId): Promise<unknown> {
    const client = await this.clientFor(accountId);
    return client.getCategories(siteId);
  }

  async predictCategory(accountId: string, siteId: MercadoLibreSiteId, title: string): Promise<unknown> {
    const text = title.trim();
    if (!text) throw new MarketplaceError('请输入商品标题或类目关键词');
    const client = await this.clientFor(accountId);
    return client.predictCategory(siteId, text);
  }

  createDrafts(productId: string, accountId: string, siteIds: MercadoLibreSiteId[], templateIds?: Partial<Record<MercadoLibreSiteId, string>>): MercadoLibreListingDraft[] {
    const product = productRepository.get(productId);
    if (!product) throw new MarketplaceError('商品不存在');
    const account = this.requireAccount(accountId);
    const collected = product.collected;
    const templates = this.getTemplates();
    return siteIds.map((siteId) => {
      const existing = mercadoLibreRepository.findListing(productId, accountId, siteId);
      if (existing) return existing;
      const template = templates.find((item) => item.id === templateIds?.[siteId]) || templates.find((item) => item.siteIds.includes(siteId));
      const draft = fromCollected(productId, account.id, siteId, collected, template);
      return mercadoLibreRepository.createListing(draft);
    });
  }

  listListings(productId?: string): MercadoLibreListingDraft[] {
    return mercadoLibreRepository.listListings(productId);
  }

  listListingIndex(): MercadoLibreListingIndexItem[] {
    return mercadoLibreRepository.listListingIndex();
  }

  getListing(id: string): MercadoLibreListingDraft {
    const listing = mercadoLibreRepository.getListing(id);
    if (!listing) throw new MarketplaceError('美客多刊登草稿不存在');
    return listing;
  }

  updateListing(id: string, patch: Partial<MercadoLibreListingDraft>): MercadoLibreListingDraft {
    const listing = this.getListing(id);
    const { syncShared = false, ...listingPatch } = patch as Partial<MercadoLibreListingDraft> & { syncShared?: boolean };
    if (['published', 'publishing'].includes(listing.status) && listingPatch.status === undefined) {
      // Published content can still be edited; status remains controlled by publish/update operations.
    }
    const updated = mercadoLibreRepository.updateListing(id, listingPatch);
    if (!updated) throw new MarketplaceError('美客多刊登草稿不存在');
    if (syncShared) this.syncSharedFields(updated);
    return updated;
  }

  deleteSharedImage(id: string, imageUrl: string): MercadoLibreListingDraft[] {
    const source = this.getListing(id);
    const url = imageUrl.trim();
    if (!url) throw new MarketplaceError('缺少要删除的图片');

    const product = productRepository.get(source.productId);
    if (!product) throw new MarketplaceError('母库商品不存在');

    return getDb().transaction(() => {
      const savedProduct = productService.deleteImage(source.productId, url);
      if (!savedProduct) throw new MarketplaceError('母库商品不存在');

      const listings = mercadoLibreRepository.listListings(source.productId);
      for (const listing of listings) {
        mercadoLibreRepository.updateListing(listing.id, {
          images: listing.images.filter((image) => image !== url),
          variants: listing.variants.map((variant) => {
            const images = variant.images?.filter((image) => image !== url);
            return { ...variant, images: images?.length ? images : undefined };
          }),
        });
      }
      return mercadoLibreRepository.listListings(source.productId);
    })();
  }

  private syncSharedFields(source: MercadoLibreListingDraft): void {
    const siblings = mercadoLibreRepository.listListings(source.productId)
      .filter((item) => item.id !== source.id && item.accountId === source.accountId);
    for (const sibling of siblings) {
      const priceBySku = new Map(sibling.variants.map((variant) => [variant.sku, variant.price]));
      const variants = source.variants.map((variant) => ({
        ...variant,
        // 价格属于站点销售条件，保留目标站点自己的价格。
        price: priceBySku.get(variant.sku) ?? variant.price,
      }));
      mercadoLibreRepository.updateListing(sibling.id, {
        title: source.title,
        description: source.description,
        images: source.images,
        variants,
      });
    }
  }

  validateListing(id: string): MercadoLibreValidationResponse {
    const listing = this.getListing(id);
    const issues = [] as Array<{ field: string; message: string; severity: 'error' | 'warning' }>;
    if (!listing.title.trim()) issues.push({ field: 'title', message: '标题不能为空', severity: 'error' });
    if (!listing.categoryId?.trim()) issues.push({ field: 'categoryId', message: '请先选择美客多类目', severity: 'error' });
    if (!listing.images.length) issues.push({ field: 'images', message: '至少需要一张商品图片', severity: 'error' });
    if (!listing.variants.length) issues.push({ field: 'variants', message: '至少需要一个变体', severity: 'error' });
    for (const [index, variant] of listing.variants.entries()) {
      if (!variant.sku.trim()) issues.push({ field: `variants.${index}.sku`, message: '变体 SKU 不能为空', severity: 'error' });
      if (variant.price < 0) issues.push({ field: `variants.${index}.price`, message: '价格不能小于 0', severity: 'error' });
      if (variant.inventory < 0) issues.push({ field: `variants.${index}.inventory`, message: '库存不能小于 0', severity: 'error' });
    }
    if (listing.language === 'source') issues.push({ field: 'language', message: '当前使用采集语言，发布前请确认平台要求；可单独翻译标题', severity: 'warning' });
    return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
  }

  async publish(id: string): Promise<MercadoLibreListingDraft> {
    const listing = this.getListing(id);
    const validation = this.validateListing(id);
    if (!validation.ok) throw new MarketplaceError('美客多发布校验未通过', validation.issues.filter((issue) => issue.severity === 'error'));
    const account = this.requireAccount(listing.accountId);
    const model = account.model;
    const next = mercadoLibreRepository.updateListing(id, { status: 'publishing', lastError: '' })!;
    try {
      const client = await this.clientFor(account.id);
      const pictureIds = await this.ensurePictures(client, next.images);
      const prepared = { ...next, remote: { ...(next.remote ?? {}), model } };
      const response = prepared.remote?.sitelessUserProductId || prepared.remote?.itemIds?.length
        ? await client.updateListing(prepared, pictureIds)
        : await client.createGlobalItem(prepared, pictureIds);
      const remote = extractRemote(response, model);
      return mercadoLibreRepository.updateListing(id, { status: 'published', remote, lastError: '' })!;
    } catch (error) {
      const message = formatError(error);
      mercadoLibreRepository.updateListing(id, { status: 'failed', lastError: message });
      throw error;
    }
  }

  async setStatus(id: string, status: 'active' | 'paused'): Promise<MercadoLibreListingDraft> {
    const listing = this.getListing(id);
    const account = this.requireAccount(listing.accountId);
    const client = await this.clientFor(account.id);
    await client.updateStatus(listing, status);
    return mercadoLibreRepository.updateListing(id, { status: status === 'active' ? 'published' : 'paused', lastError: '' })!;
  }

  async sync(id: string): Promise<MercadoLibreListingDraft> {
    const listing = this.getListing(id);
    const account = this.requireAccount(listing.accountId);
    const client = await this.clientFor(account.id);
    const remote = await client.getListing(listing);
    const status = String(remote?.status || remote?.items?.[0]?.status || listing.status);
    return mercadoLibreRepository.updateListing(id, {
      status: status === 'paused' ? 'paused' : status === 'active' ? 'published' : listing.status,
      lastSyncedAt: new Date().toISOString(),
      lastError: '',
    })!;
  }

  async handleNotification(payload: unknown): Promise<void> {
    logger.info('收到 Mercado Libre 通知', { payload });
  }

  private async ensurePictures(client: MercadoLibreClient, images: string[]): Promise<string[]> {
    const result: string[] = [];
    for (const image of images.slice(0, 20)) {
      const cached = mercadoLibreRepository.getPictureMapping(image);
      if (cached) { result.push(cached); continue; }
      const uploaded = await client.uploadPicture(image);
      mercadoLibreRepository.savePictureMapping(image, uploaded.id);
      result.push(uploaded.id);
    }
    return result;
  }

  private requireAccount(accountId?: string) {
    if (!accountId) throw new MarketplaceError('请先选择已授权的美客多卖家');
    const account = this.listAccounts().find((item) => item.id === accountId);
    if (!account) throw new MarketplaceError('美客多卖家不存在，请重新授权');
    return account;
  }

  private tokenKey(accountId: string): string { return `${TOKEN_PREFIX}${accountId}`; }

  private async clientFor(accountId: string): Promise<MercadoLibreClient> {
    await this.getValidAccessToken(accountId);
    return new MercadoLibreClient(() => this.getValidAccessToken(accountId));
  }

  private async getValidAccessToken(accountId: string): Promise<string> {
    const key = this.tokenKey(accountId);
    const token = tokenRepository.get(key);
    if (!token) throw new MarketplaceError('尚未连接美客多卖家，请先完成授权');
    const expiring = token.expiresAt ? new Date(token.expiresAt).getTime() - Date.now() < REFRESH_SKEW_MS : false;
    if (expiring && token.refreshToken) {
      const refreshed = await new MercadoLibreClient(async () => token.accessToken).refresh(token.refreshToken);
      this.saveToken(key, refreshed);
      return refreshed.access_token;
    }
    return token.accessToken;
  }

  private saveToken(key: string, token: MercadoLibreTokenResponse): void {
    tokenRepository.save({
      marketplace: key,
      env: 'production',
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined,
    });
  }

  private consumeState(state: string): boolean {
    const entry = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    return Boolean(entry && Date.now() - entry.createdAt < 10 * 60_000);
  }
}

function fromCollected(
  productId: string,
  accountId: string,
  siteId: MercadoLibreSiteId,
  source: CollectedProduct,
  template?: MercadoLibreTemplate,
): Omit<MercadoLibreListingDraft, 'id' | 'createdAt' | 'updatedAt'> {
  const sourcePrice = source.price?.value ?? 0;
  const price = template?.priceMode === 'set'
    ? template.priceValue
    : template?.priceMode === 'multiply'
      ? Math.round(sourcePrice * template.priceValue * 100) / 100
      : sourcePrice;
  return {
    productId,
    accountId,
    siteId,
    templateId: template?.id,
    status: 'draft',
    title: renderTemplate(template?.titleTemplate, source.title, source),
    description: renderTemplate(template?.descriptionTemplate, source.description ?? '', source),
    currency: template?.currency || 'USD',
    categoryId: template?.categoryId,
    attributes: template?.attributes ?? [],
    images: source.images.slice(0, 20),
    variants: source.variants.length
      ? source.variants.map((variant, index) => ({
          sku: variant.sourceSkuId || `${source.sourceProductId}-${index + 1}`,
          price: variant.price ?? price,
          inventory: variant.stock ?? 0,
          attributes: Object.entries(variant.options).map(([id, value]) => ({ id, valueName: value })),
          images: variant.image ? [variant.image] : undefined,
        }))
      : [{ sku: source.sourceProductId, price, inventory: 0, attributes: [] }],
    logisticType: template?.logisticType || 'remote',
    listingTypeId: template?.listingTypeId,
    priceMode: template?.priceMode || 'set',
    priceValue: price,
    language: template?.language || 'source',
  };
}

function renderTemplate(template: string | undefined, fallback: string, source: CollectedProduct): string {
  const content = template?.trim();
  if (!content) return fallback;
  const firstVariant = source.variants[0];
  const values: Record<string, string> = {
    title: source.title,
    sourceDescription: source.description ?? '',
    sourceProductId: source.sourceProductId,
    sku: firstVariant?.sourceSkuId || source.sourceProductId,
    brand: source.attributes?.brand ?? source.attributes?.Brand ?? source.attributes?.品牌 ?? '',
    store: source.store?.name ?? '',
  };
  return content.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '').trim();
}

function extractRemote(response: any, model: MercadoLibreSellerModel) {
  const root = Array.isArray(response) ? response[0] : response;
  const items = Array.isArray(root?.site_items) ? root.site_items : Array.isArray(root?.items) ? root.items : [];
  const itemIds = items.map((item: any) => String(item.item_id || item.id || '')).filter(Boolean);
  return {
    model,
    sitelessUserProductId: root?.id ? String(root.id) : root?.user_product_id ? String(root.user_product_id) : undefined,
    familyId: root?.family_id || root?.siteless_family_id ? String(root.family_id || root.siteless_family_id) : undefined,
    itemIds,
  };
}

function formatError(error: unknown): string {
  if (error instanceof MarketplaceError) return error.message + (error.details?.length ? `: ${error.details.map((detail) => detail.message).join('; ')}` : '');
  return error instanceof Error ? error.message : String(error);
}

export const mercadoLibreService = new MercadoLibreService();
