#!/usr/bin/env bash
# scripts/install-macos.sh
#
# One-line bootstrap entrypoint for macOS installs from a raw GitHub URL.
# Clones or updates the repo, runs local setup, then installs/updates a launchd
# user service.

set -euo pipefail

REPO_URL="${NEXTGENCHAT_REPO_URL:-https://github.com/AmmarAlasad/NextGenChat.git}"
INSTALL_DIR="${NEXTGENCHAT_DIR:-$HOME/NextGenChat}"
NEXTGENCHAT_HOME_DIR="${NEXTGENCHAT_HOME:-$HOME/.nextgenchat}"
STATE_FILE_NAME="$NEXTGENCHAT_HOME_DIR/install/install-state-macos"

hash_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

compute_install_state() {
  local head tracked staged untracked env_hash
  head="$(git rev-parse HEAD 2>/dev/null || printf 'no-head')"
  tracked="$(git diff --name-only 2>/dev/null || true)"
  staged="$(git diff --cached --name-only 2>/dev/null || true)"
  untracked="$(git ls-files --others --exclude-standard 2>/dev/null || true)"

  if [ -f .env ]; then
    env_hash="$(hash_file .env)"
  else
    env_hash="no-env"
  fi

  printf '%s\n%s\n%s\n%s\n%s\n' "$head" "$tracked" "$staged" "$untracked" "$env_hash" | hash_stdin
}

ensure_repo() {
  if [ -f "package.json" ] && [ -f "scripts/setup.sh" ] && [ -d ".git" ]; then
    pwd
    return 0
  fi

  if [ ! -d "$INSTALL_DIR/.git" ]; then
    git clone "$REPO_URL" "$INSTALL_DIR" >&2
  else
    git -C "$INSTALL_DIR" pull --ff-only >&2
  fi

  printf '%s\n' "$INSTALL_DIR"
}

install_command_shims() {
  local bin_dir="${NEXTGENCHAT_BIN_DIR:-}"

  if [ -z "$bin_dir" ]; then
    if [ -d "/opt/homebrew/bin" ] && [ -w "/opt/homebrew/bin" ]; then
      bin_dir="/opt/homebrew/bin"
    elif [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
      bin_dir="/usr/local/bin"
    else
      bin_dir="$HOME/.local/bin"
    fi
  fi

  mkdir -p "$bin_dir"

  cat > "$bin_dir/nextgenchat" <<EOF
#!/usr/bin/env bash
exec node "$REPO_DIR/bin/nextgenchat.js" "\$@"
EOF

  cat > "$bin_dir/ngc" <<EOF
#!/usr/bin/env bash
exec node "$REPO_DIR/bin/nextgenchat.js" "\$@"
EOF

  chmod +x "$bin_dir/nextgenchat" "$bin_dir/ngc"

  echo "Installed commands: nextgenchat, ngc"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) echo "Note: add $bin_dir to PATH if your shell cannot find nextgenchat or ngc." >&2 ;;
  esac
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS. Use scripts/install.sh on Linux." >&2
  exit 1
fi

command -v git >/dev/null 2>&1 || { echo "git is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required"; exit 1; }
command -v launchctl >/dev/null 2>&1 || { echo "launchctl is required"; exit 1; }

REPO_DIR="$(ensure_repo)"
cd "$REPO_DIR"

PREVIOUS_STATE=""
mkdir -p "$(dirname "$STATE_FILE_NAME")"

if [ -f "$STATE_FILE_NAME" ]; then
  PREVIOUS_STATE="$(cat "$STATE_FILE_NAME")"
fi

bash scripts/setup.sh
install_command_shims

CURRENT_STATE="$(compute_install_state)"

if [ "$CURRENT_STATE" != "$PREVIOUS_STATE" ]; then
  NEXTGENCHAT_RESTART_SERVICE=1 bash scripts/service-install-macos.sh
else
  NEXTGENCHAT_RESTART_SERVICE=0 bash scripts/service-install-macos.sh
fi

printf '%s\n' "$CURRENT_STATE" > "$STATE_FILE_NAME"

echo
echo "NextGenChat is installed as a macOS LaunchAgent."
echo "Frontend: http://localhost:3000"
echo "Backend:  http://localhost:3001"
echo "Command:  nextgenchat --help"
echo "Alias:    ngc --help"
echo "Status:   ngc --status"
echo "Logs:     ngc --logs"
