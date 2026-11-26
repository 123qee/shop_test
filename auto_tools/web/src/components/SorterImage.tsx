import { useState } from 'react';
import { fallbackToSourceImage, sizedImageSource } from '../image-utils';
import './sorter-image.css';

/** 小图先显示，预览图完成后替换；完整源图仍保留在商品记录中。 */
export function SorterImage({ source, alt = '', onReady }: { source: string; alt?: string; onReady?: () => void }) {
  const preview = sizedImageSource(source, 'preview');
  const thumb = sizedImageSource(source, 'thumb');
  const [loaded, setLoaded] = useState('');
  const [failed, setFailed] = useState('');
  const ready = loaded === preview;
  const unavailable = failed === preview;
  return <div className="sorter-image" aria-busy={!ready && !unavailable}>
    {!ready && !unavailable && thumb !== preview && <img key={`thumb:${source}`} className="sorter-image-placeholder" src={thumb} alt="" decoding="async" fetchPriority="low" />}
    {!unavailable && <img key={source} className={`sorter-image-full${ready ? ' is-ready' : ''}`} src={preview} alt={alt} loading="eager" decoding="async" fetchPriority="high"
      onLoad={() => { setLoaded(preview); onReady?.(); }}
      onError={event => { if (!fallbackToSourceImage(event.currentTarget, source)) { setFailed(preview); onReady?.(); } }} />}
    {!ready && <span className="sorter-image-status" role="status">{unavailable ? '图片加载失败，可切换图片或查看来源' : '加载图片…'}</span>}
  </div>;
}
