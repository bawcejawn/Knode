<#
  Knode - repair one node's block data by copying it from another healthy node on this PC.

  Why: a node's block store (its saved copy of past blocks) can get damaged. Whenever another node asks it for certain
  old blocks, the block store crashes ("panic: nil pointer ... GetBlocksByHeight") and the node freezes again and
  again (the self-heal reports "block store started 5 times in 20 minutes"). A restart doesn't cure it. All three
  nodes hold the same chain, so this copies a healthy node's two databases over the broken node's.

  Run in PowerShell from C:\kprediction, for example to repair the game node from the desk node:
      powershell -ExecutionPolicy Bypass -File node\repair-node-data.ps1 -Broken game -From desk
  -Broken / -From: game (C:\kpred-node), desk (C:\kpred-desk-node) or personal (C:\koinos-personal).

  Works whether a node keeps its data in its Windows folder (basedir) or in a Docker volume (after
  node\move-node-to-volume.ps1: its koinos folder then has a docker-compose.override.yml naming the volume). Between
  two folders it copies with robocopy; when a volume is involved it copies with a small throwaway Linux container.

  What it does:
    1. checks paths, Docker and disk space
    2. stops the broken node, then the source node (the source is down only while copying, about 5-20 minutes)
    3. renames the broken node's old databases to "...-broken-<date>" (kept as a backup, nothing is deleted)
    4. copies the source's block_store\db and chain\blockchain to the broken node
    5. starts the source node again (always, even if something fails), then the repaired node

  It never touches block_producer (the node keys), p2p, config.yml or your .env files.
  It asks nothing, so the self-heal (bot\heal.mjs) can run it unattended; it exits 0 when repaired, 1 when not.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("game", "desk", "personal")][string]$Broken,
  [Parameter(Mandatory = $true)][ValidateSet("game", "desk", "personal")][string]$From
)
$ErrorActionPreference = "Stop"
$Dirs = @{ game = "C:\kpred-node"; desk = "C:\kpred-desk-node"; personal = "C:\koinos-personal" }
if ($env:KNODE_TEST_ROOTS) { $Dirs = @{}; ($env:KNODE_TEST_ROOTS | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $Dirs[$_.Name] = $_.Value } }   # tests only
if ($Broken -eq $From) { throw "-Broken and -From must be different nodes. Nothing was changed." }
$Desk = $Dirs[$Broken]   # the node being repaired
$Game = $Dirs[$From]     # the healthy source
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$Alpine = "alpine:3.20"

function Say($m) { Write-Host $m }
function Ok($m) { Write-Host "OK  $m" -ForegroundColor Green }
# Native commands (docker) report progress on stderr. Windows PowerShell 5.1 can turn that into an error when the
# script runs unattended (the self-heal), so every docker call runs with "Continue" and is judged by its exit code.
function Compose($dir, [string[]]$a) {
  $ErrorActionPreference = "Continue"
  Push-Location (Join-Path $dir "koinos")
  try { & docker compose @a 2>&1 | ForEach-Object { "$_" }; if ($LASTEXITCODE -ne 0) { throw "docker compose $($a -join ' ') failed in $dir" } }
  finally { Pop-Location }
}
function Running($dir) {
  $ErrorActionPreference = "Continue"
  Push-Location (Join-Path $dir "koinos")
  try { return (& docker compose ps -q 2>$null) } finally { Pop-Location }
}
function Copy-Db($from, $to) {
  & robocopy $from $to /E /MT:16 /R:2 /W:5 /NFL /NDL /NP /NJH | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying $from failed (robocopy code $LASTEXITCODE)" }
}
# The node's Docker volume (written by node\move-node-to-volume.ps1 into docker-compose.override.yml), or $null.
function VolumeOf($dir) {
  $o = Join-Path (Join-Path $dir "koinos") "docker-compose.override.yml"
  if (-not (Test-Path $o)) { return $null }
  $m = Select-String -Path $o -Pattern "^#\s*knode-volume:\s*(\S+)" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value } else { return $null }
}
# What to mount into a helper container: the volume's name, or the basedir folder.
function MountOf($dir) { $v = VolumeOf $dir; if ($v) { return $v } else { return ("$dir\basedir" -replace "\\", "/") } }
function Container([string[]]$mounts, [string]$script) {
  $ErrorActionPreference = "Continue"
  $a = @("run", "--rm")
  foreach ($m in $mounts) { $a += @("-v", $m) }
  $a += @($Alpine, "sh", "-c", $script)
  $out = & docker @a 2>$null
  if ($LASTEXITCODE -ne 0) { throw "a copy/check container failed (exit $LASTEXITCODE)" }
  return $out
}
# Total bytes of block_store/db and chain/blockchain, read inside a container (works for a volume or a folder).
$SumScript = 'find /k/block_store/db /k/chain/blockchain -type f -exec stat -c %s {} + | awk ''{s+=$1} END {print s+0}'''
function BytesIn($mount) { return [int64]((Container @("${mount}:/k:ro") $SumScript) | Select-Object -Last 1) }

$VolBroken = VolumeOf $Desk
$VolFrom = VolumeOf $Game
$useContainer = [bool]($VolBroken -or $VolFrom)

# ---------- 1. checks ----------
foreach ($p in @((Join-Path $Desk "koinos"), (Join-Path $Game "koinos"))) { if (-not (Test-Path $p)) { throw "Not found: $p. Nothing was changed. Tell Claude." } }
$ErrorActionPreference = "Continue"; docker info --format "{{.ServerVersion}}" 2>$null | Out-Null; $dockerOk = ($LASTEXITCODE -eq 0); $ErrorActionPreference = "Stop"
if (-not $dockerOk) { throw "Docker isn't running. Open Docker Desktop and try again." }
if ($useContainer) {
  $ErrorActionPreference = "Continue"; & docker pull $Alpine 2>&1 | Out-Null; $pulled = ($LASTEXITCODE -eq 0); $ErrorActionPreference = "Stop"
  if (-not $pulled) { throw "Couldn't download the small $Alpine helper image (internet?). Nothing was changed." }
  foreach ($pair in @(@($Game, "test -d /k/block_store/db && test -d /k/chain/blockchain"),
                      @($Desk, "test -d /k/block_store/db && test -d /k/chain/blockchain && test -f /k/block_producer/private.key"))) {
    $mount = MountOf $pair[0]
    try { Container @("${mount}:/k:ro") $pair[1] | Out-Null } catch { throw "The node data in $mount isn't complete (block_store/db, chain/blockchain, keys). Nothing was changed. Tell Claude." }
  }
  $needBytes = BytesIn (MountOf $Game)
} else {
  foreach ($p in @("$Game\basedir\block_store\db", "$Game\basedir\chain\blockchain",
                   "$Desk\basedir\block_store\db", "$Desk\basedir\chain\blockchain", "$Desk\basedir\block_producer\private.key")) {
    if (-not (Test-Path $p)) { throw "Not found: $p. Nothing was changed. Tell Claude." }
  }
  $needBytes = (Get-ChildItem "$Game\basedir\block_store\db", "$Game\basedir\chain\blockchain" -Recurse -File | Measure-Object Length -Sum).Sum
}
$free = if ($env:KNODE_TEST_FREE_BYTES) { [int64]$env:KNODE_TEST_FREE_BYTES } else { (Get-PSDrive C).Free }   # Docker's Linux disk (where volumes live) is on C: too
if ($free -lt ($needBytes + 10GB)) { throw ("Not enough free space: need {0:N0} GB, have {1:N0} GB. Nothing was changed." -f (($needBytes + 10GB) / 1GB), ($free / 1GB)) }
Ok ("{0:N0} GB to copy, {1:N0} GB free" -f ($needBytes / 1GB), ($free / 1GB))

$dDb = "$Desk\basedir\block_store\db";  $dDbOld = "$dDb-broken-$stamp"
$dCh = "$Desk\basedir\chain\blockchain"; $dChOld = "$dCh-broken-$stamp"
$BrokenMount = MountOf $Desk; $FromMount = MountOf $Game
$copied = $false
$renamed = $false

try {
  # ---------- 2. stop both nodes ----------
  Say "Stopping the $Broken node (being repaired)..."
  Compose $Desk @("down")
  Say "Stopping the $From node (it restarts as soon as the copy is done)..."
  Compose $Game @("down")
  if ((Running $Desk) -or (Running $Game)) { throw "A node is still running after 'docker compose down'. Nothing was copied." }
  Ok "both nodes stopped"
  # measure again now that the source has stopped writing
  if ($useContainer) { $needBytes = BytesIn $FromMount }
  else { $needBytes = (Get-ChildItem "$Game\basedir\block_store\db", "$Game\basedir\chain\blockchain" -Recurse -File | Measure-Object Length -Sum).Sum }

  # ---------- 3. keep the old data as a backup ----------
  if ($useContainer) { Container @("${BrokenMount}:/k") "mv /k/block_store/db /k/block_store/db-broken-$stamp && mv /k/chain/blockchain /k/chain/blockchain-broken-$stamp" | Out-Null }
  else { Rename-Item $dDb $dDbOld; Rename-Item $dCh $dChOld }
  $renamed = $true
  Ok "old $Broken data kept as ...-broken-$stamp"

  # ---------- 4. copy ----------
  $t = Get-Date
  Say ("Copying {0:N0} GB from the $From node. This takes about 5-20 minutes; please leave this window open..." -f ($needBytes / 1GB))
  if ($useContainer) {
    Container @("${FromMount}:/from:ro", "${BrokenMount}:/to") "cp -a /from/block_store/db /to/block_store/db && cp -a /from/chain/blockchain /to/chain/blockchain && sync" | Out-Null
    $got = BytesIn $BrokenMount
  } else {
    Copy-Db "$Game\basedir\block_store\db" $dDb
    Copy-Db "$Game\basedir\chain\blockchain" $dCh
    $got = (Get-ChildItem $dDb, $dCh -Recurse -File | Measure-Object Length -Sum).Sum
  }
  if ($got -ne $needBytes) { throw ("Copy is incomplete ({0:N0} of {1:N0} bytes)" -f $got, $needBytes) }
  $copied = $true
  Ok ("copied in {0:N0} minutes" -f ((Get-Date) - $t).TotalMinutes)
}
catch {
  Write-Host "PROBLEM: $($_.Exception.Message)" -ForegroundColor Red
  if ($useContainer -and -not $copied) {
    # Whatever was renamed goes back in place; only a half-made copy next to it is removed.
    Say "Putting the $Broken node's old data back..."
    try {
      Container @("${BrokenMount}:/k") "for p in block_store/db chain/blockchain; do if [ -d /k/`$p-broken-$stamp ]; then rm -rf /k/`$p && mv /k/`$p-broken-$stamp /k/`$p; fi; done" | Out-Null
      Ok "old $Broken data restored (nothing lost)"
    } catch { Write-Host "Couldn't put the old data back by itself: it is in ...-broken-$stamp inside $BrokenMount. Tell Claude." -ForegroundColor Red }
  }
  elseif ($renamed -and -not $copied) {
    Say "Putting the $Broken node's old data back..."
    foreach ($pair in @(@($dDb, $dDbOld), @($dCh, $dChOld))) {
      if (Test-Path $pair[0]) { Remove-Item $pair[0] -Recurse -Force }
      Rename-Item $pair[1] (Split-Path $pair[0] -Leaf)
    }
    Ok "old $Broken data restored (nothing lost)"
  }
}
finally {
  # ---------- 5. start the nodes again, the source first ----------
  Say "Starting the $From node..."
  try { Compose $Game @("up", "-d"); Ok "$From node started" } catch { Write-Host "Couldn't start the $From node: run 'docker compose up -d' in $Game\koinos" -ForegroundColor Red }
  Say "Starting the $Broken node..."
  try { Compose $Desk @("up", "-d"); Ok "$Broken node started" } catch { Write-Host "Couldn't start the $Broken node: run 'docker compose up -d' in $Desk\koinos" -ForegroundColor Red }
}

Write-Host ""
if ($copied) {
  Write-Host "DONE. The $Broken node now has the $From node's healthy data. It needs a few minutes to catch up." -ForegroundColor Green
  Write-Host "  In about 15 minutes check:   node bot\heal.mjs --dry-run"
  if ($VolBroken) {
    Write-Host "  The old data stays inside the volume $VolBroken as ...-broken-$stamp; the self-heal deletes it after 7 days."
  } else {
    Write-Host "  The old data stays in ...-broken-$stamp. Once the $Broken node has run well for a day you can delete it:"
    Write-Host "    Remove-Item -Recurse -Force `"$dDbOld`", `"$dChOld`""
  }
} else {
  Write-Host "The repair did not finish (see above). Both nodes were started again with their old data. Tell Claude." -ForegroundColor Yellow
}

# Exit code for the self-heal (bot\heal.mjs runs this unattended): 0 = repaired, 1 = not repaired.
if ($copied) { exit 0 } else { exit 1 }
