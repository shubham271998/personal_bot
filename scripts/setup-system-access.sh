#!/bin/bash
# ── Setup System Access for Pocket Bot ──────────────────────
# Run this ONCE with: sudo bash scripts/setup-system-access.sh
# Grants passwordless sudo for specific system commands only.

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "❌ Run with sudo: sudo bash $0"
  exit 1
fi

USER_NAME="${SUDO_USER:-$(whoami)}"
SUDOERS_FILE="/etc/sudoers.d/pocket-bot"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYSTEM_SCRIPT="$SCRIPT_DIR/pocket-system.sh"

echo "🔧 Setting up system access for user: $USER_NAME"

# 1. Symlink the system script to /usr/local/bin for easy access
ln -sf "$SYSTEM_SCRIPT" /usr/local/bin/pocket-system
echo "✅ Symlinked pocket-system to /usr/local/bin/"

# 2. Create sudoers entry for commands that truly need sudo
cat > "$SUDOERS_FILE" << EOF
# Pocket Bot — passwordless sudo for system commands
# Created by setup-system-access.sh
$USER_NAME ALL=(ALL) NOPASSWD: /usr/bin/pmset
$USER_NAME ALL=(ALL) NOPASSWD: /sbin/shutdown
$USER_NAME ALL=(ALL) NOPASSWD: /usr/bin/caffeinate
$USER_NAME ALL=(ALL) NOPASSWD: /usr/sbin/networksetup
$USER_NAME ALL=(ALL) NOPASSWD: /usr/bin/killall
$USER_NAME ALL=(ALL) NOPASSWD: /usr/sbin/spctl
EOF

# Validate sudoers syntax
if visudo -cf "$SUDOERS_FILE"; then
  chmod 0440 "$SUDOERS_FILE"
  echo "✅ Sudoers file created at $SUDOERS_FILE"
else
  rm -f "$SUDOERS_FILE"
  echo "❌ Sudoers syntax error — file removed. Please check manually."
  exit 1
fi

# 3. Ensure Accessibility permissions reminder
echo ""
echo "⚠️  IMPORTANT: For sleep/shutdown/lock to work via osascript,"
echo "   you MUST grant Accessibility access to Terminal/iTerm2:"
echo "   → System Settings → Privacy & Security → Accessibility"
echo "   → Add Terminal.app (or iTerm.app or your terminal)"
echo ""
echo "   Also grant it to 'osascript' if prompted."
echo ""

# 4. Install optional tools
if command -v brew &>/dev/null; then
  echo "🍺 Checking optional tools..."

  if ! command -v blueutil &>/dev/null; then
    echo "   Installing blueutil (Bluetooth control)..."
    sudo -u "$USER_NAME" brew install blueutil 2>/dev/null || echo "   ⚠️  blueutil install failed — install manually: brew install blueutil"
  else
    echo "   ✅ blueutil already installed"
  fi

  if ! command -v brightness &>/dev/null; then
    echo "   Installing brightness (display control)..."
    sudo -u "$USER_NAME" brew install brightness 2>/dev/null || echo "   ⚠️  brightness install failed — install manually: brew install brightness"
  else
    echo "   ✅ brightness already installed"
  fi

  if ! command -v imagesnap &>/dev/null; then
    echo "   Installing imagesnap (webcam capture)..."
    sudo -u "$USER_NAME" brew install imagesnap 2>/dev/null || echo "   ⚠️  imagesnap install failed — install manually: brew install imagesnap"
  else
    echo "   ✅ imagesnap already installed"
  fi
else
  echo "⚠️  Homebrew not found. Install blueutil, brightness, imagesnap manually if needed."
fi

echo ""
echo "✅ Setup complete! The bot can now run system commands."
echo "   Test with: pocket-system help"
echo "   Or:        pocket-system battery"
