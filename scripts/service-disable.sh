#!/usr/bin/env bash
# scripts/service-disable.sh
#
# Stop/disable or remove the local NextGenChat user service.

set -euo pipefail

SERVICE_NAME="nextgenchat.service"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME"
MODE="${1:-disable}"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required to manage the NextGenChat service." >&2
  exit 1
fi

case "$MODE" in
  disable)
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl --user disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    echo "Stopped and disabled $SERVICE_NAME"
    ;;
  remove|purge)
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl --user disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "$SERVICE_FILE"
    systemctl --user daemon-reload
    echo "Stopped, disabled, and removed $SERVICE_NAME"
    ;;
  *)
    echo "Usage: bash scripts/service-disable.sh [disable|remove]" >&2
    exit 1
    ;;
esac
