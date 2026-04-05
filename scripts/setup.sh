#!/usr/bin/env bash
# scripts/setup.sh
#
# First-time local setup for the packaged local mode.
# Creates a local SQLite-backed .env, installs dependencies, and syncs Prisma.

set -e
cd "$(dirname "$0")/.."

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RESET="\033[0m"

step() { echo -e "\n${BOLD}${CYAN}▸ $1${RESET}"; }
ok() { echo -e "  ${GREEN}✓ $1${RESET}"; }
warn() { echo -e "  ${YELLOW}! $1${RESET}"; }

generate_secret() {
  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
}

sync_backend_env() {
  cp .env apps/backend/.env
}

get_env_value() {
  local key="$1"

  if [ ! -f .env ]; then
    return 0
  fi

  local line
  line=$(grep "^${key}=" .env | tail -n 1 || true)
  line="${line#${key}=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

set_env_value() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

choose_agent_workspaces_dir() {
  local configured_value="${NEXTGENCHAT_AGENT_WORKSPACES_DIR:-}"
  local existing_value
  existing_value="$(get_env_value "AGENT_WORKSPACES_DIR")"
  local default_value="${existing_value:-$HOME/.nextgenchat/agent-workspaces}"

  if [ -n "$configured_value" ]; then
    printf '%s' "$configured_value"
    return 0
  fi

  if [ -t 0 ]; then
    printf '\n%sChoose agent workspace directory%s\n' "$BOLD" "$RESET" >&2
    printf '  This folder stores each agent workspace outside the repo so reinstalling\n' >&2
    printf '  or updating the project does not wipe the agent files.\n\n' >&2
    printf '  Path [%s]: ' "$default_value" >&2

    local response
    IFS= read -r response

    if [ -n "$response" ]; then
      printf '%s' "$response"
      return 0
    fi
  fi

  printf '%s' "$default_value"
}

echo -e "\n${BOLD}NextGenChat — Local setup${RESET}"

step "Checking prerequisites"
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || { echo "git is required"; exit 1; }
command -v node >/dev/null 2>&1 && ok "Node.js $(node --version)" || { echo "Node.js 20+ is required"; exit 1; }

if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@10.33.0 --activate >/dev/null 2>&1 || true
fi

command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm --version)" || {
  echo "pnpm is required. Install it with: npm install -g pnpm"
  exit 1
}

step "Creating local environment"

if [ ! -f .env ]; then
  cp .env.example .env
  set_env_value "JWT_SECRET" "$(generate_secret)"
  set_env_value "JWT_REFRESH_SECRET" "$(generate_secret)"
  set_env_value "ENCRYPTION_KEY" "$(generate_secret)"

  if [ -n "${OPENAI_API_KEY:-}" ]; then
    set_env_value "OPENAI_API_KEY" "$OPENAI_API_KEY"
  fi

  ok "Created .env for local SQLite mode"
else
  warn "Using existing .env"
fi

set_env_value "DEPLOYMENT_MODE" "local"
set_env_value "DATABASE_URL" "file:./dev.db"
set_env_value "REDIS_ENABLED" "false"
set_env_value "REDIS_URL" ""

AGENT_WORKSPACES_DIR_VALUE="$(choose_agent_workspaces_dir)"
mkdir -p "$AGENT_WORKSPACES_DIR_VALUE"
set_env_value "AGENT_WORKSPACES_DIR" "$AGENT_WORKSPACES_DIR_VALUE"
ok "Agent workspaces will be stored in $AGENT_WORKSPACES_DIR_VALUE"

sync_backend_env
ok "Synced backend Prisma env"

step "Installing workspace dependencies"
pnpm install
ok "Dependencies installed"

step "Syncing Prisma client and local database"
pnpm --filter @nextgenchat/backend prisma:generate
pnpm --filter @nextgenchat/backend prisma:push
ok "SQLite schema is ready"

echo -e "\n${GREEN}${BOLD}✓ Local setup complete${RESET}"
echo -e "\n  ${BOLD}pnpm dev:local${RESET}   — start the app"
echo -e "  ${BOLD}pnpm stop${RESET}        — stop dev servers"
echo -e "\n  Frontend: ${CYAN}http://localhost:3000${RESET}"
echo -e "  Backend:  ${CYAN}http://localhost:3001${RESET}\n"
