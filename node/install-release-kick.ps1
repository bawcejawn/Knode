<#
  Knode - make sure the daily questions come out at 12:00 UTC (Windows Task Scheduler, every 5 minutes).

  Run once in PowerShell from C:\kprediction:
      powershell -ExecutionPolicy Bypass -File node\install-release-kick.ps1

  What it runs: node bot\release-kick.mjs (see that file). Windows starts it only 11:45-14:05 UTC each day (a UTC time,
  so daylight saving time doesn't shift it); on Sundays it starts and does nothing.
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

# Runs node with no window at all: "conhost --headless" gives it a console that is never shown (a hidden PowerShell
# window still flashes on screen for a moment). Windows older than 10 version 1809 has no --headless: hidden PowerShell.
$conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
if ([Environment]::OSVersion.Version.Build -ge 17763 -and (Test-Path $conhost)) {
  $action = New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "{0}" "{1}"' -f $node, $script) -WorkingDirectory $root
} else {
  $arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ''{0}'' ''{1}''"' -f $node, $script
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $root
}
# Daily from 11:45 UTC, every 5 minutes for 2 h 20 min (to 14:05 UTC). The start time is stored in UTC ("...Z",
# Task Scheduler's "synchronize across time zones"), so daylight saving time never moves it: it stays 11:45 UTC, which
# is 4:45 am in summer and 3:45 am in winter in California. The script itself also works in UTC only.
$day = [DateTime]::UtcNow.ToString("yyyy-MM-dd")   # a past start is fine: it repeats every day from then
$trigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.AddHours(12))
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At ([DateTime]::Today) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Hours 2 -Minutes 20)).Repetition
$trigger.StartBoundary = "${day}T11:45:00Z"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Knode question release" -Action $action -Trigger $trigger -Settings $settings -Description "Daily 11:45-14:05 UTC, every 5 minutes (Mon-Sat it acts): start the Knode bot on GitHub so the day's questions come out on time, and email if they don't. See C:\kprediction\bot\release-kick.mjs" -Force | Out-Null

Write-Host ""
$info = (Get-ScheduledTask -TaskName "Knode question release").Triggers[0].StartBoundary
Write-Host "OK  'Knode question release' is set up: daily from 11:45 UTC (stored as $info), every 5 minutes until 14:05 UTC." -ForegroundColor Green
Write-Host "    That is $(([DateTime]::Parse("${day}T11:45:00Z")).ToLocalTime().ToString('h:mm tt')) your time today; daylight saving time doesn't move it."
Write-Host "    Log:          notepad $root\node\release-kick.log"
Write-Host "    Try it now:   node bot\release-kick.mjs --at 2026-10-29T11:52:00Z --dry-run"
