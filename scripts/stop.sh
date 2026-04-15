#!/usr/bin/env bash
# scripts/stop.sh
#
# Stop the installed NextGenChat user service and any running dev server processes.
# Called by: pnpm stop

GREEN="\033[32m"
RESET="\033[0m"

stopped=0

kill_matching_processes() {
  local pattern="$1"
  local label="$2"

  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pkill -f "$pattern" 2>/dev/null || true
    sleep 1
    pgrep -f "$pattern" >/dev/null 2>&1 && pkill -9 -f "$pattern" 2>/dev/null || true
    echo -e "  ${GREEN}✓ ${label}${RESET}"
    stopped=$((stopped+1))
  fi
}

if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files 2>/dev/null | grep -q '^nextgenchat.service'; then
  if systemctl --user is-active --quiet nextgenchat.service; then
    systemctl --user stop nextgenchat.service
    echo -e "  ${GREEN}✓ NextGenChat service stopped${RESET}"
    stopped=$((stopped+1))
  fi
fi

fuser -k 3001/tcp 2>/dev/null && echo -e "  ${GREEN}✓ Backend stopped (port 3001)${RESET}" && stopped=$((stopped+1)) || true
fuser -k 3000/tcp 2>/dev/null && echo -e "  ${GREEN}✓ Frontend stopped (port 3000)${RESET}" && stopped=$((stopped+1)) || true
kill_matching_processes "pnpm turbo dev" "Stopped pnpm turbo dev"
kill_matching_processes "turbo/bin/turbo dev" "Stopped turbo dev"
kill_matching_processes "@turbo/.*/bin/turbo dev" "Stopped turbo child"
kill_matching_processes "next/dist/bin/next dev" "Stopped Next dev"
kill_matching_processes "tsx/dist/cli.mjs watch --env-file ../../.env src/main.ts" "Stopped backend watcher"

if [ $stopped -eq 0 ]; then
  echo "  No dev servers were running."
else
  echo -e "\n  All dev servers stopped."
fi
