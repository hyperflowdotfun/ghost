#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# Ghost Installer — macOS & Linux
#
# Installs @hyperflow.fun/ghost globally via bun from the public
# npm registry. Bootstraps Bun if missing.
#
# Usage: ./install.sh [--channel latest|rc] [--help]
# ------------------------------------------------------------------

GHOST_CONFIG="${HOME}/.ghost/config.json"
PACKAGE_NAME="@hyperflow.fun/ghost"
CHANNEL="latest"

# Sentinel markers for the Ghost-managed block in the shell rc file
# (~/.bashrc, ~/.zshrc, ~/.profile) that exports ~/.bun/bin to PATH.
readonly GHOST_RC_BEGIN='# GHOST-BEGIN'
readonly GHOST_RC_END='# GHOST-END'

usage() {
  cat <<EOF
Ghost Installer

Usage: ./install.sh [OPTIONS]

Options:
  --channel <v>  Release channel: latest (default) or rc
  --help         Show this help message

Examples:
  ./install.sh                                   # interactive install + onboard
  curl -fsSL <URL>/install.sh | bash             # one-liner
  curl -fsSL <URL>/install.sh | bash -s -- --channel rc
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --channel)      [ "$#" -ge 2 ] || { echo "Error: --channel requires a value"; usage; exit 1; }
                    CHANNEL="$2"; shift 2 ;;
    --channel=*)    CHANNEL="${1#*=}"; shift ;;
    --help)         usage; exit 0 ;;
    *)              echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

case "$CHANNEL" in
  latest|rc) ;;
  *) echo "Error: unknown channel '$CHANNEL' (valid: latest, rc)" >&2; exit 1 ;;
esac

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

detect_os() {
  case "$(uname -s)" in
    Darwin*) echo "darwin" ;;
    Linux*)  echo "linux" ;;
    *)       echo "unsupported" ;;
  esac
}

has_command() { command -v "$1" &>/dev/null; }
is_tty() { [ -t 0 ] && [ -t 1 ]; }

OS="$(detect_os)"
if [ "$OS" = "unsupported" ]; then
  echo "Error: Unsupported operating system. Ghost supports macOS and Linux." >&2
  exit 1
fi

# ------------------------------------------------------------------
# Terminal UI
# ------------------------------------------------------------------

NC='\033[0m'
BOLD='\033[1m'
PURPLE='\033[38;5;133m'
GREEN='\033[38;5;78m'
RED='\033[38;5;167m'
AMBER='\033[38;5;214m'
MUTED='\033[38;5;60m'

TOTAL_STAGES=3
CURRENT_STAGE=0

ui_banner() {
  echo -e "${PURPLE}${BOLD}"
  echo '     ██████╗ ██╗  ██╗ ██████╗ ███████╗████████╗'
  echo '    ██╔════╝ ██║  ██║██╔═══██╗██╔════╝╚══██╔══╝'
  echo '    ██║  ███╗███████║██║   ██║███████╗   ██║   '
  echo '    ██║   ██║██╔══██║██║   ██║╚════██║   ██║   '
  echo '    ╚██████╔╝██║  ██║╚██████╔╝███████║   ██║   '
  echo '     ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝   '
  echo ''
  echo '    AI Trading Companion for Hyperliquid'
  echo -e "${NC}"
}

ui_stage() {
  CURRENT_STAGE=$((CURRENT_STAGE + 1))
  echo -e "\n${PURPLE}${BOLD}[${CURRENT_STAGE}/${TOTAL_STAGES}] $1${NC}"
}
ui_info()    { echo -e "${MUTED}·${NC} $1"; }
ui_success() { echo -e "${GREEN}✓${NC} $1"; }
ui_error()   { echo -e "${RED}✗${NC} $1" >&2; }
ui_warn()    { echo -e "${AMBER}!${NC} $1"; }

# ------------------------------------------------------------------
# Phase: Bun bootstrap
# ------------------------------------------------------------------

install_bun() {
  ui_stage "Checking Bun runtime"
  if has_command bun; then
    ui_success "Bun v$(bun --version) already installed"
    return
  fi
  ui_info "Bun not found — installing..."
  if ! has_command curl; then
    ui_error "curl is required to install Bun."
    exit 1
  fi
  if curl -fsSL https://bun.sh/install | bash; then
    export BUN_INSTALL="${HOME}/.bun"
    export PATH="${BUN_INSTALL}/bin:${PATH}"
    if has_command bun; then
      ui_success "Bun v$(bun --version) installed"
    else
      ui_error "Bun install completed but 'bun' not on PATH. Restart your terminal and retry."
      exit 1
    fi
  else
    ui_error "Failed to install Bun. See https://bun.sh/docs/installation"
    exit 1
  fi
}

# ------------------------------------------------------------------
# Phase: Install Ghost from npm registry
# ------------------------------------------------------------------

install_ghost() {
  ui_stage "Installing Ghost"
  ui_info "Package: ${PACKAGE_NAME}"
  ui_info "Channel: ${CHANNEL}"

  # `@<channel>` forces dist-tag resolution so any existing caret pin in
  # ~/.bun/install/global/package.json can't hold the user on an older
  # release. `--no-cache` ignores bun's manifest cache so a freshly-published
  # release is seen instead of whatever the previous probe recorded.
  if ! bun install -g "${PACKAGE_NAME}@${CHANNEL}" --no-cache; then
    ui_error "Failed to install ${PACKAGE_NAME}."
    exit 1
  fi
  ensure_bun_bin_path
  if has_command ghost; then
    ui_success "Ghost installed — 'ghost' is on your PATH"
  else
    ui_warn "Installed, but 'ghost' not yet on PATH. Restart your terminal."
  fi
}

ensure_bun_bin_path() {
  local bun_bin="${HOME}/.bun/bin"
  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$bun_bin"; then
    export PATH="${bun_bin}:${PATH}"
  fi

  local shell_rc=""
  case "$(basename "${SHELL:-bash}")" in
    zsh)  shell_rc="${HOME}/.zshrc" ;;
    bash) shell_rc="${HOME}/.bashrc" ;;
    *)    shell_rc="${HOME}/.profile" ;;
  esac
  if [ -f "$shell_rc" ] && grep -qF "$GHOST_RC_BEGIN" "$shell_rc"; then
    return
  fi
  if [ -f "$shell_rc" ] && grep -qF "$bun_bin" "$shell_rc"; then
    return
  fi
  {
    echo ""
    echo "${GHOST_RC_BEGIN} (managed by ghost installer -- do not edit)"
    echo "# Ghost (Bun global bin)"
    echo "export PATH=\"${bun_bin}:\$PATH\""
    echo "$GHOST_RC_END"
  } >> "$shell_rc"
  ui_info "Added ${bun_bin} to PATH in ${shell_rc}"
}

# ------------------------------------------------------------------
# Phase: Post-install
# ------------------------------------------------------------------

post_install() {
  ui_stage "Finalizing"
  echo ""
  ui_success "Ghost installed successfully!"
  echo ""

  if [ -f "$GHOST_CONFIG" ]; then
    ui_info "Existing config found at ${GHOST_CONFIG}"
    ui_info "Run 'ghost daemon' to start Ghost."
    return
  fi

  # `ghost` lands in $HOME/.bun/bin; the rc-file PATH export isn't visible
  # to this running bash, so keep an absolute-path fallback handy.
  local bun_ghost="${HOME}/.bun/bin/ghost"
  local ghost_cmd=""
  if has_command ghost; then
    ghost_cmd="ghost"
  elif [ -x "$bun_ghost" ]; then
    ghost_cmd="$bun_ghost"
  fi

  if is_tty; then
    echo ""
    ui_info "Starting onboard wizard..."
    echo ""
    if [ -n "$ghost_cmd" ]; then
      "$ghost_cmd" onboard
    else
      ui_warn "'ghost' binary not found after install. Restart your terminal and run 'ghost onboard'."
    fi
  else
    # Piped (curl | bash) or truly headless: skip auto-launch. /dev/tty
    # re-attachment has proven unreliable on macOS and some SSH setups.
    echo ""
    ui_info "Install complete. Run 'ghost onboard' in a new terminal to finish setup."
  fi
}

# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------

main() {
  ui_banner
  echo ""
  install_bun
  install_ghost
  post_install
}

main
