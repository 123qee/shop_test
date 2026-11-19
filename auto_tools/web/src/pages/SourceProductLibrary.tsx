import type { ProductIndexItem } from '@shared/product-catalog';
import { useProductCards } from '../product-cards';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProductRecord } from '@shared/types';
import { api } from '../api';
import type { ProductGroupId, ProductMaterial } from '@shared/types';
import { groupLabel, PRODUCT_GROUPS, PRODUCT_MATERIALS } from '@shared/product-grouping';
import { ProductGroupingBadges } from './ProductGroupingPanel';

type Preview = { product: ProductRecord; index: number };

function productImages(product: ProductRecord) {
  return [...new Set([
    ...product.collected.images,
    ...product.collected.variants.map((variant) => variant.image).filter((image): image is string => Boolean(image)),
  ])];
}

export function SourceProductLibrary() {
  const [items, setItems] = useState<ProductIndexItem[]>([]);
  const [page, setPage] = useState(1);
  const [loadingPreviewId, setLoadingPreviewId] = useState('');
  const previewRequest = useRef(0);
  const pageSize = 30;
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
      setItems(await api.productIndex());
      setError('');
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => {
    void load();
    return () => { previewRequest.current++; };
  }, []);

  async function openPreview(id: string) {
    const request = ++previewRequest.current;
    setLoadingPreviewId(id);
    try {
      const { record } = await api.getProduct(id);
      if (request === previewRequest.current && productImages(record).length) setPreview({ product: record, index: 0 });
    } catch (err) {
      if (request === previewRequest.current) setError((err as Error).message);
    } finally {
      if (request === previewRequest.current) setLoadingPreviewId('');
    }
  }

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => (!keyword || [item.collected.title, item.collected.sourceProductId, item.collected.store?.name ?? '']
      .join(' ').toLowerCase().includes(keyword))
      && (group === 'all' || item.grouping.groupId === group)
      && (material === 'all' || item.grouping.material === material));
  }, [items, query, group, material]);
  const filtering = Boolean(query.trim() || group !== 'all' || material !== 'all');
  const groups = useMemo(() => PRODUCT_GROUPS.map((g) => ({ ...g, count: items.filter((p) => p.grouping.groupId === g.id).length })), [items]);

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = useMemo(() => visible.slice((currentPage - 1) * pageSize, currentPage * pageSize), [visible, currentPage]);
  const cardPage = useProductCards(pageRows);

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
      <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="搜索标题、来源商品 ID 或店铺" />
      <select aria-label="母库商品分组" value={group} onChange={(e) => { setGroup(e.target.value as ProductGroupId | 'all'); setMaterial('all'); setPage(1); }}>
        <option value="all">全部分组</option>
        {groups.filter((g) => g.count > 0 || g.id === group).map((g) => <option key={g.id} value={g.id}>{g.label}（{g.count}）</option>)}
      </select>
      <select aria-label="母库商品材质" value={material} onChange={(e) => { setMaterial(e.target.value as ProductMaterial | 'all'); setPage(1); }}>
        <option value="all">全部材质</option>
        {PRODUCT_MATERIALS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {group !== 'all' && <Link className="ghost" to={`/joom?group=${group}${material !== 'all' ? `&material=${material}` : ''}&templateState=pending`}>去处理{groupLabel(group)}预设</Link>}
      <span className="muted">{filtering ? `找到 ${visible.length} / ${items.length} 个商品` : `共 ${items.length} 个采集商品`}</span>
      <button type="button" className="button secondary small" onClick={() => void load(true)} disabled={loading || refreshing}>{refreshing ? '刷新中…' : '刷新'}</button>
    </div>
    {cardPage.error && <div className="error">{cardPage.error} <button className="ghost" onClick={cardPage.retry}>重试本页</button></div>}
    {(loading || cardPage.loading) && <div className="empty-state"><strong>正在加载母库…</strong></div>}
    {!loading && !visible.length && <div className="empty-state"><strong>{filtering ? '没有找到匹配商品' : '母库暂无商品'}</strong><p>{filtering ? '试试调整分组、材质或搜索内容。' : '先使用现有采集流程采集商品，采集结果会出现在这里。'}</p></div>}
    {!loading && cardPage.cards.length > 0 && <div className="source-table-card"><div className="table-wrap"><table className="source-table"><thead><tr><th>商品与主图</th><th>来源</th><th>素材</th><th>采集时间</th><th>平台入口</th></tr></thead><tbody>{cardPage.cards.map((item) => {
      const mainImage = item.sourceImage;
      return <tr key={item.id}>
        <td><div className="source-product-cell">
          <button type="button" className="source-thumb" onClick={() => void openPreview(item.id)} disabled={!mainImage || loadingPreviewId === item.id} aria-label={mainImage ? `预览 ${item.collected.title} 图片` : '暂无商品图片'}>
            {mainImage ? <img src={mainImage} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; event.currentTarget.parentElement?.classList.add('failed'); }} /> : <span>暂无图片</span>}
            {item.imageCount > 1 && <i>+{item.imageCount - 1}</i>}
          </button>
          <div className="source-product-copy"><strong title={item.collected.title}>{item.collected.title}</strong><ProductGroupingBadges product={item} /><small className="muted">{item.collected.sourceProductId}</small></div>
        </div></td>
        <td>{item.collected.source}{item.collected.store?.name ? <small className="muted">{item.collected.store.name}</small> : null}</td>
        <td><button type="button" className="source-gallery-link" onClick={() => void openPreview(item.id)} disabled={!item.imageCount || loadingPreviewId === item.id}>{item.imageCount} 张图片 <span>·</span> {item.variantCount} 个变体</button></td>
        <td>{new Date(item.createdAt).toLocaleString()}</td>
        <td><div className="modal-actions"><Link className="ghost" to={`/products/${item.id}`}>打开 Joom 草稿</Link><Link className="ghost" to={`/mercadolibre?productId=${encodeURIComponent(item.id)}`}>创建 Mercado Libre 草稿</Link></div></td>
      </tr>;
    })}</tbody></table></div></div>}

    {pageCount > 1 && <div className="pagination">
      <span>第 {currentPage} / {pageCount} 页 · 共 {visible.length} 件</span>
      <button className="ghost" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
      <button className="ghost" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
    </div>}
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
