@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo Starting workspace. Please keep this window open.

set "START_ARGS="
:parse_args
if "%~1"=="" goto run
if /I "%~1"=="--build-web" (
  set "START_ARGS=%START_ARGS% -BuildWeb"
) else if /I "%~1"=="--doctor" (
  set "START_ARGS=%START_ARGS% -Doctor"
) else if /I "%~1"=="--prepare" (
  set "START_ARGS=%START_ARGS% -Prepare"
) else (
  echo Unknown option: %~1
  exit /b 1
)
shift
goto parse_args

:run
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动工作台.ps1" %START_ARGS%

set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Startup failed. Please check the messages above.
echo Press Enter to close this window.
set /p "_="
exit /b %EXIT_CODE%
