/**
 * 运行在页面「主世界」的脚本(通过 <script src> 注入)。
 * 目标:拿到 AliExpress 完整 SKU 矩阵(颜色×尺码、每 SKU 价格/库存/图)+ 标题 + 全部主图。
 *
 * 新版 PC 详情页(2024+)数据在 window._d_c_.lifeCycleEventList[i].data 下分块:
 *   PRODUCT_TITLE.text / HEADER_IMAGE_PC.imagePathList /
 *   SKU.skuProperties + SKU.skuPaths / PRICE.skuIdStrPriceInfoMap[skuIdStr]
 * 旧版兜底:window.runParams.data.skuModule(老结构)+ 脚本文本扫描。
 */
(function () {
  const nonce = (document.currentScript as HTMLScriptElement | null)?.dataset.nonce || '';
  const debug: Record<string, unknown> = {};

  function post(payload: unknown) {
    window.postMessage({ __joomCollect: nonce, payload, debug }, '*');
  }
  function absUrl(u: unknown): string | null {
    if (!u || typeof u !== 'string') return null;
    let s = u.trim();
    if (!s) return null;
    if (s.startsWith('//')) s = 'https:' + s;
    return s;
  }
  const truthy = (x: string | null): x is string => !!x;

  /** "$13.54|13|54" -> 13.54;退回去符号后解析 */
  function moneyFromLocal(s: unknown): number | undefined {
    if (typeof s !== 'string') return undefined;
    const parts = s.split('|');
    if (parts.length >= 3) {
      const n = Number(parts[1] + '.' + parts[2]);
      if (isFinite(n)) return n;
    }
    const n = Number(s.replace(/[^0-9.]/g, ''));
    return isFinite(n) ? n : undefined;
  }

  type Payload = {
    title: string;
    images: string[];
    videos: Array<{ url: string; poster?: string }>;
    description: string;
    price?: { value: number; currency: string };
    variants: Array<{ sourceSkuId?: string; options: Record<string, string>; price?: number; stock?: number; image?: string }>;
  };

  /** 从页面主世界数据块里递归寻找明确的视频字段/文件地址。 */
  function videosFrom(value: unknown): Array<{ url: string }> {
    const out: Array<{ url: string }> = [];
    const seenObjects = new Set<object>();
    const walk = (node: unknown, key = '', depth = 0) => {
      if (depth > 7 || node == null) return;
      if (typeof node === 'string') {
        const url = absUrl(node.replace(/\\u002F/gi, '/').replace(/\\\//g, '/'));
        if (url && (/video/i.test(key) || /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(url))) out.push({ url });
        return;
      }
      if (typeof node !== 'object' || seenObjects.has(node as object)) return;
      seenObjects.add(node as object);
      if (Array.isArray(node)) node.forEach((item) => walk(item, key, depth + 1));
      else Object.entries(node as Record<string, unknown>).forEach(([childKey, item]) => walk(item, childKey, depth + 1));
    };
    walk(value);
    const seen = new Set<string>();
    return out.filter((item) => !seen.has(item.url) && Boolean(seen.add(item.url))).slice(0, 10);
  }

  // ---- 新版 _d_c_ 解析 ----
  function mergedBlocks(): Record<string, any> | null {
    const events = (window as any)._d_c_?.lifeCycleEventList;
    if (!Array.isArray(events) || !events.length) return null;
    const blk: Record<string, any> = {};
    for (const e of events) {
      const d = e?.data;
      if (d && typeof d === 'object') Object.assign(blk, d);
    }
    return Object.keys(blk).length ? blk : null;
  }

  function parseDcc(): Payload | null {
    const blk = mergedBlocks();
    if (!blk || !blk.SKU) return null;
    debug.source = '_d_c_';

    const title = String(blk.PRODUCT_TITLE?.text || '');
    const images: string[] = (blk.HEADER_IMAGE_PC?.imagePathList || blk.HEADER_IMAGE_PC?.imgList || [])
      .map(absUrl)
      .filter(truthy);
    const videos = videosFrom({ header: blk.HEADER_IMAGE_PC, video: blk.VIDEO, media: blk.PRODUCT_MEDIA });

    const sku = blk.SKU;
    const propNameById = new Map<string, string>();
    const colorPropIds = new Set<string>();
    const valueMetaById = new Map<string, { name: string; image: string | null }>();
    for (const p of sku.skuProperties || []) {
      const pid = String(p.skuPropertyId);
      propNameById.set(pid, String(p.skuPropertyName || pid));
      if (p.isShowTypeColor || p.showTypeColor) colorPropIds.add(pid);
      for (const v of p.skuPropertyValues || []) {
        const meta = {
          name: String(v.propertyValueName || v.propertyValueDisplayName || ''),
          image: absUrl(v.skuPropertyImagePath || v.skuPropertyImageSummPath),
        };
        if (v.propertyValueId != null) valueMetaById.set(String(v.propertyValueId), meta);
        if (v.propertyValueIdLong != null) valueMetaById.set(String(v.propertyValueIdLong), meta);
      }
    }

    const priceMap: Record<string, any> = blk.PRICE?.skuIdStrPriceInfoMap || {};
    let currency: string | undefined;

    const variants: Payload['variants'] = [];
    for (const path of sku.skuPaths || []) {
      const options: Record<string, string> = {};
      let image: string | null = null;
      const attr = String(path.skuAttr || path.path || '');
      for (const part of attr.split(';')) {
        if (!part) continue;
        const [left, disp] = part.split('#');
        const [propId, valueId] = left.split(':');
        const propName = propNameById.get(String(propId)) || String(propId);
        const meta = valueMetaById.get(String(valueId));
        options[propName] = meta?.name || (disp && disp.trim()) || String(valueId);
        if (!image && meta?.image && colorPropIds.has(String(propId))) image = meta.image;
      }
      const pinfo = priceMap[path.skuIdStr] || priceMap[String(path.skuId)];
      const price = moneyFromLocal(pinfo?.salePriceLocal) ?? pinfo?.salePrice?.value ?? pinfo?.originalPrice?.value;
      if (!currency) currency = pinfo?.originalPrice?.currency || pinfo?.salePrice?.currency;
      variants.push({
        sourceSkuId: String(path.skuIdStr || path.skuId || ''),
        options,
        price: price != null ? Number(price) : undefined,
        stock: path.skuStock ?? path.stock,
        image: image || undefined,
      });
    }

    // 商品级基准价:取变体最低价
    const prices = variants.map((v) => v.price).filter((n): n is number => typeof n === 'number');
    const priceVal = prices.length ? Math.min(...prices) : undefined;

    debug.variantCount = variants.length;
    debug.imageCount = images.length;
    if (!variants.length && !title) return null;
    return {
      title,
      images,
      videos,
      description: '',
      price: priceVal != null ? { value: priceVal, currency: currency || 'USD' } : undefined,
      variants,
    };
  }

  // ---- 旧版兜底:runParams.data.skuModule ----
  function parseLegacy(): Payload | null {
    const rp = (window as any).runParams;
    const d = rp?.data || rp;
    const sm = d?.skuModule;
    if (!sm) return null;
    debug.source = 'runParams(legacy)';
    const title = d.titleModule?.subject || '';
    const images = (d.imageModule?.imagePathList || []).map(absUrl).filter(truthy);
    const videos = videosFrom({ imageModule: d.imageModule, videoModule: d.videoModule });
    const propNameById = new Map<string, string>();
    const valueMetaById = new Map<string, { name: string; image: string | null }>();
    for (const p of sm.productSKUPropertyList || []) {
      propNameById.set(String(p.skuPropertyId), String(p.skuPropertyName || ''));
      for (const v of p.skuPropertyValues || []) {
        valueMetaById.set(String(v.propertyValueId), {
          name: String(v.propertyValueDisplayName || v.propertyValueName || ''),
          image: absUrl(v.skuPropertyImagePath),
        });
      }
    }
    const variants: Payload['variants'] = [];
    for (const s of sm.skuPriceList || []) {
      const options: Record<string, string> = {};
      let image: string | null = null;
      for (const part of String(s.skuAttr || '').split(';')) {
        if (!part) continue;
        const [left, disp] = part.split('#');
        const [propId, valueId] = left.split(':');
        options[propNameById.get(String(propId)) || String(propId)] =
          valueMetaById.get(String(valueId))?.name || (disp && disp.trim()) || String(valueId);
        if (!image) image = valueMetaById.get(String(valueId))?.image || null;
      }
      variants.push({
        sourceSkuId: String(s.skuId ?? ''),
        options,
        price: Number(s.skuVal?.actSkuCalPrice ?? s.skuVal?.skuAmount?.value ?? 0) || undefined,
        stock: s.skuVal?.availQuantity,
        image: image || undefined,
      });
    }
    if (!variants.length && !title) return null;
    const prices = variants.map((v) => v.price).filter((n): n is number => typeof n === 'number');
    return {
      title,
      images,
      videos,
      description: '',
      price: prices.length ? { value: Math.min(...prices), currency: d.priceModule?.minAmount?.currency || 'USD' } : undefined,
      variants,
    };
  }

  /** _d_c_ 可能异步注入,轮询等待最多 ~1.5s */
  function attempt(): Payload | null {
    return parseDcc() || parseLegacy();
  }
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    let result: Payload | null = null;
    try {
      result = attempt();
    } catch (e) {
      debug.error = (e as Error).message;
    }
    if (result || tries >= 8) {
      clearInterval(timer);
      if (!result) {
        debug.gaveUp = true;
        debug.hasDcc = !!(window as any)._d_c_;
        try {
          debug.windowKeys = Object.getOwnPropertyNames(window as any)
            .filter((k) => /_d_c_|param|init|data|sku|product/i.test(k))
            .slice(0, 30);
        } catch {
          /* ignore */
        }
      }
      post(result);
    }
  }, 200);
})();
