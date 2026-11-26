#!/usr/bin/env bash
# 一键启动开发环境：后端(8787) + 网页后台(5173)
# 用法: ./start-dev.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PID=""
WEB_PID=""

cleanup() {
  echo ""
  echo "⏹  正在停止…"
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "✅ 已停止"
}
trap cleanup EXIT INT TERM

# 加载 nvm(若存在)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
if command -v nvm >/dev/null 2>&1 && [ -f "$ROOT/../.nvmrc" ]; then
  nvm use --silent "$(cat "$ROOT/../.nvmrc")" >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 node，请先安装 Node.js 22 或更高版本"; exit 1
fi
node "$ROOT/scripts/startup.mjs" check-node

# 依赖
node "$ROOT/scripts/startup.mjs" prepare-server
node "$ROOT/scripts/startup.mjs" prepare-web-deps

if [ ! -f "$ROOT/server/.env" ]; then
  echo "⚠️  未找到 server/.env，可先执行: cp server/env.sample server/.env"
fi

echo "🚀 启动后端 → http://localhost:8787"
(cd "$ROOT/server" && npm run dev) &
SERVER_PID=$!

echo "🚀 启动网页 → http://localhost:5173"
(cd "$ROOT/web" && npm run dev) &
WEB_PID=$!

# 就绪后打开浏览器
(
  for _ in $(seq 1 40); do
    if curl -s -m 1 "http://localhost:5173" >/dev/null 2>&1; then
      command -v open >/dev/null 2>&1 && open "http://localhost:5173"
      break
    fi
    sleep 0.5
  done
) &

echo ""
echo "按 Ctrl+C 停止全部服务"
echo "----------------------------"
wait
