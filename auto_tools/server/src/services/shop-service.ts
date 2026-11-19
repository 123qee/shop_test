import type { ShopProfilePublic, ShopsConfigPublic } from '@shared/types';
import { config } from '../config/index.js';
import { tokenRepository, type TokenRepository } from '../repositories/token-repository.js';
import { settingsRepository, type SettingsRepository } from '../repositories/settings-repository.js';

const SHOPS_KEY = 'shops';
const LEGACY_MARKETPLACE = 'joom';

export class PublishShopError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}

export function shopTokenKey(shopId: string): string {
  return `joom:${shopId}`;
}

export interface StoredShopProfile {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  storeId?: string;
}

interface StoredShopsConfig {
  profiles: StoredShopProfile[];
  activeId: string;
}

export interface ShopSaveProfile {
  id: string;
  name: string;
  clientId?: string;
  clientSecret?: string;
  storeId?: string;
  /** 新建副本时，从该档案复制 Secret（前端不回传明文） */
  inheritSecretFrom?: string;
}

export interface JoomCredentials {
  shopId: string;
  name: string;
  clientId: string;
  clientSecret: string;
  storeId?: string;
}

function maskSecret(secret: string): string {
  const s = secret.trim();
  if (!s) return '';
  if (s.length <= 8) return '已配置';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function defaultFromEnv(): StoredShopProfile {
  return {
    id: 'default',
    name: '默认店铺',
    clientId: config.joom.clientId,
    clientSecret: config.joom.clientSecret,
    storeId: undefined,
  };
}

function normalizeStoreId(value?: string): string | undefined {
  const v = value?.trim();
  return v || undefined;
}

/**
 * 多店铺档案：Client ID / Secret / storeId 存在设置里，
 * 当前店铺决定授权、发布、同步走哪套凭证。
 */
export class ShopService {
  constructor(
    private readonly repo: SettingsRepository = settingsRepository,
    private readonly tokens: TokenRepository = tokenRepository,
  ) {}

  getConfig(): StoredShopsConfig {
    const stored = this.repo.get<StoredShopsConfig>(SHOPS_KEY);
    if (stored?.profiles?.length) {
      const activeId = stored.profiles.some((p) => p.id === stored.activeId)
        ? stored.activeId
        : stored.profiles[0].id;
      return { profiles: stored.profiles, activeId };
    }
    const seeded = defaultFromEnv();
    const configValue: StoredShopsConfig = { profiles: [seeded], activeId: seeded.id };
    this.repo.set(SHOPS_KEY, configValue);
    this.migrateLegacyToken(seeded.id);
    return configValue;
  }

  getPublic(): ShopsConfigPublic {
    const cfg = this.getConfig();
    return {
      activeId: cfg.activeId,
      profiles: cfg.profiles.map((p) => this.toPublic(p)),
    };
  }

  getActiveId(): string {
    return this.getConfig().activeId;
  }

  confirmPublishTarget(shopId: unknown): string {
    if (typeof shopId !== 'string' || !shopId.trim()) {
      throw new PublishShopError('缺少目标店铺，请刷新页面后重新确认发布。', 400);
    }
    if (shopId !== this.getActiveId()) {
      throw new PublishShopError('当前店铺已切换，请刷新页面并重新确认目标店铺。', 409);
    }
    return shopId;
  }

  getActive(): StoredShopProfile | undefined {
    const cfg = this.getConfig();
    return cfg.profiles.find((p) => p.id === cfg.activeId) ?? cfg.profiles[0];
  }

  getProfile(shopId: string): StoredShopProfile | undefined {
    return this.getConfig().profiles.find((p) => p.id === shopId);
  }

  /** 指定/当前店铺的凭证。空档案不回退到别的店；仅「默认店铺」可回退 .env。 */
  getCredentials(shopId?: string): JoomCredentials | null {
    const cfg = this.getConfig();
    const shop = cfg.profiles.find((p) => p.id === (shopId ?? cfg.activeId));
    if (!shop) return null;
    const clientId = shop.clientId?.trim() || (shop.id === 'default' ? config.joom.clientId : '');
    const clientSecret = shop.clientSecret?.trim() || (shop.id === 'default' ? config.joom.clientSecret : '');
    if (!clientId || !clientSecret) return null;
    return {
      shopId: shop.id,
      name: shop.name,
      clientId,
      clientSecret,
      storeId: shop.storeId,
    };
  }

  isConfigured(shopId?: string): boolean {
    return Boolean(this.getCredentials(shopId));
  }

  getStoreId(shopId?: string): string | undefined {
    return (shopId ? this.getProfile(shopId) : this.getActive())?.storeId;
  }

  setActive(shopId: string): ShopsConfigPublic {
    const cfg = this.getConfig();
    if (!cfg.profiles.some((p) => p.id === shopId)) {
      throw new Error('店铺不存在');
    }
    this.repo.set(SHOPS_KEY, { ...cfg, activeId: shopId });
    return this.getPublic();
  }

  save(input: { profiles: ShopSaveProfile[]; activeId: string }): ShopsConfigPublic {
    const current = this.getConfig();
    const byId = new Map(current.profiles.map((p) => [p.id, p]));
    const profiles: StoredShopProfile[] = input.profiles.map((p) => {
      const prev = byId.get(p.id);
      const inherited = p.inheritSecretFrom ? byId.get(p.inheritSecretFrom) : undefined;
      const nextSecret = p.clientSecret?.trim()
        ? p.clientSecret.trim()
        : prev?.clientSecret || inherited?.clientSecret || '';
      const nextClientId = (p.clientId ?? prev?.clientId ?? '').trim();
      if (prev && (nextClientId !== prev.clientId.trim() || (p.clientSecret?.trim() && p.clientSecret.trim() !== prev.clientSecret))) {
        this.clearTokens(p.id);
      }
      return {
        id: p.id,
        name: p.name.trim() || '未命名店铺',
        clientId: nextClientId,
        clientSecret: nextSecret,
        storeId: normalizeStoreId(p.storeId),
      };
    });
    if (!profiles.length) throw new Error('至少保留一个店铺');
    const kept = new Set(profiles.map((p) => p.id));
    for (const old of current.profiles) {
      if (!kept.has(old.id)) this.clearTokens(old.id);
    }
    const activeId = profiles.some((p) => p.id === input.activeId) ? input.activeId : profiles[0].id;
    this.repo.set(SHOPS_KEY, { profiles, activeId });
    return this.getPublic();
  }

  tokenKey(shopId?: string): string {
    return shopTokenKey(shopId || this.getActiveId());
  }

  private toPublic(p: StoredShopProfile): ShopProfilePublic {
    const token = this.tokens.get(shopTokenKey(p.id)) ?? (p.id === 'default' ? this.tokens.get(LEGACY_MARKETPLACE) : null);
    const secret = p.clientSecret?.trim() || '';
    return {
      id: p.id,
      name: p.name,
      clientId: p.clientId,
      hasSecret: Boolean(secret),
      clientSecretHint: secret ? maskSecret(secret) : undefined,
      storeId: p.storeId,
      connected: Boolean(token),
      expiresAt: token?.expiresAt,
    };
  }

  private clearTokens(shopId: string): void {
    this.tokens.clear(shopTokenKey(shopId));
    if (shopId === 'default') this.tokens.clear(LEGACY_MARKETPLACE);
  }

  /** 把旧的全局 joom token 挂到种子店铺上，避免升级后要重新授权。 */
  private migrateLegacyToken(shopId: string): void {
    const legacy = this.tokens.get(LEGACY_MARKETPLACE);
    if (!legacy || this.tokens.get(shopTokenKey(shopId))) return;
    this.tokens.save({ ...legacy, marketplace: shopTokenKey(shopId) });
  }
}

export const shopService = new ShopService();
