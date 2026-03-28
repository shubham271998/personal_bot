#!/bin/bash
# ── Grant macOS Permissions for Pocket Bot ───────────────────
# Opens the correct System Settings pane for each permission type.
# Usage: grant-permissions.sh <type>

set -euo pipefail

TYPE="${1:-help}"

case "$TYPE" in

  camera)
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
    echo "OK: Opened Camera permissions. Grant access to Terminal/iTerm."
    ;;

  accessibility)
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    echo "OK: Opened Accessibility permissions. Add Terminal/iTerm/node."
    ;;

  screen-recording)
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    echo "OK: Opened Screen Recording permissions. Grant access to Terminal/iTerm."
    ;;

  full-disk)
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    echo "OK: Opened Full Disk Access. Grant access to Terminal/iTerm."
    ;;

  automation)
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
    echo "OK: Opened Automation permissions. Grant access for osascript."
    ;;

  microphone)
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    echo "OK: Opened Microphone permissions."
    ;;

  all)
    echo "Opening all relevant permission panels..."
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
    sleep 1
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    sleep 1
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    sleep 1
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
    echo "OK: Opened Camera, Accessibility, Screen Recording, Automation panels."
    echo "Grant access to Terminal.app / iTerm2 in each."
    ;;

  check)
    echo "Permission Status Check:"
    echo ""
    # Camera - try capturing
    if ffmpeg -f avfoundation -framerate 1 -t 0.1 -i "0" -frames:v 1 -y /tmp/.perm-test.png 2>/dev/null; then
      echo "  📷 Camera: ✅ Granted"
      rm -f /tmp/.perm-test.png
    else
      echo "  📷 Camera: ❌ Not granted"
    fi
    # Screen recording
    if screencapture -x /tmp/.perm-test.png 2>/dev/null; then
      echo "  🖥️  Screen Recording: ✅ Granted"
      rm -f /tmp/.perm-test.png
    else
      echo "  🖥️  Screen Recording: ❌ Not granted"
    fi
    # Accessibility (osascript)
    if osascript -e 'tell application "System Events" to get name of first process' 2>/dev/null >/dev/null; then
      echo "  ♿ Accessibility: ✅ Granted"
    else
      echo "  ♿ Accessibility: ❌ Not granted"
    fi
    # Volume control
    if osascript -e 'output volume of (get volume settings)' 2>/dev/null >/dev/null; then
      echo "  🔊 Volume Control: ✅ Working"
    else
      echo "  🔊 Volume Control: ❌ Not working"
    fi
    echo ""
    echo "Run: grant-permissions.sh all  — to open all permission panels"
    ;;

  help|*)
    cat <<'HELP'
Grant macOS Permissions:
  camera           Open Camera permissions
  accessibility    Open Accessibility permissions
  screen-recording Open Screen Recording permissions
  full-disk        Open Full Disk Access
  automation       Open Automation permissions
  microphone       Open Microphone permissions
  all              Open all relevant permission panels
  check            Check current permission status
HELP
    ;;
esac
