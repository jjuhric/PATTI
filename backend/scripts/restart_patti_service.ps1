# BUG-15 (docs/REVIEW_2026-08-03.md): Stop-ScheduledTask alone does not reliably kill the
# node.exe process that run-background.vbs's WshShell.Run loop spawned - empirically (confirmed
# across multiple production restarts) the child survives as an orphan still holding port 3000.
# A bare Start-ScheduledTask right after then launches a second node.exe that immediately
# crashes with EADDRINUSE, while the orphaned original silently keeps serving stale code. This
# script closes that gap by explicitly finding and killing any node.exe running backend/server.js
# between the stop and start, rather than relying on Task Scheduler's job-object cleanup - which,
# for a child spawned via WshShell.Run, does not reach it.
#
# Used by host_machine_tool.js's restart_service action, and safe to run by hand for the same
# manual restart procedure documented in docs/IMPLEMENTATION_PLAN.md's Operations section.

param(
  [string]$TaskName = "PATTI-Assistant"
)

Write-Output "Stopping scheduled task '$TaskName'..."
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

$stale = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*' }

foreach ($proc in $stale) {
  Write-Output "Killing stale node.exe (PID $($proc.ProcessId))"
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1

Write-Output "Starting scheduled task '$TaskName'..."
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
