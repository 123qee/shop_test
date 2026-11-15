import assert from 'node:assert/strict';
import test from 'node:test';
import { collectedProductSchema } from '../src/routes/schemas.js';

test('ASOS 采集结果可通过服务端来源校验', () => {
  const parsed = collectedProductSchema.parse({
    source: 'asos',
    sourceUrl: 'https://www.asos.com/jack-jones/example/prd/210766378#colourWayId-210766379',
    sourceProductId: '210766378',
    title: 'Jack & Jones algarve backprint t-shirt in burnt orange',
    images: ['https://images.asos-media.com/products/example/210766378-1'],
    price: { value: 66.12, currency: 'CNY', original: 151.35 },
    variants: [
      {
        sourceSkuId: '156619440',
        options: { Color: 'Summer Fig', Size: 'S' },
        price: 66.12,
      },
    ],
    attributes: { Brand: 'Jack & Jones', Material: '100% Cotton' },
  });

  assert.equal(parsed.source, 'asos');
  assert.equal(parsed.variants[0].sourceSkuId, '156619440');
  assert.equal(parsed.price?.original, 151.35);
});
