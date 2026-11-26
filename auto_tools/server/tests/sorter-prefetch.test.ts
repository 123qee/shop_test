import assert from 'node:assert/strict';
import test from 'node:test';
import { createDetailCache, createImagePreloader } from '../../web/src/sorter-prefetch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('分拣详情合并并发请求、复用最近结果、淘汰旧项，并允许失败后重试', async () => {
  const calls: string[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<string>>>();
  const cache = createDetailCache((id) => {
    calls.push(id);
    const task = deferred<string>();
    pending.set(id, task);
    return task.promise;
  }, 2);
  const a = cache.get('a');
  assert.equal(cache.get('a'), a);
  const b = cache.get('b');
  await Promise.resolve();
  assert.deepEqual(calls, ['a', 'b']);
  pending.get('a')!.resolve('A'); pending.get('b')!.resolve('B');
  await Promise.all([a, b]);
  assert.equal(cache.peek('a'), 'A');
  assert.equal(cache.get('a'), a);
  const c = cache.get('c');
  await Promise.resolve();
  assert.equal(cache.peek('b'), undefined);
  assert.equal(cache.peek('a'), 'A');
  pending.get('c')!.resolve('C'); await c;
  const failure = cache.get('failed');
  const rejected = assert.rejects(failure, /fixture failure/);
  await Promise.resolve();
  pending.get('failed')!.reject(new Error('fixture failure'));
  await rejected;
  assert.equal(cache.peek('failed'), undefined);
  const retry = cache.get('failed');
  await Promise.resolve();
  pending.get('failed')!.resolve('recovered');
  assert.equal(await retry, 'recovered');
  assert.equal(calls.filter(id => id === 'failed').length, 2);
});

test('忘记或淘汰详情后，较慢旧请求不能写回或覆盖同 ID 的新结果', async () => {
  const old = deferred<string>(), fresh = deferred<string>();
  let attempt = 0;
  const cache = createDetailCache(() => (++attempt === 1 ? old.promise : fresh.promise), 1);
  const first = cache.get('item');
  await Promise.resolve();
  cache.forget('item');
  const next = cache.get('item');
  await Promise.resolve();
  fresh.resolve('fresh'); await next;
  old.resolve('stale'); await first;
  assert.equal(cache.peek('item'), 'fresh');
  cache.forget('item');
  assert.equal(cache.peek('item'), undefined);

  const evicted = deferred<string>();
  const bounded = createDetailCache((id) => id === 'slow' ? evicted.promise : Promise.resolve(id), 1);
  const slow = bounded.get('slow');
  await bounded.get('current');
  evicted.resolve('too late'); await slow;
  assert.equal(bounded.peek('slow'), undefined);
  assert.equal(bounded.peek('current'), 'current');
});

function imageFactory() {
  const images: Array<{ src: string; onload: (() => void) | null; onerror: (() => void) | null; decoding: string; fetchPriority: string }> = [];
  return {
    images,
    make() {
      const image = { src: '', onload: null, onerror: null, decoding: '', fetchPriority: '' };
      images.push(image);
      return image as unknown as HTMLImageElement;
    },
  };
}

test('图片预加载最多两个并发，切换队列后不启动过时图片，成功结果去重且失败可重试', () => {
  const { images, make } = imageFactory();
  const preloader = createImagePreloader(make);
  preloader.update(['a', 'a', 'b', 'old-c', 'old-d']);
  assert.deepEqual(images.map(image => image.src), ['a', 'b']);
  assert(images.every(image => image.fetchPriority === 'low' && image.decoding === 'async'));
  preloader.update(['new-c', 'new-d']);
  images[0].onload!();
  assert.deepEqual(images.map(image => image.src), ['a', 'b', 'new-c']);
  images[1].onerror!();
  assert.deepEqual(images.map(image => image.src), ['a', 'b', 'new-c', 'new-d']);
  images[2].onload!(); images[3].onload!();
  preloader.update(['a', 'new-c', 'new-d', 'b']);
  assert.equal(images.length, 5);
  assert.equal(images[4].src, 'b');
  images[4].onload!();
  preloader.dispose();
});

test('图片预加载限制待下载数量，释放会中止活动图片并忽略后续更新', () => {
  const { images, make } = imageFactory();
  const preloader = createImagePreloader(make);
  preloader.update(Array.from({ length: 20 }, (_, i) => `image-${i}`));
  for (let i = 0; i < images.length; i++) images[i].onload!();
  assert.equal(images.length, 6);
  preloader.update(['next-a', 'next-b', 'next-c']);
  assert.equal(images.length, 8);
  const active = images.slice(6);
  preloader.dispose();
  assert(active.every(image => image.src === '' && image.onload === null && image.onerror === null));
  preloader.update(['after-dispose']);
  assert.equal(images.length, 8);
});

test('已加载图片记录有上限，超过上限后允许重新温热较早图片', () => {
  const { images, make } = imageFactory();
  const preloader = createImagePreloader(make);
  for (let i = 0; i < 41; i++) {
    preloader.update([`image-${i}`]);
    images.at(-1)!.onload!();
  }
  preloader.update(['image-0', 'image-40']);
  assert.equal(images.length, 42);
  assert.equal(images.at(-1)!.src, 'image-0');
  preloader.dispose();
});
