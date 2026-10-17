@echo off
setlocal
cd /d "%~dp0"
echo Closing the gold monitor...

rem Close the Gold monitor window first; that also stops the app it runs.
taskkill /FI "WINDOWTITLE eq Gold monitor*" /T /F >nul 2>&1

rem Fallback: stop whatever is listening on port 8000, but only if it is this
rem app's Python from this folder. Another program using port 8000 is left alone.
powershell -NoProfile -Command "$root=(Get-Location).Path; $venv=Join-Path $root 'backend\.venv\Scripts\python.exe'; $owners=Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($p in $owners) { $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p); if ($null -eq $proc) { continue }; $cl = $proc.CommandLine; $cmdMatch = $cl -and ($cl.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) -and ($cl -like '*uvicorn api.main:app*'); if (($proc.ExecutablePath -and ($proc.ExecutablePath -ieq $venv)) -or $cmdMatch) { Stop-Process -Id $p -Force; Write-Output ('Stopped gold monitor (PID ' + $p + ').') } else { Write-Output ('Port 8000 is used by another program (' + $proc.Name + ', PID ' + $p + '). Left it alone.') } }"

netstat -ano | findstr /C:":8000 " | findstr LISTENING >nul
if errorlevel 1 (
  echo Closed. Your trades in MetaTrader are unchanged.
) else (
  echo Port 8000 is still in use. If that is another program, stop.bat left it alone.
)
timeout /t 3 >nul
