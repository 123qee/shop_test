import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLISH_IMAGE_SIZE,
  normalizeCollectedImages,
  restoreAsosOriginalUrl,
  squareImageUrl,
  toPublishableImageUrl,
} from '../src/services/image-service.js';

const asosImage = 'https://images.asos-media.com/products/example/210766378-2';

test('ASOS 母商品库保留原始高清图', async () => {
  const product = await normalizeCollectedImages({
    images: [asosImage],
    variants: [{ image: asosImage }],
  });
  assert.deepEqual(product.images, [asosImage]);
  assert.equal(product.variants[0].image, asosImage);
});

test('ASOS 发布图使用 1200 正方形白底留白而不裁切', () => {
  const output = new URL(toPublishableImageUrl(asosImage));
  assert.equal(output.hostname, 'wsrv.nl');
  assert.equal(output.searchParams.get('url'), asosImage);
  assert.equal(output.searchParams.get('w'), String(PUBLISH_IMAGE_SIZE));
  assert.equal(output.searchParams.get('h'), String(PUBLISH_IMAGE_SIZE));
  assert.equal(output.searchParams.get('fit'), 'contain');
  assert.equal(output.searchParams.get('cbg'), 'fff');
  assert.equal(output.searchParams.get('output'), 'jpg');
  assert.equal(output.searchParams.get('q'), '95');
});

test('旧的 550x550 ASOS 代理图可恢复原图并升级发布规格', () => {
  const legacy = `https://wsrv.nl/?url=${encodeURIComponent(asosImage)}&w=550&h=550&fit=cover&output=jpg&q=90`;
  assert.equal(restoreAsosOriginalUrl(legacy), asosImage);
  assert.equal(squareImageUrl(legacy), toPublishableImageUrl(asosImage));
});
