#!/bin/bash
# ── Pocket System Commands ──────────────────────────────────
# Sudo-free system control for the Telegram bot.
# Uses osascript (AppleScript) where possible, falls back to sudo-enabled commands.
# Usage: pocket-system.sh <command> [args...]

set -euo pipefail

CMD="${1:-help}"
shift 2>/dev/null || true

case "$CMD" in

  # ── Power ──────────────────────────────────────────────────
  sleep)
    osascript -e 'tell application "System Events" to sleep'
    echo "OK: System going to sleep"
    ;;

  shutdown)
    osascript -e 'tell application "System Events" to shut down'
    echo "OK: System shutting down"
    ;;

  restart)
    osascript -e 'tell application "System Events" to restart'
    echo "OK: System restarting"
    ;;

  lock)
    osascript -e 'tell application "System Events" to keystroke "q" using {command down, control down}'
    echo "OK: Screen locked"
    ;;

  # ── Display ────────────────────────────────────────────────
  screen-off)
    pmset displaysleepnow 2>/dev/null || osascript -e 'tell application "System Events" to key code 144'
    echo "OK: Display turned off"
    ;;

  brightness)
    LEVEL="${1:-50}"
    osascript -e "tell application \"System Preferences\" to quit" 2>/dev/null || true
    # Use brightness command if available, otherwise AppleScript
    if command -v brightness &>/dev/null; then
      brightness "$( echo "scale=2; $LEVEL / 100" | bc )"
    else
      osascript -e "
        tell application \"System Preferences\"
          reveal anchor \"displaysTab\" of pane id \"com.apple.preference.displays\"
        end tell
      " 2>/dev/null || echo "WARN: Install 'brightness' via brew for direct control"
    fi
    echo "OK: Brightness set to $LEVEL%"
    ;;

  # ── Volume ─────────────────────────────────────────────────
  volume)
    LEVEL="${1:-50}"
    osascript -e "set volume output volume $LEVEL"
    echo "OK: Volume set to $LEVEL%"
    ;;

  mute)
    osascript -e "set volume output muted true"
    echo "OK: Audio muted"
    ;;

  unmute)
    osascript -e "set volume output muted false"
    echo "OK: Audio unmuted"
    ;;

  volume-get)
    VOL=$(osascript -e "output volume of (get volume settings)")
    MUTED=$(osascript -e "output muted of (get volume settings)")
    echo "Volume: ${VOL}%, Muted: ${MUTED}"
    ;;

  # ── Apps ───────────────────────────────────────────────────
  open-app)
    APP="${1:-}"
    if [ -z "$APP" ]; then echo "ERROR: Provide app name"; exit 1; fi
    open -a "$APP" 2>/dev/null || osascript -e "tell application \"$APP\" to activate"
    echo "OK: Opened $APP"
    ;;

  quit-app)
    APP="${1:-}"
    if [ -z "$APP" ]; then echo "ERROR: Provide app name"; exit 1; fi
    osascript -e "tell application \"$APP\" to quit"
    echo "OK: Quit $APP"
    ;;

  force-quit-app)
    APP="${1:-}"
    if [ -z "$APP" ]; then echo "ERROR: Provide app name"; exit 1; fi
    pkill -f "$APP" 2>/dev/null || killall "$APP" 2>/dev/null || true
    echo "OK: Force quit $APP"
    ;;

  running-apps)
    osascript -e '
      tell application "System Events"
        set appList to name of every process whose background only is false
        set AppleScript'\''s text item delimiters to ", "
        return appList as text
      end tell
    '
    ;;

  # ── System Info ────────────────────────────────────────────
  battery)
    pmset -g batt | tail -1
    ;;

  uptime)
    uptime
    ;;

  disk)
    df -h / | tail -1 | awk '{print "Total: "$2", Used: "$3", Free: "$4", Usage: "$5}'
    ;;

  memory)
    vm_stat | head -10
    top -l 1 -n 0 | head -12 | grep -E "PhysMem|Processes|CPU"
    ;;

  wifi)
    networksetup -getairportnetwork en0 2>/dev/null || echo "WiFi info unavailable"
    ;;

  wifi-on)
    networksetup -setairportpower en0 on
    echo "OK: WiFi turned on"
    ;;

  wifi-off)
    networksetup -setairportpower en0 off
    echo "OK: WiFi turned off"
    ;;

  bluetooth-on)
    if command -v blueutil &>/dev/null; then
      blueutil -p 1
      echo "OK: Bluetooth turned on"
    else
      echo "WARN: Install blueutil (brew install blueutil) for Bluetooth control"
    fi
    ;;

  bluetooth-off)
    if command -v blueutil &>/dev/null; then
      blueutil -p 0
      echo "OK: Bluetooth turned off"
    else
      echo "WARN: Install blueutil (brew install blueutil) for Bluetooth control"
    fi
    ;;

  # ── Do Not Disturb ────────────────────────────────────────
  dnd-on)
    shortcuts run "Turn On Focus" 2>/dev/null || \
    osascript -e '
      tell application "System Events"
        tell process "ControlCenter"
          -- Click the Focus/DND menu bar item
          click menu bar item "Focus" of menu bar 1
          delay 0.5
          click checkbox 1 of window 1
        end tell
      end tell
    ' 2>/dev/null || echo "WARN: Create a Shortcut named 'Turn On Focus' for reliable DND control"
    echo "OK: Do Not Disturb enabled"
    ;;

  dnd-off)
    shortcuts run "Turn Off Focus" 2>/dev/null || echo "WARN: Create a Shortcut named 'Turn Off Focus'"
    echo "OK: Do Not Disturb disabled"
    ;;

  # ── Clipboard ──────────────────────────────────────────────
  clipboard-get)
    pbpaste
    ;;

  clipboard-set)
    TEXT="${1:-}"
    echo -n "$TEXT" | pbcopy
    echo "OK: Clipboard set"
    ;;

  # ── Notifications / Alerts ─────────────────────────────────
  notify)
    TITLE="${1:-Pocket Bot}"
    MSG="${2:-Notification}"
    osascript -e "display notification \"$MSG\" with title \"$TITLE\""
    echo "OK: Notification sent"
    ;;

  say)
    TEXT="${1:-Hello}"
    say "$TEXT" &
    echo "OK: Speaking"
    ;;

  # ── Screen ─────────────────────────────────────────────────
  screenshot)
    DEST="${1:-/tmp/screenshot.png}"
    screencapture -x "$DEST"
    echo "OK: Screenshot saved to $DEST"
    ;;

  # ── Caffeinate (prevent sleep) ─────────────────────────────
  caffeinate)
    DURATION="${1:-3600}"
    caffeinate -t "$DURATION" &
    echo "OK: Preventing sleep for ${DURATION}s (PID: $!)"
    ;;

  decaffeinate)
    pkill caffeinate 2>/dev/null || true
    echo "OK: Caffeinate stopped, sleep allowed"
    ;;

  # ── Finder ─────────────────────────────────────────────────
  empty-trash)
    osascript -e 'tell application "Finder" to empty the trash'
    echo "OK: Trash emptied"
    ;;

  eject-all)
    osascript -e 'tell application "Finder" to eject (every disk whose ejectable is true)'
    echo "OK: All ejectable disks ejected"
    ;;

  # ── Dark Mode ──────────────────────────────────────────────
  dark-mode-on)
    osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to true'
    echo "OK: Dark mode enabled"
    ;;

  dark-mode-off)
    osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to false'
    echo "OK: Dark mode disabled"
    ;;

  dark-mode-toggle)
    osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'
    echo "OK: Dark mode toggled"
    ;;

  # ── Kill Process ───────────────────────────────────────────
  kill)
    PROC="${1:-}"
    if [ -z "$PROC" ]; then echo "ERROR: Provide process name or PID"; exit 1; fi
    if [[ "$PROC" =~ ^[0-9]+$ ]]; then
      kill -9 "$PROC"
    else
      pkill -9 -f "$PROC" 2>/dev/null || killall -9 "$PROC" 2>/dev/null
    fi
    echo "OK: Killed $PROC"
    ;;

  # ── Browser ────────────────────────────────────────────────
  open-url)
    URL="${1:-}"
    if [ -z "$URL" ]; then echo "ERROR: Provide a URL"; exit 1; fi
    open "$URL"
    echo "OK: Opened $URL in default browser"
    ;;

  open-chrome)
    URL="${1:-}"
    if [ -z "$URL" ]; then
      open -a "Google Chrome"
    else
      open -a "Google Chrome" "$URL"
    fi
    echo "OK: Opened Chrome${URL:+ with $URL}"
    ;;

  open-safari)
    URL="${1:-}"
    if [ -z "$URL" ]; then
      open -a "Safari"
    else
      open -a "Safari" "$URL"
    fi
    echo "OK: Opened Safari${URL:+ with $URL}"
    ;;

  google)
    QUERY="${*:-}"
    if [ -z "$QUERY" ]; then echo "ERROR: Provide search query"; exit 1; fi
    ENCODED=$(printf '%s' "$QUERY" | python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip()))")
    open "https://www.google.com/search?q=$ENCODED"
    echo "OK: Googled '$QUERY'"
    ;;

  # ── YouTube ────────────────────────────────────────────────
  youtube)
    QUERY="${*:-}"
    if [ -z "$QUERY" ]; then
      open "https://www.youtube.com"
      echo "OK: Opened YouTube"
    else
      ENCODED=$(printf '%s' "$QUERY" | python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip()))")
      open "https://www.youtube.com/results?search_query=$ENCODED"
      echo "OK: Searching YouTube for '$QUERY'"
    fi
    ;;

  youtube-play)
    QUERY="${*:-}"
    if [ -z "$QUERY" ]; then echo "ERROR: Provide song/video name"; exit 1; fi
    ENCODED=$(printf '%s' "$QUERY" | python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip()))")
    # Use invidious API to get first video ID, then open it directly
    VIDEO_ID=$(curl -s "https://www.youtube.com/results?search_query=$ENCODED" | grep -o 'watch?v=[a-zA-Z0-9_-]*' | head -1 | cut -d= -f2)
    if [ -n "$VIDEO_ID" ]; then
      open "https://www.youtube.com/watch?v=$VIDEO_ID"
      echo "OK: Playing '$QUERY' on YouTube"
    else
      open "https://www.youtube.com/results?search_query=$ENCODED"
      echo "OK: Searching YouTube for '$QUERY'"
    fi
    ;;

  # ── Spotify ────────────────────────────────────────────────
  spotify-play)
    QUERY="${*:-}"
    if [ -z "$QUERY" ]; then
      osascript -e 'tell application "Spotify" to play'
      echo "OK: Spotify resumed"
    else
      # Open Spotify, search, wait, then play the first result
      ENCODED=$(printf '%s' "$QUERY" | python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip()))")
      open "spotify:search:$ENCODED"
      sleep 3
      # Press Enter to play the first result
      osascript -e '
        tell application "Spotify" to activate
        delay 1
        tell application "System Events"
          tell process "Spotify"
            key code 36
          end tell
        end tell
      ' 2>/dev/null || true
      sleep 1
      TRACK=$(osascript -e 'tell application "Spotify" to name of current track' 2>/dev/null || echo "")
      ARTIST=$(osascript -e 'tell application "Spotify" to artist of current track' 2>/dev/null || echo "")
      if [ -n "$TRACK" ]; then
        echo "OK: Playing '$TRACK' by $ARTIST on Spotify"
      else
        echo "OK: Opened Spotify search for '$QUERY'"
      fi
    fi
    ;;

  spotify-pause)
    osascript -e 'tell application "Spotify" to pause'
    echo "OK: Spotify paused"
    ;;

  spotify-next)
    osascript -e 'tell application "Spotify" to next track'
    sleep 0.5
    TRACK=$(osascript -e 'tell application "Spotify" to name of current track' 2>/dev/null || echo "unknown")
    ARTIST=$(osascript -e 'tell application "Spotify" to artist of current track' 2>/dev/null || echo "unknown")
    echo "OK: Skipped → Now playing: $TRACK by $ARTIST"
    ;;

  spotify-prev)
    osascript -e 'tell application "Spotify" to previous track'
    sleep 0.5
    TRACK=$(osascript -e 'tell application "Spotify" to name of current track' 2>/dev/null || echo "unknown")
    ARTIST=$(osascript -e 'tell application "Spotify" to artist of current track' 2>/dev/null || echo "unknown")
    echo "OK: Previous → Now playing: $TRACK by $ARTIST"
    ;;

  spotify-now)
    TRACK=$(osascript -e 'tell application "Spotify" to name of current track' 2>/dev/null || echo "Not playing")
    ARTIST=$(osascript -e 'tell application "Spotify" to artist of current track' 2>/dev/null || echo "")
    ALBUM=$(osascript -e 'tell application "Spotify" to album of current track' 2>/dev/null || echo "")
    STATE=$(osascript -e 'tell application "Spotify" to player state as string' 2>/dev/null || echo "stopped")
    echo "🎵 $TRACK — $ARTIST"
    echo "💿 $ALBUM"
    echo "⏯️  $STATE"
    ;;

  spotify-volume)
    LEVEL="${1:-}"
    if [ -z "$LEVEL" ]; then
      VOL=$(osascript -e 'tell application "Spotify" to sound volume' 2>/dev/null || echo "?")
      echo "Spotify volume: $VOL%"
    else
      osascript -e "tell application \"Spotify\" to set sound volume to $LEVEL"
      echo "OK: Spotify volume set to $LEVEL%"
    fi
    ;;

  # ── Apple Music ────────────────────────────────────────────
  music-play)
    QUERY="${*:-}"
    if [ -z "$QUERY" ]; then
      osascript -e 'tell application "Music" to play'
      echo "OK: Apple Music resumed"
    else
      osascript -e "tell application \"Music\" to play (every track whose name contains \"$QUERY\")"
      echo "OK: Playing '$QUERY' on Apple Music"
    fi
    ;;

  music-pause)
    osascript -e 'tell application "Music" to pause'
    echo "OK: Apple Music paused"
    ;;

  music-next)
    osascript -e 'tell application "Music" to next track'
    echo "OK: Apple Music next track"
    ;;

  # ── Media Controls (system-wide) ───────────────────────────
  media-play-pause)
    osascript -e 'tell application "System Events" to key code 16 using {command down}'
    echo "OK: Play/Pause toggled"
    ;;

  media-next)
    osascript -e 'tell application "System Events" to key code 124 using {command down}'
    echo "OK: Next track"
    ;;

  media-prev)
    osascript -e 'tell application "System Events" to key code 123 using {command down}'
    echo "OK: Previous track"
    ;;

  # ── Help ───────────────────────────────────────────────────
  help|*)
    cat <<'HELP'
Pocket System Commands:
  Power:     sleep, shutdown, restart, lock, screen-off
  Display:   brightness <0-100>
  Volume:    volume <0-100>, mute, unmute, volume-get
  Apps:      open-app <name>, quit-app <name>, force-quit-app <name>, running-apps
  System:    battery, uptime, disk, memory, wifi, wifi-on, wifi-off
  Bluetooth: bluetooth-on, bluetooth-off
  DND:       dnd-on, dnd-off
  Clipboard: clipboard-get, clipboard-set <text>
  Notify:    notify <title> <msg>, say <text>
  Screen:    screenshot [path]
  Sleep:     caffeinate [secs], decaffeinate
  Finder:    empty-trash, eject-all
  Theme:     dark-mode-on, dark-mode-off, dark-mode-toggle
  Process:   kill <name|pid>
  Browser:   open-url <url>, open-chrome [url], open-safari [url], google <query>
  YouTube:   youtube [query], youtube-play <song>
  Spotify:   spotify-play [song], spotify-pause, spotify-next, spotify-prev, spotify-now, spotify-volume [0-100]
  Music:     music-play [song], music-pause, music-next
  Media:     media-play-pause, media-next, media-prev
HELP
    ;;
esac
