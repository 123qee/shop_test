import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackToSourceImage, imagePreviewSource, sizedImageSource } from '../../web/src/image-utils';

test('分拣主图和缩略图按大小请求，解开已知 CDN 代理且不修改原始地址', () => {
  const asos = 'https://images.asos-media.com/products/shirt/123-1-black?wid=1000&foo=keep';
  const nested = `https://wsrv.nl/?url=${encodeURIComponent(`https://wsrv.nl/?url=${encodeURIComponent(asos)}&w=1200`)}&w=1200`;
  for (const url of [asos, nested]) {
    const preview = new URL(sizedImageSource(url, 'preview'));
    const thumb = new URL(sizedImageSource(url, 'thumb'));
    assert.equal(preview.hostname, 'images.asos-media.com');
    assert.equal(preview.searchParams.get('wid'), '800');
    assert.equal(thumb.searchParams.get('wid'), '200');
    assert.equal(preview.searchParams.get('foo'), 'keep');
    assert.equal(preview.searchParams.get('fit'), 'constrain');
  }
  const allegro = 'https://a.allegroimg.com/original/fixture-photo';
  const wrapped = `https://wsrv.nl/?url=${encodeURIComponent(allegro)}&w=1200&h=1200`;
  for (const url of [allegro, wrapped]) {
    assert.equal(sizedImageSource(url, 'preview'), 'https://a.allegroimg.com/s720/fixture-photo');
    assert.equal(sizedImageSource(url, 'thumb'), 'https://a.allegroimg.com/s256/fixture-photo');
  }
  const proxy = `https://wsrv.nl/?url=${encodeURIComponent('https://ae01.alicdn.com/fixture.jpg')}&w=1200&h=1200&fit=contain&q=95`;
  const preview = new URL(sizedImageSource(proxy, 'preview'));
  const thumb = new URL(sizedImageSource(proxy, 'thumb'));
  assert.equal(preview.searchParams.get('w'), '800');
  assert.equal(preview.searchParams.get('h'), '800');
  assert.equal(preview.searchParams.get('q'), '80');
  assert.equal(thumb.searchParams.get('w'), '200');
  assert.equal(thumb.searchParams.get('q'), '75');
  assert.equal(preview.searchParams.get('url'), 'https://ae01.alicdn.com/fixture.jpg');
  assert.equal(preview.searchParams.get('fit'), 'contain');
  assert.equal(new URL(proxy).searchParams.get('w'), '1200');
  for (const url of ['https://cdn.example.test/image.jpg', '/api/image/fixture', 'not a URL']) {
    assert.equal(sizedImageSource(url, 'preview'), url);
    assert.equal(sizedImageSource(url, 'thumb'), url);
  }
});

test('缩小图片失败只回退一次，原始图失败不产生循环；不同图片可独立回退', () => {
  const source = 'https://a.allegroimg.com/original/fixture';
  const image = { src: sizedImageSource(source, 'preview'), currentSrc: '', dataset: {} } as unknown as HTMLImageElement;
  assert.equal(fallbackToSourceImage(image, source), true);
  assert.equal(image.src, source);
  assert.equal(fallbackToSourceImage(image, source), false);
  const second = 'https://a.allegroimg.com/original/second';
  image.src = sizedImageSource(second, 'thumb');
  assert.equal(fallbackToSourceImage(image, second), true);
  assert.equal(image.src, second);
  assert.equal(fallbackToSourceImage(image, second), false);
  const plain = 'https://cdn.example.test/photo.jpg';
  const unchanged = { src: plain, currentSrc: plain, dataset: {} } as unknown as HTMLImageElement;
  assert.equal(fallbackToSourceImage(unchanged, plain), false);
  const asos = 'https://images.asos-media.com/products/fixture';
  image.src = sizedImageSource(asos, 'preview');
  assert.equal(fallbackToSourceImage(image, asos), true);
  assert.equal(image.src, imagePreviewSource(asos));
  assert.equal(new URL(image.src).searchParams.get('wid'), '1000');
  assert.equal(fallbackToSourceImage(image, asos), false);
});
