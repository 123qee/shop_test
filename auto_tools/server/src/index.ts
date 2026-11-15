import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config/index.js';
import { getDb } from './db/index.js';
import { logger } from './util/logger.js';
import { publishJobService } from './services/publish-job-service.js';
import { joomVideoService } from './services/joom-video-service.js';

function main() {
  getDb(); // 初始化数据库 + 迁移
  bootstrap(); // 注册扩展点
  publishJobService.start();
  joomVideoService.start();
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
