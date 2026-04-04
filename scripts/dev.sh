#!/usr/bin/env bash
# scripts/dev.sh
#
# Start the local packaged dev stack: env sync -> Prisma push -> backend + frontend.
# Called by: pnpm dev:local

set -e
cd "$(dirname "$0")/.."

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

ok() { echo -e "  ${GREEN}✓ $1${RESET}"; }
fail() { echo -e "\n${RED}${BOLD}✗ $1${RESET}\n"; exit 1; }

echo -e "\n${BOLD}NextGenChat — Local dev stack${RESET}"

if [ ! -f .env ]; then
  fail ".env file not found. Run 'pnpm setup:local' first."
fi

echo -e "\n  Clearing any stale local dev servers..."
bash scripts/stop.sh >/dev/null 2>&1 || true
ok "Ports 3000 and 3001 are free"

cp .env apps/backend/.env
ok "Synced backend Prisma env"

echo -e "\n  Syncing Prisma schema..."
pnpm --filter @nextgenchat/backend prisma:generate
pnpm --filter @nextgenchat/backend prisma:push
ok "SQLite schema up to date"

echo -e "\n${BOLD}Starting servers...${RESET}"
echo -e "  Frontend → ${CYAN}http://localhost:3000${RESET}"
echo -e "  Backend  → ${CYAN}http://localhost:3001${RESET}"
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop.\n"

exec pnpm turbo dev
