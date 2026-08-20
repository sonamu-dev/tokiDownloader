@echo off
chcp 65001 > nul
title Toki Novel Downloader

if exist "TokiNovelDownloader.exe" (
    start "" "TokiNovelDownloader.exe"
    exit
)

if exist "dist\TokiNovelWpf.exe" (
    start "" "dist\TokiNovelWpf.exe"
    exit
)

echo ======================================================
echo   📚 Toki Novel Downloader 웹 GUI를 실행하는 중입니다...
echo   (이 콘솔 창은 최소화해 두시면 됩니다)
echo ======================================================
echo.

node gui.js
