@echo off
setlocal enabledelayedexpansion
title Cribl SOC Optimization Toolkit for Microsoft Sentinel

REM =================================================================
REM  SOC-OptimizationToolkit Launcher (Windows)
REM
REM  Runs the desktop GUI from source using Node.js + Electron, the
REM  same way the previous app launched. Running from source (not a
REM  packaged .exe) is deliberate: it avoids the EDR false positives
REM  that packaged executables trigger on corporate machines.
REM
REM  Requires: Node.js 18+ (https://nodejs.org/) and pnpm
REM  (https://pnpm.io/installation, or run: corepack enable).
REM
REM  NOTE: this launches the NEW toolkit, which is scaffolded in
REM  roadmap Phase 0. Until that scaffold exists, this script reports
REM  that the toolkit is not built yet and exits cleanly.
REM =================================================================

REM Clear ELECTRON_RUN_AS_NODE if inherited from a parent (VSCode, Cursor,
REM etc. set this). When set, Electron runs scripts as plain Node and the
REM main process cannot access the Electron API (app, BrowserWindow, ...).
set ELECTRON_RUN_AS_NODE=

REM The launcher lives in the toolkit root, so %~dp0 IS the workspace root.
cd /d "%~dp0"

echo ============================================================
echo   Cribl SOC Optimization Toolkit for Microsoft Sentinel
echo ============================================================
echo.

REM Scaffold guard: the monorepo is created in roadmap Phase 0.
if not exist "pnpm-workspace.yaml" (
    echo [NOTICE] The toolkit has not been scaffolded yet.
    echo          The monorepo ^(pnpm-workspace.yaml, packages/, apps/^) is
    echo          created in roadmap Phase 0. See docs\roadmap.md.
    echo.
    pause
    exit /b 0
)

REM Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download it from https://nodejs.org/
    pause
    exit /b 1
)

REM Check pnpm
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] pnpm is not installed or not in PATH.
    echo         Enable it with "corepack enable" or see https://pnpm.io/installation
    pause
    exit /b 1
)

REM First-run install (pnpm installs the whole workspace from the root)
if not exist "node_modules" (
    echo [NOTICE] Workspace dependencies have not been installed yet.
    echo          This will run "pnpm install" to download the packages
    echo          defined across the workspace from the npm registry.
    echo.
    set /p CONFIRM="Install dependencies now? (Y/N): "
    if /i not "!CONFIRM!"=="Y" (
        echo Cancelled. Install manually with: pnpm install
        pause
        exit /b 0
    )
    echo.
    echo Installing dependencies...
    call pnpm install
    if %errorlevel% neq 0 (
        echo [ERROR] pnpm install failed. Check your network connection.
        pause
        exit /b 1
    )
    echo.
)

REM Clear desktop build cache (guarded; paths finalized in Phase 0)
if exist "apps\desktop\dist-electron" rmdir /s /q "apps\desktop\dist-electron"
if exist "apps\desktop\node_modules\.vite" rmdir /s /q "apps\desktop\node_modules\.vite"

echo Starting the desktop GUI from source...
REM Launches the Electron desktop app (apps/desktop). The exact dev script
REM is defined in Phase 0; this targets the desktop workspace package.
call pnpm --filter desktop dev
