#!/bin/bash
# Research Daemon — runs Claude CLI analysis in background
# Pushes results to Turso cloud DB for deployed bot to use

BOT_DIR="${POCKET_BOT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$BOT_DIR" || exit 1

# Load .env
if [ -f .env ]; then
  while IFS= read -r line; do
    case "$line" in \#*|"") continue ;; esac
    export "$line" 2>/dev/null || true
  done < .env
fi

exec node src/polymarket/research-daemon.mjs
