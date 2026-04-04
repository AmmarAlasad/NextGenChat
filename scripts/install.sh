#!/usr/bin/env bash
# scripts/install.sh
#
# One-line bootstrap entrypoint for local installs from a raw GitHub URL.
# Clones or updates the repo, runs local setup, then starts the app.

set -e

REPO_URL="${NEXTGENCHAT_REPO_URL:-https://github.com/AmmarAlasad/NextGenChat.git}"
INSTALL_DIR="${NEXTGENCHAT_DIR:-$HOME/NextGenChat}"

command -v git >/dev/null 2>&1 || { echo "git is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required"; exit 1; }

if [ -f "package.json" ] && [ -f "scripts/setup.sh" ]; then
  bash scripts/setup.sh
  pnpm dev:local
  exit 0
fi

if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" pull --ff-only
fi

cd "$INSTALL_DIR"
bash scripts/setup.sh
pnpm dev:local
