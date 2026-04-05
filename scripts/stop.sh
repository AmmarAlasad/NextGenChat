#!/usr/bin/env bash
# scripts/stop.sh
#
# Stop the installed NextGenChat user service and any running dev server processes.
# Called by: pnpm stop

GREEN="\033[32m"
RESET="\033[0m"

stopped=0

if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files 2>/dev/null | grep -q '^nextgenchat.service'; then
  if systemctl --user is-active --quiet nextgenchat.service; then
    systemctl --user stop nextgenchat.service
    echo -e "  ${GREEN}✓ NextGenChat service stopped${RESET}"
    stopped=$((stopped+1))
  fi
fi

fuser -k 3001/tcp 2>/dev/null && echo -e "  ${GREEN}✓ Backend stopped (port 3001)${RESET}" && stopped=$((stopped+1)) || true
fuser -k 3000/tcp 2>/dev/null && echo -e "  ${GREEN}✓ Frontend stopped (port 3000)${RESET}" && stopped=$((stopped+1)) || true
pkill -f "tsx watch\|next dev\|turbo dev" 2>/dev/null || true

if [ $stopped -eq 0 ]; then
  echo "  No dev servers were running."
else
  echo -e "\n  All dev servers stopped."
fi
