import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { MercadoLibreAttribute, MercadoLibreListingDraft, MercadoLibreValidationResponse } from '@shared/types';
import { api } from '../api';
import { useNativePrompt } from '../components/NativePromptProvider';

export function MercadoLibreProductEditor() {
  const nativePrompt = useNativePrompt();
  const { productId } = useParams();
  const [params] = useSearchParams();
  const [listings, setListings] = useState<MercadoLibreListingDraft[]>([]);
  const [selectedId, setSelectedId] = useState(params.get('listingId') || '');
  const [form, setForm] = useState<MercadoLibreListingDraft | null>(null);
  const [validation, setValidation] = useState<MercadoLibreValidationResponse | null>(null);
  const [categoryAttributes, setCategoryAttributes] = useState<CategoryRequirement[]>([]);
  const [categorySearch, setCategorySearch] = useState('');
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([]);
  const [categorySite, setCategorySite] = useState('');
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState('');

  async function load() {
    const next = await api.mercadoLibreListings(productId);
    setListings(next);
    const id = selectedId || next[0]?.id || '';
    setSelectedId(id);
    setForm(next.find((item) => item.id === id) ?? null);
    setDirty(false);
  }

  useEffect(() => { void load().catch((e) => setError((e as Error).message)); }, [productId]);
  useEffect(() => { setForm(listings.find((item) => item.id === selectedId) ?? null); setDirty(false); setValidation(null); }, [selectedId]);
  useEffect(() => {
    setCategoryAttributes([]);
    setCategorySearch('');
    setCategoryOpen(false);
  }, [selectedId]);

  const sites = useMemo(() => listings.map((item) => item.siteId), [listings]);
  const filteredCategories = useMemo(() => {
    const query = categorySearch.trim().toLowerCase();
    if (!query) return categoryOptions.slice(0, 40);
    return categoryOptions.filter((item) => `${item.id} ${item.name} ${item.path || ''}`.toLowerCase().includes(query)).slice(0, 40);
  }, [categoryOptions, categorySearch]);
  if (!form) return <div className="empty-state"><strong>还没有美客多站点草稿</strong><p>请返回工作区，从母库创建 MLC、MLM 或 MCO 草稿。</p><Link to="/mercadolibre">返回 Mercado Libre 工作区</Link></div>;
  const currentForm = form;

  function patch(next: Partial<MercadoLibreListingDraft>) {
    setForm((current) => current ? { ...current, ...next } : current);
    setDirty(true);
    setValidation(null);
  }

  function patchShared(next: Partial<MercadoLibreListingDraft>) {
    setForm((current) => current ? { ...current, ...next } : current);
    setListings((items) => items.map((item) => item.productId === currentForm.productId && item.accountId === currentForm.accountId ? { ...item, ...next } : item));
    setDirty(true);
    setValidation(null);
  }

  async function persistCurrent(options?: { silent?: boolean }) {
    setBusyAction('save');
    setError('');
    try {
      const next = await api.saveMercadoLibreListing(currentForm.id, { ...currentForm, syncShared: true });
      setForm(next);
      setListings((items) => items.map((item) => item.id === next.id ? next : item.productId === next.productId && item.accountId === next.accountId ? { ...item, title: next.title, description: next.description, images: next.images } : item));
      setDirty(false);
      setSavedAt(new Date().toISOString());
      if (!options?.silent) setMessage('草稿已保存，通用信息已同步到其他站点');
      return next;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusyAction('');
    }
  }

  async function save() {
    try { await persistCurrent(); } catch { /* error is already shown */ }
  }

  async function deleteSharedImage(image: string, index: number) {
    const label = index === 0 ? '主图' : `第 ${index + 1} 张图片`;
    if (!await nativePrompt.confirm(`确定删除${label}吗？\n\n这张图片会同时从母库和全部美客多站点草稿中删除。`)) return;
    setError('');
    setMessage('');
    try {
      if (dirty) await persistCurrent({ silent: true });
      setBusyAction('delete-image');
      const next = await api.deleteMercadoLibreListingImage(currentForm.id, image);
      setListings(next);
      setForm(next.find((item) => item.id === currentForm.id) ?? null);
      setDirty(false);
      setSavedAt(new Date().toISOString());
      setValidation(null);
      setMessage('图片已从母库和全部美客多站点草稿中删除');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyAction('');
    }
  }

  async function validate() {
    setBusyAction('validate'); setError(''); setMessage('');
    try {
      if (dirty) await persistCurrent({ silent: true });
      const result = await api.validateMercadoLibreListing(currentForm.id);
      setValidation(result);
      setMessage(result.ok ? '发布检查已通过，可以发布当前站点' : '检查完成，请先修正下方问题');
    } catch (e) { setError((e as Error).message); }
    finally { setBusyAction(''); }
  }

  async function publish() {
    setBusyAction('publish'); setError(''); setMessage('');
    try {
      if (dirty) await persistCurrent({ silent: true });
      const next = await api.publishMercadoLibreListing(currentForm.id);
      setForm(next);
      setListings((items) => items.map((item) => item.id === next.id ? next : item));
      setDirty(false);
      setMessage(currentForm.status === 'published' ? '商品更新已提交' : '当前站点已提交发布');
    } catch (e) { setError((e as Error).message); await load(); }
    finally { setBusyAction(''); }
  }

  async function sync() {
    setBusyAction('sync'); setError('');
    try { const next = await api.syncMercadoLibreListing(currentForm.id); setForm(next); setListings((items) => items.map((item) => item.id === next.id ? next : item)); setMessage('已同步当前站点状态'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusyAction(''); }
  }

  async function changeRemoteStatus(status: 'active' | 'paused') {
    setBusyAction(status); setError(''); setMessage('');
    try {
      const next = await api.setMercadoLibreListingStatus(currentForm.id, status);
      setForm(next);
      setListings((items) => items.map((item) => item.id === next.id ? next : item));
      setMessage(status === 'paused' ? '当前站点商品已暂停' : '当前站点商品已恢复销售');
    } catch (e) { setError((e as Error).message); }
    finally { setBusyAction(''); }
  }

  async function switchSite(id: string) {
    if (!id || id === currentForm.id || busyAction) return;
    try {
      if (dirty) await persistCurrent({ silent: true });
      setSelectedId(id);
      setMessage('');
      setError('');
    } catch { /* keep the user on the current site when autosave fails */ }
  }

  async function loadCategoryAttributes() {
    if (!currentForm.accountId || !currentForm.categoryId) return;
    try {
      const raw = await api.mercadoLibreCategoryAttributes(currentForm.accountId, currentForm.categoryId);
      setCategoryAttributes(normalizeAttributeRequirements(raw));
      setMessage(`已加载 ${currentForm.siteId} 类目属性要求`);
    } catch (e) { setError((e as Error).message); }
  }

  async function loadCategories() {
    if (!currentForm.accountId) return;
    setCategoryLoading(true);
    setError('');
    try {
      const raw = await api.mercadoLibreCategories(currentForm.accountId, currentForm.siteId);
      setCategoryOptions(normalizeCategories(raw));
      setCategorySite(currentForm.siteId);
      setCategoryOpen(true);
    } catch (e) { setError((e as Error).message); }
    finally { setCategoryLoading(false); }
  }

  async function openCategoryPicker() {
    if (categorySite !== currentForm.siteId || !categoryOptions.length) await loadCategories();
    else setCategoryOpen(true);
  }

  function patchVariant(index: number, field: 'price' | 'inventory', value: number) {
    patch({ variants: currentForm.variants.map((item, i) => i === index ? { ...item, [field]: value } : item) });
  }

  function updateAttribute(requirement: CategoryRequirement, value: string, valueId?: string, unitName?: string, unitId?: string) {
    const next = currentForm.attributes.filter((item) => item.id !== requirement.id);
    if (value.trim() || valueId) {
      const attribute: MercadoLibreAttribute = { id: requirement.id, name: requirement.name, valueName: value || undefined, valueId, unitName, unitId };
      next.push(attribute);
    }
    patch({ attributes: next });
  }

  function attributeValue(requirement: CategoryRequirement) {
    const current = currentForm.attributes.find((item) => item.id === requirement.id);
    return current?.valueName || current?.values?.map((item) => item.name).join(', ') || '';
  }

  function attributeId(requirement: CategoryRequirement) {
    return currentForm.attributes.find((item) => item.id === requirement.id)?.valueId || '';
  }

  function attributeUnit(requirement: CategoryRequirement) {
    const current = currentForm.attributes.find((item) => item.id === requirement.id);
    return { name: current?.unitName || '', id: current?.unitId || '' };
  }

  const readiness = getReadiness(currentForm);
  const requiredReadiness = readiness.filter((item) => item.required !== false);
  const completedReadiness = requiredReadiness.filter((item) => item.done).length;
  const readinessPercent = Math.round(completedReadiness / requiredReadiness.length * 100);
  const filledRequiredAttributes = categoryAttributes.filter((item) => item.required && (attributeValue(item) || attributeId(item))).length;

  return <div className="ml-editor-page">
    <div className="ed-bar ml-editor-bar"><Link className="back-link" to="/mercadolibre">← 返回刊登中心</Link><div className="editor-title"><strong>编辑美客多商品</strong><span className={`save-state ${dirty ? 'dirty' : ''}`}>{dirty ? '有未保存修改' : savedAt ? '刚刚已保存' : '草稿已同步'}</span></div><span className="site-tag site-tag-large">{currentForm.siteId}<small>{siteName(currentForm.siteId)}</small></span><div style={{ flex: 1 }} /><button className="button secondary" onClick={() => void sync()} disabled={!currentForm.remote || Boolean(busyAction)}>{busyAction === 'sync' ? '同步中…' : '同步状态'}</button><button className="button secondary" onClick={() => void validate()} disabled={Boolean(busyAction)}>{busyAction === 'validate' ? '检查中…' : '发布检查'}</button><button className="button primary" onClick={() => void publish()} disabled={Boolean(busyAction) || readinessPercent < 100}>{busyAction === 'publish' ? '提交中…' : currentForm.status === 'published' ? '保存并更新' : '保存并发布'}</button></div>
    {message && <div className="ok ml-alert">{message}</div>}{error && <div className="error ml-alert">{error}</div>}
    {currentForm.lastError && <div className="ml-publish-error"><strong>上次发布失败</strong><span>{currentForm.lastError}</span><button type="button" onClick={() => void validate()}>重新检查</button></div>}

    <section className="section shared-product-section"><div className="section-head"><div><h3 style={{ margin: 0 }}>通用商品信息</h3><p className="section-subtitle">以下内容会同步到 MLC、MLM、MCO，不会覆盖各站点自己的价格和物流。</p></div><span className="shared-badge">多个站点共用</span></div><div className="field"><label>标题</label><input value={currentForm.title} onChange={(e) => patchShared({ title: e.target.value })} /><span className="hint">标题修改后保存时会同步到其他站点。</span></div><div className="field"><label>描述</label><textarea rows={5} value={currentForm.description} onChange={(e) => patchShared({ description: e.target.value })} /></div></section>

    <div className="site-editor-heading"><div><h3>站点销售设置</h3><p>切换站点时会自动保存当前修改；价格、类目和库存按站点独立管理。</p></div><div className="editor-tabs">{listings.map((listing) => <button type="button" key={listing.id} className={listing.id === currentForm.id ? 'on' : ''} onClick={() => void switchSite(listing.id)}><span>{listing.siteId}</span><small>{siteName(listing.siteId)} · {statusLabel(listing.status)}</small></button>)}</div></div>

    <div className="ed-layout"><main>
      <section className="section"><div className="section-head"><div><h3 style={{ margin: 0 }}>类目与语言</h3><p className="section-subtitle">当前站点：{currentForm.siteId}</p></div><span className={`ml-status ${statusClass(currentForm.status)}`}><i />{statusLabel(currentForm.status)}</span></div><div className="row2"><div className="field"><label>类目 <span className="field-label-hint">可以按名称或 ID 搜索</span></label><div className="category-picker"><div className="category-input-row"><input value={categorySearch} onChange={(e) => { setCategorySearch(e.target.value); setCategoryOpen(true); }} onFocus={() => { if (categoryOptions.length) setCategoryOpen(true); }} placeholder={currentForm.categoryId || '输入类目名称，例如 Hoodie'} /><button type="button" className="button secondary" onClick={() => void openCategoryPicker()} disabled={!currentForm.accountId}>{categoryLoading ? '加载中…' : '搜索类目'}</button></div>{currentForm.categoryId && <div className="selected-category">当前类目：<strong>{currentForm.categoryId}</strong><button type="button" onClick={() => patch({ categoryId: undefined })}>清除</button></div>}{categoryOpen && categoryOptions.length > 0 && <div className="category-results">{filteredCategories.length ? filteredCategories.map((item) => <button type="button" key={item.id} onClick={() => { patch({ categoryId: item.id }); setCategorySearch(item.name); setCategoryOpen(false); }}><strong>{item.name}</strong><small>{item.id}{item.path ? ` · ${item.path}` : ''}</small></button>) : <div className="category-no-result">没有匹配的类目名称或 ID</div>}</div>}</div><button className="button secondary field-action" onClick={() => void loadCategoryAttributes()} disabled={!currentForm.accountId || !currentForm.categoryId}>加载类目属性</button></div><div className="field"><label>标题语言</label><select value={currentForm.language} onChange={(e) => patch({ language: e.target.value as MercadoLibreListingDraft['language'] })}><option value="source">采集语言</option><option value="english">英文</option><option value="spanish">西语</option><option value="portuguese">葡语</option></select></div></div></section>
      <section className="section"><div className="section-head"><div><h3 style={{ margin: 0 }}>价格与销售条件</h3><p className="section-subtitle">仅影响当前 {currentForm.siteId} 站点</p></div></div><div className="row2"><div className="field"><label>物流类型</label><select value={currentForm.logisticType} onChange={(e) => patch({ logisticType: e.target.value })}><option value="remote">remote</option><option value="fulfillment">fulfillment</option></select></div><div className="field"><label>站点价格</label><input type="number" value={currentForm.priceValue ?? 0} onChange={(e) => patch({ priceValue: Number(e.target.value) })} /></div></div></section>
      <section className="section"><div className="section-head"><div><h3 style={{ margin: 0 }}>变体价格与库存</h3><p className="section-subtitle">SKU 和商品图片属于通用信息；价格和库存保留站点独立。</p></div><span className="hint">共 {currentForm.variants.length} 个变体</span></div>{currentForm.variants.map((variant, index) => <div className="variant-row" key={`${variant.sku}-${index}`}><div><strong>{variant.sku}</strong><small>{variant.attributes.map((a) => `${a.id}: ${a.valueName || a.values?.map((v) => v.name).join('/') || ''}`).join(' · ')}</small></div><label><span>价格</span><input type="number" value={variant.price} onChange={(e) => patchVariant(index, 'price', Number(e.target.value))} /></label><label><span>库存</span><input type="number" value={variant.inventory} onChange={(e) => patchVariant(index, 'inventory', Number(e.target.value))} /></label></div>)}</section>
      <section className="section attribute-editor"><div className="section-head"><div><h3 style={{ margin: 0 }}>类目属性</h3><p className="section-subtitle">按美客多类目要求填写，属性仅影响当前 {currentForm.siteId} 站点。</p></div><div className="attribute-actions"><span className="hint">{categoryAttributes.length ? `必填已完成 ${filledRequiredAttributes}/${categoryAttributes.filter((item) => item.required).length}` : '选择类目后加载'}</span><button className="button secondary" onClick={() => void loadCategoryAttributes()} disabled={!currentForm.accountId || !currentForm.categoryId}>{categoryAttributes.length ? '重新加载' : '加载属性表单'}</button></div></div>{!categoryAttributes.length ? <div className="attribute-empty"><div className="empty-icon">A</div><div><strong>还没有加载类目属性</strong><p>先选择类目，再点击“加载属性表单”，系统会把类目要求转换成可填写的表单。</p></div></div> : <div className="attribute-groups">{groupRequirements(categoryAttributes).map(([groupName, requirements]) => <div className="attribute-group" key={groupName}><div className="attribute-group-title">{groupName}</div><div className="attribute-fields">{requirements.map((requirement) => { const selectedUnit = attributeUnit(requirement); return <div className="attribute-field" key={requirement.id}><label><span>{requirement.name}</span>{requirement.required && <em className="attribute-required">必填</em>}{requirement.conditionalRequired && <em className="attribute-conditional">条件必填</em>}{requirement.allowVariations && <em className="attribute-variation">可做变体</em>}</label>{requirement.values.length ? <select value={attributeId(requirement) || attributeValue(requirement)} onChange={(e) => { const option = requirement.values.find((item) => item.id === e.target.value); updateAttribute(requirement, option?.name || e.target.value, e.target.value); }}><option value="">请选择</option>{requirement.values.map((option) => <option value={option.id || option.name} key={option.id || option.name}>{option.name}</option>)}</select> : requirement.valueType === 'number' ? <input type="number" value={attributeValue(requirement)} maxLength={requirement.maxLength} onChange={(e) => updateAttribute(requirement, e.target.value)} /> : requirement.valueType === 'boolean' ? <select value={attributeValue(requirement)} onChange={(e) => updateAttribute(requirement, e.target.value)}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select> : <input value={attributeValue(requirement)} maxLength={requirement.maxLength} placeholder={requirement.valueType === 'number_unit' ? '请输入数值' : '请输入属性值'} onChange={(e) => updateAttribute(requirement, e.target.value)} />}{requirement.units.length > 0 && <select className="unit-select" value={selectedUnit.id || selectedUnit.name} onChange={(e) => { const option = requirement.units.find((item) => item.id === e.target.value || item.name === e.target.value); updateAttribute(requirement, attributeValue(requirement), attributeId(requirement) || undefined, option?.name, option?.id); }}><option value="">选择单位</option>{requirement.units.map((unit) => <option value={unit.id || unit.name} key={unit.id || unit.name}>{unit.name}</option>)}</select>}<small>{requirement.id}{requirement.maxLength ? ` · 最多 ${requirement.maxLength} 个字符` : ''}</small></div>; })}</div></div>)}</div>}</section>
    </main><aside className="editor-side"><section className="section readiness-card"><div className="readiness-head"><div><span>发布完成度</span><strong>{readinessPercent}%</strong></div><div className="readiness-track"><i style={{ width: `${readinessPercent}%` }} /></div></div><div className="readiness-list">{readiness.map((item) => <div className={`${item.done ? 'done' : ''}${item.required === false ? ' optional' : ''}`} key={item.label}><i>{item.done ? '✓' : item.required === false ? '+' : '!'}</i><span>{item.label}</span><small>{item.detail}</small></div>)}</div><button className="button primary readiness-action" onClick={() => void publish()} disabled={Boolean(busyAction) || readinessPercent < 100}>{readinessPercent < 100 ? `还需完成 ${requiredReadiness.length - completedReadiness} 项` : currentForm.status === 'published' ? '保存并更新商品' : '保存并发布商品'}</button></section><section className="section"><div className="section-head"><h3 style={{ margin: 0 }}>通用图片</h3><span className="shared-badge">{currentForm.images.length} 张 · 共用</span></div><div className="image-grid">{currentForm.images.map((image, index) => <div className="editor-image" key={`${image}-${index}`}><img src={image} alt={`商品图 ${index + 1}`} />{index === 0 && <span>主图</span>}<button type="button" className="editor-image-delete" aria-label={`删除商品图 ${index + 1}`} title="同步删除母库和全部美客多站点中的这张图片" onClick={() => void deleteSharedImage(image, index)} disabled={Boolean(busyAction)}>×</button></div>)}</div><p className="hint">删除会同步到母库和全部美客多站点草稿；线上商品需再次“保存并更新”后生效。</p></section><section className="section site-actions"><h3>当前站点操作</h3><button className="button secondary" onClick={() => void save()} disabled={Boolean(busyAction)}>{busyAction === 'save' ? '保存中…' : dirty ? '保存草稿' : '已保存'}</button>{currentForm.status === 'published' && <button className="button secondary danger-button" onClick={() => void changeRemoteStatus('paused')} disabled={Boolean(busyAction)}>{busyAction === 'paused' ? '暂停中…' : '暂停销售'}</button>}{currentForm.status === 'paused' && <button className="button secondary" onClick={() => void changeRemoteStatus('active')} disabled={Boolean(busyAction)}>{busyAction === 'active' ? '恢复中…' : '恢复销售'}</button>}{currentForm.remote && <p className="hint remote-note">平台商品：{currentForm.remote.sitelessUserProductId || currentForm.remote.itemIds?.join(', ')}</p>}</section>{validation && <section className={`section validation-card ${validation.ok ? 'ok-box' : 'error-box'}`}><h3>{validation.ok ? '✓ 发布检查通过' : `${validation.issues.length} 项需要修正`}</h3>{validation.issues.map((issue) => <div className="validation-issue" key={`${issue.field}-${issue.message}`}><strong>{fieldLabel(issue.field)}</strong><span>{issue.message}</span></div>)}</section>}</aside></div>
  </div>;
}

function statusLabel(status: MercadoLibreListingDraft['status']) {
  return ({ draft: '草稿', validating: '待校验', publishing: '发布中', published: '已发布', paused: '已暂停', failed: '失败' } as Record<typeof status, string>)[status];
}

function statusClass(status: MercadoLibreListingDraft['status']) {
  return status === 'published' ? 'success' : status === 'failed' ? 'danger' : status === 'paused' ? 'paused' : 'pending';
}

function siteName(site: string) {
  return site === 'MLC' ? '智利' : site === 'MLM' ? '墨西哥' : site === 'MCO' ? '哥伦比亚' : site;
}

function getReadiness(listing: MercadoLibreListingDraft) {
  const validVariants = listing.variants.length > 0 && listing.variants.every((variant) => variant.sku.trim() && variant.price >= 0 && variant.inventory >= 0);
  return [
    { label: '商品标题', detail: listing.title.trim() ? `${listing.title.trim().length} 个字符` : '请填写标题', done: Boolean(listing.title.trim()) },
    { label: '商品描述', detail: listing.description.trim() ? '已填写' : '建议补充（选填）', done: Boolean(listing.description.trim()), required: false },
    { label: '商品图片', detail: listing.images.length ? `${listing.images.length} 张` : '至少需要 1 张', done: listing.images.length > 0 },
    { label: '站点类目', detail: listing.categoryId || '请选择类目', done: Boolean(listing.categoryId?.trim()) },
    { label: '价格与库存', detail: validVariants ? `${listing.variants.length} 个变体有效` : '请检查变体', done: validVariants },
  ];
}

function fieldLabel(field: string) {
  if (field === 'title') return '商品标题';
  if (field === 'categoryId') return '站点类目';
  if (field === 'images') return '商品图片';
  if (field === 'variants') return '商品变体';
  if (field.startsWith('variants.')) return '变体信息';
  return field || '刊登信息';
}

interface CategoryOption { id: string; name: string; path?: string; }
interface CategoryRequirement {
  id: string;
  name: string;
  groupName: string;
  valueType: string;
  maxLength?: number;
  required: boolean;
  conditionalRequired: boolean;
  allowVariations: boolean;
  values: Array<{ id?: string; name: string }>;
  units: Array<{ id?: string; name: string }>;
}

function normalizeCategories(value: unknown): CategoryOption[] {
  const result: CategoryOption[] = [];
  const seen = new Set<string>();
  function walk(input: unknown, parentPath = '') {
    if (Array.isArray(input)) { input.forEach((item) => walk(item, parentPath)); return; }
    if (!input || typeof input !== 'object') return;
    const item = input as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name : '';
    const path = typeof item.path_from_root === 'string' ? item.path_from_root : parentPath;
    if (id && name && !seen.has(id)) { seen.add(id); result.push({ id, name, path }); }
    const nextPath = name ? (parentPath ? `${parentPath} / ${name}` : name) : parentPath;
    for (const key of ['children', 'categories', 'subcategories']) walk(item[key], nextPath);
  }
  walk(value);
  return result;
}

function normalizeAttributeRequirements(value: unknown): CategoryRequirement[] {
  const source: unknown[] = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).attributes) ? (value as Record<string, unknown>).attributes as unknown[] : [];
  return source.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const tags = item.tags && typeof item.tags === 'object' ? item.tags as Record<string, unknown> : {};
    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name : id;
    if (!id || Boolean(tags.hidden) || Boolean(tags.read_only)) return [];
    const values = Array.isArray(item.values) ? item.values.flatMap((rawValue) => {
      if (!rawValue || typeof rawValue !== 'object') return [];
      const valueItem = rawValue as Record<string, unknown>;
      const valueName = typeof valueItem.name === 'string' ? valueItem.name : '';
      return valueName ? [{ id: typeof valueItem.id === 'string' ? valueItem.id : undefined, name: valueName }] : [];
    }) : [];
    const units = Array.isArray(item.allowed_units) ? item.allowed_units.flatMap((rawUnit) => {
      if (!rawUnit || typeof rawUnit !== 'object') return [];
      const unit = rawUnit as Record<string, unknown>;
      const unitName = typeof unit.name === 'string' ? unit.name : '';
      return unitName ? [{ id: typeof unit.id === 'string' ? unit.id : undefined, name: unitName }] : [];
    }) : [];
    return [{
      id,
      name,
      groupName: typeof item.attribute_group_name === 'string' ? item.attribute_group_name : '基本属性',
      valueType: typeof item.value_type === 'string' ? item.value_type : 'string',
      maxLength: typeof item.value_max_length === 'number' ? item.value_max_length : undefined,
      required: Boolean(tags.required),
      conditionalRequired: Boolean(tags.conditional_required),
      allowVariations: Boolean(tags.allow_variations),
      values,
      units,
    }];
  });
}

function groupRequirements(requirements: CategoryRequirement[]) {
  const groups = new Map<string, CategoryRequirement[]>();
  for (const requirement of requirements) {
    const items = groups.get(requirement.groupName) || [];
    items.push(requirement);
    groups.set(requirement.groupName, items);
  }
  return [...groups.entries()];
}
