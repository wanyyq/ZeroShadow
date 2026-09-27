@echo off
title ZeroShadow Auto-Building
setlocal

cd /d "%~dp0"

echo ============================================
echo   ZeroShadow Auto-Building
echo ============================================
echo.
echo This script is a thin wrapper: the real pipeline lives in
echo build-release.ps1, which is also what GitHub Actions calls.
echo That way the local and CI builds cannot drift apart.
echo.
echo Usage:
echo   Auto-building.bat                         all six platforms
echo   Auto-building.bat windows-x64             one platform
echo   Auto-building.bat windows-x64,linux-x64   several platforms
echo.
echo Platforms: windows-x64 windows-arm64 linux-x64 linux-arm64 linux-armv7
echo            (32-bit Windows is not buildable - see README)
echo.

node -v >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js 18 or newer.
    pause
    exit /b 1
)

where pwsh >nul 2>&1
if errorlevel 1 (set "PS=powershell") else (set "PS=pwsh")

set "TARGETS="
if not "%~1"=="" set "TARGETS=-Targets %~1"

echo [STEP] Invoking build-release.ps1 %TARGETS%
echo.

%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-release.ps1" %TARGETS%
set "BUILD_EXIT=%errorlevel%"

echo.
if not "%BUILD_EXIT%"=="0" (
    echo ============================================
    echo   Build FAILED  ^(exit code %BUILD_EXIT%^)
    echo ============================================
    echo   exit 1 = fatal error ^(toolchain or a build step^)
    echo   exit 2 = at least one platform failed
    echo.
    echo   Note: pkg downloads a prebuilt runtime per target, so the first
    echo         build of each platform needs network access.
    echo.
    pause
    exit /b %BUILD_EXIT%
)

echo ============================================
echo   Build SUCCESS
echo ============================================
echo.
echo Archives were written to the project root, named
echo   ZeroShadow-^<version^>-^<platform^>.zip
echo.
echo Each archive contains:
echo   ZeroShadow.exe / ZeroShadow   backend binary
echo   web\dist\                     frontend static files
echo   .env.example                  config template
echo   data\                         runtime data folder
echo   LICENSE                       Apache 2.0
echo   README.md                     project overview
echo   docs\                         all user manuals
echo.
echo NOTE: on first run the app generates .env next to the binary and prints
echo       a random superadmin password. Never ship a .env file - it holds
echo       that password in plain text.
echo.
pause
endlocal
