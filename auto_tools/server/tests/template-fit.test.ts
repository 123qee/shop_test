import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectedProduct, PresetTemplate } from '../../shared/types';
import { audienceFromSizes, checkTemplateFit, reviewTemplates, templateTraits } from '../../shared/template-fit';

const tpl = (id: string, name: string, attributes: Record<string, string> = {}, targetSizes: string[] = []): PresetTemplate => ({
  id,
  name,
  defaults: { currency: 'USD', priceMode: 'fixed', priceMultiplier: 1, fixedPrice: 5, inventory: 999, attributes, targetSizes },
});

/** 与线上配置同构的 9 个模板。 */
const templates = [
  tpl('adult-cotton', '成人棉短袖', { material: 'Cotton' }),
  tpl('kids-cotton', '童装短袖棉', { material: 'Cotton' }),
  tpl('adult-poly', '聚酯纤维成人短袖', { material: 'Polyster' }),
  tpl('kids-set', '童装卫衣套装棉', { material: 'cotton', piecesQuantityPerSet: '2' }),
  tpl('kids-hoodie', '童装连帽卫衣无拉链', { material: 'cotton', piecesQuantity: '1' }),
  tpl('kids-zip', '童装连帽卫衣有拉链', { material: 'cotton', piecesQuantity: '1' }),
  tpl('kids-poly', '童短袖聚酯纤维', { material: 'Polyster' }),
  tpl('adult-hoodie', '成人连帽卫衣无拉链棉', { material: 'cotton' }),
  tpl('adult-zip', '成人连帽卫衣有拉链棉', { material: 'cotton' }),
];

function product(title: string, sizes: string[], sizeKey = 'Size'): CollectedProduct {
  return {
    source: 'aliexpress',
    sourceUrl: 'https://example.test/item/1.html',
    sourceProductId: '1',
    title,
    images: [],
    variants: sizes.map((size) => ({ options: { Color: 'Black', [sizeKey]: size } })),
    attributes: {},
  };
}

test('从模板名称和预设字段识别人群、品类、材质、拉链、套装', () => {
  assert.deepEqual(templateTraits(templates[5]), { audience: 'kids', kind: 'sweat', material: 'cotton', zip: true, set: false });
  assert.deepEqual(templateTraits(templates[4]), { audience: 'kids', kind: 'sweat', material: 'cotton', zip: false, set: false });
  assert.deepEqual(templateTraits(templates[2]), { audience: 'adult', kind: 'short', material: 'polyester', set: false });
  assert.equal(templateTraits(templates[3]).set, true);
  // 名称看不出人群时，按模板的目标尺码判断。
  assert.equal(templateTraits(tpl('x', '默认模板', {}, ['S', 'M', 'L', 'XL'])).audience, 'adult');
  assert.equal(templateTraits(tpl('y', '新模板', {}, ['100', '110', '120'])).audience, 'kids');
});

test('按尺码判断人群，零星的非服装规格不算数', () => {
  const sized = (values: string[], key = 'Size') => audienceFromSizes(values.map((value) => ({ key, value })));
  assert.deepEqual(sized(['100', '110', '120', '130']), { value: 'kids', strong: true, label: '尺码 100–130' });
  assert.equal(sized(['4', '5', '6'], 'Kid Size')?.value, 'kids');
  assert.equal(sized(['2T', '3T', '4T'])?.strong, true);
  assert.deepEqual(sized(['S', 'M', 'L', 'XL', 'XXL']), { value: 'adult', strong: true, label: '尺码 S–XXL' });
  assert.equal(sized(['XL recommends 125-70kg', '2XL recommended 140-80kg'])?.value, 'adult');
  assert.equal(sized(['<8cm', '>40cm', '25cm', '12cm', 'M'])?.strong, false);
  assert.equal(sized(['One Size']), undefined);
});

test('推荐：尺码定人群、标题定品类，拉链和 3D 进一步区分', () => {
  const zipHoodie = reviewTemplates(product('Kids Cartoon Zip Up Pullover Hoodie', ['110', '120', '130'], 'Kid Size'), templates);
  assert.equal(zipHoodie.suggestion?.templateId, 'kids-zip');
  assert.equal(zipHoodie.suggestion?.confidence, 'high');

  const tee = reviewTemplates(product("Men's Cotton T-Shirt Summer", ['S', 'M', 'L', 'XL']), templates);
  assert.equal(tee.suggestion?.templateId, 'adult-cotton');
  assert.equal(tee.suggestion?.confidence, 'high');

  assert.equal(reviewTemplates(product('3D Print Anime T-Shirt Men', ['S', 'M', 'L']), templates).suggestion?.templateId, 'adult-poly');

  const plainHoodie = reviewTemplates(product('Kids Cartoon Hoodie Sweatshirt', ['110', '120', '130']), templates).suggestion;
  assert.ok(plainHoodie && ['kids-hoodie', 'kids-zip'].includes(plainHoodie.templateId));
  assert.equal(plainHoodie.confidence, 'low');
  assert.match(plainHoodie.note ?? '', /拉链要看图/);

  const set = reviewTemplates(product('Kids Hoodie and Pants Set 2 Pieces', ['110', '120', '130']), templates).suggestion;
  assert.equal(set?.templateId, 'kids-set');

  assert.equal(reviewTemplates(product('Men Jeans Pants', ['30', '32', '34']), templates).suggestion, undefined);
});

test('核对：人群和品类对不上一定是矛盾，材质只在有更合适模板时才算', () => {
  const kidsTee = product('Kids Cartoon T-Shirt', ['100', '110', '120', '130']);
  const [issue] = checkTemplateFit(kidsTee, 'adult-cotton', templates);
  assert.equal(issue.dimension, 'audience');
  assert.equal(issue.message, '模板是成人款，但尺码 100–130，像童装');
  assert.deepEqual(checkTemplateFit(kidsTee, 'kids-cotton', templates), []);

  const hoodie = product('Men Hoodie Sweatshirt', ['S', 'M', 'L']);
  assert.equal(checkTemplateFit(hoodie, 'adult-cotton', templates)[0]?.dimension, 'kind');

  // 有聚酯 T 恤模板可选：3D T 恤配棉模板算矛盾。
  assert.equal(checkTemplateFit(product('3D Print T-Shirt Men', ['S', 'M', 'L']), 'adult-cotton', templates)[0]?.dimension, 'material');
  // 卫衣模板全是棉：3D 卫衣不因材质被拦下。
  assert.deepEqual(checkTemplateFit(product('3D Print Hoodie Men', ['S', 'M', 'L']), 'adult-hoodie', templates), []);

  // 卖家常把拉链卫衣写成 pullover，不当作「无拉链」的矛盾。
  assert.deepEqual(checkTemplateFit(product('Kids Zipper Pullover Hoodie', ['110', '120', '130']), 'kids-zip', templates), []);
  assert.equal(checkTemplateFit(product('Kids Zipper Hoodie', ['110', '120', '130']), 'kids-hoodie', templates)[0]?.dimension, 'zip');
});
