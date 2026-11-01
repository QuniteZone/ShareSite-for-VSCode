param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    # 默认读仓库里的 server\config.json；也可以指向 ~/.qgz-share/config.json
    [string]$Config = $(if ($env:QGZ_SHARE_CONFIG) { $env:QGZ_SHARE_CONFIG } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'server\config.json' }),

    [ValidateSet('view', 'browse', 'home')]
    [string]$Mode = 'view',

    [switch]$NoClipboard
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Config)) {
    throw "找不到分享配置文件：$Config"
}

$raw = [IO.File]::ReadAllText($Config, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
$shareConfig = $raw | ConvertFrom-Json

$token = [string]$shareConfig.token
if (-not $token -or $token.Length -lt 24) {
    throw '配置文件里的 token 无效'
}

$baseUrl = [string]$shareConfig.baseUrl
if (-not $baseUrl) {
    $port = if ($shareConfig.port) { [int]$shareConfig.port } else { 8010 }
    $baseUrl = 'http://127.0.0.1:{0}' -f $port
}
$baseUrl = $baseUrl.TrimEnd('/')

$shareBase = '{0}/s/{1}' -f $baseUrl, [uri]::EscapeDataString($token)

function Get-RealPath([string]$value) {
    try {
        return (Resolve-Path -LiteralPath $value).ProviderPath
    } catch {
        return [IO.Path]::GetFullPath($value)
    }
}

# 向本机 share-site 申请 8 位短 id；服务没起或请求失败时返回 $null，调用方回退成长链接。
function Get-ShortId([string]$vpath) {
    if (-not $vpath) { return $null }
    $port = 0
    if ($shareConfig.port) { $port = [int]$shareConfig.port }
    if ($port -le 0) { return $null }

    try {
        $api = 'http://127.0.0.1:{0}/api/link?vpath={1}&token={2}' -f $port, [uri]::EscapeDataString($vpath), [uri]::EscapeDataString($token)
        $response = Invoke-RestMethod -Uri $api -TimeoutSec 2 -UseBasicParsing
        if ($response -and $response.id) { return [string]$response.id }
    } catch {
        # 本机服务未启动或超时
    }
    return $null
}

if ($Mode -eq 'home') {
    $url = $shareBase + '/'
} else {
    $target = Get-RealPath $Path

    $matched = $null
    foreach ($root in $shareConfig.roots) {
        if (-not $root.path) { continue }
        $rootPath = Get-RealPath ([string]$root.path)
        $rootFull = $rootPath.TrimEnd('\', '/')
        if ($target -eq $rootFull -or $target.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
            $matched = [pscustomobject]@{
                Name    = [string]$root.name
                Enabled = ($root.enabled -ne $false)
                Path    = $rootFull
            }
            break
        }
    }

    if (-not $matched) {
        $names = ($shareConfig.roots | Where-Object { $_.enabled -ne $false } | ForEach-Object { $_.name }) -join '、'
        throw "该路径不在分享目录内，无法生成链接。当前分享目录：$names"
    }

    if (-not $matched.Enabled) {
        throw "目录「$($matched.Name)」在分享配置里未启用，请先在 config.json 中把 enabled 改为 true"
    }

    $relative = $target.Substring($matched.Path.Length).TrimStart('\', '/')
    $vpath = $relative -replace '\\', '/'

    $isDirectory = (Test-Path -LiteralPath $target -PathType Container)
    # /api/link 的 vpath 以根目录名开头（和页面内部链接一致）
    $apiVpath = if ($vpath) { '{0}/{1}' -f $matched.Name, $vpath } else { $matched.Name }
    $shortId = Get-ShortId $apiVpath

    if (-not $vpath) {
        $url = $shareBase + '/'
    } elseif ($shortId) {
        $url = '{0}/{1}' -f $shareBase, $shortId
    } elseif ($Mode -eq 'browse' -or $isDirectory) {
        $url = '{0}/browse?p={1}' -f $shareBase, [uri]::EscapeDataString($vpath)
    } else {
        $url = '{0}/view?p={1}' -f $shareBase, [uri]::EscapeDataString($vpath)
    }
}

if (-not $NoClipboard) {
    try {
        Set-Clipboard -Value $url -ErrorAction Stop
    } catch {
        # Clipboard can be unavailable in a non-interactive session.
    }
}

Write-Output $url
