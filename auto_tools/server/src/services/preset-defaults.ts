import type { CollectDefaults, SizeTemplate } from '@shared/types';

/** 尺码模板库出厂种子。 */
export const FACTORY_SIZE_TEMPLATES: SizeTemplate[] = [
  { id: 'men-standard', name: '男装 2XS-3XL', sizes: ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'] },
  { id: 'men-plus', name: '男装加大 2XS-6XL', sizes: ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'] },
  { id: 'kids-top', name: '童装上衣 100-160', sizes: ['100', '110', '120', '130', '140', '150', '160'] },
];

/** 出厂默认预设值。 */
export const FACTORY_DEFAULTS: CollectDefaults = {
  currency: 'USD',
  priceMode: 'multiply',
  priceMultiplier: 1,
  fixedPrice: 9.99,
  inventory: 999,
  targetSizes: ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
  categoryId: '1473502943153754907-255-2-118-3004891753', // Men's Clothing & Accessories > Shirts (men’s)
  shippingLength: 10,
  shippingWidth: 10,
  shippingHeight: 2,
  dangerInfo: { isDangerous: false },
};
