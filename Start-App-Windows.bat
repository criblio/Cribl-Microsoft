@echo off
setlocal enabledelayedexpansion
title Cribl SOC Optimization Toolkit for Microsoft Sentinel

REM =================================================================
REM  Cribl SOC Optimization Toolkit Launcher
REM
REM  Runs the app from source using Node.js and Electron.
REM  Requires Node.js 18+ (https://nodejs.org/).
REM  First run will prompt to install npm dependencies.
REM
REM  Running from source avoids EDR false positives that packaged
REM  .exe files can trigger on corporate machines.
REM =================================================================

REM Clear ELECTRON_RUN_AS_NODE if inherited from parent (VSCode, Cursor, etc. set this)
REM When set, Electron runs scripts as plain Node and this app's main process
REM can't access the Electron API (app, BrowserWindow, etc.).
set ELECTRON_RUN_AS_NODE=

cd /d "%~dp0Cribl-Microsoft_IntegrationSolution"

echo ============================================================
echo   Cribl SOC Optimization Toolkit for Microsoft Sentinel
echo ============================================================
echo.

REM Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download it from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if dependencies need to be installed
if not exist "node_modules" (
    echo [NOTICE] Node.js dependencies have not been installed yet.
    echo          This will run "npm install" to download packages
    echo          defined in package.json from the npm registry.
    echo.
    echo          Review package.json before proceeding if this is
    echo          your first time running the application.
    echo.
    set /p CONFIRM="Install dependencies now? (Y/N): "
    if /i not "!CONFIRM!"=="Y" (
        echo Cancelled. Install dependencies manually with: npm install
        pause
        exit /b 0
    )
    echo.
    echo Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed. Check your network connection.
        pause
        exit /b 1
    )
    echo.
)

echo Clearing build cache and session config...
if exist "%APPDATA%\.cribl-microsoft\config\integration-mode.json" del "%APPDATA%\.cribl-microsoft\config\integration-mode.json"
if exist "dist-electron" rmdir /s /q "dist-electron"
if exist "node_modules\.vite" rmdir /s /q "node_modules\.vite"

echo Starting application...
call npm run dev
