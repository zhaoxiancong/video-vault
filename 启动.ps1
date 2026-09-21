#Requires -Version 5.1
<#
.SYNOPSIS
    启动视频下载工具（可选：自动打开浏览器、指定端口）。
.EXAMPLE
    .\启动.ps1
    .\启动.ps1 -Port 8899 -NoBrowser
#>
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $root 'src\main.js'

if (-not (Test-Path $entry)) {
    Write-Host "找不到 src\main.js，请确认脚本和 src 目录在同一层。" -ForegroundColor Red
    exit 1
}

# 引擎（yt-dlp / ffmpeg）约 344MB，没有放进仓库，首次运行要下载一次。
$ytdlp = Join-Path $root 'tools\bin\ytdlp-win\yt-dlp.exe'
if (-not (Test-Path $ytdlp)) {
    Write-Host ""
    Write-Host "  首次运行：正在准备下载引擎（约 344MB，只需一次）…" -ForegroundColor Yellow
    & node (Join-Path $root 'tools\bootstrap-engine.js')
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  引擎准备失败，请看上面的提示。" -ForegroundColor Red
        exit 1
    }
}

$env:VAULT_PORT = "$Port"
$url = "http://127.0.0.1:$Port"

Write-Host ""
Write-Host "  启动视频下载工具…" -ForegroundColor Cyan
Write-Host "  地址：$url"
Write-Host "  按 Ctrl+C 停止（未完成的任务会保留，下次可手动继续）"
Write-Host ""

if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
        param($u)
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            try {
                $r = Invoke-WebRequest -Uri "$u/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($r.StatusCode -eq 200) { Start-Process $u; break }
            } catch { }
        }
    } -ArgumentList $url | Out-Null
}

# 用绝对路径启动：命令行里带完整项目路径，工作区的 tools\kill-safe.js
# 才能识别出"这个进程属于本项目"并安全清理。
# 用相对路径时命令行只有 "node src/main.js"，清理工具无法判断归属，会保守拒绝。
node $entry
