@echo off
chcp 65001 >nul
title 视频下载工具 Video Vault
cd /d "%~dp0app"

echo.
echo   ============================================
echo      视频下载工具  Video Vault
echo   ============================================
echo.
echo   正在启动，稍后会自动打开浏览器...
echo   关闭本窗口即停止工具（未完成的任务会保留，下次可继续）
echo.

start "" http://127.0.0.1:8787
REM 用绝对路径启动：这样命令行里带完整项目路径，
REM tools\kill-safe.js 才能识别出"这个进程属于本项目"并安全清理。
REM （用相对路径时命令行只有 "node server.js"，清理工具无法判断归属，会保守拒绝）
node "%~dp0app\server.js"

echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
