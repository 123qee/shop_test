import { getDb } from '../db/index.js';

/** 存储的 OAuth token(按目标平台区分)。 */
export interface StoredToken {
  marketplace: string;
  env: string;
  accessToken: string;
  refreshToken?: string;
  /** ISO 过期时间 */
  expiresAt?: string;
}

interface Row {
  marketplace: string;
  env: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  updated_at: string;
}

export interface TokenRepository {
  get(marketplace: string): StoredToken | null;
  save(token: StoredToken): void;
  clear(marketplace: string): void;
}

export class SqliteTokenRepository implements TokenRepository {
  get(marketplace: string): StoredToken | null {
    const row = getDb().prepare(`SELECT * FROM oauth_tokens WHERE marketplace = ?`).get(marketplace) as Row | undefined;
    if (!row) return null;
    return {
      marketplace: row.marketplace,
      env: row.env,
      accessToken: row.access_token,
      refreshToken: row.refresh_token ?? undefined,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  save(token: StoredToken): void {
    getDb()
      .prepare(
        `INSERT INTO oauth_tokens (marketplace, env, access_token, refresh_token, expires_at, updated_at)
         VALUES (@marketplace, @env, @accessToken, @refreshToken, @expiresAt, @updatedAt)
         ON CONFLICT(marketplace) DO UPDATE SET
           env = excluded.env,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run({
        marketplace: token.marketplace,
        env: token.env,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        expiresAt: token.expiresAt ?? null,
        updatedAt: new Date().toISOString(),
      });
  }

  clear(marketplace: string): void {
    getDb().prepare(`DELETE FROM oauth_tokens WHERE marketplace = ?`).run(marketplace);
  }
}

export const tokenRepository: TokenRepository = new SqliteTokenRepository();
