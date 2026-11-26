/** 分拣会话内的小缓存：合并详情预取请求；失败不缓存，淘汰后不被慢请求写回。 */
export function createDetailCache<T>(load: (id: string) => Promise<T>, limit = 6) {
  type Entry = { promise: Promise<T>; value?: T };
  const entries = new Map<string, Entry>();
  return {
    peek: (id: string) => entries.get(id)?.value,
    forget: (id: string) => { entries.delete(id); },
    clear: () => { entries.clear(); },
    get(id: string): Promise<T> {
      const existing = entries.get(id);
      if (existing) {
        entries.delete(id);
        entries.set(id, existing);
        return existing.promise;
      }
      const entry: Entry = { promise: Promise.resolve().then(() => load(id)) };
      entry.promise = entry.promise.then(value => {
        if (entries.get(id) === entry) entry.value = value;
        return value;
      }, error => {
        if (entries.get(id) === entry) entries.delete(id);
        throw error;
      });
      entries.set(id, entry);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
      return entry.promise;
    },
  };
}

type PrefetchImage = Pick<HTMLImageElement, 'src' | 'onload' | 'onerror' | 'decoding' | 'fetchPriority'>;

/** 后台图片最多同时下载两张；换商品后丢弃尚未开始的旧队列，不与当前主图抢优先级。 */
export function createImagePreloader(makeImage: () => PrefetchImage = () => new Image()) {
  const active = new Map<string, PrefetchImage>();
  const completed = new Set<string>();
  let queue: string[] = [];
  let disposed = false;
  function pump() {
    while (!disposed && active.size < 2 && queue.length) {
      const url = queue.shift()!;
      if (active.has(url) || completed.has(url)) continue;
      const image = makeImage();
      active.set(url, image);
      image.decoding = 'async';
      image.fetchPriority = 'low';
      const finish = (success: boolean) => {
        image.onload = image.onerror = null;
        active.delete(url);
        if (success) {
          completed.add(url);
          while (completed.size > 40) completed.delete(completed.values().next().value!);
        }
        pump();
      };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = url;
    }
  }
  return {
    update(urls: string[]) {
      queue = [...new Set(urls.filter(Boolean))].filter(url => !completed.has(url) && !active.has(url)).slice(0, 6);
      pump();
    },
    dispose() {
      disposed = true;
      queue = [];
      for (const image of active.values()) { image.onload = image.onerror = null; image.src = ''; }
      active.clear();
      completed.clear();
    },
  };
}
