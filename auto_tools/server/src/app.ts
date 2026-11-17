import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import { errorHandler } from './middleware/error.js';
import { collectRouter } from './routes/collect.js';
import { productsRouter } from './routes/products.js';
import { joomRouter } from './routes/joom.js';
import { settingsRouter } from './routes/settings.js';
import { operationsRouter } from './routes/operations.js';
import { imagesRouter } from './routes/images.js';
import { mercadoLibreRouter } from './routes/mercadolibre.js';
import { plannerRouter } from './routes/planner.js';
import { ordersRouter } from './routes/orders.js';
import { logger } from './util/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  // CORS:允许网页后台与插件(扩展页面 origin 不固定)访问
  app.use(cors({ origin: [config.webOrigin, /^chrome-extension:\/\//, /^moz-extension:\/\//] }));
  // 本地图片会先转成 base64 传到服务端，再上传到 PICUI；20MB 图片经 base64 后约 27MB。
  app.use(express.json({ limit: '30mb' }));

  // 请求日志(带 request-id 透传位)
  app.use((req, _res, next) => {
    if (config.verbose) logger.debug('HTTP', { method: req.method, url: req.url });
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, joomEnv: config.joom.env }));

  // 只暴露服务端生成的安全素材 id，不接受任意文件路径。
  app.use('/api/media/videos', express.static(config.videoDir, {
    fallthrough: false,
    immutable: true,
    maxAge: '1d',
  }));

  app.use('/api', collectRouter);
  app.use('/api', productsRouter);
  app.use('/api', joomRouter);
  app.use('/api', settingsRouter);
  app.use('/api', operationsRouter);
  app.use('/api', imagesRouter);
  app.use('/api', mercadoLibreRouter);
  app.use('/api', plannerRouter);
  app.use('/api', ordersRouter);

  // 生产环境托管 web 后台(web/dist)
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
    logger.info('已托管网页后台', { webDist });
  }

  app.use(errorHandler);
  return app;
}
