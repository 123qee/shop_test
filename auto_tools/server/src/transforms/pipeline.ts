import type { EditableProduct } from '@shared/types';
import { logger } from '../util/logger.js';
import type { TransformContext, TransformStep } from './types.js';

/** 顺序执行的 transform 管线。 */
export class TransformPipeline {
  private readonly steps: TransformStep[] = [];

  use(step: TransformStep): this {
    this.steps.push(step);
    return this;
  }

  async run(product: EditableProduct, ctx: TransformContext): Promise<EditableProduct> {
    let current = product;
    for (const step of this.steps) {
      if (step.enabled && !step.enabled(ctx)) continue;
      current = await step.apply(current, ctx);
      logger.debug('transform 已应用', { step: step.name });
    }
    return current;
  }
}

/** 默认管线单例;在此 use() 各步骤。 */
export const transformPipeline = new TransformPipeline();
