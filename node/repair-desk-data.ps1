<#
  Knode - repair the desk node's block data by copying it from the healthy game node.

  Why: the desk node's block store (its saved copy of past blocks) is damaged. Whenever another node asks it for
  certain old blocks, the block store crashes ("panic: nil pointer ... GetBlocksByHeight") and the chain freezes.
  The game node has the same chain data and is healthy, so this copies its two databases over the desk's.

  Run once in PowerShell from C:\kprediction:
      powershell -ExecutionPolicy Bypass -File node\repair-desk-data.ps1

  What it does:
    1. checks there is enough disk space
    2. stops the desk node, then the game node (the game is down only while copying, about 5-20 minutes)
    3. renames the desk's old databases to "...-broken-<date>" (kept as a backup, nothing is deleted)
    4. copies the game's block_store\db and chain\blockchain to the desk
    5. starts the game node again (always, even if something fails), then the desk node

  It never touches block_producer (the node keys), p2p, config.yml or your .env files.
#>
$ErrorActionPreference = "Stop"
$Desk = "C:\kpred-desk-node"
$Game = "C:\kpred-node"
$stamp = Get-Date -Format "yyyyMMdd-HHmm"

function Say($m) { Write-Host $m }
function Ok($m) { Write-Host "OK  $m" -ForegroundColor Green }
function Compose($dir, [string[]]$a) {
  Push-Location (Join-Path $dir "koinos")
  try { & docker compose @a; if ($LASTEXITCODE -ne 0) { throw "docker compose $($a -join ' ') failed in $dir" } }
  finally { Pop-Location }
}
function Running($dir) {
  Push-Location (Join-Path $dir "koinos")
  try { return (& docker compose ps -q) } finally { Pop-Location }
}
function Copy-Db($from, $to) {
  & robocopy $from $to /E /MT:16 /R:2 /W:5 /NFL /NDL /NP /NJH | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $from failed (robocopy code $LASTEXITCODE)" }
}

# ---------- 1. checks ----------
foreach ($p in @("$Desk\koinos", "$Game\koinos", "$Game\basedir\block_store\db", "$Game\basedir\chain\blockchain",
                 "$Desk\basedir\block_store\db", "$Desk\basedir\chain\blockchain", "$Desk\basedir\block_producer\private.key")) {
  if (-not (Test-Path $p)) { throw "Not found: $p. Nothing was changed. Tell Claude." }
}
docker info --format "{{.ServerVersion}}" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker isn't running. Open Docker Desktop and try again." }
$needBytes = (Get-ChildItem "$Game\basedir\block_store\db", "$Game\basedir\chain\blockchain" -Recurse -File | Measure-Object Length -Sum).Sum
$free = (Get-PSDrive C).Free
if ($free -lt ($needBytes + 10GB)) { throw ("Not enough free space: need {0:N0} GB, have {1:N0} GB. Nothing was changed." -f (($needBytes + 10GB) / 1GB), ($free / 1GB)) }
Ok ("{0:N0} GB to copy, {1:N0} GB free" -f ($needBytes / 1GB), ($free / 1GB))

$dDb = "$Desk\basedir\block_store\db";  $dDbOld = "$dDb-broken-$stamp"
$dCh = "$Desk\basedir\chain\blockchain"; $dChOld = "$dCh-broken-$stamp"
$copied = $false
$renamed = $false

try {
  # ---------- 2. stop both nodes ----------
  Say "Stopping the desk node..."
  Compose $Desk @("down")
  Say "Stopping the game node (it restarts as soon as the copy is done)..."
  Compose $Game @("down")
  if ((Running $Desk) -or (Running $Game)) { throw "A node is still running after 'docker compose down'. Nothing was copied." }
  Ok "both nodes stopped"
  # measure again now that the game node has stopped writing
  $needBytes = (Get-ChildItem "$Game\basedir\block_store\db", "$Game\basedir\chain\blockchain" -Recurse -File | Measure-Object Length -Sum).Sum

  # ---------- 3. keep the old desk data as a backup ----------
  Rename-Item $dDb $dDbOld
  Rename-Item $dCh $dChOld
  $renamed = $true
  Ok "old desk data kept as ...-broken-$stamp"

  # ---------- 4. copy ----------
  $t = Get-Date
  Say ("Copying {0:N0} GB from the game node. This takes about 5-20 minutes; please leave this window open..." -f ($needBytes / 1GB))
  Copy-Db "$Game\basedir\block_store\db" $dDb
  Copy-Db "$Game\basedir\chain\blockchain" $dCh
  $got = (Get-ChildItem $dDb, $dCh -Recurse -File | Measure-Object Length -Sum).Sum
  if ($got -ne $needBytes) { throw ("Copy is incomplete ({0:N0} of {1:N0} bytes)" -f $got, $needBytes) }
  $copied = $true
  Ok ("copied in {0:N0} minutes" -f ((Get-Date) - $t).TotalMinutes)
}
catch {
  Write-Host "PROBLEM: $($_.Exception.Message)" -ForegroundColor Red
  if ($renamed -and -not $copied) {
    Say "Putting the desk's old data back..."
    foreach ($pair in @(@($dDb, $dDbOld), @($dCh, $dChOld))) {
      if (Test-Path $pair[0]) { Remove-Item $pair[0] -Recurse -Force }
      Rename-Item $pair[1] (Split-Path $pair[0] -Leaf)
    }
    Ok "old desk data restored (nothing lost)"
  }
}
finally {
  # ---------- 5. start the nodes again, game first ----------
  Say "Starting the game node..."
  try { Compose $Game @("up", "-d"); Ok "game node started" } catch { Write-Host "Couldn't start the game node: run 'docker compose up -d' in $Game\koinos" -ForegroundColor Red }
  Say "Starting the desk node..."
  try { Compose $Desk @("up", "-d"); Ok "desk node started" } catch { Write-Host "Couldn't start the desk node: run 'docker compose up -d' in $Desk\koinos" -ForegroundColor Red }
}

Write-Host ""
if ($copied) {
  Write-Host "DONE. The desk node now has the game node's healthy data. It needs a few minutes to catch up." -ForegroundColor Green
  Write-Host "  In about 15 minutes check:   npm run desk -- node-status"
  Write-Host "  The old data stays in ...-broken-$stamp. Once the desk has run well for a day you can delete it:"
  Write-Host "    Remove-Item -Recurse -Force `"$dDbOld`", `"$dChOld`""
} else {
  Write-Host "The repair did not finish (see above). Both nodes were started again with their old data. Tell Claude." -ForegroundColor Yellow
}
