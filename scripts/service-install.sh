#!/usr/bin/env bash
# scripts/service-install.sh
#
# Install or update the local NextGenChat user service using systemd --user.

set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE_NAME="nextgenchat.service"
SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME"
RESTART_SERVICE="${NEXTGENCHAT_RESTART_SERVICE:-0}"
LINGER_ENABLED="unknown"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required to install the NextGenChat service." >&2
  exit 1
fi

if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
  LINGER_ENABLED="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || printf 'unknown')"
fi

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=NextGenChat local app
After=network.target

[Service]
Type=simple
WorkingDirectory=$(pwd)
Environment=PATH=${PATH}
ExecStart=/usr/bin/env bash $(pwd)/scripts/service-run.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" >/dev/null

if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  if [ "$RESTART_SERVICE" = "1" ]; then
    systemctl --user restart "$SERVICE_NAME"
    echo "Updated and restarted $SERVICE_NAME"
  else
    echo "$SERVICE_NAME is already running; service file refreshed"
  fi
else
  systemctl --user start "$SERVICE_NAME"
  echo "Installed and started $SERVICE_NAME"
fi

if [ "$LINGER_ENABLED" = "yes" ]; then
  echo "User lingering is enabled; the service should start again after reboot."
elif [ "$LINGER_ENABLED" = "no" ]; then
  echo "Warning: user lingering is disabled. The service may not restart after reboot until you log in again." >&2
  echo "Run: sudo loginctl enable-linger $USER" >&2
else
  echo "Warning: could not verify user lingering state. Reboot persistence depends on systemd user lingering." >&2
fi
