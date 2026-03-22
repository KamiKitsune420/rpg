@echo off
title Game Server

:: Check Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Download it from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
    echo [INFO] node_modules not found. Running npm install...
    npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

:: Check .env exists, create from example if not
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] No .env file found. Copying from .env.example...
        copy ".env.example" ".env" >nul
        echo [ACTION REQUIRED] Open .env and fill in JWT_SECRET, ADMIN_KEY, and BASE_URL.
        echo                   Then run this script again.
        pause
        exit /b 0
    ) else (
        echo [ERROR] No .env or .env.example found.
        pause
        exit /b 1
    )
)

echo.
echo  Game Server starting...
echo  Listening on http://localhost:3000
echo  Press Ctrl+C to stop.
echo.

npm start
pause
