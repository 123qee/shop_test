import { useEffect, useRef, useState } from 'react';
import { formatChinaDateTime, POLYESTER_TYPES, POLYESTER_TYPE_LABELS, type OrderPreviewBucket, type OrderPreviewLine, type PolyesterType } from '@shared/orders';
import type { ProductMaterial } from '@shared/types';
import { MATERIAL_OPTIONS } from './order-ui';

export interface OrderItem {
  line: OrderPreviewLine;
  bucket: OrderPreviewBucket;
}

interface Props {
  items: OrderItem[];
  view: 'list' | 'cards';
  excludedLineUids: Set<string>;
  selectedImages: Record<string, string[]>;
  onChangeExport: (lines: OrderPreviewLine[], checked: boolean) => void;
  onChangeMaterial: (lines: OrderPreviewLine[], material: ProductMaterial) => void;
  onChangePolyesterType: (lines: OrderPreviewLine[], type: PolyesterType | null) => void;
  onChangeImages: (lines: OrderPreviewLine[], images: string[]) => void;
  disabled: boolean;
}

export function OrderItems({ items, view, excludedLineUids, selectedImages, onChangeExport, onChangeMaterial, onChangePolyesterType, onChangeImages, disabled }: Props) {
  const [limit, setLimit] = useState(50);
  const [zoom, setZoom] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (zoom && !dialog.current?.open) dialog.current?.showModal();
    if (!zoom && dialog.current?.open) dialog.current?.close();
  }, [zoom]);

  function selection({ line, bucket }: OrderItem) {
    return <label className="orders-check" title={bucket.excluded ? '确认材质并在方案中启用后才能导出' : '取消勾选只跳过本次导出'}>
      <input type="checkbox" aria-label={`导出订单 ${line.orderId} ${line.variantSku || line.title || '商品'}`} checked={!bucket.excluded && !excludedLineUids.has(line.uid)} disabled={disabled || bucket.excluded} onChange={(event) => onChangeExport([line], event.target.checked)} />
      {view === 'cards' && '本次导出'}
    </label>;
  }

  function material({ line, bucket }: OrderItem) {
    const known = MATERIAL_OPTIONS.some((option) => option.id === line.material);
    return <div className="orders-item-material">
      <select className="orders-select" aria-label={`订单 ${line.orderId} ${line.variantSku || line.title || '商品'}的材质`} value={known ? line.material : 'unknown'} disabled={disabled} onChange={(event) => onChangeMaterial([line], event.target.value as ProductMaterial)}>
        <option value="unknown">待确认 · 不导出</option>
        {MATERIAL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {line.material === 'polyester' && <>
        <label className="orders-polyester-type">
          <span>聚酯类型</span>
          <select className="orders-select" aria-label={`订单 ${line.orderId} ${line.variantSku || line.title || '商品'}的聚酯类型`} value={line.polyesterType ?? ''} disabled={disabled} required onChange={(event) => onChangePolyesterType([line], event.target.value as PolyesterType || null)}>
            <option value="">请选择平板 / 针眼</option>
            {POLYESTER_TYPES.map((type) => <option key={type} value={type}>{POLYESTER_TYPE_LABELS[type]}</option>)}
          </select>
        </label>
        {!line.polyesterType && <small className="orders-pending-note">请选择类型后再导出</small>}
      </>}
      {bucket.excluded && <small className="orders-pending-note">{known ? '请在高级设置中启用此材质' : '确认材质后才能导出'}</small>}
    </div>;
  }

  function images(line: OrderPreviewLine, expanded: boolean) {
    const selected = selectedImages[line.uid] ?? line.selectedImages;
    const choices = <ImageChoices line={line} selected={selected} disabled={disabled} onZoom={setZoom} onChange={(urls) => onChangeImages([line], urls)} />;
    if (!line.imageUrls.length) return <span className="orders-sub">暂无图片，请重新同步</span>;
    return expanded ? choices : <details className="orders-row-images">
      <summary>已选 {selected.length} 张 · 选图片</summary>
      {choices}
    </details>;
  }

  function thumbnail(line: OrderPreviewLine) {
    const url = (selectedImages[line.uid] ?? line.selectedImages)[0] || line.imageUrl;
    return url ? <button type="button" className="orders-image-button orders-list-thumbnail" aria-label={`放大订单 ${line.orderId} 的商品图片`} onClick={() => setZoom(url)}>
      <img src={url} alt={line.title || '商品图片'} loading="lazy" referrerPolicy="no-referrer" />
    </button> : <span className="orders-noimg">无图</span>;
  }

  function product(line: OrderPreviewLine) {
    return <div className="orders-item-product">
      <span className="orders-item-title" title={line.title}>{line.title || '未命名商品'}{line.isGift ? '（赠品）' : ''}</span>
      {line.productSku && <small>SKU：{line.productSku}</small>}
      {line.variantSku && <small>变体：{line.variantSku}</small>}
      {line.exportedAt && <small>曾于 {formatChinaDateTime(line.exportedAt)} 导出</small>}
    </div>;
  }

  const visible = items.slice(0, limit);
  return <>
    {view === 'list' ? <div className="orders-items-scroll">
      <table className="orders-items-table">
        <thead><tr><th>导出</th><th>图片</th><th>下单时间</th><th>店铺 / 订单号</th><th>商品 / SKU</th><th>颜色 / 尺码</th><th>数量</th><th>材质 / 聚酯类型</th><th>图片选择</th></tr></thead>
        <tbody>{visible.map((item) => {
          const { line, bucket } = item;
          const skipped = !bucket.excluded && excludedLineUids.has(line.uid);
          return <tr key={line.uid} className={bucket.excluded ? 'pending' : skipped ? 'skipped' : ''}>
            <td>{selection(item)}{skipped && <small className="orders-skip-note">本次跳过</small>}</td>
            <td>{thumbnail(line)}</td>
            <td className="orders-item-date">{formatChinaDateTime(line.orderedAt)}</td>
            <td><div className="orders-item-shop">{line.shopName}</div><small className="orders-item-order">{line.orderId}</small></td>
            <td>{product(line)}</td>
            <td><div>{line.color || '未标颜色'}</div><div>平台本身尺码：<strong>{line.size || '未标尺码'}</strong></div><div>拿货尺码：<strong>{line.purchaseSize || '未标尺码'}</strong></div></td>
            <td className="orders-item-quantity">{line.quantity}</td>
            <td>{material(item)}</td>
            <td>{images(line, false)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <div className="orders-garments">
      {visible.map((item) => {
        const { line, bucket } = item;
        const selected = selectedImages[line.uid] ?? line.selectedImages;
        const skipped = !bucket.excluded && excludedLineUids.has(line.uid);
        return <article className={`orders-garment${bucket.excluded ? ' pending' : skipped ? ' skipped' : ''}`} key={line.uid}>
          <div className="orders-garment-info">
            <div className="orders-garment-header">{selection(item)}<span className="orders-garment-shop">{line.shopName}</span></div>
            <div className="orders-item-date">{formatChinaDateTime(line.orderedAt)} · {line.orderId}</div>
            {product(line)}
            {material(item)}
            {images(line, true)}
            <div className="orders-garment-sizes"><span className="orders-size-chip">{line.color || '未标颜色'}</span><span className="orders-size-chip">平台本身尺码：{line.size || '未标尺码'}</span><span className="orders-size-chip">拿货尺码：{line.purchaseSize || '未标尺码'}</span></div>
            <div className="orders-garment-footer"><span>{skipped ? '本次跳过' : `已选 ${selected.length} 张图片`}</span><strong>共 {line.quantity} 件</strong></div>
          </div>
        </article>;
      })}
    </div>}
    {items.length > limit && <button type="button" className="ghost orders-more" onClick={() => setLimit((value) => value + 50)}>继续查看订单商品（还有 {items.length - limit} 行）</button>}
    <dialog ref={dialog} className="orders-image-dialog" onClose={() => setZoom('')} onClick={(event) => { if (event.target === event.currentTarget) setZoom(''); }} aria-label="查看商品大图">
      <button type="button" onClick={() => setZoom('')} autoFocus>关闭大图</button>
      {zoom && <img src={zoom} alt="商品大图" referrerPolicy="no-referrer" />}
    </dialog>
  </>;
}

function ImageChoices({ line, selected, disabled, onZoom, onChange }: {
  line: OrderPreviewLine;
  selected: string[];
  disabled: boolean;
  onZoom: (url: string) => void;
  onChange: (urls: string[]) => void;
}) {
  return <div className="orders-image-choices">
    {line.imageUrls.map((url, index) => <div className={`orders-image-choice${selected.includes(url) ? ' selected' : ''}`} key={url}>
      <button type="button" className="orders-image-button" aria-label={`放大订单 ${line.orderId} 图片 ${index + 1}`} onClick={() => onZoom(url)}><img src={url} alt={`图片 ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" /></button>
      <label><input type="checkbox" aria-label={`订单 ${line.orderId} 导出图片 ${index + 1}`} checked={selected.includes(url)} disabled={disabled || (selected.length === 1 && selected.includes(url)) || (selected.length >= 21 && !selected.includes(url))} onChange={(event) => onChange(event.target.checked ? [...selected, url] : selected.filter((item) => item !== url))} /><span>{index + 1}</span></label>
    </div>)}
  </div>;
}
