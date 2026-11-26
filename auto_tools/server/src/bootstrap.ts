/**
 * 组装扩展点:注册目标平台 adapter、订单来源与 transform 步骤。
 * 加平台/加功能时,只需在这里多一行 register/use。
 */
import { marketplaceRegistry } from './marketplaces/registry.js';
import { JoomAdapter } from './marketplaces/joom/adapter.js';
import { JoomOrderSource } from './marketplaces/joom/orders.js';
import { MiaoshouOrderSource } from './marketplaces/miaoshou/orders.js';
import { orderSourceRegistry } from './orders/registry.js';
import { transformPipeline } from './transforms/pipeline.js';
import { trimTitleStep } from './transforms/steps/trim-title.js';

export function bootstrap(): void {
  // 目标平台
  const joom = new JoomAdapter();
  marketplaceRegistry.register(joom);

  // 订单来源(订单导出);接其他平台时再 register 一个 OrderSourceAdapter
  orderSourceRegistry.register(new JoomOrderSource(joom));
  orderSourceRegistry.register(new MiaoshouOrderSource());

  // 发布前处理管线(顺序执行)
  transformPipeline.use(trimTitleStep);
  // 后续:.use(pricingStep).use(translateStep).use(categoryMapStep) ...
}
