import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanOzonProductUrl, ozonExtractor, ozonImageUrl, ozonNumber, ozonProductId, ozonVariants } from '../../extension/src/extractors/ozon.js';
import { normalizeCollectedImages } from '../src/services/image-service.js';

const url = 'https://www.ozon.ru/product/hudi-junion-iz-hlopkovogo-futera-s-effektom-varki-yandeks-fabrika-3881779893/?at=tracking';
const image = 'https://ir-20.ozonstatic.cn/s3/multimedia-1-p/13746213997.jpg';
const price = { value: 2211, currency: 'RUB', original: 3980 };

test('Ozon CDN images get publication links without fetching each image during collection', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('CDN unavailable'); });
  const product = await normalizeCollectedImages({ images: [image], variants: [{ image }] });
  const converted = new URL(product.images[0]);
  assert.equal(converted.hostname, 'wsrv.nl');
  assert.equal(converted.searchParams.get('url'), image);
  assert.equal(product.variants[0].image, product.images[0]);
  assert.equal(fetch.mock.callCount(), 0);
});
// Public widget fields observed on the linked Ozon results page's Junion hoodie.
const aspects = [
  { aspectKey: 'Color', variants: [
    { sku: '3881779893', active: true, data: { searchableText: 'Красный' } },
    { sku: '3881779731', data: { searchableText: 'Зелёный' } },
  ] },
  { aspectKey: 'size', variants: [
    { sku: '3881780921', availability: 'inStock', data: { searchableText: '92 RU / 92' } },
    { sku: '3881779893', active: true, availability: 'inStock', data: { searchableText: '98 RU / 98' } },
    { sku: '3881780547', availability: 'outOfStock', data: { searchableText: '104 RU / 104' } },
  ] },
];

test('Ozon URL: slug/numeric canonical dedupe; reject review and foreign host URLs', () => {
  assert.equal(ozonProductId(url), '3881779893');
  assert.equal(cleanOzonProductUrl(url), 'https://www.ozon.ru/product/3881779893/');
  assert.equal(ozonExtractor.matches('https://www.ozon.ru/category/detskaya-odezhda-7580/'), true);
  assert.equal(ozonExtractor.isDetailPage('https://www.ozon.ru/product/3881779893/'), true);
  for (const bad of ['https://ozon.ru.evil.test/product/123/', 'https://evil.test/product/123/', `${url.split('?')[0]}reviews/`, 'https://www.ozon.ru/category/kids-123/']) {
    assert.equal(cleanOzonProductUrl(bad), null);
  }
});

test('Ozon images: original gallery URLs dedupe without mixing icons and video posters', () => {
  assert.equal(ozonImageUrl(image.replace('/137', '/c100/wc140/137')), image);
  assert.equal(ozonImageUrl(image.replace('/137', '/wc1000/137') + '?tracking=1'), image);
  assert.equal(ozonImageUrl('https://ir-20.ozonstatic.cn/s3/payments-cdn/wc75/bank.png'), null);
  assert.equal(ozonImageUrl('https://ir-20.ozonstatic.cn/s3/video-73/cover.jpg'), null);
  assert.equal(ozonImageUrl('https://ozonstatic.cn.evil.test/s3/multimedia/1.jpg'), null);
  assert.equal(ozonNumber('2\u2009211,50\u2009₽'), 2211.5);
  assert.equal(ozonNumber('Цена неизвестна'), undefined);
});

test('Ozon variants: real size SKUs under current color; no invented combinations or bank prices', () => {
  const variants = ozonVariants(aspects, '3881779893', {}, price, image);
  assert.equal(variants.length, 3);
  assert.deepEqual(variants.map((v) => v.options), ['92', '98', '104'].map((Size) => ({ Color: 'Красный', Size })));
  assert.equal(variants[1].price, 2211);
  assert.equal(variants[0].price, undefined);
  assert.equal(variants[2].stock, 0);
  assert.equal(variants.some((v) => v.sourceSkuId === '3881779731'), false);
  const fallback = ozonVariants([], '123', { Цвет: 'Белый', 'Российский размер': '128' }, price, image, true);
  assert.deepEqual(fallback[0].options, { Color: 'Белый', Size: '128' });
  assert.equal(fallback[0].stock, 0);
});

test('Ozon collect endpoint: persist source/price/variants, dedupe, read back and video source validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-tools-ozon-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const { createApp } = await import('../src/app.js');
  const { getDb } = await import('../src/db/index.js');
  const server = createApp().listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const product = {
      source: 'ozon', sourceUrl: cleanOzonProductUrl(url), sourceProductId: '3881779893',
      title: 'Худи Junion из хлопкового футера с эффектом варки, Яндекс Фабрика',
      images: [image], price, variants: ozonVariants(aspects, '3881779893', {}, price, image),
      attributes: { 'Состав материала': 'хлопок 100%' },
    };
    const collect = () => fetch(`${base}/collect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product }) });
    const response = await collect();
    assert.equal(response.status, 201);
    const first = await response.json() as { id: string };
    const duplicate = await collect();
    const second = await duplicate.json() as { id: string; duplicate?: boolean };
    assert.equal(second.id, first.id);
    assert.equal(second.duplicate, true);
    const stored = await (await fetch(`${base}/products/${first.id}`)).json() as any;
    assert.equal(stored.record.collected.source, 'ozon');
    assert.deepEqual(stored.record.collected.price, price);
    assert.equal(stored.record.collected.variants.length, 3);
    assert.equal((await fetch(`${base}/products/video-backfill-candidates?source=ozon`)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
    rmSync(dir, { recursive: true, force: true });
  }
});
