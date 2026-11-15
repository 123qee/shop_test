import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MercadoLibreConfigPublic, MercadoLibreSiteId, MercadoLibreTemplate } from '@shared/types';
import { api } from '../api';
import { useNativePrompt } from '../components/NativePromptProvider';
import { CategoryPicker } from '../CategoryPicker';
import type { CatOption } from '../categories';
import { localizeMercadoLibreCategory } from '../mercadolibre-category-labels';

const SITE_OPTIONS = ['MLC', 'MLM', 'MCO'] as const;

export function MercadoLibreSettingsPage() {
  const nativePrompt = useNativePrompt();
  const [config, setConfig] = useState<MercadoLibreConfigPublic | null>(null);
  const [templates, setTemplates] = useState<MercadoLibreTemplate[]>([]);
  const [form, setForm] = useState({ clientId: '', clientSecret: '', redirectUri: '', notificationUrl: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState<MercadoLibreTemplate>(newTemplate());
  const [templateQuery, setTemplateQuery] = useState('');
  const [categoryAccountId, setCategoryAccountId] = useState('');
  const [categoryOptions, setCategoryOptions] = useState<CatOption[]>([]);
  const [categoryLoadedKey, setCategoryLoadedKey] = useState('');
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryPredictQuery, setCategoryPredictQuery] = useState('');
  const [categoryPredictLoading, setCategoryPredictLoading] = useState(false);
  const [accountAction, setAccountAction] = useState('');

  // 模板只有一个 categoryId, 默认按第一个适用站点加载目录用于搜索，选中的 ID 会复用到所有适用站点。
  const categoryLookupSite: MercadoLibreSiteId = template.siteIds[0] || 'MLC';

  async function load() {
    const [nextConfig, nextTemplates] = await Promise.all([api.mercadoLibreConfig(), api.mercadoLibreTemplates()]);
    setConfig(nextConfig);
    setTemplates(nextTemplates);
    setForm((current) => ({
      clientId: nextConfig.clientId ?? current.clientId,
      clientSecret: '',
      redirectUri: nextConfig.redirectUri ?? current.redirectUri,
      notificationUrl: nextConfig.notificationUrl ?? current.notificationUrl,
    }));
    setCategoryAccountId((current) => current || nextConfig.connectedAccounts[0]?.id || '');
  }

  useEffect(() => { void load().catch((e) => setError((e as Error).message)); }, []);
  useEffect(() => {
    setCategoryOptions([]);
    setCategoryLoadedKey('');
  }, [categoryLookupSite]);

  const visibleTemplates = useMemo(() => {
    const keyword = templateQuery.trim().toLowerCase();
    if (!keyword) return templates;
    return templates.filter((item) => `${item.name} ${item.siteIds.join(' ')} ${item.categoryId || ''}`.toLowerCase().includes(keyword));
  }, [templates, templateQuery]);

  async function save() {
    setSaving(true); setError(''); setMessage('');
    try {
      const next = await api.saveMercadoLibreConfig({ ...form, clientSecret: form.clientSecret || undefined });
      setConfig(next); setForm((current) => ({ ...current, clientSecret: '' })); setMessage('美客多配置已保存');
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }

  async function refreshAccount(accountId: string) {
    setAccountAction(`refresh:${accountId}`); setError(''); setMessage('');
    try {
      await api.refreshMercadoLibreAccount(accountId);
      await load();
      setMessage('卖家账号状态已刷新');
    } catch (e) { setError((e as Error).message); }
    finally { setAccountAction(''); }
  }

  async function disconnectAccount(accountId: string, name: string) {
    if (!await nativePrompt.confirm(`确定断开“${name}”吗？已有草稿会保留，但暂时不能发布或同步。`)) return;
    setAccountAction(`disconnect:${accountId}`); setError(''); setMessage('');
    try {
      await api.disconnectMercadoLibreAccount(accountId);
      await load();
      setMessage('卖家账号已断开，刊登草稿仍然保留');
    } catch (e) { setError((e as Error).message); }
    finally { setAccountAction(''); }
  }

  function editTemplate(item: MercadoLibreTemplate) { setTemplate({ ...item, siteIds: [...item.siteIds], attributes: [...item.attributes] }); }

  function toggleTemplateSite(site: MercadoLibreTemplate['siteIds'][number]) {
    setTemplate((current) => ({ ...current, siteIds: current.siteIds.includes(site) ? current.siteIds.filter((item) => item !== site) : [...current.siteIds, site] }));
  }

  async function loadCategoryOptions() {
    if (!categoryAccountId) {
      setError('请先连接一个美客多卖家，再搜索类目');
      return;
    }
    setCategoryLoading(true);
    setError('');
    try {
      const raw = await api.mercadoLibreCategories(categoryAccountId, categoryLookupSite);
      setCategoryOptions(normalizeCategories(raw));
      setCategoryLoadedKey(`${categoryAccountId}:${categoryLookupSite}`);
      setMessage(`已加载 ${categoryLookupSite} 类目，可按名称或 ID 搜索；选中的类目会应用到所有适用站点`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCategoryLoading(false);
    }
  }

  async function predictCategory() {
    if (!categoryAccountId) {
      setError('请先连接一个美客多卖家，再推荐类目');
      return;
    }
    const title = categoryPredictQuery.trim();
    if (!title) {
      setError('请输入商品标题或类目关键词，例如：童装短袖');
      return;
    }
    setCategoryPredictLoading(true);
    setError('');
    try {
      const raw = await api.mercadoLibreCategoryPredict(categoryAccountId, categoryLookupSite, toMercadoLibreCategoryTitle(title));
      const options = normalizeCategories(raw);
      if (!options.length) throw new Error('接口没有返回推荐类目，请换一个更完整的商品标题');
      setCategoryOptions(options);
      setCategoryLoadedKey(`${categoryAccountId}:${categoryLookupSite}`);
      setTemplate((current) => ({ ...current, categoryId: options[0].id }));
      setMessage(`已推荐类目：${options[0].localizedLabel || options[0].label}（${options[0].id}）`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCategoryPredictLoading(false);
    }
  }

  function copyTemplate(item: MercadoLibreTemplate) {
    const baseName = item.name.trim() || '美客多模板';
    const existingNames = new Set(templates.map((entry) => entry.name));
    let name = `${baseName} - 副本`;
    let index = 2;
    while (existingNames.has(name)) name = `${baseName} - 副本 ${index++}`;
    setTemplate({ ...item, id: newTemplateId(), name, siteIds: [...item.siteIds], attributes: item.attributes.map((attribute) => ({ ...attribute, values: attribute.values?.map((value) => ({ ...value })) })) });
    setMessage(`已复制「${item.name}」，请点击“保存模板”完成创建`);
    document.getElementById('ml-template-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function saveTemplate() {
    try {
      const next = await api.saveMercadoLibreTemplate(template.id, { ...template });
      setTemplates(next); setMessage('美客多模板已保存');
    } catch (e) { setError((e as Error).message); }
  }

  async function removeTemplate(id: string) {
    if (!await nativePrompt.confirm('确定删除这个美客多模板吗？')) return;
    setTemplates(await api.deleteMercadoLibreTemplate(id));
    if (template.id === id) setTemplate(newTemplate());
    setMessage('美客多模板已删除');
  }

  return <div className="settings-layout ml-settings-page">
    <main>
      {message && <div className="ok">{message}</div>}
      {error && <div className="error">{error}</div>}
      <div className="ed-bar"><Link className="back-link" to="/mercadolibre">← 返回刊登中心</Link><strong>美客多平台设置</strong><span className="hint">应用、卖家账号与刊登模板</span><div style={{ flex: 1 }} />
        {config?.configured ? <button onClick={() => (location.href = '/api/mercadolibre/auth')}>＋ 连接卖家</button> : null}
      </div>

      <div className="settings-progress"><div className={config?.configured ? 'done' : 'active'}><i>{config?.configured ? '✓' : '1'}</i><span><strong>配置应用</strong><small>保存开发者凭证与回调地址</small></span></div><b /><div className={config?.connectedAccounts.length ? 'done' : config?.configured ? 'active' : ''}><i>{config?.connectedAccounts.length ? '✓' : '2'}</i><span><strong>授权卖家</strong><small>连接要发布商品的账号</small></span></div><b /><div className={config?.connectedAccounts.length ? 'active' : ''}><i>3</i><span><strong>创建模板</strong><small>预设站点、价格与物流规则</small></span></div></div>

      <section className="section" id="ml-app-settings">
        <div className="section-head"><div><span className="section-step">步骤 1</span><h3 style={{ margin: 0 }}>应用与 OAuth</h3><p className="section-subtitle">凭证仅保存在本机服务端，不会显示完整 Secret。</p></div><span className={`badge ${config?.configured ? 'published' : 'collected'}`}>{config?.configured ? '配置完成' : '等待配置'}</span></div>
        <div className="row2">
          <div className="field"><label>App ID</label><input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} /></div>
          <div className="field"><label>App Secret</label><input type="password" value={form.clientSecret} placeholder={config?.clientSecretHint ? `已保存（${config.clientSecretHint}）` : ''} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} /></div>
        </div>
        <div className="row2">
          <div className="field"><label>Redirect URI</label><input value={form.redirectUri} placeholder="https://.../api/mercadolibre/callback" onChange={(e) => setForm({ ...form, redirectUri: e.target.value })} /></div>
          <div className="field"><label>Notification Callback URL</label><input value={form.notificationUrl} placeholder="https://.../api/mercadolibre/notifications" onChange={(e) => setForm({ ...form, notificationUrl: e.target.value })} /></div>
        </div>
        <button onClick={() => void save()} disabled={saving || !form.clientId.trim() || (!form.clientSecret && !config?.clientSecretHint) || !form.redirectUri.trim()}>{saving ? '保存中…' : '保存应用配置'}</button>
        <p className="hint">App Secret 只在服务端保存；Redirect URI 必须与美客多应用后台完全一致。</p>
      </section>

      <section className="section" id="ml-accounts">
        <div className="section-head"><div><span className="section-step">步骤 2</span><h3 style={{ margin: 0 }}>卖家账号</h3><p className="section-subtitle">一个应用可连接多个卖家，发布时再选择账号。</p></div>{config?.configured && <button className="button secondary small" onClick={() => (location.href = '/api/mercadolibre/auth')}>＋ 连接新卖家</button>}</div>
        {!config?.connectedAccounts.length && <div className="empty-state">尚未授权卖家。先保存配置，再点击顶部「连接卖家」。</div>}
        {config?.connectedAccounts.map((account) => <div className="activity-item" key={account.id}>
          <div><strong>{account.nickname || account.userId}</strong><small>{sellerModelLabel(account.model)} · 用户 ID {account.userId}</small></div>
          <div className="account-sites">{account.sites.map((site, index) => <span className={`chip ${site.enabled ? 'site-enabled' : ''}`} key={`${site.siteId}-${site.userId || index}`}>{site.siteId} · {siteName(site.siteId)}</span>)}</div>
          <div className="account-actions"><button className="ghost" onClick={() => void refreshAccount(account.id)} disabled={Boolean(accountAction)}>{accountAction === `refresh:${account.id}` ? '刷新中…' : '刷新'}</button><button className="ghost danger-ghost" onClick={() => void disconnectAccount(account.id, account.nickname || account.userId)} disabled={Boolean(accountAction)}>{accountAction === `disconnect:${account.id}` ? '断开中…' : '断开'}</button></div>
        </div>)}
      </section>

      <section className="section" id="ml-template-editor">
        <div className="section-head"><div><span className="section-step">步骤 3</span><h3 style={{ margin: 0 }}>刊登模板</h3><p className="section-subtitle">复用类目、标题、价格和物流规则，提高批量创建效率。</p></div><span className="hint">与 Joom 模板互不影响</span></div>
        <div className="row2">
          <div className="field"><label>模板名称</label><input value={template.name} onChange={(e) => setTemplate({ ...template, name: e.target.value })} /></div>
          <div className="field"><label>适用站点 <span className="hint">可多选</span></label><div className="template-site-picker">{SITE_OPTIONS.map((site) => <button type="button" key={site} className={template.siteIds.includes(site) ? 'template-site on' : 'template-site'} onClick={() => toggleTemplateSite(site)}><strong>{site}</strong><small>{site === 'MLC' ? '智利' : site === 'MLM' ? '墨西哥' : '哥伦比亚'}</small><i>{template.siteIds.includes(site) ? '✓' : ''}</i></button>)}</div><small className="template-help">同一模板可以同时套用到多个站点；价格、类目和物流仍会按模板统一生成。</small></div>
        </div>
        <div className="row2">
          <div className="field"><label>标题模板 <span className="hint">留空则使用采集标题</span></label><input value={template.titleTemplate ?? ''} placeholder="例如：{{title}} · Official Store" onChange={(e) => setTemplate({ ...template, titleTemplate: e.target.value || undefined })} /><small className="template-help">可用变量：{'{{title}}'}、{'{{sku}}'}、{'{{sourceProductId}}'}、{'{{brand}}'}</small></div>
          <div className="field"><label>语言策略</label><select value={template.language} onChange={(e) => setTemplate({ ...template, language: e.target.value as MercadoLibreTemplate['language'] })}><option value="source">沿用采集语言</option><option value="english">英文</option><option value="spanish">西语</option><option value="portuguese">葡语</option></select></div>
        </div>
        <div className="field"><label>商品描述模板 <span className="hint">留空则使用采集描述</span></label><textarea className="template-description" rows={8} value={template.descriptionTemplate ?? ''} placeholder={'例如：\nMaterial: algodón suave\n\nCaracterísticas:\n- Diseño cómodo para uso diario\n- Fácil de combinar\n\n{{sourceDescription}}'} onChange={(e) => setTemplate({ ...template, descriptionTemplate: e.target.value || undefined })} /><small className="template-help">可用变量：{'{{title}}'}、{'{{sourceDescription}}'}、{'{{sku}}'}、{'{{sourceProductId}}'}、{'{{brand}}'}、{'{{store}}'}。支持换行，发布到美客多时会作为纯文本描述。</small></div>
        <div className="row2">
          <div className="field">
            <label>类目 ID <span className="hint">可按名称或 ID 搜索</span></label>
            <div className="ml-category-tools">
              <span className="category-lookup-site">搜索目录：{categoryLookupSite}</span>
              {config?.connectedAccounts.length ? <select value={categoryAccountId} onChange={(e) => { setCategoryAccountId(e.target.value); setCategoryOptions([]); setCategoryLoadedKey(''); }}>
                {config.connectedAccounts.map((account) => <option value={account.id} key={account.id}>{account.nickname || account.userId}</option>)}
              </select> : null}
              <button type="button" className="button secondary small" onClick={() => void loadCategoryOptions()} disabled={!categoryAccountId || categoryLoading}>
                {categoryLoading ? '加载中…' : categoryLoadedKey === `${categoryAccountId}:${categoryLookupSite}` ? '重新加载' : '加载类目'}
              </button>
            </div>
            <div className="ml-category-predict">
              <input value={categoryPredictQuery} onChange={(e) => setCategoryPredictQuery(e.target.value)} placeholder="输入商品标题，例如：童装短袖" onKeyDown={(e) => { if (e.key === 'Enter') void predictCategory(); }} />
              <button type="button" className="button secondary small" onClick={() => void predictCategory()} disabled={!categoryAccountId || categoryPredictLoading}>
                {categoryPredictLoading ? '推荐中…' : '按标题推荐'}
              </button>
            </div>
            <CategoryPicker
              categories={categoryOptions}
              value={template.categoryId}
              onChange={(categoryId) => setTemplate((current) => ({ ...current, categoryId }))}
              disabled={!categoryLoadedKey || categoryLoading}
              placeholder={categoryLoadedKey ? '输入类目名称或 ID…' : '先点击“加载类目”'}
            />
            <small className="template-help">建议输入“童装短袖”后点击“按标题推荐”；也可用中文、西语或 ID 搜索。此模板只保存一个类目 ID，会应用到所有选中站点。</small>
          </div>
          <div className="field"><label>刊登类型 <span className="hint">按账号能力填写</span></label><input value={template.listingTypeId ?? ''} placeholder="例如 gold_special" onChange={(e) => setTemplate({ ...template, listingTypeId: e.target.value || undefined })} /></div>
        </div>
        <div className="row2">
          <div className="field"><label>物流类型</label><select value={template.logisticType} onChange={(e) => setTemplate({ ...template, logisticType: e.target.value })}><option value="remote">remote</option><option value="fulfillment">fulfillment</option></select></div>
          <div className="field"><label>币种</label><select value={template.currency} onChange={(e) => setTemplate({ ...template, currency: e.target.value })}><option value="USD">USD</option><option value="CLP">CLP</option><option value="MXN">MXN</option><option value="COP">COP</option></select></div>
        </div>
        <div className="row2">
          <div className="field"><label>价格规则</label><select value={template.priceMode} onChange={(e) => setTemplate({ ...template, priceMode: e.target.value as MercadoLibreTemplate['priceMode'] })}><option value="set">固定价格</option><option value="multiply">采集价格×倍率</option><option value="net_proceeds">净收益</option></select></div>
          <div className="field"><label>价格/倍率</label><input type="number" value={template.priceValue} onChange={(e) => setTemplate({ ...template, priceValue: Number(e.target.value) })} /></div>
        </div>
        <div className="inline-add"><button onClick={() => void saveTemplate()} disabled={!template.siteIds.length}>保存模板</button><button className="ghost" onClick={() => setTemplate(newTemplate())}>新建模板</button>{!template.siteIds.length && <span className="hint">至少选择一个适用站点</span>}</div>
        <div className="template-list-head"><div><strong>已保存模板</strong><span className="hint">共 {templates.length} 个</span></div><input className="template-search" value={templateQuery} onChange={(e) => setTemplateQuery(e.target.value)} placeholder="搜索模板名称、站点或类目" /></div>
        {visibleTemplates.length ? visibleTemplates.map((item) => <div className="activity-item template-list-item" key={item.id}><div><strong>{item.name}</strong><small>{item.siteIds.join('、')} · {item.categoryId || '未绑定类目'} · {item.priceMode} · {item.descriptionTemplate ? '含描述模板' : '沿用采集描述'}</small></div><div className="template-actions"><button className="ghost" onClick={() => editTemplate(item)}>编辑</button><button className="ghost" onClick={() => copyTemplate(item)}>复制</button><button className="ghost danger-ghost" onClick={() => void removeTemplate(item.id)}>删除</button></div></div>) : <div className="template-empty">{templates.length ? '没有匹配的模板' : '还没有保存的美客多模板，填写上方表单后点击“保存模板”。'}</div>}
      </section>
    </main>
  </div>;
}

function normalizeCategories(value: unknown): CatOption[] {
  const result: CatOption[] = [];
  const seen = new Set<string>();

  function walk(input: unknown, parentPath = '') {
    if (Array.isArray(input)) {
      input.forEach((item) => walk(item, parentPath));
      return;
    }
    if (!input || typeof input !== 'object') return;
    const item = input as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name : '';
    const apiPath = Array.isArray(item.path_from_root)
      ? item.path_from_root.map((part) => typeof part === 'object' && part && 'name' in part ? String((part as { name?: unknown }).name ?? '') : '').filter(Boolean).join(' / ')
      : typeof item.path_from_root === 'string' ? item.path_from_root : '';
    const label = apiPath || (parentPath ? `${parentPath} / ${name}` : name);
    if (id && name && !seen.has(id)) {
      seen.add(id);
      result.push({ id, label, localizedLabel: localizeMercadoLibreCategory(label) });
    }
    const nextPath = name ? (parentPath ? `${parentPath} / ${name}` : name) : parentPath;
    for (const key of ['children', 'categories', 'subcategories']) walk(item[key], nextPath);
  }

  walk(value);
  return result;
}

function toMercadoLibreCategoryTitle(value: string): string {
  return value
    .replace(/童装/g, 'ropa infantil ')
    .replace(/男童/g, 'niño ')
    .replace(/女童/g, 'niña ')
    .replace(/儿童/g, 'niños ')
    .replace(/短袖|短款袖子/g, ' manga corta ')
    .replace(/T恤|短袖上衣/g, ' polera ')
    .replace(/\s+/g, ' ')
    .trim();
}

function newTemplate(): MercadoLibreTemplate {
  return { id: newTemplateId(), name: '美客多模板', siteIds: ['MLC'], titleTemplate: '', descriptionTemplate: '', attributes: [], currency: 'USD', logisticType: 'remote', priceMode: 'set', priceValue: 9.99, language: 'source' };
}

function newTemplateId() {
  return `ml_tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function siteName(site: string) {
  return site === 'MLC' ? '智利' : site === 'MLM' ? '墨西哥' : site === 'MCO' ? '哥伦比亚' : site;
}

function sellerModelLabel(model: MercadoLibreConfigPublic['connectedAccounts'][number]['model']) {
  return ({ user_products: 'User Products', global_items: 'Global Items', fully_managed: '全托管', unknown: '模式待识别' } as const)[model];
}
