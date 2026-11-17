import sharp from 'sharp';
import { OrderInputError } from './errors.js';
import type { XlsxImageCell } from './writers/xlsx.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGES = 1000;
const TIMEOUT_MS = 25_000;

/** 只取本次实际选中的图；同图下载一次，转 JPEG 后随 Excel 保存，离线也可看。 */
export async function loadExportImages(urls: string[]): Promise<Map<string, XlsxImageCell>> {
  const unique = [...new Set(urls)];
  if (unique.length > MAX_IMAGES) throw new OrderInputError('本次图片超过 1000 张，请缩小日期或店铺范围后分批导出');
  const images = new Map<string, XlsxImageCell>();
  const controller = new AbortController();
  let cursor = 0;
  let totalBytes = 0;
  let failure: Error | undefined;

  async function worker() {
    while (!failure && cursor < unique.length) {
      const url = unique[cursor++];
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > MAX_IMAGE_BYTES) {
            await reader.cancel();
            throw new Error('单张图片超过 12 MB');
          }
          chunks.push(Buffer.from(chunk.value));
        }
        // WebP / AVIF 等统一转为 Excel 支持的 JPEG；限制像素和大小，避免文件过大。
        const { data, info } = await sharp(Buffer.concat(chunks), { limitInputPixels: 40_000_000 })
          .rotate().resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
        totalBytes += data.length;
        if (totalBytes > MAX_EXPORT_BYTES) throw new Error('图片总量超过 100 MB，请分批导出');
        images.set(url, { kind: 'image', data, width: info.width, height: info.height });
      } catch (error) {
        if (!failure) {
          const reason = error instanceof Error ? error.message : String(error);
          failure = new OrderInputError(`第 ${unique.indexOf(url) + 1} 张图片下载或处理失败：${reason}。本次未导出、订单未标记，请重试或重新选图`);
          controller.abort();
        }
      } finally { clearTimeout(timeout); }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, () => worker()));
  if (failure) throw failure;
  return images;
}
