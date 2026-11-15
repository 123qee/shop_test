import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectedProduct, GroupTemplateBinding } from '../../shared/types';
import { findGroupTemplateBinding, inferProductGrouping } from '../../shared/product-grouping';

function product(title: string, attributes: Record<string, string> = {}, description?: string): CollectedProduct {
  return { source: 'joom', sourceUrl: '', sourceProductId: 'test', title, attributes, description, images: [], variants: [] };
}

test('多语种人群、款式和材质判断', () => {
  for (const [title, group, material] of [
    ["Men's Short Sleeve Polyester T-Shirt", 'men-short', 'polyester'],
    ['女装纯棉短袖', 'women-short', 'cotton'],
    ['男装棉T恤', 'men-short', 'cotton'],
    ['男士长袖T恤', 'men-top', 'unknown'],
    ['Camiseta de algodón para niños manga corta', 'kids-short', 'cotton'],
    ['Футболка мужская полиэстер', 'men-short', 'polyester'],
    ['Kids Cotton Hoodie', 'kids-sweat', 'cotton'],
    ['Women Long Sleeve T-Shirt', 'women-top', 'unknown'],
    ['Pantalones de hombre', 'pants', 'unknown'],
    ['Men Women Unisex T-Shirt', 'short', 'unknown'],
    ['Pillowcase cotton', 'home', 'cotton'],
    ['Sneakers for men', 'shoes', 'unknown'],
    ['New arrival 2026', 'pending', 'unknown'],
  ]) {
    const value = inferProductGrouping(product(title));
    assert.equal(value.groupId, group, title);
    assert.equal(value.material, material, title);
  }
});

test('属性优先；信息缺失、冲突和营销材质不强行猜测', () => {
  assert.equal(inferProductGrouping(product('Cotton T-Shirt Men', { Gender: 'Women', Material: 'Polyester' })).groupId, 'women-short');
  assert.equal(inferProductGrouping(product('Cotton T-Shirt Men', { Material: 'Polyester' })).material, 'polyester');
  assert.equal(inferProductGrouping(product('Cotton T-Shirt Men', { Material: 'unavailable' })).material, 'unknown');
  assert.equal(inferProductGrouping(product('T-Shirt and pants set for men')).groupId, 'pending');
  assert.equal(inferProductGrouping(product('Cotton Polyester T-shirt')).material, 'blend');
  assert.equal(inferProductGrouping(product('Polyester spandex T-shirt')).material, 'blend');
  assert.equal(inferProductGrouping(product('Cotton-look T-Shirt')).material, 'unknown');
  assert.equal(inferProductGrouping(product('Non-cotton T-Shirt')).material, 'unknown');
  assert.equal(inferProductGrouping(product('Men T-Shirt', {}, 'Material: 100% Polyester')).material, 'polyester');
  // 尺码和颜色属性里的棉花图案不应当变成面料证据。
  assert.equal(inferProductGrouping(product('Men T-Shirt', { Pattern: 'Cotton flower', Size: 'XL' })).material, 'unknown');
});

test('常用预设精确材质优先，未知材质和待判断组不推荐', () => {
  const bindings: GroupTemplateBinding[] = [
    { groupId: 'men-short', material: 'all', templateId: 'generic' },
    { groupId: 'men-short', material: 'polyester', templateId: 'poly' },
  ];
  assert.equal(findGroupTemplateBinding(bindings, 'men-short', 'polyester')?.templateId, 'poly');
  assert.equal(findGroupTemplateBinding(bindings, 'men-short', 'cotton')?.templateId, 'generic');
  assert.equal(findGroupTemplateBinding(bindings, 'men-short', 'all')?.templateId, 'generic');
  assert.equal(findGroupTemplateBinding(bindings, 'men-short', 'unknown'), undefined);
  assert.equal(findGroupTemplateBinding(bindings, 'pending', 'polyester'), undefined);
});
