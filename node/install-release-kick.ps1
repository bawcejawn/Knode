<#
  Knode - make sure the daily questions come out at 12:00 UTC (Windows Task Scheduler, every 5 minutes).

  Run once in PowerShell from C:\kprediction:
      powershell -ExecutionPolicy Bypass -File node\install-release-kick.ps1

  What it runs: node bot\release-kick.mjs (see that file). Outside 11:50-14:00 UTC, Monday-Saturday, it does nothing.
  Its log is node\release-kick.log. It uses GITHUB_ALERT_TOKEN from .env (the self-heal email token).
  Check the task:    Get-ScheduledTask -TaskName "Knode question release" | Get-ScheduledTaskInfo
  Remove it again:   Unregister-ScheduledTask -TaskName "Knode question release" -Confirm:$false
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "bot\release-kick.mjs"
if (-not (Test-Path $script)) { throw "bot\release-kick.mjs not found. Run 'git pull' in $root first." }
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "Node.js isn't on the PATH. Open a new PowerShell window and try again." }
$node = $nodeCmd.Source
$envFile = Join-Path $root ".env"
if (-not ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern '^\s*GITHUB_ALERT_TOKEN\s*=\s*\S' -Quiet))) {
  throw "GITHUB_ALERT_TOKEN isn't in $envFile. It's the same token the self-heal emails use."
}

# Hidden PowerShell window that runs: node bot\release-kick.mjs
$arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ''{0}'' ''{1}''"' -f $node, $script
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Knode question release" -Action $action -Trigger $trigger -Settings $settings -Description "Every 5 minutes: around 12:00 UTC Mon-Sat, start the Knode bot on GitHub so the day's questions come out on time, and email if they don't. See C:\kprediction\bot\release-kick.mjs" -Force | Out-Null

Write-Host ""
Write-Host "OK  'Knode question release' is set up: it checks every 5 minutes (it only acts 11:50-14:00 UTC, Mon-Sat)." -ForegroundColor Green
Write-Host "    Log:          notepad $root\node\release-kick.log"
Write-Host "    Try it now:   node bot\release-kick.mjs --at 2026-10-29T11:52:00Z --dry-run"
