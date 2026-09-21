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
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$app  = Join-Path $root 'app'

if (-not (Test-Path (Join-Path $app 'server.js'))) {
    Write-Host "找不到 app\server.js，请确认脚本和 app 目录在同一层。" -ForegroundColor Red
    exit 1
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

Push-Location $app
try {
    # 用绝对路径启动：命令行里带完整项目路径，tools\kill-safe.js 才能识别归属。
    # 用相对路径时命令行只有 "node server.js"，清理工具无法判断，会保守拒绝。
    node (Join-Path $app 'server.js')
} finally {
    Pop-Location
}
