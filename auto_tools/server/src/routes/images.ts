import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/error.js';
import { config } from '../config/index.js';
import { settingsService } from '../services/settings-service.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const uploadImageSchema = z.object({
  dataUrl: z.string().min(1),
  filename: z.string().trim().min(1).max(200).optional(),
});

function extensionForMime(mime: string): string {
  const normalized = mime.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('svg')) return 'svg';
  return 'jpg';
}

function safeFilename(filename: string | undefined, mime: string): string {
  const fallback = `joom-${Date.now()}.${extensionForMime(mime)}`;
  if (!filename) return fallback;
  const clean = filename.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
  return clean.includes('.') ? clean : `${clean}.${extensionForMime(mime)}`;
}

export const imagesRouter = Router();

/** 本地图片上传到 PICUI，返回 Joom 可访问的公网 URL。 */
imagesRouter.post(
  '/images/upload',
  asyncHandler(async (req, res) => {
    const { dataUrl, filename } = uploadImageSchema.parse(req.body);
    const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
    if (!match) return res.status(400).json({ error: '只支持图片文件，且必须使用 base64 图片数据' });

    const mime = match[1].toLowerCase();
    const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!buffer.length) return res.status(400).json({ error: '图片内容为空或格式无法解析' });
    if (buffer.length > MAX_IMAGE_BYTES) return res.status(413).json({ error: '图片不能超过 20 MB' });

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), safeFilename(filename, mime));
    form.append('permission', '1');

    const token = settingsService.getPicuiToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${config.picui.baseUrl}/upload`, {
      method: 'POST',
      headers,
      body: form,
    });
    const raw = await response.text();
    let payload: any = {};
    try { payload = JSON.parse(raw); } catch { /* PICUI 异常时返回纯文本 */ }

    if (!response.ok || payload.status === false) {
      const detail = payload.message || raw.slice(0, 300) || `PICUI 上传失败 (${response.status})`;
      return res.status(response.status === 429 ? 429 : 502).json({ error: detail });
    }

    const url = payload.data?.links?.url || payload.data?.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return res.status(502).json({ error: 'PICUI 上传成功，但没有返回可访问的图片 URL' });
    }
    res.json({ url, provider: 'picui', authenticated: Boolean(token) });
  }),
);
