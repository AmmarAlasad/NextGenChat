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

echo -e "\n  Building backend and frontend for a stable local run..."
pnpm --filter @nextgenchat/backend build
pnpm --filter @nextgenchat/web build
ok "Backend and frontend builds complete"

cleanup() {
  if [ -n "${backend_pid:-}" ] && kill -0 "$backend_pid" 2>/dev/null; then
    kill "$backend_pid" 2>/dev/null || true
  fi

  if [ -n "${web_pid:-}" ] && kill -0 "$web_pid" 2>/dev/null; then
    kill "$web_pid" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo -e "\n${BOLD}Starting servers...${RESET}"
echo -e "  Frontend → ${CYAN}http://localhost:3000${RESET}"
echo -e "  Backend  → ${CYAN}http://localhost:3001${RESET}"
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop.\n"

pnpm --filter @nextgenchat/backend start &
backend_pid=$!

pnpm --filter @nextgenchat/web start &
web_pid=$!

wait -n "$backend_pid" "$web_pid"
exit_code=$?
cleanup
exit "$exit_code"
