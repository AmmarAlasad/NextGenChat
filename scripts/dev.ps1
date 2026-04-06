$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "NextGenChat - Local dev stack (Windows)" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path .env)) {
    Write-Host "X .env file not found. Please run the setup script first." -ForegroundColor Red
    exit 1
}

Write-Host "  Syncing backend Prisma env..."
Copy-Item .env apps/backend/.env -Force
Write-Host "  OK Synced backend Prisma env" -ForegroundColor Green

Write-Host ""
Write-Host "  Syncing Prisma schema..."
pnpm --filter @nextgenchat/backend prisma:generate
pnpm --filter @nextgenchat/backend prisma:push
Write-Host "  OK SQLite schema up to date" -ForegroundColor Green

Write-Host ""
Write-Host "Starting servers..." -ForegroundColor Cyan
Write-Host "  Frontend -> http://localhost:3000"
Write-Host "  Backend  -> http://localhost:3001"
Write-Host "  Press Ctrl+C to stop."
Write-Host ""

pnpm turbo dev
