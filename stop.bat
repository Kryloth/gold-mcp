@echo off
setlocal
echo Closing the gold monitor...

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /C:":8000 " ^| findstr LISTENING') do (
  taskkill /PID %%P /F >nul 2>&1
)
taskkill /FI "WINDOWTITLE eq Gold monitor*" /T /F >nul 2>&1

netstat -ano | findstr /C:":8000 " | findstr LISTENING >nul
if errorlevel 1 (
  echo Closed. Your trades in MetaTrader are unchanged.
) else (
  echo The app is still running. Close the Gold monitor window by hand.
)
timeout /t 3 >nul
