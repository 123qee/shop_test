@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo 正在启动工作台，运行期间请保持这个窗口打开。

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动工作台.ps1" -BuildWeb

set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo 启动没有完成，请查看上方提示。
echo 按回车关闭此窗口。
set /p "_="
exit /b %EXIT_CODE%
