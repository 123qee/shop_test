import { useEffect, useRef, useState } from 'react';
import type { OrderPreviewBucket, OrderPreviewLine } from '@shared/orders';
import type { ProductMaterial } from '@shared/types';
import { MATERIAL_OPTIONS } from './order-ui';

function groupGarments(lines: OrderPreviewLine[]) {
  const groups = new Map<string, OrderPreviewLine[]>();
  for (const line of lines) {
    // 同款同色同订单图合并尺码；没有可靠商品标识时保留独立卡片。
    const key = JSON.stringify([line.platform, line.shopId, line.productId || line.productSku || line.uid, line.color, line.imageUrl, line.material, line.isGift]);
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups.entries()];
}

export function GarmentCards({ bucket, selectedImages, onChangeMaterial, onChangeImages, disabled }: {
  bucket: OrderPreviewBucket;
  selectedImages: Record<string, string[]>;
  onChangeMaterial: (lines: OrderPreviewLine[], material: ProductMaterial) => void;
  onChangeImages: (lines: OrderPreviewLine[], images: string[]) => void;
  disabled: boolean;
}) {
  const [limit, setLimit] = useState(24);
  const [zoom, setZoom] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const groups = groupGarments(bucket.lines);
  useEffect(() => {
    if (zoom && !dialog.current?.open) dialog.current?.showModal();
    if (!zoom && dialog.current?.open) dialog.current?.close();
  }, [zoom]);
  return <>
    <div className="orders-garments">
      {groups.slice(0, limit).map(([key, lines]) => {
        const line = lines[0];
        const candidates = line.imageUrls.filter((url) => lines.every((item) => item.imageUrls.includes(url)));
        const selected = selectedImages[line.uid] ?? line.selectedImages;
        const known = MATERIAL_OPTIONS.some((item) => item.id === line.material);
        const sizes = new Map<string, number>();
        for (const item of lines) sizes.set(item.size || '未标尺码', (sizes.get(item.size || '未标尺码') ?? 0) + item.quantity);
        const quantity = lines.reduce((sum, item) => sum + item.quantity, 0);
        return <article className={`orders-garment${bucket.excluded ? ' pending' : ''}`} key={key}>
          <div className="orders-garment-info">
            <div className="orders-garment-header">
              <span className="orders-garment-shop">{line.shopName}</span>
              <select className="orders-select" aria-label={`${line.shopName} ${line.title || '商品'}的材质`} value={known ? line.material : 'unknown'} disabled={disabled} onChange={(event) => onChangeMaterial(lines, event.target.value as ProductMaterial)}>
                <option value="unknown">待确认 · 不导出</option>
                {MATERIAL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </div>
            {bucket.excluded && known && <span className="orders-error-text">请在高级设置中启用此材质后导出</span>}
            {candidates.length === 0 && <span className="orders-sub">暂无图片，请重新同步订单</span>}
            {candidates.length > 0 && <div className="orders-image-choices">
              {candidates.map((url, index) => <div className={`orders-image-choice${selected.includes(url) ? ' selected' : ''}`} key={url}>
                <button type="button" className="orders-image-button" aria-label={`放大图片 ${index + 1}`} onClick={() => setZoom(url)}><img src={url} alt={`图片 ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" /></button>
                <label><input type="checkbox" aria-label={`导出图片 ${index + 1}`} checked={selected.includes(url)} disabled={disabled || (selected.length === 1 && selected.includes(url)) || (selected.length >= 21 && !selected.includes(url))} onChange={(event) => onChangeImages(lines, event.target.checked ? [...selected, url] : selected.filter((item) => item !== url))} /><span>{index + 1}</span></label>
              </div>)}
            </div>}
            <div className="orders-garment-sizes" aria-label="尺码和数量">{[...sizes].map(([size, qty]) => <span className="orders-size-chip" key={size}>{size} × {qty}</span>)}</div>
            <div className="orders-garment-footer"><span>已选 {selected.length} 张图片</span><strong>共 {quantity} 件</strong></div>
          </div>
        </article>;
      })}
    </div>
    {groups.length > limit && <button type="button" className="ghost orders-more" onClick={() => setLimit((value) => value + 24)}>继续查看衣服（还有 {groups.length - limit} 款）</button>}
    <dialog ref={dialog} className="orders-image-dialog" onClose={() => setZoom('')} onClick={(event) => { if (event.target === event.currentTarget) setZoom(''); }} aria-label="查看商品大图">
      <button type="button" onClick={() => setZoom('')} autoFocus>关闭大图</button>
      {zoom && <img src={zoom} alt="商品大图" referrerPolicy="no-referrer" />}
    </dialog>
  </>;
}
