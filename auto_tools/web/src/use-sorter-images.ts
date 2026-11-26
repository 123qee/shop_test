import { useEffect, useRef } from 'react';
import { sizedImageSource } from './image-utils';
import { createImagePreloader } from './sorter-prefetch';

/** 先让当前主图加载，再温热相邻图片和后续商品；快速跳过时不下载整批图片。 */
export function useSorterImages(currentReady: boolean, sources: Array<string | undefined>) {
  const preloader = useRef<ReturnType<typeof createImagePreloader>>();
  useEffect(() => {
    preloader.current = createImagePreloader();
    return () => { preloader.current?.dispose(); preloader.current = undefined; };
  }, []);
  const urls = JSON.stringify(sources.filter((source): source is string => Boolean(source)).map(source => sizedImageSource(source, 'preview')));
  useEffect(() => {
    preloader.current?.update([]);
    if (!currentReady) return;
    const timer = window.setTimeout(() => preloader.current?.update(JSON.parse(urls)), 150);
    return () => { window.clearTimeout(timer); preloader.current?.update([]); };
  }, [currentReady, urls]);
}
