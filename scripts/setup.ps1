$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Write-Host "Agent Orchestrator Setup" -ForegroundColor Cyan
Write-Host ""

function Ensure-Command {
  param([Parameter(Mandatory = $true)][string]$Name)

  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "Missing required command: $Name"
  }
}

try {
  Ensure-Command "node"
  Ensure-Command "npm"
} catch {
  Write-Host $_ -ForegroundColor Red
  Write-Host "Install Node.js (includes npm), then re-run: pwsh scripts/setup.ps1" -ForegroundColor Yellow
  exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "pnpm not found. Installing pnpm globally..." -ForegroundColor Yellow
  npm install -g pnpm
}

Write-Host "Installing dependencies..." -ForegroundColor Cyan
pnpm install

Write-Host "Cleaning stale dashboard build artifacts..." -ForegroundColor Cyan
if (Test-Path "packages/web/.next") {
  Remove-Item -Recurse -Force "packages/web/.next"
}

Write-Host "Building all packages..." -ForegroundColor Cyan
pnpm build

Write-Host "Linking CLI globally..." -ForegroundColor Cyan
Push-Location "packages/cli"
npm link
Pop-Location

Write-Host ""
Write-Host "Setup complete. The 'ao' command should now be available." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. cd <your-project>"
Write-Host "  2. ao init --auto"
Write-Host "  3. gh auth login"
Write-Host "  4. ao start"
Write-Host ""
