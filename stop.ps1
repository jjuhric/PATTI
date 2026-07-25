# Windows Stop Script for Private AI Assistant (PATTI)
# Stops all of PATTI's background processes WITHOUT removing anything - the scheduled
# task, database, and .env configuration are left in place so `setup.ps1` (or just
# starting the task again) brings everything back exactly as it was.

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  Stopping Private AI Assistant (PATTI)" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

function Write-Log ($Msg, $Color = "White") {
    Write-Host "[INFO] $Msg" -ForegroundColor $Color
}

$stoppedAnything = $false

# 1. Stop (and disable, so it doesn't silently come back at next logon) the scheduled
# task registered by setup.ps1. Disabling rather than unregistering keeps the task
# definition around so re-running setup.ps1, or Enable-ScheduledTask, restores it.
$taskName = "PrivateAI-Assistant"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    Write-Log "Stopped and disabled scheduled task '$taskName'." "Green"
    $stoppedAnything = $true
}

# 2. Kill any wscript.exe fallback process launched directly (used when the scheduled
# task couldn't be registered, e.g. no admin rights during setup).
try {
    $wscriptProcs = Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'run-background\.vbs' }
    foreach ($proc in $wscriptProcs) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Log "Stopped background launcher process (PID $($proc.ProcessId))." "Green"
        $stoppedAnything = $true
    }
} catch {
    Write-Log "Could not enumerate wscript.exe processes (may require elevated PowerShell): $_" "Yellow"
}

# 3. Kill whatever is listening on the app port (from .env, default 3000) and the Vite
# dev server port (5173), covering `npm start`/`npm run dev` run directly in a terminal.
$appPort = 3000
if (Test-Path ".env") {
    $envLines = Get-Content ".env"
    foreach ($line in $envLines) {
        if ($line -match "^PORT=(.*)") { $appPort = $Matches[1].Trim() }
    }
}

foreach ($portInfo in @(@{ Port = $appPort; Label = "backend (port $appPort)" }, @{ Port = 5173; Label = "Vite dev server (port 5173)" })) {
    $conn = Get-NetTCPConnection -LocalPort $portInfo.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        $procId = $conn.OwningProcess
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Write-Log "Stopped $($portInfo.Label), PID $procId." "Green"
        $stoppedAnything = $true
    }
}

Write-Host "`n====================================================" -ForegroundColor Green
if ($stoppedAnything) {
    Write-Host "  PATTI has been stopped." -ForegroundColor Green
} else {
    Write-Host "  Nothing was running - PATTI was already stopped." -ForegroundColor Green
}
Write-Host "====================================================" -ForegroundColor Green
Write-Host "To start it again: run setup.ps1 (if the scheduled task was disabled) or 'npm start'." -ForegroundColor Cyan
