<#
.SYNOPSIS
    下载并更新 CHzip 内置的 Inter 可变字体（InterVariable.woff2）。

.DESCRIPTION
    CHzip - fnOS 智能分卷解压套件
    Copyright (C) 2026 chanhuan

    本程序是自由软件：你可以依据自由软件基金会发布的
    GNU 通用公共许可证第 3 版（或更高版本，由你选择）的条款，
    再分发和/或修改本程序。

    发布本程序是希望它能有用，但不附带任何担保；
    甚至不附带适销性或特定用途适用性的默示担保。
    详见 GNU 通用公共许可证（仓库根目录 LICENSE 文件）。

.NOTES
    仅在 Windows 开发机上手动运行，不参与打包与测试流程。
    从 rsms/inter 官方 Release 拉取字体压缩包，逐层校验 SHA256
    （压缩包 -> 字体文件 -> 许可证 -> 落盘后的目标文件）后写入
    app/www/fonts/。缓存目录默认在工作区 .codex-cache 下，
    可用环境变量 CHZIP_CACHE_ROOT 覆盖，但不允许指到工作区之外。
#>

$ErrorActionPreference = "Stop"

# ---- 版本与官方 SHA256（升级字体时改这里） ----
$InterVersion = "4.1"
$Hashes = [PSCustomObject]@{
    Archive = "9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e"
    Font    = "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3"
    License = "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a"
}

# ---- 路径推导 ----
$ArchiveFileName = "Inter-$InterVersion.zip"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $RepoRoot

# 缓存根：默认 <工作区>/.codex-cache，可被 CHZIP_CACHE_ROOT 覆盖。
$DefaultCacheRoot = [IO.Path]::GetFullPath((Join-Path $WorkspaceRoot ".codex-cache"))
$CacheRoot = $DefaultCacheRoot
if ($env:CHZIP_CACHE_ROOT) {
    $CacheRoot = [IO.Path]::GetFullPath($env:CHZIP_CACHE_ROOT)
}

# 安全闸：自定义缓存目录必须仍落在工作区之内，防止误写系统目录。
$CachePrefix = $DefaultCacheRoot.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
if (($CacheRoot -ne $DefaultCacheRoot) -and
    (-not $CacheRoot.StartsWith($CachePrefix, [StringComparison]::OrdinalIgnoreCase))) {
    throw "缓存目录必须位于工作区内：$CacheRoot"
}

$DownloadDir = Join-Path $CacheRoot "downloads"
$ExtractDir = Join-Path $CacheRoot "font-audit\inter-$InterVersion"
$ArchivePath = Join-Path $DownloadDir $ArchiveFileName
$PartialArchivePath = "$ArchivePath.part"
$FontSource = Join-Path $ExtractDir "web\InterVariable.woff2"
$LicenseSource = Join-Path $ExtractDir "LICENSE.txt"
$FontTargetDir = Join-Path $RepoRoot "app\www\fonts"
$FontTarget = Join-Path $FontTargetDir "InterVariable.woff2"
$LicenseTarget = Join-Path $FontTargetDir "LICENSE-Inter.txt"
$DownloadUrl = "https://github.com/rsms/inter/releases/download/v$InterVersion/$ArchiveFileName"

# ---- 工具函数 ----
# 校验某文件的 SHA256 是否等于期望值，不等即抛错中止。
function Confirm-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) {
        throw "Inter 校验和不匹配（$Path）：$actual"
    }
}

# ---- 主流程 ----
New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null
New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null

# 已有缓存的压缩包先自检，哈希坏了就删掉重下。
if (Test-Path -LiteralPath $ArchivePath) {
    try {
        Confirm-Sha256 -Path $ArchivePath -Expected $Hashes.Archive
    } catch {
        Remove-Item -LiteralPath $ArchivePath -Force
        Write-Warning "缓存的 Inter 压缩包校验失败，重新下载。"
    }
}

# 没有可用缓存时，走 .part 临时文件下载 -> 校验 -> 原子改名。
if (-not (Test-Path -LiteralPath $ArchivePath)) {
    Remove-Item -LiteralPath $PartialArchivePath -Force -ErrorAction SilentlyContinue
    try {
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $PartialArchivePath
        Confirm-Sha256 -Path $PartialArchivePath -Expected $Hashes.Archive
        Move-Item -LiteralPath $PartialArchivePath -Destination $ArchivePath -Force
    } finally {
        Remove-Item -LiteralPath $PartialArchivePath -Force -ErrorAction SilentlyContinue
    }
}
Confirm-Sha256 -Path $ArchivePath -Expected $Hashes.Archive

# 解包后分别校验字体与许可证文件。
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractDir -Force
Confirm-Sha256 -Path $FontSource -Expected $Hashes.Font
Confirm-Sha256 -Path $LicenseSource -Expected $Hashes.License

# 写入 vendor 目录，并对落盘结果再做一次校验（防写盘损坏）。
New-Item -ItemType Directory -Path $FontTargetDir -Force | Out-Null
Copy-Item -LiteralPath $FontSource -Destination $FontTarget -Force
Copy-Item -LiteralPath $LicenseSource -Destination $LicenseTarget -Force
Confirm-Sha256 -Path $FontTarget -Expected $Hashes.Font
Confirm-Sha256 -Path $LicenseTarget -Expected $Hashes.License

Write-Host "Inter $InterVersion 字体已更新（来源 $ArchivePath）。"
