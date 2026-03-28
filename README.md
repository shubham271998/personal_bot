# Pocket Telegram Bot

A Telegram bot that bridges to **Claude Code CLI** with full system control, voice messages, security guard (face recognition), and live streaming status updates.

## Features

- **Claude Code Integration** — Send any message, get Claude's response with live progress updates (tool calls, subagents, timing)
- **Voice Messages** — Send voice notes in Hindi/English, auto-transcribed via Whisper
- **System Control** — Sleep, shutdown, volume, brightness, apps, WiFi, Bluetooth, DND via `/sys`
- **Music** — Play songs on Spotify, YouTube, Apple Music from Telegram
- **Browser** — Open URLs, Google search, YouTube search
- **Security Guard** — Webcam face recognition (InsightFace ArcFace) with intruder alerts and remote shutdown/lock buttons
- **Multi-Project** — Switch between codebases, auto-scan for git repos
- **Session Tracking** — Cost, tokens, timing stats for all queries
- **Auto-Start** — macOS LaunchAgent for boot-time startup with "Laptop Active" notification

## Quick Start

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow the prompts
3. Copy the bot token

### 2. Get Your Chat ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. Copy your user ID

### 3. Configure

```bash
git clone https://github.com/your-username/telegram-claude-bot.git
cd telegram-claude-bot
cp .env.example .env
```

Edit `.env`:
```
TELEGRAM_BOT_TOKEN=your-bot-token-here
ALLOWED_TELEGRAM_IDS=your-user-id
SECURITY_ALERT_CHAT_ID=your-user-id
```

### 4. Install & Run

```bash
npm install
node bot.mjs
```

## Docker Deployment

```bash
cp .env.example .env
# Edit .env with your values
docker compose up -d
```

## Prerequisites

| Requirement | Required | Purpose |
|-------------|----------|---------|
| Node.js 20+ | Yes | Runtime |
| [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) | Yes | AI backend |
| ffmpeg | For voice | Audio conversion |
| [Whisper](https://github.com/openai/whisper) | For voice | Speech-to-text |
| imagesnap / ffmpeg | For guard | Webcam capture (macOS) |

### Optional: Face Recognition Models

```bash
bash scripts/download-face-models.sh
```

Downloads InsightFace ONNX models (~180MB) for security guard face recognition.

### Optional: macOS Auto-Start

See `scripts/start-bot.sh` and create a LaunchAgent plist pointing to it.

## Commands

### General
| Command | Description |
|---------|-------------|
| _any message_ | Ask Claude about the active project |
| _voice message_ | Transcribed and sent to Claude |
| `/ask <prompt>` | Explicit Claude query |
| `/newchat` | Start fresh conversation |
| `/cancel` | Stop running request |
| `/status` | Check if Claude is processing |

### Projects
| Command | Description |
|---------|-------------|
| `/projects` | List all projects |
| `/switch <name>` | Switch active project |
| `/scanprojects` | Auto-discover git repos |
| `/addproject <name> <path>` | Add manually |

### Code Review
| Command | Description |
|---------|-------------|
| `/review` | Review uncommitted changes |
| `/review branch` | Review current branch vs main |
| `/diff` | Show current diff |
| `/commitmsg` | Generate commit message |
| `/explain <file>` | Explain code |

### System Control (`/sys`)
| Command | Description |
|---------|-------------|
| `sleep` / `shutdown` / `restart` / `lock` | Power controls |
| `volume <0-100>` / `mute` / `unmute` | Audio |
| `brightness <0-100>` | Display |
| `battery` / `uptime` / `disk` / `memory` | System info |
| `spotify-play <song>` / `spotify-pause` / `spotify-next` | Spotify |
| `youtube-play <song>` | Play on YouTube |
| `open-url <url>` / `google <query>` | Browser |
| `open-app <name>` / `quit-app <name>` | App control |
| `wifi-on` / `wifi-off` / `dark-mode-toggle` | Toggles |

### Security Guard
| Command | Description |
|---------|-------------|
| `/guardstart` | Start webcam monitoring |
| `/guardstop` | Stop monitoring |
| `/guardsnap` | Test webcam capture |
| `/guardsetface` | Set reference face photo |

When an unknown face is detected, you get inline buttons: **Shutdown / Sleep / Lock / Alarm / Dismiss**

## Security

- **ALLOWED_TELEGRAM_IDS is required** — bot rejects all users if not set
- **Rate limiting** — configurable per-user request limits
- **Input sanitization** — shell metacharacters stripped from system commands
- **Command allowlisting** — only known `/sys` commands are accepted
- **Claude timeout** — runaway sessions killed after configurable timeout (default 5min)
- **No secrets in code** — all credentials via environment variables

## Configuration

See `.env.example` for all options:

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `ALLOWED_TELEGRAM_IDS` | — | Comma-separated user IDs |
| `SECURITY_ALERT_CHAT_ID` | — | Chat ID for alerts |
| `RATE_LIMIT_MAX_REQUESTS` | 10 | Max requests per minute |
| `CLAUDE_SKIP_PERMISSIONS` | true | Claude CLI permission bypass |
| `CLAUDE_TIMEOUT_MS` | 300000 | Max Claude execution time |
| `WHISPER_MODEL` | base | Whisper model size |

## Architecture

```
Telegram ← bot.mjs → Claude CLI (stream-json)
              ↓
         ┌────┴────┐
    /sys commands   Security Guard
    (pocket-system.sh)  (InsightFace ONNX)
         ↓               ↓
    macOS APIs      Webcam + ArcFace
    (osascript)     Face Recognition
```

## License

MIT
