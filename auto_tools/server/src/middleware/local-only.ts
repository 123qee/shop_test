import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/index.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
/** ngrok 等隧道转发时会带这些头；本机直连和 Vite 开发代理不会带。 */
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip'];

/** 请求来自本机浏览器直连（不是经隧道或局域网转发过来的）。 */
export function isLocalRequest(req: Request): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  if (FORWARD_HEADERS.some((header) => req.headers[header] !== undefined)) return false;
  return LOCAL_HOST.test(req.headers.host ?? '');
}

/**
 * 只允许本机访问。start.sh 默认把 8787 通过 ngrok 暴露到公网（美客多回调需要），
 * 含买家信息的接口要挡住公网请求；局域网使用时可设 ORDERS_ALLOW_REMOTE=1。
 */
export function localOnly(message: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (config.orders.allowRemote || isLocalRequest(req)) {
      next();
      return;
    }
    res.status(403).json({ error: message });
  };
}
