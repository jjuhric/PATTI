# Windows Uninstall Script for Private AI Assistant
# Removes background tasks, running port processes, environment configurations, logs, databases, and dependencies

$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($installDir)) {
    $installDir = Get-Location
}

Write-Host "=============================================" -ForegroundColor Red
Write-Host "❌ Uninstalling Private AI Assistant Node" -ForegroundColor Red
Write-Host "=============================================" -ForegroundColor Red
Write-Host "Target directory to remove: $installDir" -ForegroundColor Yellow

# 1. Stop and remove scheduled tasks (requires Admin)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
    Write-Host "Cleaning Windows background tasks..." -ForegroundColor Cyan
    $tasks = @("PATTI-Assistant", "PATTI-Updater")
    foreach ($taskName in $tasks) {
        $taskExists = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($taskExists) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
            Write-Host "✅ Removed background scheduled task: $taskName" -ForegroundColor Green
        }
    }
} else {
    Write-Host "[WARNING] Please run this script in an Administrator PowerShell window to clean up background scheduled tasks." -ForegroundColor Yellow
}

# 2. Kill running backend processes on PORT 3000 (or customized port from .env)
$appPort = 3000
$envFile = Join-Path $installDir ".env"
if (Test-Path $envFile) {
    $envLines = Get-Content $envFile
    foreach ($line in $envLines) {
        if ($line -match "^PORT=(.*)") { $appPort = $Matches[1].Trim() }
    }
}

$portProcess = Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction SilentlyContinue
if ($portProcess) {
    $procId = $portProcess.OwningProcess
    Write-Host "Stopping running process $procId on port $appPort..." -ForegroundColor Yellow
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Write-Host "✅ Stopped active port process." -ForegroundColor Green
}

# 3. Clean files, databases, and local staging directories inside installDir, then delete folder itself
Write-Host "Deleting directory and all files..." -ForegroundColor Cyan
if (Test-Path $installDir) {
    # Move out of the folder first
    Set-Location ~
    Remove-Item $installDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✅ Private AI directory and all files deleted." -ForegroundColor Green
}

Write-Host "`n=============================================" -ForegroundColor Green
Write-Host "  Private AI has been uninstalled successfully!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
