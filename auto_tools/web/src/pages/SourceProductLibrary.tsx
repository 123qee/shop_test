import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProductRecord } from '@shared/types';
import { api } from '../api';
import type { ProductGroupId, ProductMaterial } from '@shared/types';
import { groupLabel, PRODUCT_GROUPS, PRODUCT_MATERIALS } from '@shared/product-grouping';
import { groupingOf, ProductGroupingBadges } from './ProductGroupingPanel';

type Preview = { product: ProductRecord; index: number };

function productImages(product: ProductRecord) {
  return [...new Set([
    ...product.collected.images,
    ...product.collected.variants.map((variant) => variant.image).filter((image): image is string => Boolean(image)),
  ])];
}

export function SourceProductLibrary() {
  const [items, setItems] = useState<ProductRecord[]>([]);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<ProductGroupId | 'all'>('all');
  const [material, setMaterial] = useState<ProductMaterial | 'all'>('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);

  async function load(silent = false) {
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      setItems(await api.listProducts());
      setError('');
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => (!keyword || [item.collected.title, item.collected.sourceProductId, item.collected.store?.name ?? '']
      .join(' ').toLowerCase().includes(keyword))
      && (group === 'all' || groupingOf(item).groupId === group)
      && (material === 'all' || groupingOf(item).material === material));
  }, [items, query, group, material]);
  const filtering = Boolean(query.trim() || group !== 'all' || material !== 'all');
  const groups = useMemo(() => PRODUCT_GROUPS.map((g) => ({ ...g, count: items.filter((p) => groupingOf(p).groupId === g.id).length })), [items]);

  function movePreview(offset: number) {
    if (!preview) return;
    const images = productImages(preview.product);
    setPreview({ ...preview, index: (preview.index + offset + images.length) % images.length });
  }

  useEffect(() => {
    if (!preview) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setPreview(null);
      if (event.key === 'ArrowLeft') movePreview(-1);
      if (event.key === 'ArrowRight') movePreview(1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview]);

  return <div className="source-library">
    <div className="ed-bar">
      <div><strong>采集母库</strong><span className="hint">集中查看采集商品与原始素材</span></div>
      <div style={{ flex: 1 }} />
      <Link className="ghost" to="/joom">打开 Joom 工作区</Link>
      <Link className="ghost" to="/mercadolibre">打开 Mercado Libre</Link>
    </div>
    {error && <div className="error">{error}</div>}
    <div className="toolbar source-library-toolbar">
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索标题、来源商品 ID 或店铺" />
      <select aria-label="母库商品分组" value={group} onChange={(e) => { setGroup(e.target.value as ProductGroupId | 'all'); setMaterial('all'); }}>
        <option value="all">全部分组</option>
        {groups.filter((g) => g.count > 0 || g.id === group).map((g) => <option key={g.id} value={g.id}>{g.label}（{g.count}）</option>)}
      </select>
      <select aria-label="母库商品材质" value={material} onChange={(e) => setMaterial(e.target.value as ProductMaterial | 'all')}>
        <option value="all">全部材质</option>
        {PRODUCT_MATERIALS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {group !== 'all' && <Link className="ghost" to={`/?group=${group}${material !== 'all' ? `&material=${material}` : ''}&templateState=pending`}>去处理{groupLabel(group)}预设</Link>}
      <span className="muted">{filtering ? `找到 ${visible.length} / ${items.length} 个商品` : `共 ${items.length} 个采集商品`}</span>
      <button type="button" className="button secondary small" onClick={() => void load(true)} disabled={loading || refreshing}>{refreshing ? '刷新中…' : '刷新'}</button>
    </div>
    {loading && <div className="empty-state"><strong>正在加载母库…</strong></div>}
    {!loading && !visible.length && <div className="empty-state"><strong>{filtering ? '没有找到匹配商品' : '母库暂无商品'}</strong><p>{filtering ? '试试调整分组、材质或搜索内容。' : '先使用现有采集流程采集商品，采集结果会出现在这里。'}</p></div>}
    {!loading && visible.length > 0 && <div className="source-table-card"><div className="table-wrap"><table className="source-table"><thead><tr><th>商品与主图</th><th>来源</th><th>素材</th><th>采集时间</th><th>平台入口</th></tr></thead><tbody>{visible.map((item) => {
      const images = productImages(item);
      const mainImage = images[0];
      return <tr key={item.id}>
        <td><div className="source-product-cell">
          <button type="button" className="source-thumb" onClick={() => mainImage && setPreview({ product: item, index: 0 })} disabled={!mainImage} aria-label={mainImage ? `预览 ${item.collected.title} 图片` : '暂无商品图片'}>
            {mainImage ? <img src={mainImage} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; event.currentTarget.parentElement?.classList.add('failed'); }} /> : <span>暂无图片</span>}
            {images.length > 1 && <i>+{images.length - 1}</i>}
          </button>
          <div className="source-product-copy"><strong title={item.collected.title}>{item.collected.title}</strong><ProductGroupingBadges product={item} /><small className="muted">{item.collected.sourceProductId}</small></div>
        </div></td>
        <td>{item.collected.source}{item.collected.store?.name ? <small className="muted">{item.collected.store.name}</small> : null}</td>
        <td><button type="button" className="source-gallery-link" onClick={() => images.length && setPreview({ product: item, index: 0 })} disabled={!images.length}>{images.length} 张图片 <span>·</span> {item.collected.variants.length} 个变体</button></td>
        <td>{new Date(item.createdAt).toLocaleString()}</td>
        <td><div className="modal-actions"><Link className="ghost" to={`/products/${item.id}`}>打开 Joom 草稿</Link><Link className="ghost" to={`/mercadolibre?productId=${encodeURIComponent(item.id)}`}>创建 Mercado Libre 草稿</Link></div></td>
      </tr>;
    })}</tbody></table></div></div>}

    {preview && (() => {
      const images = productImages(preview.product);
      const currentImage = images[preview.index];
      return <div className="source-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(null); }}>
        <section className="source-preview" role="dialog" aria-modal="true" aria-label="商品图片预览">
          <header><div><strong title={preview.product.collected.title}>{preview.product.collected.title}</strong><span>{preview.index + 1} / {images.length} 张图片</span></div><button type="button" className="modal-close" onClick={() => setPreview(null)} aria-label="关闭">×</button></header>
          <div className="source-preview-stage">
            {images.length > 1 && <button type="button" className="source-preview-arrow previous" onClick={() => movePreview(-1)} aria-label="上一张">‹</button>}
            <img src={currentImage} alt={`${preview.product.collected.title} 图片 ${preview.index + 1}`} onError={(event) => { event.currentTarget.style.display = 'none'; event.currentTarget.parentElement?.classList.add('failed'); }} />
            {images.length > 1 && <button type="button" className="source-preview-arrow next" onClick={() => movePreview(1)} aria-label="下一张">›</button>}
          </div>
          <div className="source-preview-thumbnails">{images.map((image, index) => <button type="button" key={`${image}-${index}`} className={index === preview.index ? 'on' : ''} onClick={() => setPreview({ ...preview, index })} aria-label={`查看第 ${index + 1} 张图片`}><img src={image} alt="" loading="lazy" /></button>)}</div>
        </section>
      </div>;
    })()}
  </div>;
}
