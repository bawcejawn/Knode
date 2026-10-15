<#
  Kprediction — set up the project's own Koinos node and block producer on this PC.

  What it does (safe to run again; finished steps are skipped):
    1. checks Docker, git and free disk space
    2. downloads the official Koinos node setup into C:\kpred-node\koinos
    3. sets the block producer to produce for the GAME CONTRACT address
    4. downloads the newest chain snapshot from Armana, checks its fingerprint (SHA-256), and unpacks it
       (so the node doesn't have to replay the whole chain)
    5. starts the node and tells you how to get its PUBLIC key

  Run in PowerShell from C:\kprediction:
      powershell -ExecutionPolicy Bypass -File node\setup-node.ps1 -Producer <contract address>

  Your other node (the 600k one) is not touched: this is a separate folder, a separate Docker project
  ("kpred-node") and a separate block-producer key.
#>
param(
  [Parameter(Mandatory = $true)][string]$Producer,
  [string]$Root = "C:\kpred-node",
  [switch]$KeepArchive
)
$ErrorActionPreference = "Stop"
function Step($text) { Write-Host "`n== $text ==" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Note($text) { Write-Host "   $text" }
function WriteNoBom($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

if ($Producer -notmatch '^1[1-9A-HJ-NP-Za-km-z]{25,34}$') { throw "That doesn't look like a Koinos address: $Producer" }

# ───────────── 1. checks ─────────────
Step "1/5 Checking this PC"
try { $null = docker version --format '{{.Server.Version}}' 2>$null; if ($LASTEXITCODE -ne 0) { throw "x" } }
catch { throw "Docker isn't running. Install Docker Desktop (docker.com), start it, then run this again." }
Ok "Docker is running"
try { $null = git --version } catch { throw "git is missing. Install Git for Windows, then run this again." }
Ok "git is installed"
$driveName = (Split-Path -Qualifier $Root).TrimEnd(':')
$free = (Get-PSDrive $driveName).Free
$haveData = Test-Path (Join-Path $Root "basedir\chain")
$needGB = if ($haveData) { 5 } else { 200 }
if ($free -lt ($needGB * 1GB)) { throw ("Not enough free space on {0}: need about {1} GB, have {2:N0} GB." -f $driveName, $needGB, ($free / 1GB)) }
Ok ("{0:N0} GB free on {1}:" -f ($free / 1GB), $driveName)

# ───────────── 2. official node setup ─────────────
Step "2/5 Official Koinos node setup"
New-Item -ItemType Directory -Force $Root | Out-Null
$repo = Join-Path $Root "koinos"
if (-not (Test-Path $repo)) { git clone --depth 1 https://github.com/koinos/koinos.git $repo; if ($LASTEXITCODE -ne 0) { throw "git clone failed" } }
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
SetEnv "COMPOSE_PROJECT_NAME" "kpred-node"
SetEnv "COMPOSE_PROFILES" "block_producer,jsonrpc"
Ok "settings in $repo\.env (data folder $basedir)"

# ───────────── 3. producer address ─────────────
Step "3/5 Block producer for the game contract"
$cfgPath = Join-Path $repo "config\config.yml"
$cfg = Get-Content $cfgPath -Raw
if ($cfg -notmatch '(?m)^block_producer:[ \t]*\r?$') { throw "config.yml has no 'block_producer:' section — tell Claude what the file looks like." }
if ($cfg -match '(?m)^([ \t]+)#?[ \t]*producer:.*$') {
  $indent = $Matches[1]
  $cfg = ([regex]'(?m)^([ \t]+)#?[ \t]*producer:.*$').Replace($cfg, "$indent" + "producer: $Producer", 1)
} else {
  $cfg = ([regex]'(?m)^block_producer:[ \t]*\r?$').Replace($cfg, "block_producer:`n  producer: $Producer", 1)
}
WriteNoBom $cfgPath $cfg
Ok "producer: $Producer"

# ───────────── 4. chain snapshot ─────────────
Step "4/5 Chain snapshot (Armana)"
if ($haveData) {
  Ok "chain data already present — skipping the snapshot"
} else {
  $idx = Invoke-RestMethod "https://snapshots.armana.io/index.json"
  $candidates = @()
  foreach ($p in $idx.PSObject.Properties) {
    if ($p.Name -match 'retire|delet|old') { continue }
    foreach ($s in @($p.Value)) { if ($s -and $s.url -and $s.sha256 -and $s.height) { $candidates += $s } }
  }
  $snap = $candidates | Sort-Object { [int64]$_.height } -Descending | Select-Object -First 1
  if (-not $snap) { throw "Couldn't read the snapshot list at snapshots.armana.io/index.json" }
  $file = Join-Path $Root $snap.name
  Note ("Newest snapshot: block {0:N0}, {1:N1} GB — this download takes a while; if it stops, run this script again and it continues where it left off." -f [int64]$snap.height, ([double]$snap.size_bytes / 1GB))
  curl.exe -L --fail --retry 5 -C - -o $file $snap.url
  if ($LASTEXITCODE -ne 0) { throw "The download stopped. Run this script again to continue it." }
  Note "Checking the fingerprint (several minutes)..."
  $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $snap.sha256.ToLower()) { Remove-Item $file; throw "Fingerprint mismatch: the download was damaged and has been deleted. Run this script again." }
  Ok "fingerprint matches"
  $restore = Join-Path $Root "restore"
  New-Item -ItemType Directory -Force $restore | Out-Null
  Note "Unpacking (can take 30+ minutes)..."
  tar -xzf $file -C $restore
  if ($LASTEXITCODE -ne 0) { throw "Unpacking failed. Free some disk space and run this script again." }
  $src = Join-Path $restore ".koinos"
  if (-not (Test-Path $src)) { $src = (Get-ChildItem $restore -Directory -Recurse -Filter "chain" | Select-Object -First 1).Parent.FullName }
  foreach ($d in @("chain", "block_store")) {
    if (-not (Test-Path (Join-Path $src $d))) { throw "The snapshot has no '$d' folder — tell Claude." }
    Move-Item (Join-Path $src $d) (Join-Path $basedir $d)
  }
  Remove-Item $restore -Recurse -Force
  if (-not $KeepArchive) { Remove-Item $file }
  Ok "chain data in place"
}

# ───────────── 5. start ─────────────
Step "5/5 Starting the node"
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose failed to start the node." }
$keyFile = Join-Path $basedir "block_producer\private.key"
for ($i = 0; $i -lt 60 -and -not (Test-Path $keyFile); $i++) { Start-Sleep -Seconds 2 }
if (Test-Path $keyFile) { Ok "the block producer created its key ($keyFile) — keep this file private" }
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
