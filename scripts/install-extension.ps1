# 把本仓库的 extension/ 安装到指定的扩展目录（用户级，不需要管理员）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-extension.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-extension.ps1 -ExtensionsDir "C:\Users\me\.code-serve-web\data\extensions" -Register
#
# 说明：
#   - 默认装到 %USERPROFILE%\.vscode\extensions（桌面版 VS Code）
#   - code-server / serve-web 一般是 <data>\extensions，需要手动 -ExtensionsDir
#   - -Register 会顺带更新该目录下的 extensions.json 清单

param(
    [string]$ExtensionsDir = (Join-Path $env:USERPROFILE '.vscode\extensions'),
    [switch]$Register
)

$ErrorActionPreference = 'Stop'

$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'extension'
$manifestPath = Join-Path $source 'package.json'

if (-not (Test-Path $manifestPath)) {
    throw "找不到扩展源目录：$source"
}

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$id = '{0}.{1}' -f $manifest.publisher, $manifest.name
$folderName = '{0}-{1}' -f $id, $manifest.version
$target = Join-Path $ExtensionsDir $folderName

New-Item -ItemType Directory -Force $ExtensionsDir | Out-Null

if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
}
Copy-Item $source $target -Recurse

Write-Host ('[install] 已复制到 {0}' -f $target)

if ($Register) {
    $extensionsJson = Join-Path $ExtensionsDir 'extensions.json'
    if (-not (Test-Path $extensionsJson)) {
        Write-Host ('[install] 没有 {0}，跳过注册（重启编辑器后一般会自动扫描）' -f $extensionsJson) -ForegroundColor Yellow
        exit 0
    }

    $list = Get-Content $extensionsJson -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($list -isnot [System.Array]) {
        $list = @($list)
    }

    $entry = $list | Where-Object { $_.identifier -and $_.identifier.id -eq $id } | Select-Object -First 1
    if (-not $entry) {
        Write-Host ('[install] 清单里没有 {0}，请在编辑器里手动安装一次后再重试' -f $id) -ForegroundColor Yellow
        exit 0
    }

    $entry.version = $manifest.version
    $entry.relativeLocation = $folderName
    $entry.location = [pscustomobject]@{
        '$mid'   = 1
        path     = '/' + ($target -replace '\\', '/')
        scheme   = 'file'
    }

    ConvertTo-Json -InputObject @($list) -Depth 12 -Compress | Set-Content $extensionsJson -Encoding utf8 -NoNewline
    Write-Host ('[install] 已注册 {0}@{1}' -f $id, $manifest.version)
}

Write-Host '[install] 重启编辑器后生效（命令面板搜索「分享」）'
