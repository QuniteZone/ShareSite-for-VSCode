# 启动只读文件阅读站点（share-site）
# 用法：powershell -ExecutionPolicy Bypass -File start-share-site.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root 'run\share-site.pid'
$outLog = Join-Path $root 'logs\share-site.out.log'
$errLog = Join-Path $root 'logs\share-site.err.log'
$node = 'C:\Program Files\nodejs\node.exe'

if (-not (Test-Path $node)) {
  $node = (Get-Command node).Source
}

function Get-SitePort {
  $configPath = if ($env:QGZ_SHARE_CONFIG) { $env:QGZ_SHARE_CONFIG } else { Join-Path $root 'config.json' }
  if (-not (Test-Path $configPath)) {
    Write-Host "[share-site] 找不到配置文件：$configPath"
    Write-Host "[share-site] 请先复制 config.example.json 为 config.json，填写 token 和 roots 后再启动。"
    exit 1
  }
  $raw = Get-Content $configPath -Raw -Encoding UTF8
  $json = $raw -replace '^\uFEFF', '' | ConvertFrom-Json
  if ($json.port) { return [int]$json.port }
  return 8010
}

$port = Get-SitePort

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[share-site] 已在运行，端口 $port（PID $($existing[0].OwningProcess)）"
  exit 0
}

New-Item -ItemType Directory -Force (Split-Path $pidFile) | Out-Null
New-Item -ItemType Directory -Force (Split-Path $outLog) | Out-Null

$process = Start-Process -FilePath $node `
  -ArgumentList 'server.js' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

Set-Content -Path $pidFile -Value $process.Id -Encoding utf8
Start-Sleep -Seconds 2

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "[share-site] 已启动：http://127.0.0.1:$port（PID $($process.Id)）"
} else {
  Write-Host "[share-site] 启动失败，请查看 $errLog"
  if (Test-Path $errLog) { Get-Content $errLog -Tail 20 }
  exit 1
}
