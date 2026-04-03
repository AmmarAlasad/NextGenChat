#!/usr/bin/env bash
# scripts/stop.sh
#
# Stop all running NextGenChat dev server processes.
# Called by: pnpm stop
# Does not stop PostgreSQL or Redis (they can stay running between sessions).

GREEN="\033[32m"
RESET="\033[0m"

stopped=0

fuser -k 3001/tcp 2>/dev/null && echo -e "  ${GREEN}✓ Backend stopped (port 3001)${RESET}" && stopped=$((stopped+1)) || true
fuser -k 3000/tcp 2>/dev/null && echo -e "  ${GREEN}✓ Frontend stopped (port 3000)${RESET}" && stopped=$((stopped+1)) || true
pkill -f "tsx watch\|next dev\|turbo dev" 2>/dev/null || true

if [ $stopped -eq 0 ]; then
  echo "  No dev servers were running."
else
  echo -e "\n  All dev servers stopped."
fi
