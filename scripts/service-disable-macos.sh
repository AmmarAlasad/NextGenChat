#!/usr/bin/env bash
# scripts/service-disable-macos.sh
#
# Stop, disable, or remove the local NextGenChat LaunchAgent on macOS.

set -euo pipefail

LABEL="com.nextgenchat.local"
PLIST_FILE="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/NextGenChat"
MODE="${1:-disable}"
NEXTGENCHAT_HOME_DIR="${NEXTGENCHAT_HOME:-$HOME/.nextgenchat}"
DOMAIN="gui/$(id -u)"
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

bootout_service() {
  if [ -f "$PLIST_FILE" ]; then
    launchctl bootout "$DOMAIN" "$PLIST_FILE" >/dev/null 2>&1 || true
  else
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  fi
}

remove_command_shims() {
  local shim_dirs=()

  if [ -n "${NEXTGENCHAT_BIN_DIR:-}" ]; then
    shim_dirs+=("$NEXTGENCHAT_BIN_DIR")
  else
    shim_dirs+=("/opt/homebrew/bin" "/usr/local/bin" "$HOME/.local/bin")
  fi

  for shim_dir in "${shim_dirs[@]}"; do
    [ -n "$shim_dir" ] || continue
    rm -f "$shim_dir/nextgenchat" "$shim_dir/ngc"
  done

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

  if [ -d "$LOG_DIR" ]; then
    rm -rf "$LOG_DIR"
    echo "Removed NextGenChat logs at $LOG_DIR"
  fi
}

case "$MODE" in
  stop)
    bootout_service
    echo "Stopped $LABEL. It will start again the next time you log in."
    ;;
  disable)
    bootout_service
    launchctl disable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    echo "Stopped and disabled $LABEL"
    ;;
  remove|purge)
    bootout_service
    launchctl disable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST_FILE"
    remove_command_shims
    if confirm_remove_data; then
      remove_nextgenchat_data
    else
      echo "Kept local NextGenChat data at $NEXTGENCHAT_HOME_DIR"
    fi
    echo "Stopped, disabled, and removed $LABEL"
    ;;
  *)
    echo "Usage: bash scripts/service-disable-macos.sh [stop|disable|remove] [--keep-data|--remove-data]" >&2
    exit 1
    ;;
esac
