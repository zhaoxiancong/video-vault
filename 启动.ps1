#Requires -Version 5.1
<#
.SYNOPSIS
    启动视频下载工具（可选：指定端口）。

.DESCRIPTION
    这个脚本必须保存为 **带 BOM 的 UTF-8**：PowerShell 5.1 读无 BOM 的 UTF-8 会按系统
    ANSI（GBK）解析，中文注释与提示会变乱码，严重时把引号吃掉直接语法错误。
    行尾用 CRLF，与 .cmd 保持一致。改完跑 `node tools\fix-launchers.js` 校验。

    **浏览器由服务自己打开**（`--open`）。早期版本在这里轮询就绪状态再开浏览器，
    那要求服务跑在后台 —— 而后台进程会在窗口关闭后继续活着，把"关窗即停"变成假话；
    用后台作业（Start‑Job 那类）又依赖命名管道，受限环境里会失败。
    所以现在：前台运行服务，服务自己开浏览器。

.EXAMPLE
    .\启动.ps1
    .\启动.ps1 -Port 8899
#>
[CmdletBinding()]
param(
    [int]$Port = 8787
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

# 横幅由 tools\launcher-banner.js 打印，和 启动.cmd 共用同一份文案 ——
# 免得两处各写一份中文、然后慢慢不一致。
& node (Join-Path $root 'tools\launcher-banner.js') banner

# 前台运行。绝对路径：命令行里带完整项目路径，工作区的 tools\kill-safe.js
# 才能识别出"这个进程属于本项目"并安全清理。
# --open 让服务就绪后自己打开浏览器（见上面 DESCRIPTION 里的理由）。
& node $entry --open
