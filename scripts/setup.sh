#!/usr/bin/env bash
# scripts/setup.sh
#
# First-time local environment setup. Run once after cloning: pnpm setup
# Works on Ubuntu 22+ and Debian/Kali. Requires sudo for apt and service management.
# Uses PostgreSQL peer auth (no password needed) — creates a DB role matching your OS username.

set -e
cd "$(dirname "$0")/.."   # always run from repo root

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

step()  { echo -e "\n${BOLD}${CYAN}▸ $1${RESET}"; }
ok()    { echo -e "  ${GREEN}✓ $1${RESET}"; }
warn()  { echo -e "  ${YELLOW}! $1${RESET}"; }
fail()  { echo -e "\n${RED}${BOLD}✗ $1${RESET}\n"; exit 1; }

echo -e "\n${BOLD}NextGenChat — First-time setup${RESET}"
echo -e "Setting up for user: ${BOLD}$USER${RESET}\n"

# ── 1. Check required tools ──────────────────────────────────────────────────
step "Checking prerequisites"

node_version=$(node --version 2>/dev/null | cut -c2- | cut -d. -f1)
if [[ -z "$node_version" || "$node_version" -lt 18 ]]; then
  fail "Node.js 18+ is required. Install it with:\n\n  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -\n  sudo apt install -y nodejs"
fi
ok "Node.js $(node --version)"

if ! command -v pnpm &>/dev/null; then
  fail "pnpm is required. Install it with:\n\n  npm install -g pnpm"
fi
ok "pnpm $(pnpm --version)"

# ── 2. Install PostgreSQL and Redis if missing ───────────────────────────────
step "Installing PostgreSQL and Redis (if needed)"

if ! command -v psql &>/dev/null; then
  warn "PostgreSQL not found — installing..."
  sudo apt-get update -qq
  sudo apt-get install -y postgresql
  ok "PostgreSQL installed"
else
  ok "PostgreSQL already installed"
fi

if ! command -v redis-cli &>/dev/null; then
  warn "Redis not found — installing..."
  sudo apt-get install -y redis-server
  ok "Redis installed"
else
  ok "Redis already installed"
fi

# ── 3. Start and enable services ─────────────────────────────────────────────
step "Starting and enabling services"

sudo systemctl enable --now postgresql redis-server 2>/dev/null \
  || { sudo service postgresql start; sudo service redis-server start; }

sleep 1

pg_isready -q 2>/dev/null || pg_isready -q -h localhost 2>/dev/null \
  || fail "PostgreSQL did not start. Check: sudo service postgresql status"
ok "PostgreSQL running"

redis-cli ping >/dev/null 2>&1 \
  || fail "Redis did not start. Check: sudo service redis-server status"
ok "Redis running"

# ── 4. Create PostgreSQL role for current OS user (peer auth — no password) ──
step "Configuring database access for '$USER'"

# Create role if it doesn't exist
sudo -u postgres psql -c "CREATE USER \"$USER\" WITH SUPERUSER;" 2>/dev/null \
  && ok "PostgreSQL role '$USER' created" \
  || ok "PostgreSQL role '$USER' already exists"

# Set a known password for TCP connections (Prisma requires TCP)
psql -U "$USER" -d postgres -c "ALTER USER \"$USER\" WITH PASSWORD 'dev';" 2>/dev/null \
  && ok "Password set for '$USER'" || true

# Create database if it doesn't exist
sudo -u postgres createdb -O "$USER" nextgenchat 2>/dev/null \
  && ok "Database 'nextgenchat' created" \
  || ok "Database 'nextgenchat' already exists"

# ── 5. Write DATABASE_URL into .env ──────────────────────────────────────────
step "Configuring .env"

DB_URL="postgresql://$USER:dev@localhost:5432/nextgenchat?schema=public"

if [ -f ".env" ]; then
  # Update existing DATABASE_URL line
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env
  ok ".env updated with socket DATABASE_URL"
else
  # Create .env from example
  cp .env.example .env
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env
  warn "Created .env from .env.example — fill in JWT_SECRET, ENCRYPTION_KEY, and OPENAI_API_KEY"
fi

# ── 6. Install dependencies ──────────────────────────────────────────────────
step "Installing workspace dependencies"
pnpm install
ok "Dependencies installed"

# ── 7. Run migrations ────────────────────────────────────────────────────────
step "Running database migrations"
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$line" ]] && continue
  export "$line" 2>/dev/null || true
done < .env
echo "DATABASE_URL=$DATABASE_URL" > apps/backend/.env
pnpm --filter @nextgenchat/backend prisma:migrate
ok "Migrations applied"

# ── Done ─────────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}✓ Setup complete!${RESET}"
echo -e "\n  ${BOLD}pnpm dev:phase1${RESET}   — start the stack"
echo -e "  ${BOLD}pnpm stop${RESET}         — stop dev servers"
echo -e "\n  Frontend: ${CYAN}http://localhost:3000${RESET}"
echo -e "  Backend:  ${CYAN}http://localhost:3001${RESET}\n"
