<#
  Knode - set up the node self-healing check to run every 20 minutes (Windows Task Scheduler).

  Run once in PowerShell from C:\kprediction:
      powershell -ExecutionPolicy Bypass -File node\install-heal.ps1

  What it runs: node bot\heal.mjs (see that file). Its log is node\heal.log.
  It may run up to 2 hours: when a node's block store keeps crashing it repairs it from a healthy node (auto-repair).
  Check the task:    Get-ScheduledTask -TaskName "Knode self-heal" | Get-ScheduledTaskInfo
  Remove it again:   Unregister-ScheduledTask -TaskName "Knode self-heal" -Confirm:$false
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "bot\heal.mjs"
if (-not (Test-Path $script)) { throw "bot\heal.mjs not found. Run 'git pull' in $root first." }
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "Node.js isn't on the PATH. Open a new PowerShell window and try again." }
$node = $nodeCmd.Source

# Hidden PowerShell window that runs: node bot\heal.mjs
$arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ''{0}'' ''{1}''"' -f $node, $script
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 20) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Knode self-heal" -Action $action -Trigger $trigger -Settings $settings -Description "Every 20 minutes: restart any Koinos node that has frozen, and email through GitHub. See C:\kprediction\bot\heal.mjs" -Force | Out-Null

# Tell bot\heal.mjs the task may run long enough for an automatic repair (it won't start one under the old 15 minutes).
Set-Content -Path (Join-Path $root "node\heal-task.json") -Value '{ "version": 2, "limitMinutes": 120 }' -Encoding ascii

Write-Host ""
Write-Host "OK  'Knode self-heal' is set up: it runs every 20 minutes, starting in 1 minute." -ForegroundColor Green
Write-Host "    Log:            notepad $root\node\heal.log"
Write-Host "    Try it now:     node bot\heal.mjs --dry-run"
Write-Host "    Test the email: node bot\heal.mjs --test-alert"
