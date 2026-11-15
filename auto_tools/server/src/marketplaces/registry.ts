import type { MarketplaceAdapter } from './types.js';

/** 目标平台注册表。加平台时在 index.ts 里 register 即可。 */
class MarketplaceRegistry {
  private readonly adapters = new Map<string, MarketplaceAdapter>();

  register(adapter: MarketplaceAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): MarketplaceAdapter | undefined {
    return this.adapters.get(id);
  }

  /** 取出唯一/默认平台(当前只有 Joom);多平台时按 id 取。 */
  require(id: string): MarketplaceAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`未注册的目标平台: ${id}`);
    return a;
  }

  list(): MarketplaceAdapter[] {
    return [...this.adapters.values()];
  }
}

export const marketplaceRegistry = new MarketplaceRegistry();
