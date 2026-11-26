import { createHmac } from 'node:crypto';

export const MIAOSHOU_BASE = 'https://openapi-erp.91miaoshou.com';
const prefix = '/open/v1/product/collect_box/mercadolibre/collect_box/';
export const MIAOSHOU_PATHS = {
  shops: '/open/v1/product/shop/shop/get_shop_list',
  sites: prefix + 'get_auth_site_and_site_name_map',
  categories: prefix + 'get_category_tree_by_site',
  rules: prefix + 'get_category_attribute_rules',
  detail: prefix + 'get_site_collect_item_info',
  search: prefix + 'search_collect_box_detailList',
  create: prefix + 'create_collect_box_item',
  orderPackages: '/open/v1/order/package/fetch/search_package_list',
} as const;
export class MiaoshouError extends Error {
  constructor(message: string, public status = 400, public uncertain = false) { super(message); }
}
export function miaoshouSignature(secret: string, path: string, timestamp: string, key: string, body: string): string {
  return createHmac('sha256', secret).update(secret + path + timestamp + key + body + secret).digest('hex');
}
export class MiaoshouClient {
  constructor(private key: string, private secret: string, private fetcher: typeof fetch = fetch, private intervalMs = 1100) {}
  async call<T = any>(path: typeof MIAOSHOU_PATHS[keyof typeof MIAOSHOU_PATHS], input: unknown): Promise<T> {
    await reserveSlot(this.intervalMs);
    const body = JSON.stringify(input);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const isCreate = path === MIAOSHOU_PATHS.create;
    let response: Response;
    try {
      response = await this.fetcher(MIAOSHOU_BASE + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35_000), headers: {
        'Content-Type': 'application/json', 'x-app-key': this.key, 'x-timestamp': timestamp,
        'x-sign': miaoshouSignature(this.secret, path, timestamp, this.key, body),
      }, body });
    } catch {
      throw new MiaoshouError(isCreate ? '请求中断或超时，请先核对妙手采集箱结果' : '妙手接口连接失败，请稍后重试', 502, isCreate);
    }
    const data = await response.json().catch(() => null) as any;
    if (!response.ok || data?.result !== 'success' || data?.code !== 'success') {
      const uncertain = isCreate && (response.status >= 500 || !data || !['success', 'fail'].includes(data.result)
        || typeof data.code !== 'string' || data.result === 'success' || /^upstream/.test(String(data.code)));
      const reason = String(data?.message || data?.code || `HTTP ${response.status}`).slice(0, 350).split(this.secret).join('[已隐藏]');
      throw new MiaoshouError(`妙手接口返回：${reason}`, 502, uncertain);
    }
    return data.data as T;
  }
}
let lastCall = 0;
let slot = Promise.resolve();
function reserveSlot(interval: number): Promise<void> {
  const next = slot.then(async () => {
    const wait = lastCall + interval - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCall = Date.now();
  });
  slot = next.catch(() => {});
  return next;
}
