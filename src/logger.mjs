/**
 * Structured Logger with file rotation and Telegram forwarding
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOGS_DIR = path.resolve(__dirname, "../logs")

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true })

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SECURITY: 4 }
const COLORS = {
  DEBUG: "\x1b[36m",
  INFO: "\x1b[32m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
  SECURITY: "\x1b[35m",
  RESET: "\x1b[0m",
}

// Max log file size before rotation (5MB)
const MAX_LOG_SIZE = 5 * 1024 * 1024
const MAX_LOG_FILES = 10

class Logger {
  constructor() {
    this.minLevel = LOG_LEVELS.DEBUG
    this.telegramNotifier = null // set later to avoid circular dep
    this.securityChatId = null
  }

  setTelegramNotifier(fn, chatId) {
    this.telegramNotifier = fn
    this.securityChatId = chatId
  }

  _getLogFile(category = "bot") {
    const date = new Date().toISOString().split("T")[0]
    return path.join(LOGS_DIR, `${category}-${date}.log`)
  }

  _rotateIfNeeded(filePath) {
    try {
      if (!fs.existsSync(filePath)) return
      const stats = fs.statSync(filePath)
      if (stats.size > MAX_LOG_SIZE) {
        const rotated = `${filePath}.${Date.now()}.bak`
        fs.renameSync(filePath, rotated)

        // Clean old rotated files
        const dir = path.dirname(filePath)
        const base = path.basename(filePath)
        const rotatedFiles = fs
          .readdirSync(dir)
          .filter((f) => f.startsWith(base) && f.endsWith(".bak"))
          .sort()
        while (rotatedFiles.length > MAX_LOG_FILES) {
          fs.unlinkSync(path.join(dir, rotatedFiles.shift()))
        }
      }
    } catch {}
  }

  _write(level, category, message, meta = {}) {
    if (LOG_LEVELS[level] < this.minLevel) return

    const timestamp = new Date().toISOString()
    const entry = {
      timestamp,
      level,
      category,
      message,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    }

    // Console output with colors
    const color = COLORS[level] || COLORS.RESET
    console.log(
      `${color}[${timestamp}] [${level}] [${category}]${COLORS.RESET} ${message}`,
      Object.keys(meta).length > 0 ? meta : "",
    )

    // File output
    const logFile = this._getLogFile(category.toLowerCase())
    this._rotateIfNeeded(logFile)
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n")

    // Forward important logs to Telegram (WARN, ERROR, SECURITY — skip DEBUG/INFO noise)
    if (this.telegramNotifier && this.securityChatId && LOG_LEVELS[level] >= LOG_LEVELS.WARN) {
      const icons = {
        DEBUG: "🔍",
        INFO: "ℹ️",
        WARN: "⚠️",
        ERROR: "❌",
        SECURITY: "🚨",
      }
      const icon = icons[level] || "📋"
      const metaStr = Object.keys(meta).length > 0
        ? "\n" + Object.entries(meta).map(([k, v]) => `  ${k}: ${v}`).join("\n")
        : ""
      const time = timestamp.split("T")[1].split(".")[0]
      this.telegramNotifier(
        this.securityChatId,
        `${icon} [${time}] [${level}] [${category}]\n${message}${metaStr}`,
      )
    }
  }

  debug(category, msg, meta) {
    this._write("DEBUG", category, msg, meta)
  }
  info(category, msg, meta) {
    this._write("INFO", category, msg, meta)
  }
  warn(category, msg, meta) {
    this._write("WARN", category, msg, meta)
  }
  error(category, msg, meta) {
    this._write("ERROR", category, msg, meta)
  }
  security(msg, meta) {
    this._write("SECURITY", "SECURITY", msg, meta)
  }

  // Get recent logs for a category
  getRecent(category = "bot", lines = 50) {
    const logFile = this._getLogFile(category)
    if (!fs.existsSync(logFile)) return "No logs found."
    const content = fs.readFileSync(logFile, "utf-8")
    const allLines = content.trim().split("\n")
    return allLines
      .slice(-lines)
      .map((l) => {
        try {
          const e = JSON.parse(l)
          return `[${e.timestamp.split("T")[1]}] [${e.level}] ${e.message}`
        } catch {
          return l
        }
      })
      .join("\n")
  }
}

export const logger = new Logger()
export default logger
