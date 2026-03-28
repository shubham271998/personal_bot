/**
 * Input sanitization for security
 */

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

const MAX_PROMPT_LENGTH = 50000
const SHELL_DANGEROUS_CHARS = /[;|&$`><()\n\\{}]/g

/**
 * Sanitize string for safe shell argument use
 */
export function sanitizeForShell(input) {
  if (!input) return ""
  return input.replace(SHELL_DANGEROUS_CHARS, "").trim().slice(0, 500)
}

/**
 * Validate system command is in allowlist
 */
export function validateSystemCommand(cmd) {
  return ALLOWED_SYSTEM_COMMANDS.has(cmd)
}

/**
 * Sanitize prompt before sending to Claude
 */
export function sanitizePrompt(input) {
  if (!input) return ""
  return input.replace(/\0/g, "").trim().slice(0, MAX_PROMPT_LENGTH)
}

/**
 * Sanitize file path (prevent traversal)
 */
export function sanitizePath(p) {
  if (!p) return ""
  return p.replace(/\.\.\//g, "").replace(/\.\.\\/g, "")
}
