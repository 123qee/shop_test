import type { EditableProduct } from '@shared/types';
import type { TransformStep } from '../types.js';

/**
 * 示例 step:清理标题多余空白并限长。
 * 这是「加功能 = 加一个 step」的模板,后续 pricing / translate / category 照此新增。
 */
export const trimTitleStep: TransformStep = {
  name: 'trim-title',
  apply(product: EditableProduct): EditableProduct {
    const title = product.title.replace(/\s+/g, ' ').trim().slice(0, 250);
    return { ...product, title };
  },
};
