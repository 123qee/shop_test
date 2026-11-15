import type { CollectedProduct } from '@shared/types';

/**
 * 来源平台提取器。新增平台 = 实现此接口并在 registry 注册,
 * content 主逻辑不感知具体平台。
 */
export interface SourceExtractor {
  /** 平台标识 */
  readonly id: CollectedProduct['source'];
  /** 是否匹配当前站点 */
  matches(url: string): boolean;
  /** 当前是否为商品详情页 */
  isDetailPage(url: string): boolean;
  /** 在列表/店铺页查找所有商品卡片元素 */
  findCards(root?: ParentNode): HTMLElement[];
  /** 从商品卡片取详情页 URL,供批量采集使用 */
  getCardUrl(card: HTMLElement): string | null;
  /** 从单个卡片元素提取商品(列表页信息有限,变体可能为空) */
  extractCard(card: HTMLElement): CollectedProduct | null;
  /** 从详情页提取完整商品(可能需注入主世界脚本读 SKU,故为异步) */
  extractDetail(): Promise<CollectedProduct | null>;
}
