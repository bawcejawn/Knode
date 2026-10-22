<#
  Kprediction - set up the project's own Koinos node and block producer on this PC.

  What it does (safe to run again; finished steps are skipped):
    1. checks Docker, git and free disk space
    2. downloads the official Koinos node setup into C:\kpred-node\koinos (the pinned release, checked by its commit)
    3. sets the block producer to produce for the GAME CONTRACT address
    4. downloads the newest chain snapshot from Armana, checks its fingerprint (SHA-256) against one you got from a
       SECOND source (-SnapshotSha256), and unpacks it (so the node doesn't have to replay the whole chain)
    5. starts the node and tells you how to get its PUBLIC key

  Run in PowerShell from C:\kprediction:
      powershell -ExecutionPolicy Bypass -File node\setup-node.ps1 -Producer <contract address> -SnapshotSha256 <hash>

  -SnapshotSha256: the snapshot's SHA-256 from somewhere other than snapshots.armana.io, so a tampered server can't
  hand you a matching file and fingerprint together. For example the hash Armana posts in the Koinos Discord or Telegram,
  or one a second node operator computed for the same file. Run once without it to see which snapshot is newest and
  its listed hash; then compare that with the second source. Not needed when the chain data is already there.

  Your other node (the 600k one) is not touched: this is a separate folder, a separate Docker project
  ("kpred-node") and a separate block-producer key.

  The same script also sets up your PERSONAL node next to it, in its own folder, Docker project and ports:
      powershell -ExecutionPolicy Bypass -File node\setup-node.ps1 -Producer <your own address> -Root C:\koinos-personal -Project koinos-personal -PortOffset 10
  (RPC 8090, P2P 8898 for that one; the game node keeps 8080 / 8888.)
#>
param(
  [Parameter(Mandatory = $true)][string]$Producer,
  [string]$Root = "C:\kpred-node",
  [string]$Project = "kpred-node",
  [int]$PortOffset = 0,
  [string]$SnapshotSha256 = "",
  [switch]$KeepArchive
)
$ErrorActionPreference = "Stop"
function Step($text) { Write-Host "`n== $text ==" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Note($text) { Write-Host "   $text" }
function WriteNoBom($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

if ($Producer -notmatch '^1[1-9A-HJ-NP-Za-km-z]{25,34}$') { throw "That doesn't look like a Koinos address: $Producer" }

# The official node setup is pinned to a release, checked by its commit (https://github.com/koinos/koinos/releases).
# To move to a newer release: read its notes, then change BOTH lines to the new tag and the commit GitHub shows for it.
$KoinosTag = "v2.2.1"
$KoinosCommit = "7c861cd13681f6fce735e345cc6f563cc6047574"

# ------------- 1. checks -------------
Step "1/5 Checking this PC"
try { $null = docker version --format '{{.Server.Version}}' 2>$null; if ($LASTEXITCODE -ne 0) { throw "x" } }
catch { throw "Docker isn't running. Install Docker Desktop (docker.com), start it, then run this again." }
Ok "Docker is running"
try { $null = git --version } catch { throw "git is missing. Install Git for Windows, then run this again." }
Ok "git is installed"
$driveName = (Split-Path -Qualifier $Root).TrimEnd(':')
$free = (Get-PSDrive $driveName).Free
$haveData = (Test-Path (Join-Path $Root "basedir\chain")) -and (Test-Path (Join-Path $Root "basedir\block_store"))
# Room needed: the snapshot archive (~61 GB) plus the two databases the producer uses, unpacked. The other three
# databases in the archive are skipped and the archive is deleted afterwards. 140 GB leaves a safe margin.
$needGB = if ($haveData) { 5 } else { 140 }
if ($free -lt ($needGB * 1GB)) { throw ("Not enough free space on {0}: need about {1} GB, have {2:N0} GB." -f $driveName, $needGB, ($free / 1GB)) }
Ok ("{0:N0} GB free on {1}:" -f ($free / 1GB), $driveName)

# ------------- 2. official node setup -------------
Step "2/5 Official Koinos node setup"
New-Item -ItemType Directory -Force $Root | Out-Null
$repo = Join-Path $Root "koinos"
if (-not (Test-Path $repo)) {
  git -c advice.detachedHead=false clone --depth 1 --branch $KoinosTag https://github.com/koinos/koinos.git $repo; if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
  if ((git -C $repo rev-parse HEAD).Trim() -ne $KoinosCommit) { Remove-Item $repo -Recurse -Force; throw "The downloaded node setup is not release $KoinosTag (commit $KoinosCommit). Nothing was installed." }
  Ok "official node setup $KoinosTag (commit $($KoinosCommit.Substring(0, 12)))"
} elseif ((git -C $repo rev-parse HEAD).Trim() -ne $KoinosCommit) {
  Note "This folder's node setup is not the pinned release $KoinosTag (an older run used the newest code). It keeps working;"
  Note "to move to the release, stop the node and run: git -C $repo fetch --depth 1 origin tag $KoinosTag; git -C $repo checkout $KoinosTag"
}
Set-Location $repo
if (-not (Test-Path "config")) { Copy-Item "config-example" "config" -Recurse }
if (-not (Test-Path ".env")) { Copy-Item "env.example" ".env" }
$basedir = Join-Path $Root "basedir"
New-Item -ItemType Directory -Force $basedir | Out-Null

function SetEnv($key, $value) {
  $lines = @(Get-Content ".env")
  $found = $false
  $lines = $lines | ForEach-Object { if ($_ -match "^\s*#?\s*$key\s*=") { $found = $true; "$key=$value" } else { $_ } }
  if (-not $found) { $lines += "$key=$value" }
  WriteNoBom (Join-Path $repo ".env") (($lines -join "`n") + "`n")
}
SetEnv "BASEDIR" ($basedir -replace '\\', '/')
SetEnv "COMPOSE_PROJECT_NAME" $Project
SetEnv "COMPOSE_PROFILES" "block_producer,jsonrpc"
if ($PortOffset -ne 0) {
  # A second node on the same PC needs its own ports (the game node keeps the standard ones: RPC 8080, P2P 8888).
  SetEnv "JSONRPC_PORT" (8080 + $PortOffset)
  SetEnv "P2P_PORT" (8888 + $PortOffset)
  SetEnv "AMQP_PORT" (5672 + $PortOffset)
  SetEnv "AMQP_ADMIN_PORT" (15672 + $PortOffset)
  SetEnv "GRPC_PORT" (50051 + $PortOffset)
  SetEnv "REST_PORT" (3000 + $PortOffset)
  Ok ("own ports for this node: RPC {0}, P2P {1}" -f (8080 + $PortOffset), (8888 + $PortOffset))
}
Ok "settings in $repo\.env (data folder $basedir, Docker project $Project)"

# ------------- 3. producer address -------------
Step "3/5 Block producer address"
$cfgPath = Join-Path $repo "config\config.yml"
$cfg = Get-Content $cfgPath -Raw
if ($cfg -notmatch '(?m)^block_producer:[ \t]*\r?$') { throw "config.yml has no 'block_producer:' section - tell Claude what the file looks like." }
if ($cfg -match '(?m)^([ \t]+)#?[ \t]*producer:.*$') {
  $indent = $Matches[1]
  $cfg = ([regex]'(?m)^([ \t]+)#?[ \t]*producer:.*$').Replace($cfg, "$indent" + "producer: $Producer", 1)
} else {
  $cfg = ([regex]'(?m)^block_producer:[ \t]*\r?$').Replace($cfg, "block_producer:`n  producer: $Producer", 1)
}
WriteNoBom $cfgPath $cfg
Ok "producer: $Producer"

# ------------- 4. chain snapshot -------------
Step "4/5 Chain snapshot (Armana)"
if ($haveData) {
  Ok "chain data already present - skipping the snapshot"
} else {
  $idx = Invoke-RestMethod "https://snapshots.armana.io/index.json"
  $candidates = @(); $listed = @()
  foreach ($p in $idx.PSObject.Properties) {
    foreach ($s in @($p.Value)) {
      if (-not ($s -and $s.url -and $s.sha256 -and $s.height)) { continue }
      $listed += $s
      if ($p.Name -notmatch 'retire|delet|old') { $candidates += $s }
    }
  }
  $snap = $candidates | Sort-Object { [int64]$_.height } -Descending | Select-Object -First 1
  # A download already started keeps going, even if a newer snapshot appeared meanwhile (old ones stay up for a day).
  $partial = Get-ChildItem $Root -Filter "koinos-mainnet-*.tar.gz" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($partial) {
    $match = $listed | Where-Object { $_.name -eq $partial.Name } | Select-Object -First 1
    if ($match) { $snap = $match } else { Remove-Item $partial.FullName }
  }
  if (-not $snap) { throw "Couldn't read the snapshot list at snapshots.armana.io/index.json" }
  # The listed hash only proves the file matches the list on the same server. Require the same hash from a second source.
  if (-not $SnapshotSha256) {
    throw ("Newest snapshot: {0} (block {1:N0}), listed SHA-256 {2}. Get its SHA-256 from a second source (Armana's post in the Koinos Discord or Telegram, or another node operator), then run again with -SnapshotSha256 <that hash>." -f $snap.name, [int64]$snap.height, $snap.sha256)
  }
  if ($SnapshotSha256.Trim().ToLower() -ne $snap.sha256.ToLower()) {
    throw ("The SHA-256 you gave ({0}) is not the one snapshots.armana.io lists for {1} ({2}). Don't use this snapshot: check both sources again." -f $SnapshotSha256, $snap.name, $snap.sha256)
  }
  Ok "the listed fingerprint matches the one from your second source"
  $file = Join-Path $Root $snap.name
  Note ("Newest snapshot: block {0:N0}, {1:N1} GB - this download takes a while; if it stops, run this script again and it continues where it left off." -f [int64]$snap.height, ([double]$snap.size_bytes / 1GB))
  $done = (Test-Path $file) -and ((Get-Item $file).Length -eq [int64]$snap.size_bytes)
  if (-not $done) {
    # --ssl-no-revoke: Windows' curl otherwise fails when it can't reach the certificate-revocation server (the
    # connection is still encrypted and the certificate still checked, and the file's SHA-256 is verified below).
    $ok = $false
    for ($try = 1; $try -le 30 -and -not $ok; $try++) {
      curl.exe -L --fail --ssl-no-revoke --retry 5 -C - -o $file $snap.url
      if ($LASTEXITCODE -eq 0) { $ok = $true } else { Note "Connection dropped (attempt $try of 30) - continuing in 20 s..."; Start-Sleep -Seconds 20 }
    }
    if (-not $ok) { throw "The download keeps stopping. Run this script again later to continue it." }
  } else { Ok "already downloaded" }
  Note "Checking the fingerprint (several minutes)..."
  $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $snap.sha256.ToLower()) { Remove-Item $file; throw "Fingerprint mismatch: the download was damaged and has been deleted. Run this script again." }
  Ok "fingerprint matches"
  $restore = Join-Path $Root "restore"
  New-Item -ItemType Directory -Force $restore | Out-Null
  Note "Unpacking (can take 30+ minutes)..."
  # Unpack only the two databases this node uses (chain, block_store); skip the other three to save space.
  tar -xzf $file -C $restore --include "*.koinos/chain*" --include "*.koinos/block_store*"
  if ($LASTEXITCODE -ne 0) { throw "Unpacking failed. Free some disk space and run this script again." }
  if (-not (Get-ChildItem $restore -Directory -Recurse -Filter "chain" -ErrorAction SilentlyContinue)) {
    Note "Unpacking everything instead (needs more space)..."
    tar -xzf $file -C $restore
    if ($LASTEXITCODE -ne 0) { throw "Unpacking failed. Free some disk space and run this script again." }
  }
  $src = Join-Path $restore ".koinos"
  if (-not (Test-Path $src)) { $src = (Get-ChildItem $restore -Directory -Recurse -Filter "chain" | Select-Object -First 1).Parent.FullName }
  foreach ($d in @("chain", "block_store")) {
    if (-not (Test-Path (Join-Path $src $d))) { throw "The snapshot has no '$d' folder - tell Claude." }
    Move-Item (Join-Path $src $d) (Join-Path $basedir $d)
  }
  Remove-Item $restore -Recurse -Force
  if (-not $KeepArchive) { Remove-Item $file }
  Ok "chain data in place"
}

# ------------- 5. start -------------
Step "5/5 Starting the node"
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose failed to start the node." }
$keyFile = Join-Path $basedir "block_producer\private.key"
for ($i = 0; $i -lt 60 -and -not (Test-Path $keyFile); $i++) { Start-Sleep -Seconds 2 }
if (Test-Path $keyFile) { Ok "the block producer created its key ($keyFile) - keep this file private" }
else { Note "The block producer key isn't there yet; check again in a minute." }

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Cyan
Write-Host "  cd C:\kprediction"
Write-Host "  npm run bot -- node-status     # is the node caught up with the chain?"
Write-Host "  npm run bot -- node-key        # the node's PUBLIC key (safe to share)"
Write-Host ""
Write-Host "Useful:"
Write-Host "  cd $repo ; docker compose logs --tail 30 block_producer     # what the producer is doing"
Write-Host "  cd $repo ; docker compose down                              # stop the node"
Write-Host "  cd $repo ; docker compose up -d                             # start it again"
