import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeError } from '../../web/src/error-summary';

test('大量重复颜色报错按颜色归并，并保留受影响变体数量', () => {
  const message = Array.from({ length: 1000 }, (_, i) =>
    `variants.${i}.colors: 变体 ${i + 1}:颜色不是 Joom 允许的色名(${i < 600 ? 'Oro' : 'Gris oscuro'})`,
  ).join('；');
  const result = summarizeError(message);
  assert.equal(result.count, 1000);
  assert.equal(result.expandable, true);
  assert.equal(result.summary, '颜色不是 Joom 允许的色名(Oro)（600 个变体）；颜色不是 Joom 允许的色名(Gris oscuro)（400 个变体）');
});

test('混合错误保留不同原因，多余类别给出提示', () => {
  const result = summarizeError('标题为空；SKU 为空；图片不合规；库存无效；价格无效');
  assert.equal(result.summary, '标题为空；SKU 为空；图片不合规；另有 2 类问题');
  assert.equal(result.count, 5);
});

test('长单条错误也可展开，摘要限制长度', () => {
  const result = summarizeError('远端返回异常：' + '详细信息'.repeat(200));
  assert.equal(result.expandable, true);
  assert.equal(result.summary.length, 220);
});

test('短错误直接显示，重复普通错误显示次数', () => {
  assert.deepEqual(summarizeError('发布失败'), { summary: '发布失败', count: 1, expandable: false });
  assert.equal(summarizeError('请求超时;请求超时').summary, '请求超时（重复 2 次）');
});
