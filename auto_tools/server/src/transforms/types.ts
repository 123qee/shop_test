import type { EditableProduct, ProductRecord } from '@shared/types';

/** transform 执行上下文,后续可扩展(目标平台、店铺配置、汇率等)。 */
export interface TransformContext {
  record: ProductRecord;
  marketplaceId: string;
}

/**
 * 发布前的可插拔处理步骤。加功能(翻译、加价、类目映射、标题清洗……)
 * = 新增一个 step 并注册进管线,互不影响。
 */
export interface TransformStep {
  readonly name: string;
  /** 是否对当前上下文启用 */
  enabled?(ctx: TransformContext): boolean;
  /** 接收上一步产物,返回处理后的商品 */
  apply(product: EditableProduct, ctx: TransformContext): Promise<EditableProduct> | EditableProduct;
}
