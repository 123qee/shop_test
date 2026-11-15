import test from 'node:test';
import assert from 'node:assert/strict';
import { collectedProductSchema, editableProductSchema } from '../src/routes/schemas.js';
import { deriveEditable } from '../src/services/product-service.js';
import { mapToJoomCreatePayload } from '../src/marketplaces/joom/mapper.js';

test('采集视频进入草稿，但不混入 Joom 创建商品请求', () => {
  const collected = collectedProductSchema.parse({
    source: 'aliexpress',
    sourceUrl: 'https://example.com/item/1',
    sourceProductId: '1',
    title: 'Video product',
    images: ['https://example.com/main.jpg'],
    videos: [{ url: 'https://example.com/demo.mp4', poster: 'https://example.com/poster.jpg' }],
    variants: [{ options: {}, price: 9.9 }],
    attributes: {},
  });
  const editable = editableProductSchema.parse(deriveEditable(collected));
  assert.equal(editable.video?.url, 'https://example.com/demo.mp4');

  const payload = mapToJoomCreatePayload(editable);
  assert.equal('video' in payload, false);
  assert.equal('videoUrl' in payload, false);
  assert.equal(payload.mainImage, 'https://example.com/main.jpg');
});
