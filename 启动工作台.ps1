param(
  [switch]$BuildWeb,
  [switch]$Doctor,
  [switch]$Prepare
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$autoTools = Join-Path $root 'auto_tools'
$serverDir = Join-Path $autoTools 'server'
$webDir = Join-Path $autoTools 'web'
$startup = Join-Path $autoTools 'scripts/startup.mjs'
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$ngrokPort = if ($env:NGROK_PORT) { [int]$env:NGROK_PORT } else { $port }
$ngrokUrl = if ($env:NGROK_URL) { $env:NGROK_URL } else { 'https://java-suburb-kettle.ngrok-free.dev' }
$ngrokEnabled = if ($env:NGROK_ENABLED) { $env:NGROK_ENABLED -ne '0' } else { $true }
$serverProcess = $null
$ngrokProcess = $null
$ownsServer = $false
$serverOut = Join-Path $autoTools '.windows-server.log'
$serverErr = Join-Path $autoTools '.windows-server-error.log'
$ngrokOut = Join-Path $autoTools '.windows-ngrok.log'
$ngrokErr = Join-Path $autoTools '.windows-ngrok-error.log'
$scriptExitCode = 0

function Stop-ProcessTree([System.Diagnostics.Process]$Process) {
  if ($null -ne $Process) {
    $Process.Refresh()
    if (-not $Process.HasExited) {
      & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    }
  }
}

function Invoke-Startup([string[]]$StartupArgs) {
  & node $startup @StartupArgs
  if ($LASTEXITCODE -ne 0) {
    throw "启动准备失败：$($StartupArgs -join ' ')，退出码：$LASTEXITCODE。"
  }
}

function Test-ServerReady {
  try {
    Invoke-WebRequest -Uri "http://localhost:$port/api/health" -TimeoutSec 2 -UseBasicParsing | Out-Null
    return $true
  }
  catch {
    return $false
  }
}

function Show-RecentLog([string]$Path) {
  if (Test-Path $Path) {
    Write-Host "--- Recent log: $Path ---" -ForegroundColor DarkGray
    Get-Content $Path -Tail 30
  }
}

function Update-Repository {
  $gitProcess = $null
  try {
    $gitCommand = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $gitCommand) {
      Write-Host '没有找到 Git，跳过自动更新，继续使用本地代码启动。' -ForegroundColor Yellow
      return
    }

    Write-Host '正在尝试拉取当前分支的最新代码（最多等待 15 秒）……'
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $gitCommand.Source
    $startInfo.Arguments = 'pull --ff-only --no-rebase --no-autostash --no-recurse-submodules'
    $startInfo.WorkingDirectory = $root
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # 只影响本次 Git 子进程，避免凭证弹窗或 SSH 密码询问卡住启动。
    $startInfo.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $startInfo.EnvironmentVariables['GCM_INTERACTIVE'] = 'Never'
    $startInfo.EnvironmentVariables['GIT_ASKPASS'] = 'echo'
    $startInfo.EnvironmentVariables['SSH_ASKPASS'] = 'echo'
    $startInfo.EnvironmentVariables['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes -o ConnectTimeout=10'

    $gitProcess = New-Object System.Diagnostics.Process
    $gitProcess.StartInfo = $startInfo
    if (-not $gitProcess.Start()) { throw '无法启动 Git。' }
    $gitProcess.StandardInput.Close()
    # 同时读取两个输出流，防止 Git 输出过多时填满缓冲区。
    $outputTask = $gitProcess.StandardOutput.ReadToEndAsync()
    $errorTask = $gitProcess.StandardError.ReadToEndAsync()

    if (-not $gitProcess.WaitForExit(15000)) {
      Stop-ProcessTree $gitProcess
      Write-Host '拉取代码超时，已停止更新，继续使用本地代码启动。' -ForegroundColor Yellow
      return
    }

    $output = $outputTask.GetAwaiter().GetResult()
    $errorOutput = $errorTask.GetAwaiter().GetResult()
    if ($output) { Write-Host $output.TrimEnd() }
    if ($gitProcess.ExitCode -ne 0) {
      if ($errorOutput) { Write-Host $errorOutput.TrimEnd() -ForegroundColor DarkGray }
      Write-Host '拉取代码失败（网络、权限或本地改动等原因），继续使用本地代码启动。' -ForegroundColor Yellow
      return
    }
    Write-Host '代码更新检查完成，继续启动工作台。'
  }
  catch {
    Write-Host "自动更新未完成：$($_.Exception.Message) 继续使用本地代码启动。" -ForegroundColor Yellow
  }
  finally {
    if ($null -ne $gitProcess) { $gitProcess.Dispose() }
  }
}

try {
  if (-not $Doctor -and -not $Prepare) { Update-Repository }

  if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw '找不到 Node.js 或 npm。请先安装 Node.js 22 或更高版本，再重新双击启动。'
  }

  if ($Doctor) {
    & node $startup doctor
    $scriptExitCode = $LASTEXITCODE
    exit $scriptExitCode
  }
  Invoke-Startup @('check-node')

  $webBuild = Join-Path $webDir 'dist/index.html'
  if ($BuildWeb) { Invoke-Startup @('prepare-web', '--force') }
  else { Invoke-Startup @('prepare-web') }
  if ($Prepare) {
    Invoke-Startup @('prepare-server')
    Write-Host '依赖与网页准备完成，未启动服务。'
    exit 0
  }

  if (Test-ServerReady) {
    $page = Invoke-WebRequest -Uri "http://localhost:$port/" -TimeoutSec 5 -UseBasicParsing
    if ($page.Content -cne [System.IO.File]::ReadAllText($webBuild)) {
      throw "端口 $port 上的服务提供的网页与当前项目不同。请关闭旧工作台的启动窗口后，再双击当前目录的启动工作台.bat。"
    }
    Write-Host "服务已经在运行：http://localhost:$port"
  }
  else {
    Invoke-Startup @('prepare-server')

    if (-not (Test-Path (Join-Path $serverDir '.env'))) {
      Write-Host '提示：没有找到 server/.env。部分平台功能需要在该文件中配置凭证。' -ForegroundColor Yellow
    }

    Write-Host "正在启动后台服务：http://localhost:$port ……"
    $serverProcess = Start-Process -FilePath $env:ComSpec `
      -ArgumentList @('/d', '/c', 'npm run dev') `
      -WorkingDirectory $serverDir `
      -WindowStyle Hidden `
      -RedirectStandardOutput $serverOut `
      -RedirectStandardError $serverErr `
      -PassThru
    $ownsServer = $true

    Write-Host '正在等待后台服务启动……'
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      if (Test-ServerReady) {
        $ready = $true
        break
      }
      $serverProcess.Refresh()
      if ($serverProcess.HasExited) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
      Show-RecentLog $serverOut
      Show-RecentLog $serverErr
      throw '后台服务启动失败，请检查上方日志。'
    }
  }

  if ($ngrokEnabled) {
    $ngrokCommand = Get-Command ngrok.exe -ErrorAction SilentlyContinue
    if (-not $ngrokCommand) { $ngrokCommand = Get-Command ngrok -ErrorAction SilentlyContinue }
    if ($ngrokCommand) {
      Write-Host "正在启动 ngrok：$ngrokUrl ……"
      $ngrokProcess = Start-Process -FilePath $ngrokCommand.Source `
        -ArgumentList @('http', "$ngrokPort", '--url', $ngrokUrl) `
        -WindowStyle Hidden `
        -RedirectStandardOutput $ngrokOut `
        -RedirectStandardError $ngrokErr `
        -PassThru
      Start-Sleep -Seconds 2
      $ngrokProcess.Refresh()
      if ($ngrokProcess.HasExited) {
        Show-RecentLog $ngrokOut
        Show-RecentLog $ngrokErr
        Write-Host 'ngrok 启动失败，本地工作台仍可使用。' -ForegroundColor Yellow
        $ngrokProcess = $null
      }
      else {
        Write-Host "ngrok 已启动：$ngrokUrl"
      }
    }
    else {
      Write-Host '没有找到 ngrok，已跳过公网隧道；本地工作台仍可使用。' -ForegroundColor Yellow
    }
  }
  else {
    Write-Host 'NGROK_ENABLED=0，已跳过 ngrok。'
  }

  Start-Process "http://localhost:$port"
  Write-Host "工作台已启动：http://localhost:$port"
  Write-Host '按 Ctrl+C 停止本次启动的服务。'

  if ($ownsServer -and $null -ne $serverProcess) {
    while ($true) {
      $serverProcess.Refresh()
      if ($serverProcess.HasExited) { break }
      Start-Sleep -Seconds 1
    }
    Write-Host '后台服务已停止。'
    Show-RecentLog $serverOut
    Show-RecentLog $serverErr
  }
  elseif ($null -ne $ngrokProcess) {
    $ngrokProcess.WaitForExit()
  }
}
catch {
  Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
  $scriptExitCode = 1
}
finally {
  if ($ownsServer) { Stop-ProcessTree $serverProcess }
  Stop-ProcessTree $ngrokProcess
}

exit $scriptExitCode
