@echo off
chcp 65001 >nul
title 数据清洁工 安装器
setlocal
set "PS1=%~dp0install.ps1"
if not exist "%PS1%" (
  echo 没找到 install.ps1，正在下载...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseB 'https://raw.githubusercontent.com/wyndam-c/st-data-janitor/main/install.ps1' -OutFile '%PS1%'"
)
if not exist "%PS1%" (
  echo 下载失败，请手动下载 install.ps1 放到本文件夹，或检查网络/代理。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
echo 按任意键关闭...
pause >nul
