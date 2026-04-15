#!/usr/bin/env bash
# scripts/install.sh
#
# One-line bootstrap entrypoint for local installs from a raw GitHub URL.
# Clones or updates the repo, runs local setup, then installs/updates a user service.

set -euo pipefail

REPO_URL="${NEXTGENCHAT_REPO_URL:-https://github.com/AmmarAlasad/NextGenChat.git}"
INSTALL_DIR="${NEXTGENCHAT_DIR:-$HOME/NextGenChat}"
NEXTGENCHAT_HOME_DIR="${NEXTGENCHAT_HOME:-$HOME/.nextgenchat}"
STATE_FILE_NAME="$NEXTGENCHAT_HOME_DIR/install/install-state"

compute_install_state() {
  local head tracked staged untracked env_hash
  head="$(git rev-parse HEAD 2>/dev/null || printf 'no-head')"
  tracked="$(git diff --name-only 2>/dev/null || true)"
  staged="$(git diff --cached --name-only 2>/dev/null || true)"
  untracked="$(git ls-files --others --exclude-standard 2>/dev/null || true)"

  if [ -f .env ]; then
    env_hash="$(sha256sum .env | awk '{print $1}')"
  else
    env_hash="no-env"
  fi

  printf '%s\n%s\n%s\n%s\n%s\n' "$head" "$tracked" "$staged" "$untracked" "$env_hash" | sha256sum | awk '{print $1}'
}

ensure_repo() {
  if [ -f "package.json" ] && [ -f "scripts/setup.sh" ] && [ -d ".git" ]; then
    pwd
    return 0
  fi

  if [ ! -d "$INSTALL_DIR/.git" ]; then
    git clone "$REPO_URL" "$INSTALL_DIR"
  else
    git -C "$INSTALL_DIR" pull --ff-only
  fi

  printf '%s\n' "$INSTALL_DIR"
}

command -v git >/dev/null 2>&1 || { echo "git is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required"; exit 1; }

REPO_DIR="$(ensure_repo)"
cd "$REPO_DIR"

PREVIOUS_STATE=""
mkdir -p "$(dirname "$STATE_FILE_NAME")"

if [ -f "$STATE_FILE_NAME" ]; then
  PREVIOUS_STATE="$(cat "$STATE_FILE_NAME")"
fi

bash scripts/setup.sh

CURRENT_STATE="$(compute_install_state)"

if [ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/nextgenchat.service" ] || [ "$CURRENT_STATE" != "$PREVIOUS_STATE" ]; then
  NEXTGENCHAT_RESTART_SERVICE=1 bash scripts/service-install.sh
else
  NEXTGENCHAT_RESTART_SERVICE=0 bash scripts/service-install.sh
fi

printf '%s\n' "$CURRENT_STATE" > "$STATE_FILE_NAME"

echo
echo "NextGenChat is installed as a user service."
echo "Frontend: http://localhost:3000"
echo "Backend:  http://localhost:3001"
echo "Status:   systemctl --user status nextgenchat.service"
echo "Logs:     journalctl --user -u nextgenchat.service -f"
