import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { config } from '../config/index.js';
import { productRepository } from '../repositories/product-repository.js';
import { MiaoshouClient, MiaoshouError, MIAOSHOU_PATHS } from '../marketplaces/miaoshou/client.js';
import { emptyMiaoshouFields, miaoshouDraftIssues, MIAOSHOU_SITES, type MiaoshouConfigPublic, type MiaoshouDraft, type MiaoshouTemplate, type MiaoshouWorkspace, type MiaoshouShop, type MiaoshouRules, type MiaoshouCategory } from '../../../shared/miaoshou.js';

interface StoredConfig { appKey: string; appSecret: string; defaultShopId: string; defaultSites: typeof MIAOSHOU_SITES[number][] }
const editableStates = new Set(['pending', 'ready', 'skipped', 'failed']);
const required = (rule: { tags?: Record<string, unknown> }) => [true, 1, '1', 'true'].includes(rule.tags?.required as string);
function parseRow<T>(row: unknown): T | undefined { return row ? JSON.parse((row as { data: string }).data) : undefined; }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function buildMiaoshouPayload(draft: MiaoshouDraft, rules: MiaoshouRules) {
  const issues = miaoshouDraftIssues(draft);
  const supplied = new Map(draft.attributes.map(a => [a.name, a]));
  for (const rule of [...rules.productAttributeRules, ...rules.skuAttributeRules]) {
    if (required(rule) && !supplied.get(rule.name)?.values.some(v => v.name.trim())) issues.push(`填写类目属性：${rule.displayName || rule.name}`);
  }
  const optionNames = [...new Set(draft.variants.flatMap(v => Object.keys(v.options)))];
  const alias = (text: string) => /^(colou?r|颜色|色彩)$/i.test(text) ? 'COLOR' : /^(size|尺码|尺寸)$/i.test(text) ? 'SIZE' : text;
  const mapped = optionNames.map(name => ({ name, rule: rules.saleAttributeRules.find(r => r.name === draft.optionMappings[name] || r.id === draft.optionMappings[name])
    ?? rules.saleAttributeRules.find(r => [r.name, r.displayName, r.id].some(value => value && alias(value).toLowerCase() === alias(name).toLowerCase())) }));
  for (const mapping of mapped) if (!mapping.rule) issues.push(`将来源规格“${mapping.name}”映射到类目销售属性`);
  const activeRules = rules.saleAttributeRules.filter(r => mapped.some(m => m.rule?.name === r.name));
  if (new Set(mapped.flatMap(m => m.rule ? [m.rule.name] : [])).size !== mapped.filter(m => m.rule).length) issues.push('不同来源规格不能映射到同一个销售属性');
  for (const rule of rules.saleAttributeRules.filter(required)) {
    const name = mapped.find(m => m.rule?.name === rule.name)?.name;
    if (!name || draft.variants.some(v => !v.options[name]?.trim())) issues.push(`每个 SKU 都需要销售属性：${rule.displayName || rule.name}`);
  }
  const valueOf = (v: MiaoshouDraft['variants'][number], name: string, id: string) => {
    const value = v.options[name]?.trim() || '';
    return id === 'SIZE' && Object.hasOwn(draft.sizeMap, value) ? draft.sizeMap[value] : value;
  };
  let nextKey = 1;
  const saleAttributes = activeRules.map(rule => {
    const name = mapped.find(m => m.rule?.name === rule.name)!.name;
    const values = [...new Set(draft.variants.map(v => valueOf(v, name, rule.id)))];
    if (values.some(value => !value)) issues.push(`每个 SKU 都需要规格：${name}`);
    return { name: rule.name, values: values.map(value => ({ skuKey: nextKey++, name: value })) };
  });
  const skuMap: Record<string, unknown> = {};
  let firstSkuKey = ';';
  draft.variants.forEach((variant, index) => {
    const parts = activeRules.map(rule => {
      const sourceName = mapped.find(m => m.rule?.name === rule.name)!.name;
      return saleAttributes.find(a => a.name === rule.name)!.values.find(v => v.name === valueOf(variant, sourceName, rule.id))!.skuKey;
    });
    const key = ';' + parts.join(';') + (parts.length ? ';' : '');
    if (skuMap[key]) issues.push('尺码映射后存在重复规格组合，请检查 SKU');
    if (index === 0) {
      const pictureParts = parts.filter((_, i) => [true, 1, '1'].includes(activeRules[i].tags?.definesPicture as string));
      firstSkuKey = pictureParts.length ? ';' + pictureParts.join(';') + ';' : key;
    }
    const imgs = [...new Set([...variant.images.filter(img => draft.images.includes(img)), ...draft.images])].slice(0, 10);
    skuMap[key] = { itemNum: variant.sku, stock: draft.stock ?? variant.stock, imgUrls: imgs,
      length: String(draft.lengthCm ?? ''), width: String(draft.widthCm ?? ''), height: String(draft.heightCm ?? ''), lengthWidthHeightUnit: 'cm',
      weight: String(draft.weightKg ?? ''), weightUnit: 'kg', upc: '', isDelete: false,
      ...(variant.sizeGridRowId ? { sizeGridRowId: variant.sizeGridRowId } : {}), siteAndPriceMap: {}, siteAndListingTypeInfoMap: {} };
  });
  if (issues.length) throw new MiaoshouError([...new Set(issues)].join('；'));
  return { siteCollectItemInfo: {
    price: draft.netProceeds, cid: draft.categoryId, title: draft.title, notes: draft.description,
    warrantyType: draft.warrantyType, warrantyTime: draft.warrantyTime ?? 0, warrantyTimeUnit: draft.warrantyTimeUnit,
    sourceList: [{ source: draft.source, sourceItemId: draft.sourceProductId, sourceItemUrl: draft.sourceUrl }],
    firstSkuKey, pricingMode: 'netProceeds', shopId: draft.shopId,
    attributes: draft.attributes, saleAttributes, sites: draft.sites,
    siteAndTitleList: draft.sites.filter(site => draft.siteTitles[site]?.trim()).map(site => ({ site, title: draft.siteTitles[site] })),
    siteAndPriceMap: Object.fromEntries(draft.sites.map(site => [site, draft.sitePrices[site] ?? draft.netProceeds])),
    skuMap, hasSaveSite: 1,
  } };
}

export class MiaoshouService {
  private running = false;
  constructor(private clientFactory = (key: string, secret: string) => new MiaoshouClient(key, secret)) {}
  private storedConfig(): StoredConfig {
    const stored = parseRow<StoredConfig>(getDb().prepare('SELECT data FROM miaoshou_config WHERE id = 1').get());
    if (stored) return stored;
    let local: Partial<StoredConfig> = {};
    const file = path.join(path.dirname(config.dbPath), 'miaoshou-local.json');
    if (fs.existsSync(file)) { try { local = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 设置页可重新配置 */ } }
    return { appKey: local.appKey || process.env.MIAOSHOU_APP_KEY || '', appSecret: local.appSecret || process.env.MIAOSHOU_APP_SECRET || '', defaultShopId: local.defaultShopId || '', defaultSites: local.defaultSites ?? [...MIAOSHOU_SITES] };
  }
  publicConfig(): MiaoshouConfigPublic {
    const c = this.storedConfig();
    return { configured: Boolean(c.appKey && c.appSecret), appKey: c.appKey ? c.appKey.slice(0, 5) + '…' + c.appKey.slice(-4) : '', secretConfigured: Boolean(c.appSecret), defaultShopId: c.defaultShopId, defaultSites: c.defaultSites };
  }
  saveConfig(patch: Partial<StoredConfig>) {
    const old = this.storedConfig();
    const next = { ...old, ...patch, appKey: patch.appKey?.trim() || old.appKey, appSecret: patch.appSecret?.trim() || old.appSecret };
    getDb().prepare('INSERT INTO miaoshou_config(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(next));
    return this.publicConfig();
  }
  private client() { const c = this.storedConfig(); if (!c.appKey || !c.appSecret) throw new MiaoshouError('请先在模板与连接中配置妙手应用'); return this.clientFactory(c.appKey, c.appSecret); }
  templates(): MiaoshouTemplate[] { return getDb().prepare('SELECT data FROM miaoshou_templates ORDER BY rowid').all().map(row => parseRow<MiaoshouTemplate>(row)!); }
  saveTemplate(template: MiaoshouTemplate) { getDb().prepare('INSERT INTO miaoshou_templates(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(template.id, JSON.stringify(template)); return template; }
  deleteTemplate(id: string) { getDb().prepare('DELETE FROM miaoshou_templates WHERE id=?').run(id); }
  workspace(): MiaoshouWorkspace {
    const drafts = getDb().prepare('SELECT data FROM miaoshou_drafts ORDER BY updated_at DESC').all().map(row => parseRow<MiaoshouDraft>(row)!);
    const history = getDb().prepare('SELECT a.id FROM miaoshou_actions a JOIN miaoshou_drafts d ON d.id=a.draft_id AND d.version=a.after_version WHERE a.undone=0 AND d.status IN (\'ready\',\'skipped\',\'pending\') ORDER BY a.rowid DESC LIMIT 1').get() as { id: string } | undefined;
    return { config: this.publicConfig(), templates: this.templates(), undoId: history?.id, drafts: drafts.map(d => ({ id: d.id, productId: d.productId, title: d.title, image: d.images[0], templateId: d.templateId, source: d.source, shopId: d.shopId, sites: d.sites, netProceeds: d.netProceeds, status: d.status, remoteId: d.remoteId, lastError: d.lastError, version: d.version, updatedAt: d.updatedAt, issues: miaoshouDraftIssues(d) })) };
  }
  get(id: string): MiaoshouDraft { const d = parseRow<MiaoshouDraft>(getDb().prepare('SELECT data FROM miaoshou_drafts WHERE id=?').get(id)); if (!d) throw new MiaoshouError('美客多分拣草稿不存在', 404); return d; }
  open(productId: string): MiaoshouDraft {
    const existing = parseRow<MiaoshouDraft>(getDb().prepare('SELECT data FROM miaoshou_drafts WHERE product_id=?').get(productId));
    if (existing) return existing;
    const product = productRepository.get(productId); if (!product) throw new MiaoshouError('来源商品不存在', 404);
    const c = product.collected, settings = this.storedConfig(), now = new Date().toISOString();
    const variants = c.variants.length ? c.variants : [{ options: {}, sourceSkuId: c.generatedSku || c.sourceProductId }];
    const draft: MiaoshouDraft = { ...emptyMiaoshouFields(), id: randomUUID(), productId, templateId: '', title: c.title, description: c.description || '',
      shopId: settings.defaultShopId, sites: [...settings.defaultSites], images: [...new Set([...c.images, ...variants.flatMap(v => v.image ? [v.image] : [])])],
      source: c.source, sourceUrl: c.sourceUrl, sourceProductId: c.sourceProductId,
      variants: variants.map((v, i) => ({ sku: v.sourceSkuId || `${c.generatedSku || c.sourceProductId}-${i + 1}`, options: { ...v.options }, images: v.image ? [v.image] : [], stock: v.stock ?? null, sourcePrice: v.price ?? null, sizeGridRowId: '' })),
      status: 'pending', version: 1, createdAt: now, updatedAt: now };
    getDb().prepare('INSERT INTO miaoshou_drafts(id,product_id,status,version,data,updated_at) VALUES(?,?,?,?,?,?)').run(draft.id, productId, draft.status, draft.version, JSON.stringify(draft), now);
    return draft;
  }
  private write(draft: MiaoshouDraft, expected: number) {
    const updated = { ...draft, version: expected + 1, updatedAt: new Date().toISOString() };
    const result = getDb().prepare('UPDATE miaoshou_drafts SET status=?,version=?,data=?,updated_at=? WHERE id=? AND version=?').run(updated.status, updated.version, JSON.stringify(updated), updated.updatedAt, updated.id, expected);
    if (!result.changes) throw new MiaoshouError('草稿已被其他操作修改，请刷新后重试', 409);
    return updated;
  }
  private editable(id: string, version: number) { const d = this.get(id); if (d.version !== version) throw new MiaoshouError('草稿版本已更新，请刷新', 409); if (!editableStates.has(d.status)) throw new MiaoshouError('当前提交状态不允许修改；待核对结果需先处理', 409); return d; }
  update(id: string, version: number, patch: Partial<MiaoshouDraft>) { const d = this.editable(id, version); return this.write({ ...d, ...patch }, version); }
  decide(id: string, version: number, action: 'ready' | 'skipped' | 'pending', templateId?: string) {
    return getDb().transaction(() => {
      const before = this.editable(id, version); let next = clone(before);
      if (templateId) {
        const template = this.templates().find(t => t.id === templateId); if (!template) throw new MiaoshouError('模板已不存在，请重新选择');
        const { id: _id, name: _name, groupId: _group, material: _material, ...fields } = template;
        next = { ...next, ...clone(fields), templateId, shopId: fields.shopId || next.shopId, description: fields.description || next.description };
      }
      next.status = action; next.lastError = undefined;
      const result = this.write(next, version), historyId = randomUUID();
      getDb().prepare('INSERT INTO miaoshou_actions(id,draft_id,before_data,after_version,created_at) VALUES(?,?,?,?,?)').run(historyId, id, JSON.stringify(before), result.version, result.updatedAt);
      return result;
    })();
  }
  undo(id: string) {
    return getDb().transaction(() => {
      const row = getDb().prepare('SELECT * FROM miaoshou_actions WHERE id=? AND undone=0').get(id) as { draft_id: string; before_data: string; after_version: number } | undefined;
      if (!row) throw new MiaoshouError('没有可撤销的分拣操作', 409);
      this.editable(row.draft_id, row.after_version);
      const restored = this.write(JSON.parse(row.before_data), row.after_version);
      getDb().prepare('UPDATE miaoshou_actions SET undone=1 WHERE id=?').run(id);
      return restored;
    })();
  }
  async shops(): Promise<MiaoshouShop[]> {
    const rows: MiaoshouShop[] = [];
    for (const site of ['CBT']) {
      for (let pageNo = 1; pageNo <= 20; pageNo++) {
        const d = await this.client().call(MIAOSHOU_PATHS.shops, { platform: 'mercadolibre', site, pageNo, pageSize: 100 });
        const batch = d?.shopList ?? [];
        for (const s of batch) rows.push({ shopId: String(s.shopId), name: s.shopNick || s.platformShopName || String(s.shopId), site: s.site, status: s.status });
        if (batch.length < 100) break;
      }
    }
    return [...new Map(rows.map(s => [s.shopId, s])).values()];
  }
  async sites(shopId: string) { const d = await this.client().call(MIAOSHOU_PATHS.sites, { shopId: Number(shopId), includeCbt: 0 }); return d?.siteAndSiteNameMap ?? {}; }
  async rules(shopId: string, categoryId: string): Promise<MiaoshouRules> {
    const d = await this.client().call(MIAOSHOU_PATHS.rules, { cid: Number(categoryId), shopId: Number(shopId) });
    return { productAttributeRules: d?.productAttributeRules ?? [], saleAttributeRules: d?.saleAttributeRules ?? [], skuAttributeRules: d?.skuAttributeRules ?? [] };
  }
  async categories(): Promise<MiaoshouCategory[]> {
    const data = await this.client().call(MIAOSHOU_PATHS.categories, { site: 'CBT' });
    const result: MiaoshouCategory[] = [];
    const visit = (nodes: any, parents: string[]) => { for (const n of Object.values(nodes ?? {}) as any[]) { const label = [...parents, n.nameChinese || n.name]; if (Object.keys(n.children ?? {}).length) visit(n.children, label); else if (!n.disabled) result.push({ id: String(n.cid), label: label.join(' / ') }); } };
    visit(data?.cateTree, []); return result;
  }
  async validate(id: string): Promise<string[]> {
    const d = this.get(id), local = miaoshouDraftIssues(d); if (local.length) return local;
    try { await this.prepare(d); return []; } catch (e) { if (e instanceof MiaoshouError && e.status === 400) return [e.message]; throw e; }
  }
  private async prepare(d: MiaoshouDraft) {
    const local = miaoshouDraftIssues(d); if (local.length) throw new MiaoshouError(local.join('；'));
    const shops = await this.shops();
    if (!shops.some(s => s.shopId === d.shopId && s.site === 'CBT' && s.status === 'normal')) throw new MiaoshouError('请使用已授权且状态正常的传统模式店铺');
    const sites = await this.sites(d.shopId), unauthorized = d.sites.filter(site => !sites[site]);
    if (unauthorized.length) throw new MiaoshouError(`当前店铺未授权站点：${unauthorized.join('、')}`);
    return buildMiaoshouPayload(d, await this.rules(d.shopId, d.categoryId));
  }
  enqueue(items: { id: string; version: number }[]) {
    const drafts = getDb().transaction(() => {
      return items.map(({ id, version }) => { const d = this.editable(id, version); if (!['ready', 'failed'].includes(d.status)) throw new MiaoshouError('请先分拣并加入提交清单'); const issues = miaoshouDraftIssues(d); if (issues.length) throw new MiaoshouError(`${d.title}：${issues.join('；')}`); return this.write({ ...d, status: 'queued', lastError: undefined }, version); });
    })();
    void this.drain(); return drafts;
  }
  start() {
    for (const row of getDb().prepare("SELECT data FROM miaoshou_drafts WHERE status='submitting'").all()) { const d = parseRow<MiaoshouDraft>(row)!; this.write({ ...d, status: 'needs_review', lastError: '服务在提交时中断，请先核对妙手采集箱结果' }, d.version); }
    void this.drain();
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const d = parseRow<MiaoshouDraft>(getDb().prepare("SELECT data FROM miaoshou_drafts WHERE status='queued' ORDER BY updated_at LIMIT 1").get());
        if (!d) break;
        let current = d;
        let submissionStarted = false;
        let receivedId: string | undefined;
        try {
          const payload = await this.prepare(d);
          current = this.write({ ...d, status: 'submitting' }, d.version);
          submissionStarted = true;
          const result = await this.client().call(MIAOSHOU_PATHS.create, payload);
          const remoteId = result?.collectBoxDetailId;
          if (!remoteId || !/^\d+$/.test(String(remoteId))) throw new MiaoshouError('妙手未返回有效采集箱 ID，请核对结果', 502, true);
          receivedId = String(remoteId);
          this.write({ ...current, status: 'submitted', remoteId: String(remoteId), lastError: undefined }, current.version);
        } catch (e) {
          const uncertain = submissionStarted && (!(e instanceof MiaoshouError) || e.uncertain);
          this.write({ ...current, ...(receivedId ? { remoteId: receivedId } : {}), status: uncertain ? 'needs_review' : 'failed', lastError: e instanceof Error ? e.message : '提交失败' }, current.version);
        }
      }
    } finally { this.running = false; }
  }
  async reconcile(id: string, version: number, remoteId: string) {
    const d = this.get(id); if (d.version !== version || d.status !== 'needs_review') throw new MiaoshouError('草稿状态已更新，请刷新', 409);
    const data = await this.client().call(MIAOSHOU_PATHS.detail, { detailId: Number(remoteId) });
    const remote = data?.siteCollectItemInfo;
    const sources = remote?.sourceList ?? [];
    const sourceMatches = sources.some((s: any) => s.sourceItemId === d.sourceProductId && s.source === d.source)
      || remote?.sourceItemUrl?.split('?')[0] === d.sourceUrl.split('?')[0];
    const remoteSkus = Object.values(remote?.skuMap ?? {}).map((s: any) => s.itemNum).sort();
    const sameSkus = JSON.stringify(remoteSkus) === JSON.stringify(d.variants.map(v => v.sku).sort());
    const samePricing = remote?.pricingMode === 'netProceeds' && Number(remote.price) === d.netProceeds && d.sites.every(site => {
      const price = remote.siteAndPriceMap?.[site];
      return Number(price == null || price === '' ? remote.price : price) === (d.sitePrices[site] ?? d.netProceeds);
    });
    if (!sourceMatches || String(remote.shopId) !== d.shopId || remote.title !== d.title || !sameSkus || !samePricing || d.sites.some(site => !remote.sites?.includes(site))) throw new MiaoshouError('该采集箱商品与草稿的来源、店铺、标题、SKU、站点或净收益不一致，未自动关联');
    return this.write({ ...d, status: 'submitted', remoteId, lastError: undefined }, version);
  }
  async reviewCandidates(id: string, version: number) {
    const d = this.get(id);
    if (d.status !== 'needs_review' || d.version !== version) throw new MiaoshouError('草稿状态已更新，请刷新', 409);
    const data = await this.client().call(MIAOSHOU_PATHS.search, { pageNo: 1, pageSize: 20, filter: { sourceItemIdKeyword: d.sourceProductId } });
    return (data?.detailList ?? []).filter((row: { collectBoxDetailShop?: { shopId?: string } }) => String(row.collectBoxDetailShop?.shopId) === d.shopId)
      .map((row: { collectBoxDetailId: string; title: string; collectBoxDetailShop: { shopId: string } }) => ({ remoteId: String(row.collectBoxDetailId), title: row.title, shopId: String(row.collectBoxDetailShop.shopId) }));
  }
  release(id: string, version: number) {
    const d = this.get(id); if (d.version !== version || d.status !== 'needs_review') throw new MiaoshouError('草稿状态已更新，请刷新', 409);
    if (d.remoteId) throw new MiaoshouError('妙手已返回采集箱 ID，请先核对并关联该商品，不能直接重试');
    return this.write({ ...d, status: 'ready', lastError: '已人工核对未入箱，可重新提交' }, version);
  }
}
export const miaoshouService = new MiaoshouService();
