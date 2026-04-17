#!/usr/bin/env bash
# scripts/service-install-macos.sh
#
# Install or update the local NextGenChat LaunchAgent on macOS.

set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="com.nextgenchat.local"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/NextGenChat"
RESTART_SERVICE="${NEXTGENCHAT_RESTART_SERVICE:-0}"
MODE="${1:-install}"
DOMAIN="gui/$(id -u)"

xml_escape() {
  sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g'
}

escaped() {
  printf '%s' "$1" | xml_escape
}

is_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

write_plist() {
  mkdir -p "$PLIST_DIR" "$LOG_DIR"

  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(escaped "$(pwd)/scripts/service-run-macos.sh")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(escaped "$(pwd)")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(escaped "$PATH")</string>
    <key>NEXTGENCHAT_HOME</key>
    <string>$(escaped "${NEXTGENCHAT_HOME:-$HOME/.nextgenchat}")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(escaped "$LOG_DIR/service.out.log")</string>
  <key>StandardErrorPath</key>
  <string>$(escaped "$LOG_DIR/service.err.log")</string>
</dict>
</plist>
EOF
}

start_service() {
  launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true

  if ! is_loaded; then
    launchctl bootstrap "$DOMAIN" "$PLIST_FILE"
  fi

  launchctl kickstart -k "$DOMAIN/$LABEL"
}

case "$MODE" in
  install)
    write_plist

    if is_loaded && [ "$RESTART_SERVICE" = "1" ]; then
      launchctl bootout "$DOMAIN" "$PLIST_FILE" >/dev/null 2>&1 || true
      start_service
      echo "Updated and restarted $LABEL"
    elif is_loaded; then
      launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
      echo "$LABEL is already running; LaunchAgent file refreshed"
    else
      start_service
      echo "Installed and started $LABEL"
    fi

    echo "The LaunchAgent will start again when you log in."
    ;;
  start)
    if [ ! -f "$PLIST_FILE" ]; then
      write_plist
    fi
    start_service
    echo "Started $LABEL"
    ;;
  *)
    echo "Usage: bash scripts/service-install-macos.sh [install|start]" >&2
    exit 1
    ;;
esac
