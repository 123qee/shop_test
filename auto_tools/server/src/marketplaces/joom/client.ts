import { config } from '../../config/index.js';
import type { JoomCredentials } from '../../services/shop-service.js';
import { logger } from '../../util/logger.js';
import { MarketplaceError } from '../types.js';

/** Joom OAuth token 换取/刷新的返回结构。 */
export interface JoomTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expiry_time?: number; // 秒级时间戳(文档字段)
}

/** Joom 统一响应结构:{ data, paging, errors }。 */
interface JoomEnvelope<T> {
  data?: T;
  paging?: { next?: string };
  message?: string;
  errors?: Array<{ code?: string; field?: string; message?: string; description?: string }>;
}

/**
 * Joom API 底层客户端:只负责 HTTP 与协议细节(鉴权头、错误解析、限流退避、request-id 日志)。
 * 不涉及 token 存储与业务映射,那些在 adapter 层。
 */
export class JoomClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly endpoints = config.joom.endpoints,
  ) {}

  // ---- OAuth(走 v2 地址,form-urlencoded)----

  async exchangeCode(code: string, creds: JoomCredentials): Promise<JoomTokenResponse> {
    return this.oauthForm('/oauth/access_token', {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.joom.redirectUri,
    });
  }

  async refresh(refreshToken: string, creds: JoomCredentials): Promise<JoomTokenResponse> {
    return this.oauthForm('/oauth/refresh_token', {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  private async oauthForm(path: string, params: Record<string, string>): Promise<JoomTokenResponse> {
    const url = this.endpoints.oauthV2 + path;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const requestId = res.headers.get('request-id') ?? undefined;
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok || (json?.errors && json.errors.length > 0)) {
      logger.error('Joom OAuth 失败', { path, status: res.status, requestId, body: text.slice(0, 500) });
      throw new MarketplaceError(
        `Joom 授权失败 (${res.status})`,
        json?.errors ?? [{ message: text.slice(0, 300) || res.statusText }],
        requestId,
      );
    }
    // Joom 的 token 响应可能套在 { data: {...} } 信封里,也可能是顶层字段,两种都兼容
    const payload = json && typeof json === 'object' && json.data ? json.data : json;
    logger.debug('Joom OAuth 响应字段', { path, keys: Object.keys(payload ?? {}), requestId });
    return payload as JoomTokenResponse;
  }

  // ---- 业务 API v3(JSON,camelCase,Bearer)----

  /**
   * 发起 v3 请求。自动加 Bearer 头;429 时按 X-Rate-Limit-Reset 退避重试(最多 3 次)。
   * 返回 envelope.data;errors 非空则抛 MarketplaceError。
   */
  async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const env = await this.requestEnvelope<T>(method, path, body, attempt);
    return env.data as T;
  }

  /** 返回完整信封（含 paging.next），用于 /products/multi 等分页接口。 */
  async requestEnvelope<T>(
    method: string,
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<JoomEnvelope<T>> {
    const token = await this.getAccessToken();
    const url = path.startsWith('http') ? path : this.endpoints.apiV3 + path;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const requestId = res.headers.get('request-id') ?? undefined;

    if (res.status === 429 && attempt < 3) {
      const reset = Number(res.headers.get('X-Rate-Limit-Reset')) || 2;
      const waitMs = Math.min(reset * 1000, 10_000);
      logger.warn('Joom 触发限流,退避重试', { path, waitMs, attempt, requestId });
      await new Promise((r) => setTimeout(r, waitMs));
      return this.requestEnvelope<T>(method, path, body, attempt + 1);
    }

    const text = await res.text();
    let env: JoomEnvelope<T>;
    try {
      env = text ? (JSON.parse(text) as JoomEnvelope<T>) : {};
    } catch {
      env = {};
    }

    if (!res.ok || (env.errors && env.errors.length > 0)) {
      logger.error('Joom API 错误', { method, path, status: res.status, requestId, errors: env.errors });
      const details = env.errors?.map((error) => ({
        code: error.code,
        field: error.field,
        message: error.message || error.description || env.message || res.statusText,
      })) ?? [{ message: env.message || text.slice(0, 300) || res.statusText }];
      throw new MarketplaceError(
        `Joom 请求失败 (${res.status})`,
        details,
        requestId,
      );
    }

    if (config.verbose) logger.debug('Joom API OK', { method, path, requestId });
    return env;
  }
}
