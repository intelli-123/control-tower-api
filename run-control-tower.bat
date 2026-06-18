@echo off
setlocal enableextensions
cd /d "%~dp0"
title Agent Control Tower - Launcher

REM Pin the portable Node version used when Node is not already installed.
set "NODE_VER=v20.18.1"
set "NODE_CMD=node"
set "NPM_CMD=npm"

echo ===========================================================
echo    Agent Control Tower  -  one-click launcher
echo ===========================================================
echo.

REM ---- Load saved answers from a previous run (if any) ----
set "HAVE_CONFIG="
if exist "ct-launcher.config.bat" ( call "ct-launcher.config.bat" & set "HAVE_CONFIG=1" )

REM ---- 1. Ensure Node.js is available --------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [..] Node.js not found on PATH.
  if exist ".node\node.exe" (
    echo [ok] Using portable Node.js in .node
    set "PATH=%CD%\.node;%PATH%"
    set "NODE_CMD=%CD%\.node\node.exe"
    set "NPM_CMD=%CD%\.node\npm.cmd"
  ) else (
    echo [..] Downloading portable Node.js %NODE_VER% ^(no admin required, ~30 MB^)...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $u='https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-x64.zip'; $z=Join-Path $env:TEMP 'ct-node.zip'; Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $z; if (Test-Path '.nodetmp') { Remove-Item '.nodetmp' -Recurse -Force }; Expand-Archive -Path $z -DestinationPath '.nodetmp' -Force; Move-Item ('.nodetmp\node-%NODE_VER%-win-x64') '.node'; Remove-Item $z,'.nodetmp' -Recurse -Force } catch { Write-Host $_; exit 1 }"
    if errorlevel 1 (
      echo.
      echo [ERROR] Could not download Node.js automatically.
      echo         Install Node.js 20+ from https://nodejs.org and run this file again.
      echo.
      pause
      exit /b 1
    )
    set "PATH=%CD%\.node;%PATH%"
    set "NODE_CMD=%CD%\.node\node.exe"
    set "NPM_CMD=%CD%\.node\npm.cmd"
    echo [ok] Portable Node.js installed in .node
  )
) else (
  echo [ok] Node.js found:
  node -v
)
echo.

REM ---- 2. Install dependencies on first run --------------------------------
if not exist "node_modules" (
  echo [..] Installing dependencies ^(first run only^)...
  call "%NPM_CMD%" install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection / proxy and retry.
    pause
    exit /b 1
  )
) else (
  echo [ok] Dependencies already installed.
)
echo.

REM ---- Returning run: auto-start with saved settings (3s window to edit) ---
if defined HAVE_CONFIG (
  echo Saved settings found  ^|  PORT=%PORT%   ^(admin / keys / proxy as saved^)
  choice /c ER /n /t 3 /d R /m "Press [E] to edit settings, or wait 3s to start (Ctrl+C to cancel)... "
  if errorlevel 2 goto launch
  echo.
  echo Editing settings ^(Enter keeps the current value^)...
)

REM ---- 3. PORT (mandatory) -------------------------------------------------
:askport
set "INPUT_PORT="
if defined PORT (
  set /p "INPUT_PORT=Port to run on [%PORT%]: "
) else (
  set /p "INPUT_PORT=Port to run on (required, e.g. 3090): "
)
if not defined INPUT_PORT if defined PORT set "INPUT_PORT=%PORT%"
if not defined INPUT_PORT (
  echo     ^! Port is required.
  goto askport
)
echo %INPUT_PORT%| findstr /r "^[1-9][0-9]*$" >nul
if errorlevel 1 (
  echo     ^! Please enter a number.
  goto askport
)
if %INPUT_PORT% gtr 65535 (
  echo     ^! Port must be 65535 or lower.
  goto askport
)
set "PORT=%INPUT_PORT%"

REM ---- 4. Optional inputs (press Enter to skip / keep) ---------------------
set "IN="
set /p "IN=Admin password (Enter = keep current / default 'admin'): "
if defined IN set "CT_ADMIN_PASSWORD=%IN%"

set "IN="
set /p "IN=Anthropic API key for AI summaries (Enter = skip, uses rule-based): "
if defined IN set "ANTHROPIC_API_KEY=%IN%"

set "IN="
set /p "IN=Disable MCP auto-discovery on startup? (y/N): "
if /i "%IN:~0,1%"=="y" (set "CT_MONITOR_MCP=off") else (set "CT_MONITOR_MCP=")

set "IN="
set /p "IN=Behind a corporate TLS/SSL proxy? Needed for remote MCPs to connect (y/N): "
if /i "%IN:~0,1%"=="y" (set "NODE_TLS_REJECT_UNAUTHORIZED=0") else (set "NODE_TLS_REJECT_UNAUTHORIZED=")

REM ---- 5. Remember answers for next time -----------------------------------
(
  echo set "PORT=%PORT%"
  if defined CT_ADMIN_PASSWORD echo set "CT_ADMIN_PASSWORD=%CT_ADMIN_PASSWORD%"
  if defined ANTHROPIC_API_KEY echo set "ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%"
  if defined CT_MONITOR_MCP echo set "CT_MONITOR_MCP=%CT_MONITOR_MCP%"
  if defined NODE_TLS_REJECT_UNAUTHORIZED echo set "NODE_TLS_REJECT_UNAUTHORIZED=%NODE_TLS_REJECT_UNAUTHORIZED%"
)> "ct-launcher.config.bat"

REM ---- 6. Launch in the background + open the browser when ready -----------
:launch
echo.
echo [..] Starting Control Tower in the background on http://localhost:%PORT%
REM Open the default browser once the server answers (runs detached).
start "" /b powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){ try{ Invoke-WebRequest -UseBasicParsing ('http://localhost:%PORT%/api/health') -TimeoutSec 1 ^| Out-Null; Start-Process ('http://localhost:%PORT%'); break }catch{ Start-Sleep -Milliseconds 500 } }"
REM Run the server in its own minimized window (env + PATH inherited).
start "Agent Control Tower" /min cmd /k "node server.js"
echo.
echo Control Tower is running in a minimized window titled "Agent Control Tower".
echo To stop it, close that window. To change settings, run this file again and press [E].
endlocal
exit /b 0
