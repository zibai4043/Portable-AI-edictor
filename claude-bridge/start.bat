@echo off
echo ====================================
echo Claude Code Bridge Server Launcher
echo ====================================
echo.

cd /d "%~dp0"

echo Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

echo Checking dependencies...
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

echo.
echo Starting server...
echo.

node server.js

pause