@echo off
setlocal
cd /d "%~dp0"
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

if not exist "%ROOT%\backend\.venv\Scripts\python.exe" (
  echo This folder is missing the Python setup in backend\.venv.
  echo Create that environment and install the project, then try again.
  pause
  exit /b 1
)

echo Checking the MetaTrader calendar...
pushd "%ROOT%\backend"
"%ROOT%\backend\.venv\Scripts\python.exe" -m goldcore.calendar_setup
if errorlevel 2 (
  popd
  echo.
  pause
  exit /b 1
)
popd

netstat -ano | findstr /C:":8000 " | findstr LISTENING >nul
if not errorlevel 1 (
  echo The app is already running. Opening it.
  start "" http://127.0.0.1:8000/
  exit /b 0
)

where npm >nul 2>&1
if errorlevel 1 (
  if not exist "%ROOT%\frontend\dist\index.html" (
    echo Node.js is not installed, and the page has not been built yet.
    pause
    exit /b 1
  )
) else (
  pushd "%ROOT%\frontend"
  if not exist "node_modules\" (
    echo Installing the page. This can take a minute.
    call npm install
    if errorlevel 1 (
      echo Installing the page failed.
      popd
      pause
      exit /b 1
    )
  )
  if not exist "dist\index.html" (
    echo Building the page. This can take a minute.
    call npm run build
    if errorlevel 1 (
      echo Building the page failed.
      popd
      pause
      exit /b 1
    )
  )
  popd
)

echo Keep MetaTrader 5 open and logged in.
echo Starting the app. A Gold monitor window will stay open while it runs.
start "Gold monitor" cmd /k "cd /d ""%ROOT%\backend"" && ""%ROOT%\backend\.venv\Scripts\python.exe"" -m uvicorn api.main:app --host 127.0.0.1 --port 8000"

echo Waiting for it to be ready...
set TRIES=0
:wait
set /a TRIES+=1
if %TRIES% GTR 40 (
  echo The app did not start. Read the Gold monitor window for the reason.
  pause
  exit /b 1
)
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/status -TimeoutSec 2; if ($r.StatusCode -ne 200) { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  timeout /t 1 >nul
  goto wait
)

start "" http://127.0.0.1:8000/
echo.
echo The app is open in your browser.
echo Leave the Gold monitor window running. Closing it stops the app.
echo Your trades stay in MetaTrader either way.
timeout /t 5 >nul
