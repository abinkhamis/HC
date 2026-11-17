@echo off
rem HC Operations Hub - start the single main platform on http://localhost:4300 and open it.
rem If it is already running, it is only opened (never a second copy).
setlocal
cd /d "%~dp0"
set "NODE=%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.20.0-win-x64\node.exe"
if not exist "%NODE%" set "NODE=node"

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 4300 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if %errorlevel%==0 goto open

if not exist data mkdir data
powershell -NoProfile -Command "Start-Process -FilePath '%NODE%' -ArgumentList '--disable-warning=ExperimentalWarning','src\server.js','--port','4300' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput 'data\platform.log' -RedirectStandardError 'data\platform-error.log'"
powershell -NoProfile -Command "for ($i = 0; $i -lt 40; $i++) { try { Invoke-WebRequest -UseBasicParsing http://localhost:4300/ -TimeoutSec 2 | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if not %errorlevel%==0 (
  echo The platform did not start. See data\platform-error.log
  pause
  exit /b 1
)

:open
start "" http://localhost:4300/
