<#
  Knode - set up a Koinos TESTNET (Harbinger) node on this PC, for testing the game without real money.

  It runs next to your mainnet node without touching it: its own folder (C:\kpred-testnet), its own Docker project
  ("kpred-testnet") and its own ports (the testnet node answers on http://127.0.0.1:8081, the mainnet one stays on 8080).
  It does not produce blocks (it doesn't need to): it only reads the testnet and sends our test transactions.

  Run in PowerShell from C:\kprediction:
      powershell -ExecutionPolicy Bypass -File node\setup-testnet.ps1

  The first sync downloads the whole testnet chain (there is no snapshot), so it can take hours. Check progress with:
      npm run bot -- node-status --testnet
#>
param([string]$Root = "C:\kpred-testnet")
$ErrorActionPreference = "Stop"
function Step($text) { Write-Host "`n== $text ==" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   OK  $text" -ForegroundColor Green }
function Note($text) { Write-Host "   $text" }
function WriteNoBom($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

Step "1/3 Checking this PC"
try { $null = docker version --format '{{.Server.Version}}' 2>$null; if ($LASTEXITCODE -ne 0) { throw "x" } }
catch { throw "Docker isn't running. Start Docker Desktop, then run this again." }
Ok "Docker is running"
try { $null = git --version } catch { throw "git is missing. Install Git for Windows, then run this again." }
Ok "git is installed"
$driveName = (Split-Path -Qualifier $Root).TrimEnd(':')
$free = (Get-PSDrive $driveName).Free
if ($free -lt (40 * 1GB)) { throw ("Not enough free space on {0}: keep at least 40 GB free for the testnet, have {1:N0} GB." -f $driveName, ($free / 1GB)) }
Ok ("{0:N0} GB free on {1}:" -f ($free / 1GB), $driveName)

Step "2/3 Official Koinos node setup, Harbinger testnet settings"
New-Item -ItemType Directory -Force $Root | Out-Null
$repo = Join-Path $Root "koinos"
if (-not (Test-Path $repo)) { git clone --depth 1 https://github.com/koinos/koinos.git $repo; if ($LASTEXITCODE -ne 0) { throw "git clone failed" } }
Set-Location $repo
if (-not (Test-Path "harbinger")) { throw "The Koinos setup has no 'harbinger' folder - tell Claude." }
if (-not (Test-Path "config")) { Copy-Item "harbinger\config-example" "config" -Recurse }
if (-not (Test-Path ".env")) { Copy-Item "harbinger\env.example" ".env" }
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
SetEnv "COMPOSE_PROJECT_NAME" "kpred-testnet"
SetEnv "COMPOSE_PROFILES" "jsonrpc"
SetEnv "JSONRPC_PORT" "8081"
SetEnv "P2P_PORT" "8889"
SetEnv "AMQP_PORT" "5673"
SetEnv "AMQP_ADMIN_PORT" "15673"
SetEnv "GRPC_PORT" "50052"
SetEnv "REST_PORT" "3001"
Ok "testnet settings in $repo\.env (data folder $basedir, RPC on port 8081)"

Step "3/3 Starting the testnet node"
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose failed to start the testnet node." }
Ok "started"

Write-Host ""
Write-Host "Done. The node now downloads the testnet chain; that can take a few hours the first time." -ForegroundColor Cyan
Write-Host "  cd $repo ; docker compose logs --tail 5 chain     # shows the block height it has reached"
Write-Host ""
Write-Host "Useful:"
Write-Host "  cd $repo ; docker compose logs --tail 30 chain     # what the testnet node is doing"
Write-Host "  cd $repo ; docker compose down                    # stop it (the mainnet node keeps running)"
Write-Host "  cd $repo ; docker compose up -d                   # start it again"
