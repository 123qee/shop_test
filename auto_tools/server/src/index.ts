import { restoreTemplateSeed } from './services/template-sync.js';
import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config/index.js';
import { getDb } from './db/index.js';
import { logger } from './util/logger.js';
import { publishJobService } from './services/publish-job-service.js';
import { joomVideoService } from './services/joom-video-service.js';
import { orderSyncService } from './orders/sync-service.js';
import { orderExportService } from './orders/export-service.js';

function main() {
  const db = getDb(); // 初始化数据库 + 迁移
  const restored = restoreTemplateSeed(db);
  if (restored.length) logger.info('已从仓库恢复模板配置', { settings: restored });
  bootstrap(); // 注册扩展点
  publishJobService.start();
  joomVideoService.start();
  orderSyncService.start();
  orderExportService.cleanupExpired();
  const app = createApp();
  app.listen(config.port, () => {
    logger.info(`server 已启动`, {
      url: `http://localhost:${config.port}`,
      joomEnv: config.joom.env,
      joomConfigured: config.joom.configured,
    });
  });
}

main();
