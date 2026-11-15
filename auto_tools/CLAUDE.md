# auto_tools 项目规则

## 改完代码必须重启前后端

每次修改 `server/` 或 `web/` 下的代码后，必须让页面运行的是最新代码，不能只停在改动和类型检查上：

1. **重新构建网页后台**（页面由后端从 `web/dist` 提供，不重新构建页面仍是旧代码）：
   ```bash
   cd web && npm run build
   ```
2. **重启后端**（停掉占用 8787 端口的旧进程，再重新启动）：
   ```bash
   lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill
   cd server && nohup npm run dev > /tmp/auto-tools-server.log 2>&1 &
   ```
3. **验证**后再告诉用户完成：
   - `curl -s http://localhost:8787/api/health` 返回 `{"ok":true,...}`；
   - 如果改了接口，用 `curl` 调一下新接口，确认返回的不是 404；
   - `web/dist/assets/*.js` 的时间晚于最后一次修改的源码，或包含新加的代码字符串。
4. 如果用户正在使用 `./start.sh`，等同于上面的步骤：改了 web 代码用 `./start.sh --build-web`。

只改了文档或测试文件时可以不重启，但要在回复里说明。

## 报告状态

- 没有重启或没有验证时，不能说"已生效"或"页面已更新"。
- 测试失败时，先在改动前后各跑一次确认是否由本次改动引起，不能直接归为"原本就存在的问题"。
