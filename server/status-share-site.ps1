# 查看只读文件阅读站点（share-site）状态
# 用法：powershell -ExecutionPolicy Bypass -File status-share-site.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $root 'config.json'

$port = 8010
$baseUrl = ''
if (Test-Path $configPath) {
  $raw = Get-Content $configPath -Raw -Encoding UTF8
  $json = $raw -replace '^﻿', '' | ConvertFrom-Json
  if ($json.port) { $port = [int]$json.port }
  if ($json.baseUrl) { $baseUrl = [string]$json.baseUrl }
}

$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if ($conn) {
  $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  Write-Host "[share-site] 状态：运行中"
  Write-Host "  本地地址：http://127.0.0.1:$port"
  if ($baseUrl) { Write-Host "  公网地址：$baseUrl" }
  Write-Host "  PID：$($conn.OwningProcess)（$($proc.ProcessName)）"
  try {
    $res = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -UseBasicParsing -TimeoutSec 5
    Write-Host "  健康检查：HTTP $($res.StatusCode)"
  } catch {
    Write-Host "  健康检查：失败（$($_.Exception.Message)）"
  }
} else {
  Write-Host "[share-site] 状态：未运行（端口 $port 无监听）"
}
