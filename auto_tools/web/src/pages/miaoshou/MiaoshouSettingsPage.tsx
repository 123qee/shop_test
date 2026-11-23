import { useState } from 'react';
import { Link } from 'react-router-dom';
import { emptyMiaoshouFields, MIAOSHOU_SITES, MIAOSHOU_SITE_NAMES, type MiaoshouShop, type MiaoshouTemplate } from '@shared/miaoshou';
import { PRODUCT_GROUPS, PRODUCT_MATERIALS } from '@shared/product-grouping';
import { useNativePrompt } from '../../components/NativePromptProvider';
import { miaoshouApi } from './api';
import { useMiaoshouWorkspace } from './use-workspace';
import { MiaoshouFieldsForm } from './MiaoshouFieldsForm';
import { useUnsavedChanges } from './use-unsaved-changes';
import './miaoshou.css';

export function MiaoshouSettingsPage() {
  const { workspace, refresh, error, setError } = useMiaoshouWorkspace();
  const [appKey, setAppKey] = useState(''), [secret, setSecret] = useState('');
  const [shops, setShops] = useState<MiaoshouShop[]>([]);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<MiaoshouTemplate | null>(null);
  const [templateDirty, setTemplateDirty] = useState(false);
  const [fieldsValid, setFieldsValid] = useState(true);
  const [editorRevision, setEditorRevision] = useState(0);
  useUnsavedChanges(templateDirty || !fieldsValid || Boolean(appKey || secret));
  const { confirm } = useNativePrompt();
  async function run(task: () => Promise<unknown>, message: string) { setBusy(true); setNotice(''); try { await task(); await refresh(); setNotice(message); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function openTemplate(t?: MiaoshouTemplate) {
    if ((templateDirty || !fieldsValid) && !await confirm('当前模板有未保存的修改，确定切换？')) return;
    setEditing(t ? structuredClone(t) : { ...emptyMiaoshouFields(), shopId: workspace?.config.defaultShopId ?? '', sites: workspace?.config.defaultSites ?? [...MIAOSHOU_SITES], id: crypto.randomUUID(), name: '', groupId: '', material: '' });
    setTemplateDirty(false);
    setEditorRevision(n => n + 1);
  }
  return <div className="ms-page">
    <div className="ms-top"><div><strong>模板与妙手连接</strong><p>传统店铺模式 · 净收益定价 · 美客多专用模板</p></div><Link className="ghost" to="/miaoshou/sort">进入分拣</Link></div>
    {error && <div className="error" role="alert">{error}</div>}
    <section className="ms-panel"><div className="ms-section-head"><h3>妙手应用</h3><span className={workspace?.config.configured ? 'ms-good' : 'ms-muted'}>{workspace?.config.configured ? `已配置 ${workspace.config.appKey}` : '尚未配置'}</span></div>
      <p className="ms-note">应用信息由服务端保存。密钥留空表示保留已有值。</p><div className="ms-fields"><label>App ID<input value={appKey} onChange={e => setAppKey(e.target.value)} placeholder={workspace?.config.appKey || '填写妙手 App ID'} autoComplete="off" /></label><label>App Secret<input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={workspace?.config.secretConfigured ? '已配置，留空保持' : '填写妙手 App Secret'} autoComplete="new-password" /></label></div>
      <div className="ms-inline"><button disabled={busy} onClick={() => void run(async () => { await miaoshouApi.config({ appKey, appSecret: secret, defaultShopId: workspace?.config.defaultShopId ?? '', defaultSites: workspace?.config.defaultSites ?? [...MIAOSHOU_SITES] }); setSecret(''); setAppKey(''); }, '应用配置已保存。')}>保存应用配置</button><button className="ghost" disabled={busy || !workspace?.config.configured} onClick={() => void run(async () => setShops((await miaoshouApi.shops(true)).shops), '已连接妙手，传统店铺列表已更新。')}>{busy ? '处理中…' : '测试连接并读取传统店铺'}</button></div>
      {workspace && <><div className="ms-fields"><label>默认传统店铺<select disabled={busy} value={workspace.config.defaultShopId} onChange={e => void run(() => miaoshouApi.config({ defaultShopId: e.target.value, defaultSites: workspace.config.defaultSites }), '默认店铺已保存。')}><option value="">每次选择</option>{workspace.config.defaultShopId && !shops.some(s => s.shopId === workspace.config.defaultShopId) && <option value={workspace.config.defaultShopId}>店铺 {workspace.config.defaultShopId}</option>}{shops.map(s => <option key={s.shopId} value={s.shopId}>{s.name}</option>)}</select></label></div><div className="ms-site-checks">{MIAOSHOU_SITES.map(site => <label key={site}><input type="checkbox" disabled={busy} checked={workspace.config.defaultSites.includes(site)} onChange={e => { const next = MIAOSHOU_SITES.filter(s => s === site ? e.target.checked : workspace.config.defaultSites.includes(s)); if (!next.length) { setError('至少保留一个默认站点'); return; } void run(() => miaoshouApi.config({ defaultShopId: workspace.config.defaultShopId, defaultSites: next }), '默认站点已保存。'); }} />{MIAOSHOU_SITE_NAMES[site]}</label>)}</div></>}
    </section>
    <div className="ms-template-layout"><section className="ms-panel"><div className="ms-section-head"><h3>独立商品模板</h3><button className="ghost" disabled={busy} onClick={() => void openTemplate()}>新建模板</button></div><p className="ms-note">参考妙手的类目属性、描述和保修信息结构。模板可以先留空，使用时再补齐。</p>
      {!workspace?.templates.length && <div className="ms-empty-small">暂无模板，分拣仍可使用“暂不套用模板”。</div>}
      <div className="ms-template-list">{workspace?.templates.map(t => <div key={t.id} className="ms-template-item"><button className={`ms-template${editing?.id === t.id ? ' selected' : ''}`} onClick={() => void openTemplate(t)}><strong>{t.name}</strong><small>净收益 {t.netProceeds == null ? '待填' : `${t.netProceeds} USD`} · {t.sites.join(' / ')}</small></button><button className="ghost" disabled={busy} aria-label={`删除模板 ${t.name}`} onClick={async () => { if (await confirm(`删除本机独立模板“${t.name}”？已套用的草稿保留当前内容。`)) void run(async () => { await miaoshouApi.deleteTemplate(t.id); if (editing?.id === t.id) { setEditing(null); setTemplateDirty(false); } }, '模板已删除。'); }}>删除</button></div>)}</div>
      <a href="https://erp.91miaoshou.com/mercadolibre/move_collect/template_management/product" target="_blank" rel="noreferrer">参考妙手现有产品模板 ↗</a>
    </section>
    {editing && <section className="ms-panel"><h3>{workspace?.templates.some(t => t.id === editing.id) ? '编辑模板' : '新建模板'}{templateDirty ? ' · 未保存' : ''}</h3><fieldset className="ms-fieldset" disabled={busy}><label>模板名称<input value={editing.name} onChange={e => { setEditing({ ...editing, name: e.target.value }); setTemplateDirty(true); }} placeholder="例如：童装棉质短袖" /></label><div className="ms-fields"><label>适用分组<select value={editing.groupId} onChange={e => { setEditing({ ...editing, groupId: e.target.value as MiaoshouTemplate['groupId'] }); setTemplateDirty(true); }}><option value="">不限制</option>{PRODUCT_GROUPS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label><label>适用材质<select value={editing.material} onChange={e => { setEditing({ ...editing, material: e.target.value as MiaoshouTemplate['material'] }); setTemplateDirty(true); }}><option value="">不限制</option>{PRODUCT_MATERIALS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label></div></fieldset>
      <MiaoshouFieldsForm key={`${editing.id}:${editorRevision}`} value={editing} disabled={busy} onValidityChange={setFieldsValid} onChange={patch => { setEditing({ ...editing, ...patch }); setTemplateDirty(true); }} />
      <div className="ms-actions"><button disabled={busy || !editing.name.trim() || !fieldsValid} onClick={() => void run(async () => { await miaoshouApi.saveTemplate(editing); setTemplateDirty(false); }, '模板已保存，已分拣的草稿保持当前内容。')}>保存模板</button><button className="ghost" disabled={busy} onClick={async () => { if (!(templateDirty || !fieldsValid) || await confirm('放弃未保存的模板修改？')) { setEditing(null); setTemplateDirty(false); setFieldsValid(true); } }}>关闭编辑</button></div></section>}
    </div>
    <div className="ms-notice" role="status" aria-live="polite">{notice}</div>
  </div>;
}
