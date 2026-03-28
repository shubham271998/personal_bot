#!/bin/bash
# ── Pocket Bot Startup Script ───────────────────────────────
# Used by LaunchAgent. Sends "laptop active" msg, then starts bot.
# Configure paths for your system before using.

BOT_DIR="${POCKET_BOT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$BOT_DIR" || exit 1

# Load .env manually (launchd shell is minimal)
if [ -f .env ]; then
  while IFS= read -r line; do
    case "$line" in
      \#*|"") continue ;;
    esac
    export "$line" 2>/dev/null || true
  done < .env
fi

# Send "laptop active" notification via Telegram API
CHAT_ID="${SECURITY_ALERT_CHAT_ID:-}"
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "$CHAT_ID" ]; then
  TIMESTAMP=$(date "+%Y-%m-%d %H:%M:%S")
  MSG=$(printf '🟢 *Laptop Active*\n⏰ %s\n🤖 Bot starting...' "$TIMESTAMP")
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${MSG}" \
    -d "parse_mode=Markdown" > /dev/null 2>&1 || true
fi

# Start the bot
exec node bot.mjs
