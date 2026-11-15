import 'dotenv/config';
import path from 'node:path';

/** Joom 各环境的 API 基址。授权流程走 v2,业务接口走 v3。 */
const JOOM_ENDPOINTS = {
  production: {
    apiV3: 'https://api-merchant.joom.com/api/v3',
    oauthV2: 'https://api-merchant.joom.com/api/v2',
  },
  sandbox: {
    apiV3: 'https://sandbox-202607-api-merchant.joomdev.net/api/v3',
    oauthV2: 'https://sandbox-202607-api-merchant.joomdev.net/api/v2',
  },
} as const;

const MERCADO_LIBRE_API_BASE_URL = 'https://api.mercadolibre.com';
const MERCADO_LIBRE_AUTH_URL = 'https://global-selling.mercadolibre.com/authorization';

export type JoomEnv = keyof typeof JOOM_ENDPOINTS;

function bool(v: string | undefined, def = false): boolean {
  if (v == null) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const joomEnv = (process.env.JOOM_ENV as JoomEnv) || 'sandbox';
if (!(joomEnv in JOOM_ENDPOINTS)) {
  throw new Error(`JOOM_ENV 非法: ${joomEnv}(应为 production 或 sandbox)`);
}

export const config = {
  port: Number(process.env.PORT) || 8787,
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5173',
  dbPath: path.resolve(process.env.DB_PATH || './data/app.db'),
  videoDir: path.resolve(process.env.VIDEO_DIR || './data/videos'),
  joom: {
    env: joomEnv,
    endpoints: JOOM_ENDPOINTS[joomEnv],
    clientId: process.env.JOOM_CLIENT_ID || '',
    clientSecret: process.env.JOOM_CLIENT_SECRET || '',
    redirectUri: process.env.JOOM_REDIRECT_URI || 'http://localhost:8787/api/joom/callback',
    /** 是否已配置凭证 */
    get configured() {
      return Boolean(this.clientId && this.clientSecret);
    },
  },
  mercadolibre: {
    apiBaseUrl: process.env.MERCADOLIBRE_API_BASE_URL || MERCADO_LIBRE_API_BASE_URL,
    authUrl: process.env.MERCADOLIBRE_AUTH_URL || MERCADO_LIBRE_AUTH_URL,
    clientId: process.env.MERCADOLIBRE_CLIENT_ID || '',
    clientSecret: process.env.MERCADOLIBRE_CLIENT_SECRET || '',
    redirectUri: process.env.MERCADOLIBRE_REDIRECT_URI || '',
    notificationUrl: process.env.MERCADOLIBRE_NOTIFICATION_URL || '',
    get configured() {
      return Boolean(this.clientId && this.clientSecret && this.redirectUri);
    },
  },
  verbose: bool(process.env.VERBOSE, false),
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  },
  picui: {
    baseUrl: process.env.PICUI_BASE_URL || 'https://picui.cn/api/v1',
    token: process.env.PICUI_TOKEN || '',
  },
} as const;

export type AppConfig = typeof config;
