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

NEXTGENCHAT_HOME_DEFAULT="${NEXTGENCHAT_HOME:-$HOME/.nextgenchat}"
NEXTGENCHAT_DB_PATH_DEFAULT="$NEXTGENCHAT_HOME_DEFAULT/dev.db"
NEXTGENCHAT_AGENT_WORKSPACES_DEFAULT="$NEXTGENCHAT_HOME_DEFAULT/agent-workspaces"

step() { echo -e "\n${BOLD}${CYAN}▸ $1${RESET}"; }
ok() { echo -e "  ${GREEN}✓ $1${RESET}"; }
warn() { echo -e "  ${YELLOW}! $1${RESET}"; }

generate_secret() {
  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
}

notify_existing_local_data() {
  local data_dir="$1"
  local legacy_workspace_dir="apps/backend/agent-workspaces"
  local legacy_db_paths=("apps/backend/dev.db" "apps/backend/prisma/dev.db" "dev.db")

  if [ -d "$data_dir" ] && [ -n "$(ls -A "$data_dir" 2>/dev/null)" ]; then
    warn "Found existing NextGenChat local data at $data_dir"
    warn "Setup will reuse that existing installation data."
  fi

  if [ -d "$legacy_workspace_dir" ] && [ -n "$(ls -A "$legacy_workspace_dir" 2>/dev/null)" ]; then
    warn "Found legacy repo-local agent workspaces at $legacy_workspace_dir"
    warn "They will not be used automatically. Move anything you still need into $NEXTGENCHAT_AGENT_WORKSPACES_DEFAULT"
  fi

  for legacy_db in "${legacy_db_paths[@]}"; do
    if [ -f "$legacy_db" ]; then
      warn "Found legacy repo-local SQLite data at $legacy_db"
      warn "It will not be used automatically. Move it to $NEXTGENCHAT_DB_PATH_DEFAULT if you need it."
    fi
  done
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
    local tmp_env
    tmp_env="$(mktemp)"
    awk -v key="$key" -v value="$value" 'index($0, key "=") == 1 { $0 = key "=" value } { print }' .env > "$tmp_env"
    mv "$tmp_env" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
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

notify_existing_local_data "$NEXTGENCHAT_HOME_DEFAULT"

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

mkdir -p "$NEXTGENCHAT_HOME_DEFAULT"
mkdir -p "$NEXTGENCHAT_AGENT_WORKSPACES_DEFAULT"

set_env_value "DEPLOYMENT_MODE" "local"
set_env_value "DATABASE_URL" "file:$NEXTGENCHAT_DB_PATH_DEFAULT"
set_env_value "REDIS_ENABLED" "false"
set_env_value "REDIS_URL" ""
set_env_value "AGENT_WORKSPACES_DIR" "$NEXTGENCHAT_AGENT_WORKSPACES_DEFAULT"
ok "Local installation data root: $NEXTGENCHAT_HOME_DEFAULT"
ok "SQLite database will be stored at $NEXTGENCHAT_DB_PATH_DEFAULT"
ok "Agent workspaces will be stored at $NEXTGENCHAT_AGENT_WORKSPACES_DEFAULT"

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
