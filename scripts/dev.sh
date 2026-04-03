#!/usr/bin/env bash
# scripts/dev.sh
#
# Start the full Phase 1 dev stack: infra check → migrations → backend + frontend.
# Called by: pnpm dev:phase1
# Requires PostgreSQL and Redis. Run 'pnpm setup' first if you haven't already.

set -e
cd "$(dirname "$0")/.."   # always run from repo root

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

ok()   { echo -e "  ${GREEN}✓ $1${RESET}"; }
warn() { echo -e "  ${YELLOW}! $1${RESET}"; }
fail() { echo -e "\n${RED}${BOLD}✗ $1${RESET}\n"; exit 1; }

echo -e "\n${BOLD}NextGenChat — Phase 1 dev stack${RESET}"

# ── PostgreSQL ───────────────────────────────────────────────────────────────
if pg_isready -q 2>/dev/null || pg_isready -q -h localhost 2>/dev/null; then
  ok "PostgreSQL is running"
else
  warn "PostgreSQL not running — attempting to start..."
  sudo systemctl start postgresql 2>/dev/null \
    || sudo service postgresql start 2>/dev/null \
    || fail "Could not start PostgreSQL.\n  Run: sudo service postgresql start\n  Or run: pnpm setup"
  sleep 1
  pg_isready -q 2>/dev/null || pg_isready -q -h localhost 2>/dev/null \
    || fail "PostgreSQL still not reachable. Run 'pnpm setup' first."
  ok "PostgreSQL started"
fi

# ── Redis ────────────────────────────────────────────────────────────────────
if redis-cli ping >/dev/null 2>&1; then
  ok "Redis is running"
else
  warn "Redis not running — attempting to start..."
  sudo systemctl start redis-server 2>/dev/null \
    || sudo service redis-server start 2>/dev/null \
    || fail "Could not start Redis.\n  Run: sudo service redis-server start\n  Or run: pnpm setup"
  sleep 1
  redis-cli ping >/dev/null 2>&1 \
    || fail "Redis still not reachable. Run 'pnpm setup' first."
  ok "Redis started"
fi

# ── Load .env safely (handles & and other special chars in values) ───────────
if [ ! -f ".env" ]; then
  fail ".env file not found. Run 'pnpm setup' first."
fi

while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue   # skip comments
  [[ -z "$line" ]] && continue                   # skip blank lines
  export "$line" 2>/dev/null || true
done < .env

# Write DATABASE_URL directly into apps/backend/.env where Prisma always looks
echo "DATABASE_URL=$DATABASE_URL" > apps/backend/.env

# ── Migrations ───────────────────────────────────────────────────────────────
echo -e "\n  Applying migrations..."
pnpm --filter @nextgenchat/backend prisma:migrate
ok "Migrations up to date"

# ── Start servers ─────────────────────────────────────────────────────────────
echo -e "\n${BOLD}Starting servers...${RESET}"
echo -e "  Frontend → ${CYAN}http://localhost:3000${RESET}"
echo -e "  Backend  → ${CYAN}http://localhost:3001${RESET}"
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop.\n"

exec pnpm turbo dev
