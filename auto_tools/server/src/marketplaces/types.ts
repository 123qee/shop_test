import type { EditableProduct, JoomIssueDetail, JoomProductState, JoomRemoveReason, ShopStatusItem } from '@shared/types';

/**
 * 目标电商平台适配器。新增平台 = 实现此接口并注册进 registry,
 * 业务层(PublishService)只依赖接口,不感知具体平台。
 */
export interface MarketplaceAdapter {
  /** 平台唯一标识,如 'joom' */
  readonly id: string;
  /** 展示名 */
  readonly name: string;

  /** 固定使用该店铺的授权，包括异步校验、重试和最终写入。 */
  forShop?(shopId: string): MarketplaceAdapter;

  /** 是否已完成 OAuth 连接(可发布) */
  isConnected(): boolean | Promise<boolean>;

  /** 连接状态详情 */
  getStatus(): Promise<MarketplaceStatus>;

  /** 生成 OAuth 授权跳转地址 */
  getAuthorizeUrl(): string;

  /** OAuth 回调:用授权码换取并保存 token */
  handleCallback(params: Record<string, string>): Promise<void>;

  /** 断开连接(清除 token) */
  disconnect(): Promise<void>;

  /**
   * 发布一个商品。入参是经过 transform 管线处理后的可发布数据。
   * 返回平台侧的商品 id。
   */
  publish(product: EditableProduct): Promise<PublishResult>;

  /**
   * 更新已经发布的商品。平台通常要求用平台商品 id 或商家 SKU 定位，
   * 更新请求本身只携带需要修改的字段。
   */
  update?(product: EditableProduct, reference: { id?: string; sku?: string }): Promise<PublishResult>;

  /** 拉取平台商品，供状态同步和运营诊断使用。 */
  getProduct?(reference: { id?: string; sku?: string }): Promise<RemoteProduct>;

  /** 分页拉取店铺全部商品，供整店状态同步。平台不支持则不实现。 */
  listProducts?(shopId?: string): Promise<RemoteProduct[]>;

  /**
   * 从平台删除商品（不可恢复）。Joom 为 POST /products/remove，
   * 用平台商品 id 或商家 SKU 定位。
   */
  remove?(reference: { id?: string; sku?: string }, reason: JoomRemoveReason): Promise<void>;

  /** 可选:删除商品中的指定变体。 */
  removeVariants?(reference: { id?: string; sku?: string }, variants: Array<{ id?: string; sku?: string }>): Promise<void>;

  /** 可选:某类目的必填属性(用于发布前校验)。平台不支持则不实现。 */
  getRequiredAttributes?(categoryId: string): Promise<Array<{ id: string; name: string }>>;
}

export interface MarketplaceStatus {
  connected: boolean;
  env: 'production' | 'sandbox';
  expiresAt?: string;
  configured?: boolean;
  shopId?: string;
  shopName?: string;
  storeId?: string;
  shops?: ShopStatusItem[];
}

export interface PublishResult {
  marketplaceProductId: string;
  /** 平台返回的原始数据,便于排查 */
  raw?: unknown;
}

export interface RemoteProduct {
  id: string;
  shopId?: string;
  shopName?: string;
  state?: JoomProductState;
  updateTimestamp?: string;
  hasActiveVersion?: boolean;
  name?: string;
  sku?: string;
  /** 变体库存合计 */
  inventory?: number;
  /** 审核/质量问题说明 */
  issues?: string;
  issueDetails?: JoomIssueDetail[];
  raw?: unknown;
}

/** 平台返回的字段级错误,向上透传给前端展示。 */
export class MarketplaceError extends Error {
  constructor(
    message: string,
    public readonly details?: Array<{ code?: string; field?: string; message: string }>,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

/** A product submission may already have reached Joom. Verify before sending another write. */
export class PublishReceiptError extends MarketplaceError {}
