import { config } from '../config/index.js';
import { settingsRepository, type SettingsRepository } from '../repositories/settings-repository.js';

const KEY = 'mercadolibreConfig';

interface StoredMercadoLibreConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  notificationUrl: string;
}

function mask(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= 8 ? '已配置' : `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export class MercadoLibreConfigService {
  constructor(private readonly repo: SettingsRepository = settingsRepository) {}

  getStored(): StoredMercadoLibreConfig {
    const stored = this.repo.get<StoredMercadoLibreConfig>(KEY);
    return {
      clientId: stored?.clientId?.trim() || config.mercadolibre.clientId,
      clientSecret: stored?.clientSecret?.trim() || config.mercadolibre.clientSecret,
      redirectUri: stored?.redirectUri?.trim() || config.mercadolibre.redirectUri,
      notificationUrl: stored?.notificationUrl?.trim() || config.mercadolibre.notificationUrl,
    };
  }

  getCredentials() {
    const value = this.getStored();
    if (!value.clientId || !value.clientSecret || !value.redirectUri) return null;
    return value;
  }

  save(input: Partial<StoredMercadoLibreConfig>): void {
    const current = this.getStored();
    const next = {
      clientId: input.clientId?.trim() || current.clientId,
      clientSecret: input.clientSecret?.trim() || current.clientSecret,
      redirectUri: input.redirectUri?.trim() || current.redirectUri,
      notificationUrl: input.notificationUrl?.trim() || current.notificationUrl,
    };
    if (!next.clientId || !next.clientSecret || !next.redirectUri) {
      throw new Error('Mercado Libre App ID、Secret 和 Redirect URI 不能为空');
    }
    if (!/^https:\/\//i.test(next.redirectUri)) throw new Error('Mercado Libre Redirect URI 必须使用 HTTPS');
    if (next.notificationUrl && !/^https:\/\//i.test(next.notificationUrl)) {
      throw new Error('Mercado Libre 通知回调地址必须使用 HTTPS');
    }
    this.repo.set(KEY, next);
  }

  getPublic() {
    const value = this.getStored();
    return {
      configured: Boolean(value.clientId && value.clientSecret && value.redirectUri),
      clientId: value.clientId || undefined,
      clientSecretHint: mask(value.clientSecret),
      redirectUri: value.redirectUri || undefined,
      notificationUrl: value.notificationUrl || undefined,
    };
  }
}

export const mercadoLibreConfigService = new MercadoLibreConfigService();
