@echo off
chcp 65001 >nul
title Xianyu AI Local Service
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found. Please install Python 3 first.
  pause
  exit /b 1
)
python local_ai_server.py
if errorlevel 1 (
  echo.
  echo [ERROR] Service failed to start. Please send a screenshot of this window.
)
pause
