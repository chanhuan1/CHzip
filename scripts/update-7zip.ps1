<#
.SYNOPSIS
    下载并更新 CHzip 内置的 7-Zip 静态二进制（7zzs）。

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
    从 7-zip.org 官方源拉取 linux-x64 / linux-arm64 两个 7zzs，
    校验 SHA256 后写入 app/vendor/7zip/ 对应架构目录，
    并同步刷新 License.txt 与 readme.txt。
#>

$ErrorActionPreference = "Stop"

# 内置 7-Zip 版本；升级时只需改这里与下方两组 SHA256。
$SevenZipVersion = "26.02"
$CompactVersion = $SevenZipVersion.Replace(".", "")

# 仓库根目录（本脚本位于 scripts/ 下）与下载缓存目录。
$RepoRoot = Split-Path -Parent $PSScriptRoot
$WorkspaceRoot = Split-Path -Parent $RepoRoot
$CacheRoot = Join-Path $WorkspaceRoot ".codex-cache\7zip-$SevenZipVersion"

# 各架构的下载地址、官方 SHA256 与安装目标目录。
$SevenZipPackages = @(
    [PSCustomObject]@{
        Arch        = "x64"
        Url         = "https://www.7-zip.org/a/7z$CompactVersion-linux-x64.tar.xz"
        Sha256      = "41aaba7b1235304ab5aa0624530c67ae829496cd29e875925271efdccc28c03e"
        TargetDir   = "linux-x64"
    },
    [PSCustomObject]@{
        Arch        = "arm64"
        Url         = "https://www.7-zip.org/a/7z$CompactVersion-linux-arm64.tar.xz"
        Sha256      = "70ea6cc737ae1495ea2d7eb20ef3120fe579bd3f1a83a9d2362b62ec5bde2bba"
        TargetDir   = "linux-arm64"
    }
)

New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null

foreach ($package in $SevenZipPackages) {
    # 已下载过的压缩包直接复用，避免重复拉取。
    $archivePath = Join-Path $CacheRoot "$($package.Arch).tar.xz"
    $extractDir = Join-Path $CacheRoot $package.Arch

    if (-not (Test-Path -LiteralPath $archivePath)) {
        Invoke-WebRequest -Uri $package.Url -OutFile $archivePath
    }

    # 哈希不匹配即中止，绝不把未校验的二进制写进 vendor。
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $package.Sha256) {
        throw "7-Zip $($package.Arch) 校验和不匹配：$actualHash"
    }

    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    tar.exe -xf $archivePath -C $extractDir

    $destinationDir = Join-Path $RepoRoot "app\vendor\7zip\$($package.TargetDir)"
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $extractDir "7zzs") -Destination (Join-Path $destinationDir "7zzs") -Force
}

# 以 x64 包内的许可证与说明文件为准，刷新 vendor 根目录的两份文档。
Copy-Item -LiteralPath (Join-Path $CacheRoot "x64\License.txt") -Destination (Join-Path $RepoRoot "app\vendor\7zip\License.txt") -Force
Copy-Item -LiteralPath (Join-Path $CacheRoot "x64\readme.txt") -Destination (Join-Path $RepoRoot "app\vendor\7zip\readme.txt") -Force

Write-Host "7-Zip $SevenZipVersion 二进制已更新。"
