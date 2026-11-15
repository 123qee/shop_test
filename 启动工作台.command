#!/bin/bash

# 双击此文件即可启动工作台；实际启动流程仍由 auto_tools/start.sh 负责。
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
STATUS=0

if ! cd "$APP_DIR"; then
  echo "无法进入项目目录，请确认项目文件没有被移动或删除。"
  STATUS=1
elif [ "$(uname -s)" != "Darwin" ]; then
  echo "这个双击启动文件适用于 macOS。"
  echo "其他系统请按 auto_tools/README.md 中的命令启动。"
  STATUS=1
else
  echo "正在启动商品工作台，请稍候……"
  echo "首次启动需要安装依赖，可能需要几分钟。"
  echo "----------------------------------------"
  bash "$APP_DIR/auto_tools/start.sh" "$@"
  STATUS=$?
fi

echo ""
if [ "$STATUS" -eq 0 ]; then
  echo "启动流程已结束。"
else
  echo "启动没有完成，请查看上方提示；需要帮助时可把这段提示发给项目维护者。"
fi
read -r -p "按回车关闭此窗口……" _
exit "$STATUS"
