import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AiConfigPublic, CategoryRequirements, CollectDefaults, PicuiConfigPublic, PresetsConfig, PresetTemplate, ShopProfilePublic, ShopsConfigPublic } from '@shared/types';
import { api } from '../api';
import { categoryLabelFor, normCategories, type CatOption } from '../categories';
import { CategoryPicker } from '../CategoryPicker';
import { normalizeJoomColorList } from '@shared/listing-language';
import { useNativePrompt } from '../components/NativePromptProvider';

const FACTORY: CollectDefaults = {
  currency: 'USD',
  priceMode: 'multiply',
  priceMultiplier: 1,
  fixedPrice: 9.99,
  inventory: 999,
  targetSizes: ['2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
  categoryId: '1473502943153754907-255-2-118-3004891753',
};

let idSeq = 0;
const newId = () => `tpl_${Date.now()}_${idSeq++}`;

function cloneDefaults(defaults: CollectDefaults): CollectDefaults {
  return structuredClone(defaults);
}

/** 「T恤模板」→「T恤模板 副本」；重名则「副本 2」。从副本再复制不会叠成「副本 副本」。 */
function nextCopyName(sourceName: string, names: string[]): string {
  const trimmed = sourceName.trim() || '模板';
  const stem = trimmed.replace(/\s*副本(?:\s+\d+)?$/, '').trim() || trimmed;
  const used = new Set(names);
  const first = `${stem} 副本`;
  if (!used.has(first)) return first;
  let n = 2;
  while (used.has(`${stem} 副本 ${n}`)) n += 1;
  return `${stem} 副本 ${n}`;
}

const SIZE_SCALE = ['6XS', '5XS', '4XS', '3XS', '2XS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];

function normalizePresetSize(value: string): string {
  const s = value.trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^X{2,6}S$/.test(s)) return `${s.length}XS`;
  if (/^X{2,6}L$/.test(s)) return `${s.length}XL`;
  return s;
}

const SETTINGS_NAV = [
  { id: 'settings-shop', label: '店铺账号', hint: '连接与店铺切换' },
  { id: 'settings-ai', label: 'AI 标题优化', hint: '模型与提示词' },
  { id: 'settings-images', label: '图片图床', hint: 'PICUI 上传配置' },
  { id: 'settings-template', label: '采集模板', hint: '选择与管理模板' },
  { id: 'settings-description', label: '产品描述', hint: '默认描述内容' },
  { id: 'settings-price', label: '价格与币种' },
  { id: 'settings-logistics', label: '库存与物流' },
  { id: 'settings-size', label: '尺码与颜色' },
  { id: 'settings-attributes', label: '类目属性', hint: '默认属性与模板' },
];

function AnchorNav({ items, title = '本页导航' }: { items: typeof SETTINGS_NAV; title?: string }) {
  return (
    <nav className="anchor-nav" aria-label={title}>
      <div className="anchor-nav-title">{title}</div>
      <div className="anchor-nav-list">
        {items.map((item, index) => (
          <a href={`#${item.id}`} key={item.id}>
            <span className="anchor-index">{String(index + 1).padStart(2, '0')}</span>
            <span><strong>{item.label}</strong>{item.hint && <small>{item.hint}</small>}</span>
          </a>
        ))}
      </div>
      <a className="anchor-top" href="#page-top">↑ 回到顶部</a>
    </nav>
  );
}

/** 支持 “2XS-3XL” 范围，也支持 “2XS, XS, S, …” 列表。 */
function parseTargetSizes(input: string): string[] {
  const result: string[] = [];
  for (const part of input.split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const range = part.match(/^(.+?)\s*-\s*(.+)$/);
    if (range) {
      const start = normalizePresetSize(range[1]);
      const end = normalizePresetSize(range[2]);
      const from = SIZE_SCALE.indexOf(start);
      const to = SIZE_SCALE.indexOf(end);
      if (from >= 0 && to >= from) {
        result.push(...SIZE_SCALE.slice(from, to + 1));
        continue;
      }
    }
    result.push(normalizePresetSize(part));
  }
  return Array.from(new Set(result));
}

export function SettingsPage() {
  const nativePrompt = useNativePrompt();
  const navigate = useNavigate();
  const [config, setConfig] = useState<PresetsConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<PresetsConfig | null>(null);
  const [selId, setSelId] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sizeFrom, setSizeFrom] = useState('');
  const [sizeTo, setSizeTo] = useState('');
  const [colorFrom, setColorFrom] = useState('');
  const [colorTo, setColorTo] = useState('');
  const [joomColors, setJoomColors] = useState<string[]>([]);
  const [sizePresetInput, setSizePresetInput] = useState('');
  const [requirements, setRequirements] = useState<CategoryRequirements | null>(null);
  const [attributeTemplateName, setAttributeTemplateName] = useState('');
  const [categories, setCategories] = useState<CatOption[]>([]);
  const [aiConfig, setAiConfig] = useState<AiConfigPublic | null>(null);
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('deepseek-chat');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPreview, setAiPreview] = useState(true);
  const [cottonPrompt, setCottonPrompt] = useState('');
  const [polyPrompt, setPolyPrompt] = useState('');
  const [shops, setShops] = useState<ShopsConfigPublic | null>(null);
  const [selShopId, setSelShopId] = useState('');
  const [shopSecrets, setShopSecrets] = useState<Record<string, string>>({});
  const [shopInherit, setShopInherit] = useState<Record<string, string>>({});
  const [shopBusy, setShopBusy] = useState(false);
  const [picuiConfig, setPicuiConfig] = useState<PicuiConfigPublic | null>(null);
  const [picuiToken, setPicuiToken] = useState('');

  useEffect(() => {
    api.joomCategories().then((d) => setCategories(normCategories(d))).catch(() => {});
    api.joomColors().then((d) => setJoomColors(normalizeJoomColorList(d))).catch(() => {});
  }, []);

  useEffect(() => {
    api
      .getSettings()
      .then((c) => {
        setSavedConfig(c);
        setConfig(c);
        setSelId(c.activeId);
      })
      .catch((e) => setError((e as Error).message));
    api
      .getAiConfig()
      .then((c) => {
        setAiConfig(c);
        setAiModel(c.model);
        setAiPreview(c.preview);
        setCottonPrompt(c.materials.find((m) => m.id === 'cotton')?.prompt ?? '');
        setPolyPrompt(c.materials.find((m) => m.id === 'polyester')?.prompt ?? '');
      })
      .catch(() => {});
    api
      .getShops()
      .then((c) => {
        setShops(c);
        setSelShopId(c.activeId);
      })
      .catch(() => {});
    api
      .getPicuiConfig()
      .then(setPicuiConfig)
      .catch(() => {});
  }, []);

  const selected = useMemo(() => config?.templates.find((t) => t.id === selId) ?? null, [config, selId]);

  const targetSizesText = selected?.defaults.targetSizes?.join(', ') ?? '';
  useEffect(() => setSizePresetInput(targetSizesText), [selId, targetSizesText]);

  // 模板的默认类目变化时,拉取其属性要求以便在预设里设默认值
  const catId = selected?.defaults.categoryId;
  useEffect(() => {
    if (!catId) {
      setRequirements(null);
      return;
    }
    let cancelled = false;
    api
      .joomCategoryRequirements(catId)
      .then((r) => !cancelled && setRequirements(r))
      .catch(() => !cancelled && setRequirements(null));
    return () => {
      cancelled = true;
    };
  }, [catId]);

  if (error && !config) return <div className="error">{error}</div>;
  if (!config || !selected) return <p className="muted">加载中…</p>;

  const form = selected.defaults;
  const num = (s: string): number => (s === '' ? 0 : Number(s));
  const numOpt = (s: string): number | undefined => (s === '' ? undefined : Number(s));

  const updateTemplate = (patch: Partial<PresetTemplate>) =>
    setConfig({ ...config, templates: config.templates.map((t) => (t.id === selId ? { ...t, ...patch } : t)) });
  const patch = (p: Partial<CollectDefaults>) => updateTemplate({ defaults: { ...form, ...p } });

  const addTemplate = () => {
    const t: PresetTemplate = { id: newId(), name: `模板 ${config.templates.length + 1}`, defaults: { ...FACTORY } };
    setConfig({ ...config, templates: [...config.templates, t] });
    setSelId(t.id);
  };
  const duplicateTemplate = () => {
    const t: PresetTemplate = {
      id: newId(),
      name: nextCopyName(selected.name, config.templates.map((x) => x.name)),
      defaults: cloneDefaults(form),
    };
    setConfig({ ...config, templates: [...config.templates, t] });
    setSelId(t.id);
    setError('');
    setMsg(`已复制「${selected.name}」为「${t.name}」。改完记得点右上角「保存预设」；新采集仍用原来的默认模板。`);
  };
  const deleteTemplate = async () => {
    if (config.templates.length <= 1) return setError('至少保留一个模板');
    if (!await nativePrompt.confirm(`删除模板「${selected.name}」?`)) return;
    const templates = config.templates.filter((t) => t.id !== selId);
    const activeId = config.activeId === selId ? templates[0].id : config.activeId;
    setConfig({ ...config, templates, activeId });
    setSelId(templates[0].id);
  };
  const setActive = () => {
    setConfig({ ...config, activeId: selId });
    setMsg(`点击「保存采集预设」后，新采集将默认使用「${selected.name}」。`);
  };

  const addSize = () => {
    const f = sizeFrom.trim();
    const t = sizeTo.trim();
    if (!f || !t) return;
    patch({ sizeMap: { ...(form.sizeMap ?? {}), [f]: t } });
    setSizeFrom('');
    setSizeTo('');
  };
  const removeSize = (k: string) => {
    const next = { ...(form.sizeMap ?? {}) };
    delete next[k];
    patch({ sizeMap: Object.keys(next).length ? next : undefined });
  };
  const addColor = () => {
    const f = colorFrom.trim();
    const t = colorTo.trim();
    if (!f || !t) return;
    patch({ colorMap: { ...(form.colorMap ?? {}), [f]: t } });
    setColorFrom('');
    setColorTo('');
  };
  const removeColor = (k: string) => {
    const next = { ...(form.colorMap ?? {}) };
    delete next[k];
    patch({ colorMap: Object.keys(next).length ? next : undefined });
  };
  const applySizePreset = () => {
    const sizes = parseTargetSizes(sizePresetInput);
    patch({ targetSizes: sizes });
    setSizePresetInput(sizes.join(', '));
  };
  const removeTargetSize = (size: string) => {
    const next = (form.targetSizes ?? []).filter((s) => s !== size);
    patch({ targetSizes: next });
  };

  // ---- 尺码模板库 ----
  const sizeTemplates = config.sizeTemplates ?? [];
  const applySizeTemplate = (id: string) => {
    const t = sizeTemplates.find((x) => x.id === id);
    if (!t) return;
    patch({ targetSizes: [...t.sizes] });
    setSizePresetInput(t.sizes.join(', '));
  };
  const saveSizeTemplate = async () => {
    const sizes = parseTargetSizes(sizePresetInput);
    if (!sizes.length) return setError('先填尺码,再存为模板');
    const name = (await nativePrompt.prompt('尺码模板名称,如「男装 2XS-3XL」'))?.trim();
    if (!name) return;
    setConfig({ ...config, sizeTemplates: [...sizeTemplates, { id: newId(), name, sizes }] });
    setMsg(`已保存尺码模板「${name}」,记得点右上角「保存预设」`);
  };
  const deleteSizeTemplate = (id: string) => {
    setConfig({ ...config, sizeTemplates: sizeTemplates.filter((x) => x.id !== id) });
  };

  // ---- 常用类目收藏 ----
  const catFavorites = config.categoryFavorites ?? [];
  const applyCatFavorite = (id: string) => {
    const f = catFavorites.find((x) => x.id === id);
    if (f) patch({ categoryId: f.categoryId });
  };
  const saveCatFavorite = async () => {
    const cid = (form.categoryId ?? '').trim();
    if (!cid) return setError('先填 categoryId,再收藏');
    const name = (await nativePrompt.prompt('类目收藏名称,如「男装衬衫」'))?.trim();
    if (!name) return;
    setConfig({ ...config, categoryFavorites: [...catFavorites, { id: newId(), name, categoryId: cid }] });
    setMsg(`已收藏类目「${name}」,记得点右上角「保存预设」`);
  };
  const deleteCatFavorite = (id: string) => {
    setConfig({ ...config, categoryFavorites: catFavorites.filter((x) => x.id !== id) });
  };
  const isRequired = (sev: string) => sev.toLowerCase() === 'required';
  const setDefAttr = (attrId: string, val: string) => {
    const next = { ...(form.attributes ?? {}) };
    if (val) next[attrId] = val;
    else delete next[attrId];
    patch({ attributes: Object.keys(next).length ? next : undefined });
  };

  const attributeTemplates = config.categoryAttributeTemplates ?? [];
  const saveAttributeTemplate = () => {
    const name = attributeTemplateName.trim();
    const attrs = Object.fromEntries(Object.entries(form.attributes ?? {}).filter(([, value]) => value.trim()));
    if (!name || !Object.keys(attrs).length) return setError('请填写模板名称和至少一个属性值');
    const next = { ...config, categoryAttributeTemplates: [...attributeTemplates, { id: newId(), name, categoryId: form.categoryId, attributes: attrs }] };
    setConfig(next); setAttributeTemplateName(''); setMsg(`已保存属性模板「${name}」，记得点击右上角保存全部`);
  };
  const deleteAttributeTemplate = (id: string) => setConfig({ ...config, categoryAttributeTemplates: attributeTemplates.filter((t) => t.id !== id) });

  const selectedShop = shops?.profiles.find((s) => s.id === selShopId) ?? shops?.profiles[0] ?? null;
  const pingJoom = () => window.dispatchEvent(new Event('joom-refresh'));
  const patchShop = (patch: Partial<ShopProfilePublic>) => {
    if (!shops || !selectedShop) return;
    setShops({
      ...shops,
      profiles: shops.profiles.map((s) => (s.id === selectedShop.id ? { ...s, ...patch } : s)),
    });
  };
  const addShop = () => {
    if (!shops) return;
    const t: ShopProfilePublic = {
      id: `shop_${Date.now()}_${idSeq++}`,
      name: `店铺 ${shops.profiles.length + 1}`,
      clientId: '',
      hasSecret: false,
      connected: false,
    };
    setShops({ ...shops, profiles: [...shops.profiles, t], activeId: t.id });
    setSelShopId(t.id);
    setMsg('已新建店铺，填好 Client ID / Secret 后点「保存店铺」。保存后顶栏可一键切换。');
  };
  const duplicateShop = () => {
    if (!shops || !selectedShop) return;
    const t: ShopProfilePublic = {
      ...selectedShop,
      id: `shop_${Date.now()}_${idSeq++}`,
      name: nextCopyName(selectedShop.name, shops.profiles.map((x) => x.name)),
      connected: false,
      expiresAt: undefined,
    };
    setShops({ ...shops, profiles: [...shops.profiles, t], activeId: t.id });
    setSelShopId(t.id);
    setShopInherit((prev) => ({ ...prev, [t.id]: selectedShop.id }));
    setMsg(`已复制「${selectedShop.name}」为「${t.name}」。改 storeId 或凭证后点「保存店铺」。`);
  };
  const deleteShop = async () => {
    if (!shops || !selectedShop) return;
    if (shops.profiles.length <= 1) return setError('至少保留一个店铺');
    if (!await nativePrompt.confirm(`删除店铺「${selectedShop.name}」？对应授权也会清掉。`)) return;
    const profiles = shops.profiles.filter((s) => s.id !== selectedShop.id);
    const activeId = shops.activeId === selectedShop.id ? profiles[0].id : shops.activeId;
    setShops({ ...shops, profiles, activeId });
    setSelShopId(profiles[0].id);
  };
  async function switchShop(nextId: string) {
    if (!shops) return;
    setSelShopId(nextId);
    setShops({ ...shops, activeId: nextId });
    try {
      const saved = await api.setActiveShop(nextId);
      setShops(saved);
      pingJoom();
    } catch {
      // 尚未保存到服务器的新店铺，只改本地当前项
    }
  }
  async function saveShops() {
    if (!shops) return;
    setShopBusy(true);
    setError('');
    setMsg('');
    try {
      const saved = await api.saveShops({
        activeId: selShopId || shops.activeId,
        profiles: shops.profiles.map((p) => ({
          id: p.id,
          name: p.name,
          clientId: p.clientId,
          clientSecret: shopSecrets[p.id]?.trim() || undefined,
          storeId: p.storeId,
          inheritSecretFrom: shopSecrets[p.id]?.trim() ? undefined : shopInherit[p.id],
        })),
      });
      setShops(saved);
      setSelShopId(saved.activeId);
      setShopSecrets({});
      setShopInherit({});
      pingJoom();
      const active = saved.profiles.find((p) => p.id === saved.activeId);
      setMsg(
        active?.hasSecret
          ? `店铺已保存。当前是「${active.name}」${active.connected ? '，已授权可直接发布' : '，请到右上角点「连接 Joom」'}`
          : '店铺已保存，但还缺 Secret，填好后再保存一次',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setShopBusy(false);
    }
  }

  async function saveAi() {
    setAiBusy(true);
    setError('');
    setMsg('');
    try {
      const saved = await api.saveAiConfig({
        apiKey: aiKey.trim() || undefined,
        model: aiModel.trim() || 'deepseek-chat',
        preview: aiPreview,
        prompts: { cotton: cottonPrompt, polyester: polyPrompt },
      });
      setAiConfig(saved);
      setAiKey('');
      setAiModel(saved.model);
      setAiPreview(saved.preview);
      setCottonPrompt(saved.materials.find((m) => m.id === 'cotton')?.prompt ?? '');
      setPolyPrompt(saved.materials.find((m) => m.id === 'polyester')?.prompt ?? '');
      setMsg(saved.configured ? `DeepSeek 已保存（${saved.apiKeyHint}）` : '已保存提示词。仍缺少 API Key 时无法生成标题');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }

  async function save() {
    if (!config || !savedConfig) return;
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const saved = await api.saveSettings(config, savedConfig);
      setSavedConfig(saved);
      setConfig(saved);
      setSelId(id => saved.templates.some(t => t.id === id) ? id : saved.activeId);
      setMsg(`采集预设已保存。默认模板为「${saved.templates.find((t) => t.id === saved.activeId)?.name}」。`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function savePicui() {
    if (!picuiToken.trim()) return setError('请填写 PICUI Token');
    setBusy(true);
    setError('');
    setMsg('');
    try {
      const saved = await api.savePicuiConfig(picuiToken);
      setPicuiConfig(saved);
      setPicuiToken('');
      setMsg(`PICUI Token 已保存（${saved.tokenHint ?? '已配置'}）`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="ed-bar" id="page-top">
        <button className="ghost" onClick={() => navigate('/')}>
          ← 返回
        </button>
        <strong>设置</strong>
        <div style={{ flex: 1 }} />
        <button onClick={save} disabled={busy}>
          保存采集预设
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {msg && <div className="ok">{msg}</div>}

      <div className="settings-layout">
        <main>

      {shops && selectedShop && (
        <section className="section" id="settings-shop">
          <div className="section-head">
            <h3 style={{ margin: 0 }}>
              店铺账号 <span className="hint">换店只改这里，采集模板不管凭证</span>
            </h3>
            <span className={`badge ${selectedShop.connected ? 'published' : selectedShop.hasSecret || shopInherit[selectedShop.id] ? 'edited' : 'collected'}`}>
              {shops.activeId === selectedShop.id ? '当前店铺 · ' : ''}
              {selectedShop.connected ? '已授权' : selectedShop.hasSecret || shopInherit[selectedShop.id] ? '已填凭证，未授权' : '缺凭证'}
            </span>
          </div>
          <div className="tpl-bar">
            <label>店铺</label>
            <select value={selShopId} onChange={(e) => void switchShop(e.target.value)}>
              {shops.profiles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.id === shops.activeId ? '(当前)' : ''}
                </option>
              ))}
            </select>
            <input
              style={{ width: 180 }}
              value={selectedShop.name}
              onChange={(e) => patchShop({ name: e.target.value })}
              placeholder="店铺名，如 Nineteen Wear"
            />
            <button className="ghost" type="button" onClick={addShop}>
              + 新建
            </button>
            <button className="ghost" type="button" onClick={duplicateShop} title="复制凭证和 storeId，方便开第二家店">
              复制店铺
            </button>
            <button className="ghost" type="button" onClick={deleteShop}>
              删除
            </button>
          </div>
          <div className="row2">
            <div className="field">
              <label>Client ID</label>
              <input
                value={selectedShop.clientId}
                autoComplete="off"
                placeholder="Joom 应用 Client ID"
                onChange={(e) => patchShop({ clientId: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Client Secret</label>
              <input
                type="password"
                autoComplete="off"
                value={shopSecrets[selectedShop.id] ?? ''}
                placeholder={
                  selectedShop.hasSecret || shopInherit[selectedShop.id]
                    ? `已保存${selectedShop.clientSecretHint ? `（${selectedShop.clientSecretHint}）` : ''}，留空则不改`
                    : 'Joom 应用 Secret'
                }
                onChange={(e) => setShopSecrets((prev) => ({ ...prev, [selectedShop.id]: e.target.value }))}
              />
            </div>
          </div>
          <div className="field">
            <label>
              店铺 ID storeId <span className="hint">商户身份授权必填；店铺级授权可留空</span>
            </label>
            <input
              value={selectedShop.storeId ?? ''}
              placeholder="例如 123456789"
              onChange={(e) => patchShop({ storeId: e.target.value || undefined })}
            />
          </div>
          <div className="inline-add" style={{ marginTop: 0 }}>
            <button className="ghost preset-action" onClick={() => void saveShops()} disabled={shopBusy}>
              {shopBusy ? '保存中…' : '保存店铺'}
            </button>
            <span className="hint">
              保存后到右上角切这家店并点「连接 Joom」。各店授权分开记，切回去不用重新登。原先写在 server/.env 的凭证会自动当成「默认店铺」。
            </span>
          </div>
        </section>
      )}

      <section className="section" id="settings-ai">
        <div className="section-head">
          <h3 style={{ margin: 0 }}>
            AI 标题优化 <span className="hint">DeepSeek · 列表页「批量 AI 改标题」用它</span>
          </h3>
          <span className={`badge ${aiConfig?.configured ? 'published' : 'collected'}`}>
            {aiConfig?.configured ? `已配置 ${aiConfig.apiKeyHint}` : '未配置'}
          </span>
        </div>
        <div className="row2">
          <div className="field">
            <label>DeepSeek API Key</label>
            <input
              type="password"
              autoComplete="off"
              value={aiKey}
              placeholder={aiConfig?.configured ? '已保存，留空则不改' : 'sk-...'}
              onChange={(e) => setAiKey(e.target.value)}
            />
          </div>
          <div className="field">
            <label>模型</label>
            <input value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="deepseek-chat" />
          </div>
        </div>
        <label className="ck" style={{ margin: '4px 0 14px' }}>
          <input type="checkbox" checked={aiPreview} onChange={(e) => setAiPreview(e.target.checked)} />
          默认先预览再写入（列表页也可随时关）
        </label>
        <div className="row2">
          <div className="field">
            <label>棉 · 提示词</label>
            <textarea className="desc-area" style={{ minHeight: 160 }} value={cottonPrompt} onChange={(e) => setCottonPrompt(e.target.value)} />
            <button
              className="ghost"
              type="button"
              style={{ marginTop: 8 }}
              onClick={() => setCottonPrompt(aiConfig?.materials.find((m) => m.id === 'cotton')?.factoryPrompt ?? '')}
            >
              恢复默认提示词
            </button>
          </div>
          <div className="field">
            <label>聚酯纤维 · 提示词</label>
            <textarea className="desc-area" style={{ minHeight: 160 }} value={polyPrompt} onChange={(e) => setPolyPrompt(e.target.value)} />
            <button
              className="ghost"
              type="button"
              style={{ marginTop: 8 }}
              onClick={() => setPolyPrompt(aiConfig?.materials.find((m) => m.id === 'polyester')?.factoryPrompt ?? '')}
            >
              恢复默认提示词
            </button>
          </div>
        </div>
        <div className="inline-add" style={{ marginTop: 0 }}>
          <button className="ghost preset-action" onClick={saveAi} disabled={aiBusy}>
            {aiBusy ? '保存中…' : '保存 AI 配置'}
          </button>
          <span className="hint">列表只需选面料。想改话术在这里改，Key 也可写在 server/.env 的 DEEPSEEK_API_KEY。</span>
        </div>
      </section>

      <section className="section" id="settings-images">
        <div className="section-head">
          <h3 style={{ margin: 0 }}>
            图片图床（PICUI） <span className="hint">采集预设共用 · 本地图片上传后用于 Joom 变体</span>
          </h3>
          <span className={`badge ${picuiConfig?.configured ? 'published' : 'collected'}`}>
            {picuiConfig?.configured ? `已配置 ${picuiConfig.tokenHint ?? ''}` : '未配置（可游客上传）'}
          </span>
        </div>
        <div className="field">
          <label>
            PICUI Token <span className="hint">从 PICUI 个人中心获取；只保存在本地服务端，不回显完整内容</span>
          </label>
          <input
            type="password"
            autoComplete="off"
            value={picuiToken}
            placeholder={picuiConfig?.configured ? '已保存，填新 Token 可替换' : '粘贴 PICUI Token'}
            onChange={(e) => setPicuiToken(e.target.value)}
          />
        </div>
        <div className="inline-add" style={{ marginTop: 0 }}>
          <button className="ghost preset-action" onClick={() => void savePicui()} disabled={busy || !picuiToken.trim()}>
            {busy ? '保存中…' : '保存 PICUI Token'}
          </button>
          <span className="hint">不填 Token 时仍可使用 PICUI 游客上传；建议配置个人 Token，便于管理图片和降低游客限流影响。</span>
        </div>
      </section>

      <section className="section" id="settings-template">
        <div className="tpl-bar">
          <label htmlFor="editing-template">正在编辑的模板</label>
          <select
            id="editing-template"
            value={selId}
            onChange={(e) => setSelId(e.target.value)}
          >
            {config.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.id === config.activeId ? '(默认)' : ''}
              </option>
            ))}
          </select>
          <input
            style={{ width: 180 }}
            value={selected.name}
            onChange={(e) => updateTemplate({ name: e.target.value })}
            placeholder="模板名"
          />
          <button className="ghost" onClick={addTemplate}>
            + 新建
          </button>
          <button
            className="ghost"
            onClick={duplicateTemplate}
            title="复制当前模板的价格、尺码、类目、描述等全部预设，生成一份可改的新模板"
          >
            复制模板
          </button>
          <button className="ghost" onClick={deleteTemplate}>
            删除
          </button>
          {config.activeId === selId ? (
            <span className="badge published" style={{ alignSelf: 'center' }}>
              当前默认（新采集用它）
            </span>
          ) : (
            <button className="ghost" onClick={setActive}>
              设为采集默认
            </button>
          )}
        </div>
      </section>

      <section className="section" id="settings-description">
        <h3>
          产品描述 <span className="hint">设了则覆盖采集描述(纯文本)· 整行更宽</span>
        </h3>
        <textarea
          className="desc-area"
          rows={16}
          value={form.description ?? ''}
          placeholder="留空则用采集到的描述"
          onChange={(e) => patch({ description: e.target.value || undefined })}
        />
      </section>

      <div className="ed-layout">
        <div>
          <section className="section" id="settings-price">
            <h3>价格与币种</h3>
            <div className="row2">
              <div className="field">
                <label>
                  币种 currency <span className="hint">须等于 Joom 账户币种</span>
                </label>
                <input value={form.currency} onChange={(e) => patch({ currency: e.target.value.toUpperCase() })} />
              </div>
              <div className="field">
                <label>价格规则</label>
                <select
                  value={form.priceMode}
                  onChange={(e) => patch({ priceMode: e.target.value as CollectDefaults['priceMode'] })}
                >
                  <option value="multiply">采集价 × 倍率</option>
                  <option value="fixed">统一固定价</option>
                </select>
              </div>
            </div>
            {form.priceMode === 'multiply' ? (
              <div className="field">
                <label>
                  倍率 <span className="hint">含汇率 + 利润。如 MXN→USD 约 0.05,加价 1.5 倍 ⇒ 0.075</span>
                </label>
                <input type="number" value={form.priceMultiplier} onChange={(e) => patch({ priceMultiplier: num(e.target.value) })} />
              </div>
            ) : (
              <div className="field">
                <label>固定价格</label>
                <input type="number" value={form.fixedPrice} onChange={(e) => patch({ fixedPrice: num(e.target.value) })} />
              </div>
            )}
            <div className="field">
              <label>建议零售价 msrPrice（可选）</label>
              <input
                type="number"
                value={form.msrPrice ?? ''}
                onChange={(e) =>
                  patch({
                    msrPrice: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
              />
            </div>
          </section>


          <section className="section" id="settings-logistics">
            <h3>库存与物流</h3>
            <div className="row2">
              <div className="field">
                <label>默认库存</label>
                <input type="number" value={form.inventory} onChange={(e) => patch({ inventory: num(e.target.value) })} />
              </div>
              <div className="field">
                <label>履约天数(1~7,可选)</label>
                <input
                  type="number"
                  value={form.committedFulfillmentDays ?? ''}
                  onChange={(e) => patch({ committedFulfillmentDays: numOpt(e.target.value) })}
                />
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>默认运费(可选)</label>
                <input type="number" value={form.shippingPrice ?? ''} onChange={(e) => patch({ shippingPrice: numOpt(e.target.value) })} />
              </div>
              <div className="field">
                <label>默认毛重 kg(可选)</label>
                <input type="number" value={form.shippingWeight ?? ''} onChange={(e) => patch({ shippingWeight: numOpt(e.target.value) })} />
              </div>
            </div>
            <div className="row3">
              <div className="field">
                <label>默认长 cm</label>
                <input type="number" value={form.shippingLength ?? ''} onChange={(e) => patch({ shippingLength: numOpt(e.target.value) })} />
              </div>
              <div className="field">
                <label>默认宽 cm</label>
                <input type="number" value={form.shippingWidth ?? ''} onChange={(e) => patch({ shippingWidth: numOpt(e.target.value) })} />
              </div>
              <div className="field">
                <label>默认高 cm</label>
                <input type="number" value={form.shippingHeight ?? ''} onChange={(e) => patch({ shippingHeight: numOpt(e.target.value) })} />
              </div>
            </div>
          </section>

          <section className="section" id="settings-size">
            <h3>
              目标尺码模板 <span className="hint">按每个款式（颜色 + 款式图 + 其他规格）生成完整尺码</span>
            </h3>
            <div className="inline-add" style={{ gap: 8, marginBottom: 10 }}>
              <select
                value=""
                onChange={(e) => e.target.value && applySizeTemplate(e.target.value)}
                style={{ flex: 1 }}
              >
                <option value="">从尺码模板库选择…</option>
                {sizeTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.sizes.length} 码）
                  </option>
                ))}
              </select>
              <button className="ghost" onClick={saveSizeTemplate}>
                ＋存为尺码模板
              </button>
            </div>
            {sizeTemplates.length > 0 && (
              <div className="chips" style={{ marginBottom: 10 }}>
                {sizeTemplates.map((t) => (
                  <span className="chip" key={t.id} title={t.sizes.join(', ')}>
                    {t.name}
                    <button onClick={() => deleteSizeTemplate(t.id)}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="chips">
              {(form.targetSizes ?? []).map((size) => (
                <span className="chip" key={size}>
                  {size}
                  <button onClick={() => removeTargetSize(size)}>×</button>
                </span>
              ))}
              {!form.targetSizes?.length && <span className="muted">未启用，保留采集到的全部尺码</span>}
            </div>
            <div className="inline-add" style={{ gap: 8 }}>
              <input
                placeholder="如 2XS-3XL，或 2XS, XS, S, M, L, XL, 2XL, 3XL"
                value={sizePresetInput}
                onChange={(e) => setSizePresetInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applySizePreset()}
              />
              <button className="ghost" onClick={applySizePreset}>
                应用尺码模板
              </button>
            </div>
            <p className="hint" style={{ marginBottom: 20 }}>
              示例：输入 2XS-3XL，会生成 2XS、XS、S、M、L、XL、2XL、3XL。清空后应用即可关闭。
            </p>

            <h3>
              尺码映射 <span className="hint">采集到的尺码 → Joom 尺码</span>
            </h3>
            <div className="chips">
              {Object.entries(form.sizeMap ?? {}).map(([k, v]) => (
                <span className="chip" key={k}>
                  {k} → {v}
                  <button onClick={() => removeSize(k)}>×</button>
                </span>
              ))}
              {!form.sizeMap && <span className="muted">暂无映射</span>}
            </div>
            <div className="inline-add" style={{ gap: 8 }}>
              <input placeholder="采集尺码,如 均码" value={sizeFrom} onChange={(e) => setSizeFrom(e.target.value)} />
              <input placeholder="Joom 尺码,如 One Size" value={sizeTo} onChange={(e) => setSizeTo(e.target.value)} />
              <button className="ghost" onClick={addSize}>
                添加
              </button>
            </div>

            <h3>
              颜色映射 <span className="hint">采集到的颜色 → Joom 英文色名</span>
            </h3>
            <p className="hint">
              系统已内置常见俄语/中文色名（如 черный → Black）。这里只需补充没覆盖到的。
            </p>
            <div className="chips">
              {Object.entries(form.colorMap ?? {}).map(([k, v]) => (
                <span className="chip" key={k}>
                  {k} → {v}
                  <button onClick={() => removeColor(k)}>×</button>
                </span>
              ))}
              {!form.colorMap && <span className="muted">暂无自定义映射</span>}
            </div>
            <div className="inline-add" style={{ gap: 8 }}>
              <input placeholder="采集颜色,如 черный" value={colorFrom} onChange={(e) => setColorFrom(e.target.value)} />
              <input
                list="settings-joom-colors"
                placeholder="Joom 颜色,如 Black"
                value={colorTo}
                onChange={(e) => setColorTo(e.target.value)}
              />
              <button className="ghost" onClick={addColor}>
                添加
              </button>
            </div>
            <datalist id="settings-joom-colors">
              {joomColors.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </section>

          {requirements && requirements.attributes.length > 0 && (
            <section className="section" id="settings-attributes">
              <div className="section-head">
                <h3 style={{ margin: 0 }}>
                  类目属性默认{' '}
                  <span className="hint">来自默认类目 · 采集后自动填入(编辑页可改)· 共 {requirements.attributes.length} 项</span>
                </h3>
              </div>
              <div className="attrs">
                {requirements.attributes.map((a) => {
                  const listId = `sattr-${a.attributeId}`;
                  return (
                    <div className="field" key={a.attributeId}>
                      <label>
                        {a.attributeName}
                        {isRequired(a.severity) ? <span className="req"> *</span> : <span className="hint"> {a.severity}</span>}
                      </label>
                      <input
                        list={a.allowedValues?.length ? listId : undefined}
                        value={form.attributes?.[a.attributeId] ?? ''}
                        placeholder={a.goodDescriptionSamples?.[0] ?? '填写默认值'}
                        onChange={(e) => setDefAttr(a.attributeId, e.target.value)}
                      />
                      {a.allowedValues?.length ? (
                        <datalist id={listId}>
                          {a.allowedValues.map((v) => (
                            <option key={v} value={v} />
                          ))}
                        </datalist>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          <section className="section" id="settings-attribute-templates">
            <div className="section-head"><h3 style={{ margin: 0 }}>类目属性模板</h3><span className="hint">把常用材质、性别、季节等组合保存下来，编辑页一键套用</span></div>
            <div className="inline-add"><input placeholder="模板名称，如：男士纯棉 T 恤" value={attributeTemplateName} onChange={(e) => setAttributeTemplateName(e.target.value)} /><button className="ghost" onClick={saveAttributeTemplate}>保存当前属性</button></div>
            <div className="chips" style={{ marginTop: 12 }}>{attributeTemplates.length ? attributeTemplates.map((t) => <span className="chip" key={t.id} title={Object.entries(t.attributes).map(([k, v]) => `${k}: ${v}`).join('；')}>{t.name}<button onClick={() => deleteAttributeTemplate(t.id)}>×</button></span>) : <span className="muted">还没有属性模板</span>}</div>
          </section>
        </div>

        <aside className="side">
          <section className="section" id="settings-category">
            <h3>默认归属</h3>
            <div className="field">
              <label>
                默认店铺 storeId <span className="hint">留空则跟当前店铺档案</span>
              </label>
              <input value={form.storeId ?? ''} onChange={(e) => patch({ storeId: e.target.value || undefined })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>
                默认类目 <span className="hint">连接 Joom 后可搜索中文路径,或手填 categoryId</span>
              </label>
              <div className="inline-add" style={{ gap: 8, marginBottom: 8 }}>
                <select
                  value=""
                  onChange={(e) => e.target.value && applyCatFavorite(e.target.value)}
                  style={{ flex: 1 }}
                >
                  <option value="">从常用类目选择…</option>
                  {catFavorites.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <button className="ghost" onClick={saveCatFavorite}>
                  ＋收藏当前
                </button>
              </div>
              <CategoryPicker
                categories={categories}
                value={form.categoryId}
                onChange={(categoryId) => patch({ categoryId })}
              />
              {catFavorites.length > 0 && (
                <div className="chips" style={{ marginTop: 8 }}>
                  {catFavorites.map((f) => (
                    <span className="chip" key={f.id} title={`${categoryLabelFor(categories, f.categoryId)} · ${f.categoryId}`}>
                      {f.name}
                      <button onClick={() => deleteCatFavorite(f.id)}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>
          <section className="section">
            <h3>说明</h3>
            <p className="hint">
              不同产品类型建一个模板(如「T恤」「裤子」)。采集用<b>默认模板</b>,进编辑页可随时切换模板重新生成草稿。换店请到上方「店铺账号」，不要把 Client ID 写进尺码模板。币种强制统一,避免
              currency 报错。
            </p>
          </section>
        </aside>
      </div>
        </main>
        <AnchorNav items={SETTINGS_NAV} title="采集预设导航" />
      </div>
    </>
  );
}
