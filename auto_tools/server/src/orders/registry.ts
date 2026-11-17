import type { OrderSourceAdapter } from './types.js';

/** 订单来源注册表。加平台时在 bootstrap.ts 里 register 即可。 */
class OrderSourceRegistry {
  private readonly sources = new Map<string, OrderSourceAdapter>();

  register(source: OrderSourceAdapter): void {
    this.sources.set(source.platform, source);
  }

  get(platform: string): OrderSourceAdapter | undefined {
    return this.sources.get(platform);
  }

  require(platform: string): OrderSourceAdapter {
    const source = this.sources.get(platform);
    if (!source) throw new Error(`未注册的订单平台: ${platform}`);
    return source;
  }

  list(): OrderSourceAdapter[] {
    return [...this.sources.values()];
  }

  label(platform: string): string {
    return this.sources.get(platform)?.label ?? platform;
  }
}

export const orderSourceRegistry = new OrderSourceRegistry();
