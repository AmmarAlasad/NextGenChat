#!/usr/bin/env bash
# scripts/service-disable.sh
#
# Stop/disable or remove the local NextGenChat user service.

set -euo pipefail

SERVICE_NAME="nextgenchat.service"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME"
MODE="${1:-disable}"
NEXTGENCHAT_HOME_DIR="${NEXTGENCHAT_HOME:-$HOME/.nextgenchat}"
REMOVE_DATA=0
KEEP_DATA=0

shift || true
for arg in "$@"; do
  case "$arg" in
    --remove-data|--delete-data) REMOVE_DATA=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required to manage the NextGenChat service." >&2
  exit 1
fi

remove_command_shims() {
  local bin_dir="${NEXTGENCHAT_BIN_DIR:-$HOME/.local/bin}"

  rm -f "$bin_dir/nextgenchat" "$bin_dir/ngc"
  echo "Removed command shims: nextgenchat, ngc"
}

confirm_remove_data() {
  if [ "$REMOVE_DATA" = "1" ]; then
    return 0
  fi

  if [ "$KEEP_DATA" = "1" ]; then
    return 1
  fi

  echo
  echo "Local NextGenChat data is stored at:"
  echo "  $NEXTGENCHAT_HOME_DIR"
  echo
  echo "This includes conversations, the local database, logs, and agent workspaces."
  printf "Type DELETE to remove this data, or press Enter to keep it: "
  read -r answer
  [ "$answer" = "DELETE" ]
}

remove_nextgenchat_data() {
  if [ -d "$NEXTGENCHAT_HOME_DIR" ]; then
    rm -rf "$NEXTGENCHAT_HOME_DIR"
    echo "Removed local NextGenChat data at $NEXTGENCHAT_HOME_DIR"
  else
    echo "No local NextGenChat data directory found at $NEXTGENCHAT_HOME_DIR"
  fi
}

case "$MODE" in
  stop)
    systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    echo "Stopped $SERVICE_NAME"
    ;;
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
    remove_command_shims
    if confirm_remove_data; then
      remove_nextgenchat_data
    else
      echo "Kept local NextGenChat data at $NEXTGENCHAT_HOME_DIR"
    fi
    echo "Stopped, disabled, and removed $SERVICE_NAME"
    ;;
  *)
    echo "Usage: bash scripts/service-disable.sh [stop|disable|remove] [--keep-data|--remove-data]" >&2
    exit 1
    ;;
esac
