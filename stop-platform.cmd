@echo off
rem HC Operations Hub - stop the main platform running on port 4300 (data is not touched).
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 4300 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess; 'Stopped.' } else { 'The platform is not running.' }"
ping -n 3 127.0.0.1 >nul
