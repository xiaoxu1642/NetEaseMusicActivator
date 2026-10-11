<#
  dist/chrome → NetEaseMusicActivator-v<version>.zip，并把包内容与 dist 对账。

  这一跳原先在仓库里没有真源（全靠手敲 Compress-Archive），所以「包里缺 LICENSE」没有任何东西会拦 ——
  v1.1.0–v1.2.4 六个已发布扩展包都是那么外流的。缺件在这里是 throw，不是 warn。
  对账锚点用「文件名 + 内容哈希」，不用条目时间戳。
  跑法：pwsh -NoProfile -File scripts\pack.ps1   （或加 -SkipBuild 复用现有 dist）
#>
param(
    [string]$OutDir = "",
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist\chrome'

if (-not $SkipBuild) {
    node (Join-Path $root 'build.js')
    if ($LASTEXITCODE -ne 0) { throw "build.js 失败（exit=$LASTEXITCODE）" }
}
if (-not (Test-Path $dist)) { throw "dist/chrome 不存在，先跑 node build.js" }

$version = (Get-Content (Join-Path $dist 'manifest.json') -Raw | ConvertFrom-Json).version
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $root 'docs' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zipPath = Join-Path $OutDir "NetEaseMusicActivator-v$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

if (-not ('System.IO.Compression.ZipFile' -as [type])) { Add-Type -AssemblyName System.IO.Compression.FileSystem }

# CreateFromDirectory 用正斜杠写条目名，解压即是可加载的扩展目录（manifest.json 在压缩包根）。
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $dist, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)

$source = Get-ChildItem -Path $dist -Recurse -File |
    ForEach-Object { ($_.FullName.Substring($dist.Length + 1) -replace '\\', '/') } | Sort-Object

$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' } | Sort-Object)
    $entryHashes = @()
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName -replace '\\', '/'
        $stream = $entry.Open()
        try {
            $sha256 = [System.Security.Cryptography.SHA256]::Create()
            $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLower()
        } finally { $stream.Dispose() }
        $entryHashes += [pscustomobject]@{ Name = $name; Sha256 = $hash }
    }
} finally { $archive.Dispose() }

$missing = @($source | Where-Object { $entries -notcontains $_ })
$extra = @($entries | Where-Object { $source -notcontains $_ })
if ($missing.Count -or $extra.Count) {
    throw "包内容与 dist 不一致`n  缺少: $($missing -join ', ')`n  多余: $($extra -join ', ')"
}
if ($entries -notcontains 'LICENSE') { throw "包里缺 LICENSE —— GPL-3.0 承诺不能只在仓库里" }

Write-Host "ZIP=$zipPath"
Write-Host "ENTRIES=$($entries.Count) HAS_LICENSE=True"
Write-Host "SHA256(zip)=$((Get-FileHash -Path $zipPath -Algorithm SHA256).Hash)"
Write-Host "包内 sha256 清单（可直接贴进 release notes）："
foreach ($e in $entryHashes) { Write-Host ("  {0}  {1}" -f $e.Sha256, $e.Name) }
