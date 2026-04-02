#!/bin/bash
export HOME="/Users/shubhamrao"
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v20.19.5/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$HOME/Downloads/pocket-android/telegram-claude-bot"

# Load all env vars from .env
while IFS= read -r line; do
  case "$line" in \#*|"") ;; *) export "$line" 2>/dev/null ;; esac
done < .env

exec "$HOME/.nvm/versions/node/v20.19.5/bin/node" bot.mjs
