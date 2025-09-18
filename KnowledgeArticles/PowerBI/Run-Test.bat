@echo off
REM Run-Test.bat - Quick launcher for Cribl connection test with Client Credentials
REM 
REM Usage: Double-click this file or run from command prompt
REM        You will be prompted for your Cribl Client ID and Secret

echo ========================================
echo  Cribl Search API Connection Test
echo  (Client Credentials Authentication)
echo ========================================
echo.

set /p INSTANCE="Enter your Cribl instance (e.g., acme.cribl.cloud): "
set /p CLIENT_ID="Enter your Client ID: "
set /p CLIENT_SECRET="Enter your Client Secret: "
set /p DATASET="Enter your dataset name: "

echo.
echo Starting connection test...
echo.

powershell.exe -ExecutionPolicy Bypass -File "Test-CriblConnection.ps1" -CriblInstance "%INSTANCE%" -ClientId "%CLIENT_ID%" -ClientSecret "%CLIENT_SECRET%" -Dataset "%DATASET%" -Verbose

echo.
echo Test complete.
pause