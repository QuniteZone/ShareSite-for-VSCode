# 停止只读文件阅读站点（share-site）
# 用法：powershell -ExecutionPolicy Bypass -File stop-share-site.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root 'run\share-site.pid'

$configPath = Join-Path $root 'config.json'
$port = 8010
if (Test-Path $configPath) {
  $raw = Get-Content $configPath -Raw -Encoding UTF8
  $json = $raw -replace '^﻿', '' | ConvertFrom-Json
  if ($json.port) { $port = [int]$json.port }
}

$targets = @()

if (Test-Path $pidFile) {
  $saved = [int](Get-Content $pidFile -Raw).Trim()
  $proc = Get-Process -Id $saved -ErrorAction SilentlyContinue
  if ($proc) { $targets += $proc }
}

foreach ($conn in (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node' -and -not ($targets | Where-Object { $_.Id -eq $proc.Id })) {
    $targets += $proc
  }
}

if (-not $targets) {
  Write-Host "[share-site] 未发现运行中的实例（端口 $port）"
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

foreach ($proc in $targets) {
  Write-Host "[share-site] 停止 PID $($proc.Id)"
  Stop-Process -Id $proc.Id -Force
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "[share-site] 已停止"
