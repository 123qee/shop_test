import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { miaoshouDraftIssues, MIAOSHOU_STATUS_NAMES, type MiaoshouDraft } from '@shared/miaoshou';
import { miaoshouApi } from './api';
import { MiaoshouFieldsForm, NumberField } from './MiaoshouFieldsForm';
import { useUnsavedChanges } from './use-unsaved-changes';
import { useNativePrompt } from '../../components/NativePromptProvider';
import './miaoshou.css';

export function MiaoshouDraftPage() {
  const { id = '' } = useParams();
  const [draft, setDraft] = useState<MiaoshouDraft | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [issues, setIssues] = useState<string[] | null>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [failedImage, setFailedImage] = useState('');
  const [fieldsValid, setFieldsValid] = useState(true);
  const { prompt } = useNativePrompt();
  useEffect(() => { let cancelled = false; setDraft(null); miaoshouApi.get(id).then(d => { if (!cancelled) { setDraft(d); setSaved(JSON.stringify(d)); setError(''); } }).catch(e => { if (!cancelled) setError(e.message); }); return () => { cancelled = true; }; }, [id]);
  const dirty = Boolean(draft && JSON.stringify(draft) !== saved) || !fieldsValid;
  useUnsavedChanges(dirty);
  const optionNames = useMemo(() => [...new Set(draft?.variants.flatMap(v => Object.keys(v.options)) ?? [])], [draft?.variants]);
  const readonly = draft && !['pending', 'ready', 'skipped', 'failed'].includes(draft.status);
  function patch(value: Partial<MiaoshouDraft>) { setDraft(d => d ? { ...d, ...value } : null); setIssues(null); setNotice(''); }
  async function save() {
    if (!draft || !fieldsValid) return null;
    const { id: _id, productId: _pid, templateId: _tid, source: _source, sourceUrl: _url, sourceProductId: _sourceid, status: _status, version: _version, remoteId: _remote, lastError: _error, createdAt: _created, updatedAt: _updated, ...fields } = draft;
    const next = await miaoshouApi.update(draft, fields); setDraft(next); setSaved(JSON.stringify(next)); return next;
  }
  async function run(validate: boolean) { setBusy(true); setError(''); setNotice(''); try { const next = await save(); if (!next) return; if (validate) { const result = await miaoshouApi.validate(next.id); setIssues(result.issues); setNotice(result.issues.length ? '已保存，请补齐下面列出的内容。' : '已保存，妙手类目属性和站点检查通过，可以到提交清单提交。'); } else setNotice('美客多草稿已保存。'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const localIssues = draft ? miaoshouDraftIssues(draft) : [];
  return <div className="ms-page">
    <div className="ms-top"><div><strong>编辑美客多草稿</strong><p>{draft && MIAOSHOU_STATUS_NAMES[draft.status]}{dirty ? ' · 有未保存的修改' : ''}</p></div><div className="ms-inline"><Link className="ghost" to="/miaoshou/sort">返回分拣</Link><Link className="ghost" to="/miaoshou/queue">提交清单</Link></div></div>
    {error && <div className="error" role="alert">{error}</div>}
    {!draft && !error && <div className="empty-state">正在加载草稿…</div>}
    {draft && <><div className="ms-editor-layout"><aside className="ms-editor-gallery"><div className="ms-hero">{draft.images[imageIndex] && failedImage !== draft.images[imageIndex] ? <img key={draft.images[imageIndex]} src={draft.images[imageIndex]} alt={draft.title} onError={() => setFailedImage(draft.images[imageIndex])} /> : <span>{draft.images[imageIndex] ? '图片加载失败，可切换图片或查看来源' : '暂无图片'}</span>}</div><div className="ms-thumbnails">{draft.images.map((image, i) => <button key={`${image}-${i}`} aria-label={`预览第 ${i + 1} 张图片`} aria-pressed={imageIndex === i} onClick={() => setImageIndex(i)}><img src={image} alt="" loading="lazy" /></button>)}</div><p className="ms-note">{draft.source} · {draft.sourceProductId}<br />{draft.images.length} 张图片 · {draft.variants.length} 个 SKU</p><a href={draft.sourceUrl} target="_blank" rel="noreferrer">查看来源商品 ↗</a></aside>
      <div className="ms-editor-fields">{readonly && <p className="ms-callout">{MIAOSHOU_STATUS_NAMES[draft.status]}。当前草稿保留提交时的内容，可在提交清单查看结果。</p>}<fieldset disabled={busy || Boolean(readonly)} className="ms-fieldset"><label>基础标题（英文，最多 60 字符）<input maxLength={60} value={draft.title} onChange={e => patch({ title: e.target.value })} /></label></fieldset>
      <MiaoshouFieldsForm key={draft.id} value={draft} disabled={busy || Boolean(readonly)} onChange={patch} optionNames={optionNames} onValidityChange={setFieldsValid} />
      <fieldset disabled={busy || Boolean(readonly)} className="ms-fieldset"><section className="ms-form-section"><h3>商品图片</h3><p className="ms-note">调整图片顺序、保留内容和主图。每个 SKU 最多提交 10 张，优先使用对应规格图，再按这里的顺序补齐。</p>{draft.images.map((url, i) => <div key={`${url}-${i}`} className="ms-image-row"><img src={url} alt={`商品图片 ${i + 1}`} loading="lazy" /><span>{i === 0 ? '主图' : `图片 ${i + 1}`}</span><button type="button" className="ghost" disabled={i === 0} onClick={() => { const images = [...draft.images]; [images[i-1], images[i]] = [images[i], images[i-1]]; patch({ images }); setImageIndex(i - 1); }}>前移</button><button type="button" className="ghost" onClick={() => { patch({ images: draft.images.filter((_, n) => n !== i) }); setImageIndex(0); }}>移除</button></div>)}</section>
      <section className="ms-form-section"><h3>SKU（{draft.variants.length} 个）</h3><p className="ms-note">逐行核对规格、平台 SKU 和库存；按需补充妙手尺码表行 ID。</p><button type="button" className="ghost" onClick={async () => { const name = (await prompt('填写需要补充的规格名称，例如 Color 或 Size。将为当前各 SKU 添加空值，供逐行填写。'))?.trim(); if (!name) return; if (name.length > 60 || optionNames.includes(name)) { setError('规格名称过长或已经存在'); return; } patch({ variants: draft.variants.map(v => ({ ...v, options: { ...v.options, [name]: '' } })) }); }}>添加规格项</button><div className="ms-sku-list">{draft.variants.map((v, i) => <div key={i} className="ms-sku"><strong>{Object.entries(v.options).map(([k, val]) => `${k}: ${val}`).join(' / ') || '单规格'}</strong><div className="ms-fields">{Object.entries(v.options).map(([name, value]) => <label key={name}>{name}<input value={value} onChange={e => patch({ variants: draft.variants.map((old, n) => n === i ? { ...old, options: { ...old.options, [name]: e.target.value } } : old) })} /></label>)}<label>SKU<input value={v.sku} onChange={e => patch({ variants: draft.variants.map((old, n) => n === i ? { ...old, sku: e.target.value } : old) })} /></label><NumberField label="库存（默认库存优先）" integer value={v.stock} onChange={stock => patch({ variants: draft.variants.map((old, n) => n === i ? { ...old, stock } : old) })} /><label>尺码表行 ID（可选）<input value={v.sizeGridRowId} placeholder="可在妙手继续补齐" onChange={e => patch({ variants: draft.variants.map((old, n) => n === i ? { ...old, sizeGridRowId: e.target.value } : old) })} /></label></div><button type="button" className="ghost" onClick={() => patch({ variants: draft.variants.filter((_, n) => n !== i) })}>移除此 SKU</button></div>)}</div></section></fieldset>
      {(issues ?? localIssues).length > 0 && <div className="ms-issues"><strong>提交前待完善</strong><ul>{(issues ?? localIssues).map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
      <div className="ms-actions"><button className="ghost" disabled={busy || Boolean(readonly) || !fieldsValid} onClick={() => void run(false)}>{busy ? '处理中…' : '保存草稿'}</button><button disabled={busy || Boolean(readonly) || !fieldsValid} onClick={() => void run(true)}>保存并检查提交内容</button>{draft.status === 'pending' && <button className="ghost" disabled={busy || !fieldsValid} onClick={async () => { setBusy(true); try { const next = await save(); if (next) { const queued = await miaoshouApi.decide(next, 'ready'); setDraft(queued); setSaved(JSON.stringify(queued)); setNotice('已加入妙手提交清单。'); } } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>保存并加入提交清单</button>}</div>
      </div></div></>}
    <p className="ms-notice" role="status" aria-live="polite">{notice}</p>
  </div>;
}
