import { config } from '../../config/index.js';
import { MarketplaceError } from '../types.js';
import { logger } from '../../util/logger.js';
import type { MercadoLibreAttribute, MercadoLibreListingDraft, MercadoLibreSellerModel } from '@shared/types';
import { mercadoLibreConfigService } from '../../services/mercadolibre-config-service.js';

export interface MercadoLibreTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  user_id?: number;
  refresh_token?: string;
}

export interface MercadoLibreSellerContext {
  userId: string;
  nickname?: string;
  tags: string[];
  model: MercadoLibreSellerModel;
  sites: Array<{ siteId: 'MLC' | 'MLM' | 'MCO'; userId?: string; logisticTypes: string[]; enabled: boolean }>;
}

export class MercadoLibreClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly getCredentials = () => mercadoLibreConfigService.getCredentials(),
  ) {}

  async exchangeCode(code: string): Promise<MercadoLibreTokenResponse> {
    const credentials = this.credentials();
    return this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      redirect_uri: credentials.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<MercadoLibreTokenResponse> {
    const credentials = this.credentials();
    return this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: refreshToken,
    });
  }

  async getSellerContext(): Promise<MercadoLibreSellerContext> {
    const user = await this.request<any>('GET', '/users/me');
    const userId = String(user.id || user.user_id || '');
    if (!userId) throw new MarketplaceError('美客多响应中缺少卖家 user_id');
    const tags = Array.isArray(user.tags) ? user.tags.map(String) : [];
    const marketplace = await this.request<any>('GET', `/marketplace/users/${encodeURIComponent(userId)}`).catch(() => undefined);
    const sites = (Array.isArray(marketplace?.marketplaces) ? marketplace.marketplaces : [])
      .map((item: any) => ({
        siteId: String(item.site_id || '').toUpperCase(),
        userId: item.user_id ? String(item.user_id) : undefined,
        logisticTypes: [String(item.logistic_type || 'remote')],
        enabled: true,
      }))
      .filter((item: any) => ['MLC', 'MLM', 'MCO'].includes(item.siteId));
    const model: MercadoLibreSellerModel = tags.includes('user_product_seller')
      ? 'user_products'
      : marketplace?.user_type === 'fully_managed' || marketplace?.is_fully_managed
        ? 'fully_managed'
        : 'global_items';
    return { userId, nickname: user.nickname, tags, model, sites };
  }

  async getCategoryAttributes(categoryId: string): Promise<unknown> {
    return this.request('GET', `/categories/${encodeURIComponent(categoryId)}/attributes`);
  }

  async getCategories(siteId: 'MLC' | 'MLM' | 'MCO'): Promise<unknown> {
    return this.request('GET', `/sites/${encodeURIComponent(siteId)}/categories`);
  }

  async predictCategory(siteId: 'MLC' | 'MLM' | 'MCO', title: string): Promise<unknown> {
    return this.request('GET', `/sites/${encodeURIComponent(siteId)}/category_predictor/predict?title=${encodeURIComponent(title)}`);
  }

  async uploadPicture(sourceUrl: string): Promise<{ id: string; url?: string }> {
    const token = await this.getAccessToken();
    const image = await fetch(sourceUrl);
    if (!image.ok) throw new MarketplaceError(`读取商品图片失败 (${image.status})`);
    const type = image.headers.get('content-type') || 'image/jpeg';
    const blob = new Blob([await image.arrayBuffer()], { type });
    const form = new FormData();
    form.append('file', blob, filenameFor(sourceUrl, type));
    const res = await fetch(`${config.mercadolibre.apiBaseUrl}/pictures/items/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok || !json?.id) throw this.errorFromResponse('上传美客多图片失败', res.status, json, text);
    return { id: String(json.id), url: json.url ? String(json.url) : undefined };
  }

  async createGlobalItem(draft: MercadoLibreListingDraft, pictureIds: string[]): Promise<any> {
    const body = draft.remote?.model === 'global_items'
      ? legacyPayload(draft, pictureIds)
      : userProductPayload(draft, pictureIds);
    const path = draft.remote?.model === 'global_items' ? '/global/items' : '/global/user-products/families';
    return this.request('POST', path, body);
  }

  async updateListing(draft: MercadoLibreListingDraft, pictureIds: string[]): Promise<any> {
    const remoteId = draft.remote?.sitelessUserProductId || draft.remote?.itemIds?.[0];
    if (!remoteId) throw new MarketplaceError('美客多草稿缺少远端商品 ID，无法更新');
    if (draft.remote?.model === 'global_items') {
      return this.request('PUT', `/global/items/${encodeURIComponent(remoteId)}`, legacyUpdatePayload(draft, pictureIds));
    }
    return this.request('PUT', `/global/user-products/${encodeURIComponent(remoteId)}`, userProductUpdatePayload(draft, pictureIds));
  }

  async updateStatus(draft: MercadoLibreListingDraft, status: 'active' | 'paused'): Promise<any> {
    const remoteId = draft.remote?.sitelessUserProductId || draft.remote?.itemIds?.[0];
    if (!remoteId) throw new MarketplaceError('美客多草稿缺少远端商品 ID，无法修改状态');
    if (draft.remote?.model === 'global_items') {
      return this.request('PUT', `/global/items/${encodeURIComponent(remoteId)}`, { status });
    }
    return this.request('PUT', `/global/user-products/${encodeURIComponent(remoteId)}`, { status });
  }

  async getListing(draft: MercadoLibreListingDraft): Promise<any> {
    const remoteId = draft.remote?.sitelessUserProductId || draft.remote?.itemIds?.[0];
    if (!remoteId) throw new MarketplaceError('美客多草稿缺少远端商品 ID，无法同步');
    const path = draft.remote?.model === 'global_items'
      ? `/global/items/${encodeURIComponent(remoteId)}`
      : `/user-products/${encodeURIComponent(remoteId)}`;
    return this.request('GET', path);
  }

  private async tokenRequest(params: Record<string, string>): Promise<MercadoLibreTokenResponse> {
    const res = await fetch(`${config.mercadolibre.apiBaseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok || !json?.access_token) throw this.errorFromResponse('美客多 OAuth 失败', res.status, json, text);
    return json as MercadoLibreTokenResponse;
  }

  private async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${config.mercadolibre.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok) throw this.errorFromResponse(`美客多请求失败 ${method} ${path}`, res.status, json, text);
    return json as T;
  }

  private credentials() {
    const credentials = this.getCredentials();
    if (!credentials) throw new MarketplaceError('未配置美客多 App ID、Secret 或 Redirect URI');
    return credentials;
  }

  private errorFromResponse(prefix: string, status: number, json: any, raw: string): MarketplaceError {
    const causes = Array.isArray(json?.cause) ? json.cause : [];
    const details = causes.map((cause: any) => ({ code: cause.code, field: cause.department, message: String(cause.message || cause.code || '未知错误') }));
    logger.error('Mercado Libre API 错误', { prefix, status, json: String(raw).slice(0, 800) });
    return new MarketplaceError(`${prefix} (${status})`, details.length ? details : [{ message: String(json?.message || raw).slice(0, 300) }]);
  }
}

function parseJson(text: string): any {
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

function filenameFor(url: string, type: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop();
    if (name && /\.[a-z0-9]+$/i.test(name)) return name;
  } catch { /* fall through */ }
  return `product-image.${type.split('/')[1] || 'jpg'}`;
}

function pictures(ids: string[]) { return ids.filter(Boolean).map((id) => ({ id })); }

function attributes(values: MercadoLibreAttribute[]) {
  return values.map((attribute) => ({
    id: attribute.id,
    ...(attribute.name ? { name: attribute.name } : {}),
    ...(attribute.values ? { values: attribute.values } : attribute.valueId || attribute.valueName ? { value_id: attribute.valueId, value_name: attribute.valueName } : {}),
  }));
}

function siteCondition(draft: MercadoLibreListingDraft) {
  return {
    site_id: draft.siteId,
    logistic_type: draft.logisticType || 'remote',
    ...(draft.listingTypeId ? { listing_type_id: draft.listingTypeId } : {}),
    ...(draft.priceMode !== 'net_proceeds' && draft.priceValue != null ? { price: draft.priceValue } : {}),
    ...(draft.priceMode === 'net_proceeds' && draft.priceValue != null ? { global_net_proceeds: draft.priceValue } : {}),
  };
}

function userProductPayload(draft: MercadoLibreListingDraft, pictureIds: string[]) {
  return [{
    sites_to_sell: [siteCondition(draft)],
    family_name: draft.title,
    category_id: draft.categoryId,
    currency_id: draft.currency || 'USD',
    ...(draft.priceMode === 'net_proceeds' ? { global_net_proceeds: draft.priceValue } : { price: draft.priceValue }),
    description: { plain_text: draft.description || '' },
    pictures: pictures(pictureIds),
    attributes: attributes(draft.attributes),
  }];
}

function legacyPayload(draft: MercadoLibreListingDraft, pictureIds: string[]) {
  return {
    sites_to_sell: [{
      ...siteCondition(draft),
      title: draft.title,
      pictures: pictures(pictureIds),
      variations: draft.variants.map((variant) => ({
        price: variant.price,
        available_quantity: variant.inventory,
        seller_custom_field: variant.sku,
        attribute_combinations: attributes(variant.attributes),
      })),
    }],
    family_name: draft.title,
    category_id: draft.categoryId,
    currency_id: draft.currency || 'USD',
    description: { plain_text: draft.description || '' },
  };
}

function userProductUpdatePayload(draft: MercadoLibreListingDraft, pictureIds: string[]) {
  return {
    listing_sites: [{
      listing_id: draft.remote?.itemIds?.[0],
      family_name: draft.title,
      description: { plain_text: draft.description || '' },
      ...(draft.priceValue != null ? { [draft.priceMode === 'net_proceeds' ? 'net_proceeds' : 'price']: draft.priceValue } : {}),
    }],
    ...(pictureIds.length ? { pictures: pictures(pictureIds) } : {}),
    ...(draft.attributes.length ? { attributes: attributes(draft.attributes) } : {}),
  };
}

function legacyUpdatePayload(draft: MercadoLibreListingDraft, pictureIds: string[]) {
  return {
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.description ? { description: { plain_text: draft.description } } : {}),
    ...(draft.categoryId ? { category_id: draft.categoryId } : {}),
    ...(pictureIds.length ? { pictures: pictures(pictureIds) } : {}),
    ...(draft.priceValue != null ? { price: draft.priceValue } : {}),
    variations: draft.variants.map((variant) => ({
      price: variant.price,
      available_quantity: variant.inventory,
      seller_custom_field: variant.sku,
      attribute_combinations: attributes(variant.attributes),
    })),
  };
}
