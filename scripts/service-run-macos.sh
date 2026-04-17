#!/usr/bin/env bash
# scripts/service-run-macos.sh
#
# Run the installed local stack under launchd on macOS.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo ".env file not found. Run scripts/setup.sh first." >&2
  exit 1
fi

set -a
. ./.env
set +a

cp .env apps/backend/.env

pnpm --filter @nextgenchat/backend prisma:generate
pnpm --filter @nextgenchat/backend prisma:push
pnpm build

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

PORT=3001 pnpm --filter @nextgenchat/backend start &
backend_pid=$!

PORT=3000 pnpm --filter @nextgenchat/web start &
web_pid=$!

while true; do
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    exit_code=0
    wait "$backend_pid" || exit_code=$?
    cleanup
    exit "$exit_code"
  fi

  if ! kill -0 "$web_pid" 2>/dev/null; then
    exit_code=0
    wait "$web_pid" || exit_code=$?
    cleanup
    exit "$exit_code"
  fi

  sleep 2
done
