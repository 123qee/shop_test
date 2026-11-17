import type { OrderLine, UnifiedOrder } from '@shared/orders';

/**
 * 订单来源适配器。新增平台 = 实现此接口并在 bootstrap 注册，
 * 同步、材质判定、拆分、写文件、命名都不需要改。
 *
 * 与发布用的 MarketplaceAdapter 分开：某个平台只接订单或只接发布都不受影响。
 */
export interface OrderSourceAdapter {
  /** 平台标识，如 'joom' */
  readonly platform: string;
  /** 展示名，如 'Joom' */
  readonly label: string;

  /** 可导出订单的店铺及授权状态 */
  listShops(): OrderSourceShop[];

  /**
   * 增量拉取：返回 since 之后有更新的订单，每次产出一页。
   * 订单行需要尽量补全标题、颜色、尺码和材质原文。
   */
  fetchOrders(shopId: string, options: FetchOrdersOptions): AsyncIterable<UnifiedOrder[]>;

  /** 订单行对应的本地商品库记录 id，用来读取已确认的分组材质。平台不支持时不实现。 */
  findCatalogProductId?(line: OrderLine, shopId: string): string | undefined;
}

export interface OrderSourceShop {
  shopId: string;
  shopName: string;
  /** 已填写凭证 */
  configured: boolean;
  /** 已完成授权，可以拉订单 */
  connected: boolean;
}

export interface FetchOrdersOptions {
  /** 只返回该时间之后有更新的订单 */
  since: Date;
}
