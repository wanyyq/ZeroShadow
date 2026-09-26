@echo off
title ZeroShadow Auto-Building

echo ============================================
echo   ZeroShadow Auto-Building Script
echo ============================================
echo.

:: ===== Check Node.js =====
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 18+
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_MAJOR=%%a
set NODE_MAJOR=%NODE_MAJOR:~1%
echo [INFO] Node.js major version: %NODE_MAJOR%

if %NODE_MAJOR% lss 18 (
    echo [WARN] Node.js 18+ is recommended. Current version may cause build failures.
)

:: ===== Install pkg =====
where pkg >nul 2>&1
if %errorlevel% neq 0 (
    echo [STEP] Installing pkg globally...
    npm install -g pkg
    if %errorlevel% neq 0 (
        echo [ERROR] pkg install failed
        pause
        exit /b 1
    )
)

:: ===== Install dependencies =====
echo.
echo [STEP] Installing server dependencies...
cd /d "%~dp0server"
call pnpm install
if %errorlevel% neq 0 (
    echo [ERROR] Server dependency install failed
    pause
    exit /b 1
)

cd /d "%~dp0"
echo [STEP] Installing web dependencies...
cd /d "%~dp0web"
call pnpm install
if %errorlevel% neq 0 (
    echo [ERROR] Web dependency install failed
    pause
    exit /b 1
)

:: ===== Build frontend =====
echo.
echo [STEP] Building frontend (Vite)...
call pnpm build
if %errorlevel% neq 0 (
    echo [ERROR] Frontend build failed
    pause
    exit /b 1
)

:: ===== Clean old config =====
cd /d "%~dp0"
if exist "data\config.json" (
    echo [STEP] Cleaning old debug config...
    del /q "data\config.json" 2>nul
)

:: ===== Bundle server to CJS (pkg doesn't support ESM well) =====
echo.
echo [STEP] Bundling server ESM to CJS (esbuild)...
cd /d "%~dp0server"
call pnpm bundle
if %errorlevel% neq 0 (
    echo [ERROR] esbuild bundle failed
    pause
    exit /b 1
)

:: ===== Package .exe =====
echo.
echo [STEP] Packaging ZeroShadow.exe (target: node18-win-x64)...
cd /d "%~dp0server"
call pkg dist\server-bundle.cjs --target node18-win-x64 --output ZeroShadow.exe
if %errorlevel% neq 0 (
    echo [ERROR] pkg build failed
    pause
    exit /b 1
)

:: ===== Create release directory =====
echo.
echo [STEP] Creating release directory...
cd /d "%~dp0"
set RELEASE_DIR=ZeroShadow-Release
set RELEASE_ZIP=ZeroShadow-Release.zip

if exist "%RELEASE_DIR%" rd /s /q "%RELEASE_DIR%"
mkdir "%RELEASE_DIR%"
mkdir "%RELEASE_DIR%\data"

copy /y "server\ZeroShadow.exe" "%RELEASE_DIR%\" >nul
xcopy /E /I /Y "web\dist" "%RELEASE_DIR%\web\dist\" >nul
copy /y ".env.example" "%RELEASE_DIR%\.env.example" >nul

:: ===== Package + secret gate =====
:: package-release.ps1 purges runtime secrets (.env, data\.jwt-secret,
:: data\users.json, data\config.json, logs) from the release directory and
:: refuses to build the archive if any secret would ship. Never zip the
:: project root: it contains .env and data\ and would leak credentials.
echo.
echo [STEP] Packaging and verifying (secret gate)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-release.ps1" -ReleaseDir "%RELEASE_DIR%" -ZipPath "%RELEASE_ZIP%"
if %errorlevel% neq 0 (
    echo [ERROR] Packaging failed or secrets were detected - see output above
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Build SUCCESS!
echo   Output: %~dp0%RELEASE_DIR%
echo   Zip:    %~dp0%RELEASE_ZIP%
echo ============================================
echo.
echo Release folder:
echo   %RELEASE_DIR%\
echo     ZeroShadow.exe     - Backend executable
echo     web\dist\          - Frontend static files
echo     .env.example       - Config template (copy to .env on first run)
echo     data\              - Empty runtime data folder
echo.
echo IMPORTANT: .env is generated automatically on first run, in the same
echo            folder as ZeroShadow.exe. Never ship a .env file.
echo.
pause
