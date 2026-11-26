#!/usr/bin/env bash
# 一键启动 auto_tools:装依赖 -> 构建网页(首次/按需)-> 启动后端 -> 启动固定 ngrok 隧道
# 用法:
#   ./start.sh              普通启动
#   ./start.sh --build-web  强制重新构建网页后台（源码变化时默认自动构建）
#   ./start.sh --doctor     只读检查，不安装、不启动服务
#   ./start.sh --prepare    只安装依赖与构建网页，不启动服务
# 可选:
#   NGROK_URL=https://你的域名.ngrok-free.dev ./start.sh
#   NGROK_ENABLED=0 ./start.sh       不启动 ngrok
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8787}"
NGROK_PORT="${NGROK_PORT:-$PORT}"
NGROK_URL="${NGROK_URL:-https://java-suburb-kettle.ngrok-free.dev}"
NGROK_ENABLED="${NGROK_ENABLED:-1}"
FORCE_BUILD_WEB=0
MODE=start
for argument in "$@"; do
  case "$argument" in
    --build-web) FORCE_BUILD_WEB=1 ;;
    --doctor) MODE=doctor ;;
    --prepare) MODE=prepare ;;
    *) echo "未知参数：$argument"; exit 1 ;;
  esac
done
STARTUP="$ROOT/scripts/startup.mjs"

SERVER_PID=""
NGROK_PID=""
OWN_SERVER=0

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  echo ""
  echo "⏹  正在停止…"
  if [ -n "$NGROK_PID" ] && kill -0 "$NGROK_PID" 2>/dev/null; then
    kill "$NGROK_PID" 2>/dev/null || true
  fi
  if [ "$OWN_SERVER" = "1" ] && [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  echo "✅ 已停止"
  exit "$exit_code"
}
# 加载 nvm（若存在），优先使用项目 .nvmrc 中已安装的版本。
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
if command -v nvm >/dev/null 2>&1 && [ -f "$ROOT/../.nvmrc" ]; then
  nvm use --silent "$(cat "$ROOT/../.nvmrc")" >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 node,请先安装 Node.js 22 或更高版本"; exit 1
fi
if [ "$MODE" = doctor ]; then
  node "$STARTUP" doctor
  exit $?
fi
node "$STARTUP" check-node

if [ "$FORCE_BUILD_WEB" = "1" ]; then
  node "$STARTUP" prepare-web --force
else
  node "$STARTUP" prepare-web
fi
if [ "$MODE" = prepare ]; then
  node "$STARTUP" prepare-server
  echo "✅ 依赖与网页准备完成，未启动服务。"
  exit 0
fi

trap cleanup EXIT INT TERM

# 检查服务是否已经在运行；如果已运行，只接管 ngrok，不重复启动后端。
if curl -fsS -m 2 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo "✅ 服务已在运行:http://localhost:$PORT"
else
  node "$STARTUP" prepare-server

  # .env 提醒
  if [ ! -f "$ROOT/server/.env" ]; then
    echo "⚠️  未找到 server/.env,先复制模板:cp server/env.sample server/.env 并填写 Joom 凭证"
  fi

  echo "🚀 启动后端 → http://localhost:$PORT"
  (cd "$ROOT/server" && npm run dev) &
  SERVER_PID=$!
  OWN_SERVER=1

  echo "⏳ 等待后端就绪…"
  READY=0
  for _ in $(seq 1 40); do
    if curl -fsS -m 1 "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 0.5
  done
  if [ "$READY" != "1" ]; then
    echo "❌ 后端启动失败，请检查上方日志"
    exit 1
  fi
fi

if [ "$NGROK_ENABLED" = "1" ]; then
  if ! command -v ngrok >/dev/null 2>&1; then
    echo "⚠️  未找到 ngrok，已跳过隧道启动；如需自动启动请先安装并配置 ngrok"
  else
    echo "🌐 启动 ngrok → $NGROK_URL → http://localhost:$NGROK_PORT"
    ngrok http "$NGROK_PORT" --url "$NGROK_URL" >"$ROOT/.ngrok.log" 2>&1 &
    NGROK_PID=$!
    sleep 1
    if ! kill -0 "$NGROK_PID" 2>/dev/null; then
      echo "⚠️  ngrok 启动失败，详细信息见 $ROOT/.ngrok.log"
      NGROK_PID=""
    else
      echo "✅ ngrok 已启动: $NGROK_URL"
    fi
  fi
elif [ "$NGROK_ENABLED" = "0" ]; then
  echo "ℹ️  NGROK_ENABLED=0，已跳过 ngrok"
else
  echo "⚠️  NGROK_ENABLED 只能是 0 或 1，已跳过 ngrok"
fi

# 启动后打开本地后台；OAuth 回调使用上面打印的公网 ngrok 地址。
command -v open >/dev/null 2>&1 && open "http://localhost:$PORT" || true

echo "🚀 后台已启动(Ctrl+C 停止) → http://localhost:$PORT"
if [ -n "$NGROK_PID" ]; then
  echo "🔗 公网地址 → $NGROK_URL"
fi

if [ "$OWN_SERVER" = "1" ]; then
  wait "$SERVER_PID"
elif [ -n "$NGROK_PID" ]; then
  wait "$NGROK_PID"
else
  echo "ℹ️  当前脚本没有需要持续管理的进程，启动流程结束"
fi
