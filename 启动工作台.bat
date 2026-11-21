@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo Starting workspace. Please keep this window open.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动工作台.ps1" -BuildWeb

set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Startup failed. Please check the messages above.
echo Press Enter to close this window.
set /p "_="
exit /b %EXIT_CODE%
