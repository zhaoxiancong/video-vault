@echo off
REM ============================================================================
REM  Video Vault launcher -- double-click this.
REM
REM  *** THIS FILE MUST STAY PURE ASCII. ***
REM  Reason (measured, not theoretical): cmd.exe tokenizes a .cmd file using the
REM  system ANSI codepage, while `chcp 65001` only affects *output*. Multi-byte
REM  UTF-8 characters therefore get mis-split and cmd ends up treating Chinese
REM  prose as commands. The observed symptom was cmd printing, for every Chinese
REM  line, "<mojibake> is not recognized as an internal or external command" --
REM  and the service never starting at all.
REM
REM  Chinese UI text lives in tools\launcher-banner.js (node reads UTF-8 fine).
REM  Same reason this file uses CRLF line endings: cmd.exe is unreliable with
REM  LF-only batch files.
REM
REM  After editing this file or the sibling .ps1 launcher, ALWAYS run:
REM      node tools\fix-launchers.js
REM  (editors write UTF-8 without BOM and with LF, which is the wrong shape for
REM  both files -- it "looks fine" and then breaks on double-click.)
REM
REM  Design note: this file starts the server in the FOREGROUND and lets the
REM  server open the browser itself (--open). Earlier versions polled for
REM  readiness from here, which forced the server into the background -- and a
REM  background process survives this window closing, making the "close the
REM  window to stop the tool" promise below a lie. Foreground means the server
REM  dies with the window, and Ctrl+C lets it pause unfinished tasks cleanly.
REM ============================================================================

chcp 65001 >nul 2>&1
title Video Vault
cd /d "%~dp0"

node "%~dp0tools\launcher-banner.js" banner

REM --- engine (yt-dlp / ffmpeg, ~344MB, deliberately not in git) -------------
if not exist "tools\bin\ytdlp-win\yt-dlp.exe" (
  node "%~dp0tools\launcher-banner.js" engine
  node "%~dp0tools\bootstrap-engine.js"
  if errorlevel 1 (
    node "%~dp0tools\launcher-banner.js" failed
    pause
    exit /b 1
  )
)

REM  Absolute path on purpose: the command line then contains the full project
REM  path, which is how the workspace tools\kill-safe.js recognises that this
REM  process belongs to this project and may safely be cleaned up.
node "%~dp0src\main.js" --open

echo.
echo   Stopped. Press any key to close.
pause >nul
