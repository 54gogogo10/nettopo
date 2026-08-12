@echo off
title NetTopo Network Topology Designer
cd /d %~dp0

echo ============================================
echo   NetTopo Network Topology Designer
echo   Starting local server: http://localhost:8765
echo   Note: Web Shell (SSH/Telnet) is desktop-only.
echo   Please use dist\NetTopo-*-portable.exe for full features.
echo ============================================
echo.
echo   The browser will open automatically.
echo   Close this window to stop the server.
echo.

where python >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8765
  python -m http.server 8765
  goto :end
)

where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8765
  npx --yes http-server -p 8765
  goto :end
)

echo [ERROR] Python or Node.js not found.
echo Please open index.html directly in the browser instead.
pause

:end
