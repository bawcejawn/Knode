<#
  Knode - move one Koinos node's data from its Windows folder into a Docker volume.

  Why: each node keeps its databases in a Windows folder (C:\kpred-node\basedir, ...). The Linux containers reach
  that folder through Docker Desktop's Windows-to-Linux file bridge, which is slow for databases and a likely cause of
  the damaged block stores (desk node 2026-10-23, game node 2026-10-27). A Docker volume lives on Linux's own disk
  inside WSL2: faster, and a proper filesystem for the databases.

  Run in PowerShell from C:\kprediction, one node at a time (desk first: it produces the fewest blocks):
      powershell -ExecutionPolicy Bypass -File node\move-node-to-volume.ps1 -Node desk -WhatIf   (shows the plan only)
      powershell -ExecutionPolicy Bypass -File node\move-node-to-volume.ps1 -Node desk
  -Node: desk (C:\kpred-desk-node), game (C:\kpred-node) or personal (C:\koinos-personal).

  What it does (nothing is ever deleted):
    1. checks Docker, the node's folder, its data folder (basedir), and free disk space
    2. takes the repair lock (node\repair.lock) so the self-heal leaves this node alone while it moves
    3. stops the node (docker compose down)
    4. creates the Docker volume "<project>-basedir" and copies the whole basedir into it (keys included)
    5. checks the copy: same number of files, same total size, same block-producer key (sha256)
    6. writes docker-compose.override.yml next to docker-compose.yml: Docker Compose reads it automatically and mounts
       the volume at /koinos instead of the folder (docker-compose.yml itself is not changed)
    7. starts the node again and waits up to 5 minutes for it to answer
  If anything fails before step 7, the override is set aside and the node is started again on its old folder.
  The old basedir folder stays exactly as it was: it is the backup.

  Roll back at any time:  in the node's koinos folder:  docker compose down,  rename docker-compose.override.yml,
  docker compose up -d   (the node then runs on its old folder again).
  -Resume: only after a move that failed during the copy (no override written yet): empties the half-filled volume
  and copies again.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("game", "desk", "personal")][string]$Node,
  [switch]$WhatIf,
  [switch]$Resume
)
$ErrorActionPreference = "Stop"
$Roots = @{ game = "C:\kpred-node"; desk = "C:\kpred-desk-node"; personal = "C:\koinos-personal" }
if ($env:KNODE_TEST_ROOTS) { $Roots = @{}; ($env:KNODE_TEST_ROOTS | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $Roots[$_.Name] = $_.Value } }   # tests only
$Alpine = "alpine:3.20"          # a small, pinned Linux image used only to copy and check files
$Koinos = Join-Path $Roots[$Node] "koinos"
$Override = Join-Path $Koinos "docker-compose.override.yml"
$LockFile = Join-Path $(if ($env:HEAL_DIR) { $env:HEAL_DIR } else { $PSScriptRoot }) "repair.lock"   # the self-heal's lock
$stamp = Get-Date -Format "yyyyMMdd-HHmm"

function Say($m) { Write-Host $m }
function Ok($m) { Write-Host "OK  $m" -ForegroundColor Green }
function Plan($m) { Write-Host "(dry run) would: $m" -ForegroundColor Cyan }
function EnvValue($name, $default) {
  $line = Get-Content (Join-Path $Koinos ".env") | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^\s*$name\s*=\s*", "").Trim().Trim('"') }
  return $default
}
# Native commands (docker) report progress on stderr. Windows PowerShell 5.1 can turn that into an error when the
# script runs unattended, so every docker call runs with "Continue" and is judged by its exit code instead.
function Compose([string[]]$a) {
  $ErrorActionPreference = "Continue"
  Push-Location $Koinos
  try { & docker compose @a 2>&1 | ForEach-Object { "$_" }; if ($LASTEXITCODE -ne 0) { throw "docker compose $($a -join ' ') failed in $Koinos" } }
  finally { Pop-Location }
}
function Running() { $ErrorActionPreference = "Continue"; Push-Location $Koinos; try { return (& docker compose ps -q 2>$null) } finally { Pop-Location } }
function Container([string[]]$mounts, [string]$script) {
  $ErrorActionPreference = "Continue"
  $a = @("run", "--rm")
  foreach ($m in $mounts) { $a += @("-v", $m) }
  $a += @($Alpine, "sh", "-c", $script)
  $out = & docker @a 2>$null
  if ($LASTEXITCODE -ne 0) { throw "a copy/check container failed (exit $LASTEXITCODE)" }
  return $out
}
function DockerExit([string[]]$a) { $ErrorActionPreference = "Continue"; $null = & docker @a 2>&1; return $LASTEXITCODE }

# ---------- 1. checks ----------
if (-not (Test-Path (Join-Path $Koinos "docker-compose.yml"))) { throw "Not found: $Koinos\docker-compose.yml. Nothing was changed." }
if (-not (Test-Path (Join-Path $Koinos ".env"))) { throw "Not found: $Koinos\.env. Nothing was changed." }
$BaseFwd = (EnvValue "BASEDIR" "") -replace "\\", "/"
if (-not $BaseFwd) { throw "No BASEDIR in $Koinos\.env. Nothing was changed." }
$Base = if ($env:KNODE_TEST_ROOTS) { $BaseFwd } else { $BaseFwd -replace "/", "\" }
$Project = EnvValue "COMPOSE_PROJECT_NAME" (Split-Path $Roots[$Node] -Leaf)
$Port = EnvValue "JSONRPC_PORT" "8080"
$Vol = "$Project-basedir"
$Marker = "# knode-volume: $Vol"

if (Test-Path $Override) {
  $existing = Get-Content $Override -Raw
  if ($existing -match [regex]::Escape($Marker)) { Ok "the $Node node already runs on the volume $Vol. Nothing to do."; exit 0 }
  throw "$Override already exists and wasn't written by this script. Nothing was changed. Tell Claude."
}
foreach ($p in @($Base, (Join-Path $Base "block_store/db"), (Join-Path $Base "chain/blockchain"), (Join-Path $Base "block_producer/private.key"))) {
  if (-not (Test-Path $p)) { throw "Not found: $p. Nothing was changed. Tell Claude." }
}
if ((DockerExit @("info", "--format", "{{.ServerVersion}}")) -ne 0) { throw "Docker isn't running. Open Docker Desktop and try again." }
if (-not $WhatIf -and (DockerExit @("pull", $Alpine)) -ne 0) { throw "Couldn't download the small $Alpine helper image (internet?). Nothing was changed." }
$size = (Get-ChildItem $Base -Recurse -File -Force | Measure-Object Length -Sum).Sum
$free = if ($env:KNODE_TEST_FREE_BYTES) { [int64]$env:KNODE_TEST_FREE_BYTES } else { (Get-PSDrive C).Free }
if ($free -lt ($size + 20GB)) { throw ("Not enough free space on C: (Docker's disk lives there): need {0:N0} GB, have {1:N0} GB. Nothing was changed." -f (($size + 20GB) / 1GB), ($free / 1GB)) }
Ok ("$Node node: {0:N0} GB in $Base, {1:N0} GB free on C:" -f ($size / 1GB), ($free / 1GB))
if (Test-Path $LockFile) {
  try { $l = Get-Content $LockFile -Raw | ConvertFrom-Json } catch { $l = $null }
  $age = if ($l) { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$l.startedAt } else { 0 }
  if ($l -and $age -lt 90 * 60000) { throw "A repair or move is running ($($l.broken) from $($l.from)). Try again when it's done. Nothing was changed." }
}
$volExists = ((DockerExit @("volume", "inspect", $Vol)) -eq 0)

if ($WhatIf) {
  Plan "take the repair lock $LockFile (the self-heal leaves the $Node node alone meanwhile)"
  Plan "stop the $Node node (docker compose down in $Koinos)"
  if ($volExists) { if ($Resume) { Plan "empty the half-filled volume $Vol (-Resume)" } else { Plan "check the existing volume $Vol is empty (else stop: use -Resume after a failed copy)" } }
  else { Plan "create the Docker volume $Vol" }
  Plan ("copy {0:N0} GB from $BaseFwd into the volume ($Alpine container)" -f ($size / 1GB))
  Plan "check the copy: file count, total size, block-producer key sha256"
  Plan "write $Override (the volume at /koinos for every Koinos service; docker-compose.yml unchanged)"
  Plan "start the node and wait up to 5 minutes for http://127.0.0.1:$Port to answer"
  Say "Nothing was changed (dry run)."
  exit 0
}

# ---------- 2. lock ----------
$lockBody = @{ pid = $PID; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); broken = $Node; from = $Node; action = "move" } | ConvertTo-Json -Compress
Set-Content -Path $LockFile -Value $lockBody -Encoding ascii
$wroteOverride = $false
$started = $false
$moved = $false
try {
  # ---------- 3. stop ----------
  Say "Stopping the $Node node..."
  Compose @("down")
  if (Running) { throw "The node is still running after 'docker compose down'. Nothing was copied." }
  Ok "stopped"

  # ---------- 4. volume and copy ----------
  if ($volExists) {
    $first = Container @("${Vol}:/to") "ls -A /to | head -n 1"
    if ($first) {
      if (-not $Resume) { throw "The volume $Vol already holds data. If an earlier move failed during the copy, run again with -Resume." }
      Say "Emptying the half-filled volume $Vol (-Resume)..."
      Container @("${Vol}:/to") "find /to -mindepth 1 -delete" | Out-Null
    }
  } else {
    if ((DockerExit @("volume", "create", $Vol)) -ne 0) { throw "Couldn't create the volume $Vol." }
  }
  Ok "volume $Vol ready"
  $t = Get-Date
  Say ("Copying {0:N0} GB into the volume. This takes a while (roughly 5-30 minutes); please leave this window open..." -f ($size / 1GB))
  Container @("${BaseFwd}:/from:ro", "${Vol}:/to") "cp -a /from/. /to/ && sync" | Out-Null
  Ok ("copied in {0:N0} minutes" -f ((Get-Date) - $t).TotalMinutes)

  # ---------- 5. check ----------
  $check = Container @("${BaseFwd}:/from:ro", "${Vol}:/to:ro") 'for d in /from /to; do n=$(find $d -type f | wc -l); b=$(find $d -type f -exec stat -c %s {} + | awk ''{s+=$1} END {print s+0}''); k=$(sha256sum $d/block_producer/private.key | cut -c1-64); echo $d $n $b $k; done'
  $res = @{}
  foreach ($line in $check) { if ("$line" -match '^(/from|/to) (\d+) (\d+) ([0-9a-f]{64})$') { $res[$matches[1]] = @{ n = $matches[2]; b = $matches[3]; k = $matches[4] } } }
  if (-not $res["/from"] -or -not $res["/to"]) { throw "The copy check gave no clear answer: $check" }
  $src = $res["/from"]; $dst = $res["/to"]
  if ($src.n -ne $dst.n) { throw "The copy has $($dst.n) files, the folder $($src.n)." }
  if ($src.b -ne $dst.b) { throw "The copy holds $($dst.b) bytes, the folder $($src.b)." }
  if ($src.k -ne $dst.k) { throw "The block-producer key in the copy doesn't match the folder's." }
  Ok ("copy checked: {0} files, {1:N0} GB, block-producer key identical" -f $dst.n, ([int64]$dst.b / 1GB))

  # ---------- 6. override ----------
  $services = @("chain", "mempool", "block_store", "p2p", "block_producer", "jsonrpc", "grpc", "transaction_store", "contract_meta_store", "account_history")
  $lines = @($Marker,
    "# Written by node\move-node-to-volume.ps1 on $stamp. Docker Compose reads this file automatically: every Koinos",
    "# service gets the Docker volume above at /koinos instead of the BASEDIR folder (Compose merges volumes by their",
    "# path in the container). To go back to the folder: docker compose down, rename this file, docker compose up -d.",
    "services:")
  foreach ($s in $services) { $lines += @("  ${s}:", "    volumes:", "      - knode-basedir:/koinos") }
  $lines += @("volumes:", "  knode-basedir:", "    external: true", "    name: $Vol")
  Set-Content -Path $Override -Value $lines -Encoding ascii
  $wroteOverride = $true
  Push-Location $Koinos
  try { $ErrorActionPreference = "Continue"; $cfg = (& docker compose config 2>$null) -join "`n"; $cfgExit = $LASTEXITCODE } finally { Pop-Location; $ErrorActionPreference = "Stop" }
  if ($cfgExit -ne 0) { throw "docker compose config rejected the override." }
  $leaf = ($BaseFwd -split "/" | Where-Object { $_ } | Select-Object -Last 2) -join "/"
  if ($cfg -notmatch [regex]::Escape("name: $Vol")) { throw "The checked configuration doesn't use the volume $Vol." }
  if (($cfg -replace "\\", "/") -match [regex]::Escape($leaf)) { throw "The checked configuration still mounts the folder $BaseFwd somewhere." }
  Ok "docker-compose.override.yml written and checked"

  # ---------- 7. start ----------
  Say "Starting the $Node node on the volume..."
  Compose @("up", "-d")
  $started = $true
  $moved = $true
  $h = $null
  $until = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $until -and -not $h) {
    Start-Sleep -Seconds 10
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port" -Method Post -ContentType "application/json" -TimeoutSec 8 -Body '{"jsonrpc":"2.0","id":1,"method":"chain.get_head_info","params":{}}'
      $h = $r.result.head_topology.height
    } catch { }
  }
  if ($h) { Ok "the $Node node answers: block #$h" } else { Write-Host "The node started but doesn't answer on port $Port yet. Give it a few more minutes, then: node bot\heal.mjs --dry-run" -ForegroundColor Yellow }
}
catch {
  Write-Host "PROBLEM: $($_.Exception.Message)" -ForegroundColor Red
  if (-not $started) {
    if ($wroteOverride -and (Test-Path $Override)) {
      Rename-Item $Override "docker-compose.override.yml.failed-$stamp"
      Say "Set the override aside (docker-compose.override.yml.failed-$stamp); the node uses its old folder."
    }
    Say "Starting the $Node node again on its old folder..."
    try { Compose @("up", "-d"); Ok "$Node node started (old folder, unchanged)" } catch { Write-Host "Couldn't start it: run 'docker compose up -d' in $Koinos" -ForegroundColor Red }
  }
}
finally {
  try { $l = Get-Content $LockFile -Raw | ConvertFrom-Json; if ($l.pid -eq $PID) { Remove-Item $LockFile } } catch { }
}

Write-Host ""
if ($moved) {
  Write-Host "DONE. The $Node node now runs on the Docker volume $Vol." -ForegroundColor Green
  Write-Host "  In about 15 minutes check:   node bot\heal.mjs --dry-run   (it should say OK, 0 behind)"
  Write-Host "  The old folder $Base is untouched: it is your backup. After a week of good running you can delete it."
  Write-Host "  To go back to the folder: in $Koinos run  docker compose down,  rename docker-compose.override.yml,  docker compose up -d"
  exit 0
} else {
  Write-Host "The move did not finish (see above). The node runs on its old folder, nothing was lost. Tell Claude." -ForegroundColor Yellow
  exit 1
}
