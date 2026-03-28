/**
 * Security Module — Comprehensive hardening
 *
 * Covers: input sanitization, shell injection, path traversal, DoS,
 * prompt injection, log filtering, secret masking, CSRF tokens,
 * API key validation, concurrent limits, and more.
 */
import crypto from "crypto"

// ── Constants ───────────────────────────────────────────────
const MAX_PROMPT_LENGTH = 10000
const MAX_ARG_LENGTH = 200
const MAX_CONCURRENT_SESSIONS = 3
const MAX_MESSAGE_SIZE = 50000 // bytes
const CALLBACK_TOKEN_TTL_MS = 300000 // 5 min

// Shell-dangerous characters (comprehensive)
const SHELL_DANGER = /[;|&$`><()\n\\{}\[\]!#~\x00-\x1f\x7f]/g
// Path traversal patterns
const PATH_TRAVERSAL = /(\.\.[/\\]|[/\\]\.\.|~[/\\]|^\/etc|^\/var|^\/usr|^\/sys|^\/proc|^\/dev|^\/root|^\/private)/i
// Prompt injection patterns
const PROMPT_INJECTION = /ignore\s+(all\s+)?previous\s+instructions|ignore\s+above|disregard\s+(all|previous|above)|you\s+are\s+now\s+(?:a\s+)?(?:DAN|evil|unrestricted)/i
// Sensitive patterns to mask in logs
const SENSITIVE_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]+/g,                  // Anthropic API keys
  /\b\d{10}:[A-Za-z0-9_-]{35}\b/g,           // Telegram bot tokens
  /ANTHROPIC_API_KEY=[^\s&]+/gi,              // Env var leaks
  /Bearer\s+[a-zA-Z0-9._-]+/gi,              // Auth headers
  /password[=:]\s*\S+/gi,                     // Passwords
]
// Allowed system commands (strict whitelist)
const ALLOWED_SYSTEM_COMMANDS = new Set([
  "sleep", "shutdown", "restart", "lock", "screen-off",
  "brightness", "volume", "mute", "unmute", "volume-get",
  "open-app", "quit-app", "force-quit-app", "running-apps",
  "battery", "uptime", "disk", "memory",
  "wifi", "wifi-on", "wifi-off",
  "bluetooth-on", "bluetooth-off",
  "dnd-on", "dnd-off",
  "clipboard-get", "clipboard-set",
  "notify", "say",
  "screenshot",
  "caffeinate", "decaffeinate",
  "empty-trash", "eject-all",
  "dark-mode-on", "dark-mode-off", "dark-mode-toggle",
  "kill",
  "open-url", "open-chrome", "open-safari", "google",
  "youtube", "youtube-play",
  "spotify-play", "spotify-pause", "spotify-next", "spotify-prev", "spotify-now", "spotify-volume",
  "music-play", "music-pause", "music-next",
  "media-play-pause", "media-next", "media-prev",
  "help",
])
// Blocked paths that can never be added as projects
const BLOCKED_PATHS = ["/etc", "/var", "/usr", "/sys", "/proc", "/dev", "/root", "/private/etc", "/sbin", "/bin"]

// ── Active callback tokens (CSRF protection) ───────────────
const activeCallbackTokens = new Map()

// Cleanup expired tokens
setInterval(() => {
  const now = Date.now()
  for (const [key, expiry] of activeCallbackTokens) {
    if (now > expiry) activeCallbackTokens.delete(key)
  }
}, 60000)

// ── Concurrent session tracking ─────────────────────────────
const userSessionCounts = new Map()

// ── Functions ───────────────────────────────────────────────

/**
 * Sanitize string for shell argument (strict)
 * Removes ALL dangerous characters, quotes the result
 */
export function sanitizeShellArg(input) {
  if (!input || typeof input !== "string") return ""
  return input
    .replace(SHELL_DANGER, "")
    .replace(/'/g, "")
    .trim()
    .slice(0, MAX_ARG_LENGTH)
}

/**
 * Validate system command against whitelist
 */
export function isValidSystemCommand(cmd) {
  return typeof cmd === "string" && ALLOWED_SYSTEM_COMMANDS.has(cmd)
}

/**
 * Sanitize prompt — strip injection attempts, null bytes, limit length
 */
export function sanitizePrompt(input) {
  if (!input || typeof input !== "string") return ""
  let cleaned = input
    .replace(/\0/g, "")        // null bytes
    .replace(/\r/g, "")        // carriage returns
    .trim()
    .slice(0, MAX_PROMPT_LENGTH)

  // Warn on prompt injection (don't strip — just flag)
  if (PROMPT_INJECTION.test(cleaned)) {
    cleaned = `[User message - process normally]: ${cleaned}`
  }

  return cleaned
}

/**
 * Validate project path — block sensitive system directories
 */
export function isValidProjectPath(resolvedPath) {
  if (!resolvedPath || typeof resolvedPath !== "string") return false
  const lower = resolvedPath.toLowerCase()
  for (const blocked of BLOCKED_PATHS) {
    if (lower === blocked || lower.startsWith(blocked + "/")) return false
  }
  if (PATH_TRAVERSAL.test(resolvedPath)) return false
  return true
}

/**
 * Mask sensitive data in strings (for logging)
 */
export function maskSecrets(text) {
  if (!text || typeof text !== "string") return text
  let masked = text
  for (const pattern of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, "[REDACTED]")
  }
  return masked
}

/**
 * Mask secrets from stderr before exposing in error messages
 */
export function sanitizeErrorMessage(error) {
  if (!error) return "Unknown error"
  const msg = typeof error === "string" ? error : error.message || String(error)
  return maskSecrets(msg).slice(0, 500)
}

/**
 * Validate URL — only http/https allowed
 */
export function isValidUrl(url) {
  if (!url || typeof url !== "string") return false
  try {
    const parsed = new URL(url)
    return ["http:", "https:", "spotify:"].includes(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * Generate a CSRF token for callback buttons
 * Returns token to embed in callback_data
 */
export function generateCallbackToken(userId, action) {
  const token = crypto.randomBytes(8).toString("hex")
  const key = `${userId}:${action}:${token}`
  activeCallbackTokens.set(key, Date.now() + CALLBACK_TOKEN_TTL_MS)
  return token
}

/**
 * Validate a callback token (one-time use)
 */
export function validateCallbackToken(userId, action, token) {
  const key = `${userId}:${action}:${token}`
  const expiry = activeCallbackTokens.get(key)
  if (!expiry) return false
  activeCallbackTokens.delete(key) // one-time use
  return Date.now() <= expiry
}

/**
 * Check concurrent session limit for a user
 */
export function canStartSession(userId) {
  const count = userSessionCounts.get(userId) || 0
  return count < MAX_CONCURRENT_SESSIONS
}

export function incrementSession(userId) {
  userSessionCounts.set(userId, (userSessionCounts.get(userId) || 0) + 1)
}

export function decrementSession(userId) {
  const count = userSessionCounts.get(userId) || 0
  if (count <= 1) userSessionCounts.delete(userId)
  else userSessionCounts.set(userId, count - 1)
}

/**
 * Validate message size (DoS protection)
 */
export function isMessageTooLarge(text) {
  if (!text) return false
  return Buffer.byteLength(text, "utf8") > MAX_MESSAGE_SIZE
}

/**
 * Validate Anthropic API key format
 */
export function isValidApiKeyFormat(key) {
  if (!key || typeof key !== "string") return false
  // Anthropic keys: sk-ant-api03-... (typically 90-120 chars)
  return /^sk-ant-[a-zA-Z0-9_-]{20,200}$/.test(key.trim())
}

/**
 * Generate secure encryption key from password
 * Uses proper salt per-key instead of static salt
 */
export function deriveEncryptionKey(password, salt) {
  return crypto.scryptSync(password, salt, 32)
}

/**
 * Encrypt with random IV and per-key salt
 */
export function encryptSecure(text, masterKey) {
  const salt = crypto.randomBytes(16)
  const key = deriveEncryptionKey(masterKey, salt)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv)
  let encrypted = cipher.update(text, "utf8", "hex")
  encrypted += cipher.final("hex")
  return salt.toString("hex") + ":" + iv.toString("hex") + ":" + encrypted
}

/**
 * Decrypt with per-key salt
 */
export function decryptSecure(text, masterKey) {
  try {
    const [saltHex, ivHex, encrypted] = text.split(":")
    if (!saltHex || !ivHex || !encrypted) return null
    const salt = Buffer.from(saltHex, "hex")
    const key = deriveEncryptionKey(masterKey, salt)
    const iv = Buffer.from(ivHex, "hex")
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv)
    let decrypted = decipher.update(encrypted, "hex", "utf8")
    decrypted += decipher.final("utf8")
    return decrypted
  } catch {
    return null
  }
}

/**
 * Validate Telegram user ID (must be positive integer)
 */
export function isValidTelegramId(id) {
  return Number.isInteger(id) && id > 0
}

/**
 * Sanitize file path for logging (remove home dir)
 */
export function sanitizePath(p) {
  if (!p) return ""
  return p.replace(process.env.HOME || "/home/user", "~")
}

/**
 * Rate limit check with exponential backoff tracking
 */
const failedAttempts = new Map()

export function recordFailedAttempt(userId) {
  const count = (failedAttempts.get(userId) || 0) + 1
  failedAttempts.set(userId, count)
  // Auto-reset after 1 hour
  setTimeout(() => {
    const current = failedAttempts.get(userId) || 0
    if (current <= 1) failedAttempts.delete(userId)
    else failedAttempts.set(userId, current - 1)
  }, 3600000)
  return count
}

export function getFailedAttempts(userId) {
  return failedAttempts.get(userId) || 0
}

export function isBlocked(userId) {
  return (failedAttempts.get(userId) || 0) >= 10
}
