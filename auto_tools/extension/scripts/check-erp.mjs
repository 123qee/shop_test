import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/erp/field-utils.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  write: false,
});
const { aliasesMatch, cellAt, marketingCrop, shippingTemplateMatches, skuInputs, specAliases, truncateTitle } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('运费模板按稳定名称匹配，忽略ERP重复数量变化的copy前缀', () => {
  const configured = 'copy copy copy copy copy copy 人民币20.9预算模板';
  assert.equal(shippingTemplateMatches('copy copy copy copy copy 人民币20.9预算模板', [configured]), true);
  assert.equal(shippingTemplateMatches(configured, ['人民币20.9预算模板']), true);
  assert.equal(shippingTemplateMatches('copy copy copy copy copy 86.9卫衣运费模板', [configured]), false);
});

test('原箱下拉框前的隐藏校验值不参与结果检查', () => {
  const inputs = [
    { value: 'true', type: 'text', style: { display: 'none' } },
    { value: '是', type: 'text', style: { display: '' } },
  ];
  const visible = skuInputs({ querySelectorAll: () => inputs });
  assert.deepEqual(visible.map(input => input.value), ['是']);
  inputs[1].value = '否';
  assert.deepEqual(skuInputs({ querySelectorAll: () => inputs }).map(input => input.value), ['否']);
});

test('规格迁移匹配已知中英颜色，不猜其他规格或删除规格', () => {
  assert.equal(aliasesMatch('黑色', specAliases('Black')), true);
  assert.equal(aliasesMatch('白色', specAliases('White')), true);
  assert.equal(specAliases('Black')[0], '黑色');
  assert.equal(specAliases('White')[0], '白色');
  assert.equal(aliasesMatch('深灰色', specAliases('Black')), false);
  assert.equal(aliasesMatch('删除规格属性值', specAliases('Black')), false);
  assert.deepEqual(specAliases('Unknown print'), ['Unknown print']);
});

test('标题只保留前128个字符，不会切开emoji代理对', () => {
  assert.equal(truncateTitle('a'.repeat(184)).length, 128);
  assert.equal(truncateTitle(`${'a'.repeat(127)}😀tail`), `${'a'.repeat(127)}😀`);
  assert.equal(truncateTitle('short title'), 'short title');
});

test('夏季不能命中春夏或四季，休闲不能命中商务休闲', () => {
  assert.equal(aliasesMatch('春夏(Spring And Summer)', ['夏季', 'summer']), false);
  assert.equal(aliasesMatch('四季(Four Seasons)', ['夏季', 'summer']), false);
  assert.equal(aliasesMatch('夏季(summer)', ['夏季', 'summer']), true);
  assert.equal(aliasesMatch('商务休闲(Smart Casual)', ['休闲', 'Casual']), false);
  assert.equal(aliasesMatch('女性(Women)', ['男性', 'Men']), false);
});

test('保留中英文和嵌套括号选项的正确匹配', () => {
  for (const [value, aliases] of [
    ['中国大陆(Origin)(Mainland China)', ['中国大陆', 'Mainland China']],
    ['江西(Jiangxi)', ['江西', 'Jiangxi']],
    ['短款（4-16inch）(Short (4 - 16 Inch))', ['短款（4-16inch）', 'Short (4 - 16 Inch)']],
    ['NONE(NONE)', ['NONE']],
    ['COTTON ', ['COTTON']],
    ['是', ['是']],
  ]) assert.equal(aliasesMatch(value, aliases), true, value);
});

// 复现 ERP 实测结构：黑色行有 index=0 的尺码格且 rowspan=2，白色行省略此格。
function rowFixture(indices) {
  const cells = indices.map(index => ({
    column: index,
    hasAttribute: key => key === 'index',
    getAttribute: key => key === 'index' ? String(index) : null,
  }));
  return { querySelectorAll: selector => {
    assert.equal(selector, ':scope > td');
    return cells;
  } };
}

test('合并尺码列后，两种颜色的价格、货值、重量、尺寸、编码仍定位同一逻辑列', () => {
  const black = rowFixture(Array.from({ length: 15 }, (_, i) => i));
  const white = rowFixture(Array.from({ length: 14 }, (_, i) => i + 1));
  for (const index of [2, 3, 5, 6, 7, 8, 10]) {
    assert.equal(cellAt(black, index).column, index);
    assert.equal(cellAt(white, index).column, index);
  }
  assert.equal(cellAt(white, 0), null);
});

test('营销图输出使用 ERP 接受的目标尺寸，分辨率不足时不做大幅放大', () => {
  assert.deepEqual(marketingCrop(1799, 1799), { portrait: false, width: 1799, height: 1799 });
  assert.deepEqual(marketingCrop(1000, 1000), { portrait: false, width: 1000, height: 1000 });
  assert.deepEqual(marketingCrop(800, 1066), { portrait: true, width: 750, height: 1000 });
  assert.deepEqual(marketingCrop(800, 800, true), { portrait: true, width: 750, height: 1000 });
  assert.equal(marketingCrop(500, 500, true), null);
  assert.equal(marketingCrop(700, 700), null);
});

test('同一首图分别生成两个营销图比例，不再按原图比例二选一', () => {
  assert.deepEqual(marketingCrop(1799, 1799, false), { portrait: false, width: 1799, height: 1799 });
  assert.deepEqual(marketingCrop(1799, 1799, true), { portrait: true, width: 750, height: 1000 });
  assert.deepEqual(marketingCrop(800, 1066, false), { portrait: false, width: 800, height: 800 });
  assert.deepEqual(marketingCrop(800, 1066, true), { portrait: true, width: 750, height: 1000 });
  assert.deepEqual(marketingCrop(800, 800, true), { portrait: true, width: 750, height: 1000 }, '方图裁切后允许轻度放大到 ERP 最低尺寸');
});
