#!/usr/bin/env node

/**
 * Telegram ↔ Claude Code Bridge v2.0
 *
 * Features:
 * - Multi-project support (switch between codebases)
 * - Code review (diff analysis, branch review, commit messages)
 * - Structured logging with file rotation
 * - Security guard (webcam monitoring, laptop sleep)
 * - Git operations (status, log, diff)
 * - File review and explanation
 * - Queue management for concurrent requests
 */
import "dotenv/config"
import TelegramBot from "node-telegram-bot-api"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"
import { spawn as spawnProc } from "child_process"
import { checkRateLimit } from "./src/rate-limiter.mjs"
import {
  sanitizeShellArg, isValidSystemCommand, sanitizePrompt,
  isValidApiKeyFormat, maskSecrets, sanitizeErrorMessage,
  isMessageTooLarge, generateCallbackToken, validateCallbackToken,
  canStartSession, incrementSession, decrementSession,
  isValidProjectPath, recordFailedAttempt, isBlocked,
} from "./src/security.mjs"
import userManager from "./src/user-manager.mjs"
import logger from "./src/logger.mjs"
import projectManager from "./src/projects.mjs"
import {
  runClaude,
  runShell,
  isRunning,
  getSession,
  getConversationInfo,
  cancelSession,
  cancelAllSessions,
  resetConversation,
} from "./src/claude-runner.mjs"
import {
  reviewCode,
  quickCheck,
  generateCommitMessage,
  explainCode,
  getGitStatus,
  getDiff,
} from "./src/code-review.mjs"
import { sessionTracker, getClaudeCLISessions } from "./src/session-tracker.mjs"
import {
  setBot as setGuardBot,
  startMonitoring as startSecurityGuard,
  stopMonitoring as stopSecurityGuard,
  isGuardRunning,
  clearReferenceCache,
  captureWebcam,
  captureScreen,
  compareImages,
  sleepLaptop,
  shutdownLaptop,
  lockScreen,
  soundAlarm,
  REFERENCE_PHOTO,
  REFERENCE_SCREEN,
} from "./src/security-guard.mjs"
import { runSystemCommand } from "./src/system-commands.mjs"

// ── Config ──────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!BOT_TOKEN) {
  logger.error("BOT", "Set TELEGRAM_BOT_TOKEN env variable")
  process.exit(1)
}

const ALLOWED_USER_IDS = process.env.ALLOWED_TELEGRAM_IDS
  ? process.env.ALLOWED_TELEGRAM_IDS.split(",").map(Number)
  : []

const DEFAULT_PROJECT_DIR =
  process.env.PROJECT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const MAX_MESSAGE_LENGTH = 4096
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Bot Setup ───────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true })

// Add default project if none exist
if (projectManager.list().length === 0) {
  projectManager.add("default", DEFAULT_PROJECT_DIR, "Default project")
}

// Register all commands so they show in Telegram's / menu
bot.setMyCommands([
  { command: "start", description: "Show help and all commands" },
  { command: "ask", description: "Ask Claude about the project" },
  { command: "cancel", description: "Stop a running Claude request" },
  { command: "status", description: "Check if Claude is processing" },
  { command: "projects", description: "List all projects" },
  { command: "scanprojects", description: "Scan system for git repos" },
  { command: "addallprojects", description: "Auto-add all discovered repos" },
  { command: "addproject", description: "Add a project: /addproject name path" },
  { command: "removeproject", description: "Remove a project: /removeproject name" },
  { command: "switch", description: "Switch active project: /switch name" },
  { command: "review", description: "Review code changes (branch/last)" },
  { command: "gitstatus", description: "Git status & recent commits" },
  { command: "diff", description: "Show current git diff" },
  { command: "commitmsg", description: "Generate commit message from diff" },
  { command: "explain", description: "Explain a file or function" },
  { command: "check", description: "Quick bug check on changes or file" },
  { command: "newchat", description: "Start fresh Claude conversation" },
  { command: "sessions", description: "Session stats overview" },
  { command: "history", description: "Recent session history" },
  { command: "sessioninfo", description: "Detailed session info: /sessioninfo <id>" },
  { command: "context", description: "Context usage analysis" },
  { command: "running", description: "Currently running sessions" },
  { command: "clearsessions", description: "Clear session history" },
  { command: "logs", description: "View recent logs" },
  { command: "guard", description: "Security guard status" },
  { command: "guardstart", description: "Start webcam monitoring" },
  { command: "guardstop", description: "Stop webcam monitoring" },
  { command: "guardsnap", description: "Take test webcam photo" },
  { command: "guardscreen", description: "Take test screenshot" },
  { command: "guardsetface", description: "Set reference face photo" },
  { command: "sys", description: "System command: /sys sleep|shutdown|volume|battery|..." },
  { command: "permit", description: "Check & grant macOS permissions" },
  { command: "setup", description: "Connect your Claude API key" },
  { command: "myusage", description: "View your usage & spending" },
  { command: "removekey", description: "Remove your API key" },
  { command: "users", description: "(Admin) List all users" },
  { command: "approve", description: "(Admin) Approve user: /approve <id>" },
  { command: "blockuser", description: "(Admin) Block user: /blockuser <id>" },
])

// Track the owner's chat ID — auto-detected from first message or from env
let ownerChatId = process.env.SECURITY_ALERT_CHAT_ID
  ? Number(process.env.SECURITY_ALERT_CHAT_ID)
  : ALLOWED_USER_IDS[0] || null

// Set up Telegram notifications for logger — sends ALL logs to bot
function setupLogForwarding() {
  logger.setTelegramNotifier(
    (chatId, msg) => bot.sendMessage(chatId, msg).catch(() => {}),
    ownerChatId,
  )
}
setupLogForwarding()

// Don't log startup until we have a chat ID (avoid sending to null)
// Startup logs will be in file only until first message auto-detects chat ID
console.log(`🤖 Bot v2.0 started. Projects: ${projectManager.list().length}`)
console.log(`   Default dir: ${DEFAULT_PROJECT_DIR}`)
if (!ownerChatId) {
  console.log("   ⚠️  No chat ID yet — send /start to the bot to auto-detect it")
}
if (ALLOWED_USER_IDS.length === 0) {
  console.log("   ⚠️  No ALLOWED_TELEGRAM_IDS — bot is open to anyone")
}

// Send startup notification to Telegram
if (ownerChatId) {
  const now = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
  bot.sendMessage(
    ownerChatId,
    `🟢 *Laptop Active — Bot Online*\n⏰ ${now}\n📁 Projects: ${projectManager.list().length}\n🤖 Ready for commands`,
    { parse_mode: "Markdown" },
  ).catch(() => {})
}

// Register admin users from env (admin status is checked by ID, not DB flag)
for (const id of ALLOWED_USER_IDS) {
  if (!userManager.exists(id)) {
    userManager.register(id, { username: "admin", firstName: "Admin" })
  }
  userManager.approve(id)
}

// ── Helpers ─────────────────────────────────────────────────
function isAllowed(userId) {
  // Admins from ALLOWED_TELEGRAM_IDS always allowed
  if (ALLOWED_USER_IDS.includes(userId)) return true
  // Registered + approved users with API key are allowed
  const user = userManager.get(userId)
  return user?.isApproved && userManager.hasApiKey(userId)
}

function isAdmin(userId) {
  // Admin is ONLY the owner (from ALLOWED_TELEGRAM_IDS). No one else. Ever.
  return ALLOWED_USER_IDS.includes(userId)
}

function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text]
  const chunks = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining)
      break
    }
    let splitIdx = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH)
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.5) splitIdx = MAX_MESSAGE_LENGTH
    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx)
  }
  return chunks
}

function getProjectDir(chatId) {
  return projectManager.getActiveDir(chatId) || DEFAULT_PROJECT_DIR
}

function getProjectName(chatId) {
  return projectManager.getActive(chatId)?.name || "default"
}

async function sendResult(chatId, result, thinkingMsgId) {
  if (thinkingMsgId) {
    bot.deleteMessage(chatId, thinkingMsgId).catch(() => {})
  }
  if (!result || result.trim() === "") {
    await bot.sendMessage(chatId, "_(empty response)_", { parse_mode: "Markdown" })
    return
  }
  const chunks = splitMessage(result)
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk)
  }
}

// ── /start ──────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  const project = projectManager.getActive(chatId)

  // Auto-detect owner chat ID on first /start
  if (!ownerChatId) {
    ownerChatId = chatId
    setupLogForwarding()
    setGuardBot(bot, chatId)
    logger.info("BOT", `Owner chat ID auto-detected: ${chatId}`)
  }

  // Register user on /start
  if (!userManager.exists(userId)) {
    userManager.register(userId, {
      username: msg.from.username,
      firstName: msg.from.first_name,
    })
  }

  const hasKey = userManager.hasApiKey(userId)
  const setupHint = hasKey
    ? `✅ Claude connected`
    : `⚠️ Not connected — use /setup to link your Claude API key`

  bot.sendMessage(
    chatId,
    `🤖 *Claude Code Bot v2.0*\n\n` +
      `Your ID: \`${userId}\`\n` +
      `${setupHint}\n` +
      `Active project: \`${project?.name || "none"}\`\n\n` +
      `*Getting Started:*\n` +
      `/setup — Connect your Claude API key\n` +
      `/myusage — View your usage & costs\n` +
      `/removekey — Disconnect your key\n\n` +
      `*General Commands:*\n` +
      `/ask <prompt> — Ask Claude about the project\n` +
      `/newchat — Start fresh conversation\n` +
      `/cancel — Stop running request\n` +
      `/status — Check if Claude is processing\n\n` +
      `*Project Management:*\n` +
      `/projects — List all projects\n` +
      `/scanprojects — Scan system for git repos\n` +
      `/addallprojects — Auto-add all found repos\n` +
      `/addproject <name> <path> — Add manually\n` +
      `/removeproject <name> — Remove a project\n` +
      `/switch <name> — Switch active project\n\n` +
      `*Code Review:*\n` +
      `/review — Review uncommitted changes\n` +
      `/review branch — Review current branch vs main\n` +
      `/review last — Review last commit\n` +
      `/gitstatus — Git status & recent commits\n` +
      `/diff — Show current diff\n` +
      `/commitmsg — Generate commit message\n` +
      `/explain <file or function> — Explain code\n` +
      `/check [file] — Quick bug check\n\n` +
      `*System Control:*\n` +
      `/sys — Direct system commands (sleep, shutdown, volume, etc.)\n` +
      `Or just tell Claude: "put my laptop to sleep"\n\n` +
      `*Security:*\n` +
      `/guard — Security guard status\n` +
      `/guardstart — Start webcam monitoring\n` +
      `/guardstop — Stop webcam monitoring\n` +
      `/guardsnap — Take test webcam photo\n\n` +
      `*Sessions & Context:*\n` +
      `/sessions — Session stats overview\n` +
      `/history [n] — Recent session history\n` +
      `/sessioninfo <id> — Detailed session info\n` +
      `/context — Context usage analysis\n` +
      `/running — Currently running sessions\n` +
      `/clearsessions — Clear session history\n\n` +
      `*Logs:*\n` +
      `/logs [category] — View recent logs\n\n` +
      `Or just send any message to chat with Claude!`,
    { parse_mode: "Markdown" },
  )
})

// ── /cancel ─────────────────────────────────────────────────
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id
  if (cancelSession(chatId)) {
    bot.sendMessage(chatId, "🛑 Cancelled.")
  } else {
    bot.sendMessage(chatId, "Nothing running.")
  }
})

// ── /status ─────────────────────────────────────────────────
bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id
  if (isRunning(chatId)) {
    const session = getSession(chatId)
    const elapsed = Math.round((Date.now() - session.startedAt) / 1000)
    bot.sendMessage(
      chatId,
      `⏳ Claude is thinking...\n` +
        `Project: ${session.projectName}\n` +
        `Running for: ${elapsed}s\n` +
        `Prompt: ${session.prompt}`,
    )
  } else {
    bot.sendMessage(chatId, `💤 Idle.\nActive project: ${getProjectName(chatId)}`)
  }
})

// ── /projects ───────────────────────────────────────────────
bot.onText(/\/projects$/, (msg) => {
  const chatId = msg.chat.id
  const projects = projectManager.list()
  const active = projectManager.getActive(chatId)

  if (projects.length === 0) {
    bot.sendMessage(
      chatId,
      "No projects registered.\n\n" +
        "Use /scanprojects to auto-discover git repos\n" +
        "Or /addproject <name> <path> to add manually",
    )
    return
  }

  const lines = projects.map((p) => {
    const marker = p.name === active?.name ? "→ " : "  "
    return `${marker}*${p.name}*\n  \`${p.path}\`${p.description ? `\n  ${p.description}` : ""}`
  })

  bot.sendMessage(
    chatId,
    `📁 *Registered Projects (${projects.length}):*\n\n${lines.join("\n\n")}\n\n` +
      `Use /switch <name> to change\n` +
      `Use /scanprojects to find more`,
    { parse_mode: "Markdown" },
  )
})

// ── /scanprojects — Discover git repos on system ────────────
bot.onText(/\/scanprojects$/, async (msg) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  bot.sendMessage(chatId, "🔍 Scanning for git repos...")

  const found = await projectManager.scanForProjects()

  if (found.length === 0) {
    bot.sendMessage(chatId, "No git repos found in common directories.")
    return
  }

  const lines = found.map((p) => {
    const status = p.alreadyAdded ? "✅" : "➕"
    return `${status} *${p.name}*\n  \`${p.path}\``
  })

  const notAdded = found.filter((p) => !p.alreadyAdded).length

  bot.sendMessage(
    chatId,
    `🔍 *Found ${found.length} git repos:*\n\n${lines.join("\n\n")}\n\n` +
      `✅ = already registered, ➕ = not yet added\n\n` +
      (notAdded > 0
        ? `Use /addallprojects to add all ${notAdded} new ones\nOr /addproject <name> <path> to add one`
        : `All repos are already registered!`),
    { parse_mode: "Markdown" },
  )
})

// ── /addallprojects — Auto-add all discovered repos ─────────
bot.onText(/\/addallprojects$/, async (msg) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  const { found, added } = await projectManager.autoAddProjects()
  bot.sendMessage(
    chatId,
    `✅ Scanned ${found} repos, added ${added} new projects.\nUse /projects to see all.`,
  )
})

// ── /addproject ─────────────────────────────────────────────
bot.onText(/\/addproject\s+(\S+)\s+(.+)/, (msg, match) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  const name = match[1]
  const projectPath = match[2].trim()
  const result = projectManager.add(name, projectPath)

  if (result.ok) {
    bot.sendMessage(chatId, `✅ Added project "${name}"\nPath: \`${projectPath}\``, {
      parse_mode: "Markdown",
    })
  } else {
    bot.sendMessage(chatId, `❌ ${result.error}`)
  }
})

// ── /removeproject ──────────────────────────────────────────
bot.onText(/\/removeproject\s+(\S+)/, (msg, match) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  const result = projectManager.remove(match[1])
  bot.sendMessage(chatId, result.ok ? `✅ Removed "${match[1]}"` : `❌ ${result.error}`)
})

// ── /switch ─────────────────────────────────────────────────
bot.onText(/\/switch\s+(\S+)/, (msg, match) => {
  const chatId = msg.chat.id
  const result = projectManager.switchTo(chatId, match[1])

  if (result.ok) {
    resetConversation(chatId) // Reset conversation context on project switch
    bot.sendMessage(
      chatId,
      `✅ Switched to *${match[1]}*\n\`${result.project.path}\`\n_(conversation reset)_`,
      { parse_mode: "Markdown" },
    )
  } else {
    bot.sendMessage(chatId, `❌ ${result.error}`)
  }
})

// ── /newchat — Start fresh conversation ─────────────────────
bot.onText(/\/newchat/, (msg) => {
  const chatId = msg.chat.id
  resetConversation(chatId)
  bot.sendMessage(chatId, "🔄 Fresh conversation started. Claude won't remember previous messages.")
})

// ── /review ─────────────────────────────────────────────────
bot.onText(/\/review\s*(.*)/, async (msg, match) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return
  if (isRunning(chatId)) {
    bot.sendMessage(chatId, "⏳ Already processing. /cancel to stop.")
    return
  }

  const scope = match[1]?.trim()
  let reviewScope = "changes"
  if (scope === "branch") reviewScope = "branch"
  else if (scope === "last" || scope === "last-commit") reviewScope = "last-commit"

  const thinkingMsg = await bot.sendMessage(chatId, `⏳ Reviewing ${reviewScope}...`)
  bot.sendChatAction(chatId, "typing")

  try {
    const result = await reviewCode({
      chatId,
      projectDir: getProjectDir(chatId),
      projectName: getProjectName(chatId),
      onTyping: () => bot.sendChatAction(chatId, "typing").catch(() => {}),
      scope: reviewScope,
    })
    await sendResult(chatId, result, thinkingMsg.message_id)
  } catch (err) {
    await sendResult(chatId, `❌ Review failed: ${err.message}`, thinkingMsg.message_id)
  }
})

// ── /gitstatus ──────────────────────────────────────────────
bot.onText(/\/gitstatus/, async (msg) => {
  const chatId = msg.chat.id
  const projectDir = getProjectDir(chatId)
  const status = await getGitStatus(projectDir)

  if (!status) {
    bot.sendMessage(chatId, "❌ Not a git repository or git error.")
    return
  }

  bot.sendMessage(
    chatId,
    `📊 *Git Status* (${getProjectName(chatId)})\n\n` +
      `Branch: \`${status.branch}\`\n\n` +
      `*Changes:*\n\`\`\`\n${status.status}\n\`\`\`\n\n` +
      `*Recent commits:*\n\`\`\`\n${status.recentCommits}\n\`\`\``,
    { parse_mode: "Markdown" },
  )
})

// ── /diff ───────────────────────────────────────────────────
bot.onText(/\/diff/, async (msg) => {
  const chatId = msg.chat.id
  const diff = await getDiff(getProjectDir(chatId))

  if (!diff) {
    bot.sendMessage(chatId, "No changes.")
    return
  }

  // Truncate for Telegram
  const maxLen = 3800
  const truncated = diff.length > maxLen ? diff.slice(0, maxLen) + "\n...(truncated)" : diff
  bot.sendMessage(chatId, `\`\`\`diff\n${truncated}\n\`\`\``, { parse_mode: "Markdown" })
})

// ── /commitmsg ──────────────────────────────────────────────
bot.onText(/\/commitmsg/, async (msg) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return
  if (isRunning(chatId)) {
    bot.sendMessage(chatId, "⏳ Already processing.")
    return
  }

  const thinkingMsg = await bot.sendMessage(chatId, "⏳ Generating commit message...")
  bot.sendChatAction(chatId, "typing")

  try {
    const result = await generateCommitMessage({
      chatId,
      projectDir: getProjectDir(chatId),
      projectName: getProjectName(chatId),
      onTyping: () => bot.sendChatAction(chatId, "typing").catch(() => {}),
    })
    await sendResult(chatId, result, thinkingMsg.message_id)
  } catch (err) {
    await sendResult(chatId, `❌ ${err.message}`, thinkingMsg.message_id)
  }
})

// ── /explain ────────────────────────────────────────────────
bot.onText(/\/explain\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return
  if (isRunning(chatId)) {
    bot.sendMessage(chatId, "⏳ Already processing.")
    return
  }

  const target = match[1].trim()
  const thinkingMsg = await bot.sendMessage(chatId, `⏳ Explaining: ${target}...`)
  bot.sendChatAction(chatId, "typing")

  try {
    const result = await explainCode({
      chatId,
      projectDir: getProjectDir(chatId),
      projectName: getProjectName(chatId),
      target,
      onTyping: () => bot.sendChatAction(chatId, "typing").catch(() => {}),
    })
    await sendResult(chatId, result, thinkingMsg.message_id)
  } catch (err) {
    await sendResult(chatId, `❌ ${err.message}`, thinkingMsg.message_id)
  }
})

// ── /check ──────────────────────────────────────────────────
bot.onText(/\/check\s*(.*)/, async (msg, match) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return
  if (isRunning(chatId)) {
    bot.sendMessage(chatId, "⏳ Already processing.")
    return
  }

  const filePath = match[1]?.trim() || null
  const thinkingMsg = await bot.sendMessage(chatId, `⏳ Checking${filePath ? `: ${filePath}` : " changes"}...`)
  bot.sendChatAction(chatId, "typing")

  try {
    const result = await quickCheck({
      chatId,
      projectDir: getProjectDir(chatId),
      projectName: getProjectName(chatId),
      filePath,
      onTyping: () => bot.sendChatAction(chatId, "typing").catch(() => {}),
    })
    await sendResult(chatId, result, thinkingMsg.message_id)
  } catch (err) {
    await sendResult(chatId, `❌ ${err.message}`, thinkingMsg.message_id)
  }
})

// ── /logs ───────────────────────────────────────────────────
bot.onText(/\/logs\s*(.*)/, (msg, match) => {
  const chatId = msg.chat.id
  if (!isAdmin(msg.from.id)) { bot.sendMessage(chatId, "⛔ Admin only."); return }
  const category = match[1]?.trim() || "bot"
  const recent = maskSecrets(logger.getRecent(category, 30))
  bot.sendMessage(chatId, `📋 *Recent logs (${category}):*\n\`\`\`\n${recent}\n\`\`\``, {
    parse_mode: "Markdown",
  })
})

// ── /sessions — Session stats overview ──────────────────────
bot.onText(/\/sessions$/, (msg) => {
  const chatId = msg.chat.id
  const stats = sessionTracker.getStats()

  if (stats.empty) {
    bot.sendMessage(chatId, "No sessions yet. Send some messages first!")
    return
  }

  let text =
    `📊 *Claude Session Stats*\n\n` +
    `*Sessions:*\n` +
    `  Total: ${stats.totalSessions} (today: ${stats.todaySessions}, last hour: ${stats.lastHourSessions})\n` +
    `  ✅ ${stats.successfulSessions} | ❌ ${stats.failedSessions} | 🛑 ${stats.cancelledSessions}\n` +
    `  Success rate: ${stats.successRate}\n\n` +
    `*💰 Cost:*\n` +
    `  Total: $${stats.totalCostUsd.toFixed(4)}\n` +
    `  Today: $${stats.todayCostUsd.toFixed(4)}\n` +
    `  Avg/session: $${stats.avgCostPerSession.toFixed(4)}\n\n` +
    `*🔢 Tokens:*\n` +
    `  Input: ${stats.totalInputTokens.toLocaleString()}\n` +
    `  Output: ${stats.totalOutputTokens.toLocaleString()}\n` +
    `  Cache read: ${stats.totalCacheReadTokens.toLocaleString()}\n` +
    `  Cache create: ${stats.totalCacheCreateTokens.toLocaleString()}\n` +
    `  Total: ${stats.totalTokens.toLocaleString()}\n` +
    `  Avg/session: ${stats.avgTokensPerSession.toLocaleString()}\n\n` +
    `*⏱ Speed:*\n` +
    `  Avg API time: ${(stats.avgApiTimeMs / 1000).toFixed(1)}s\n` +
    `  Avg wall time: ${(stats.avgWallTimeMs / 1000).toFixed(1)}s\n\n`

  // Per-project breakdown
  const projects = Object.entries(stats.projectStats)
  if (projects.length > 0) {
    text += `*📁 Per Project:*\n`
    projects.forEach(([name, p]) => {
      text += `  ${name}: ${p.count} sessions, $${p.cost.toFixed(4)}, ${p.tokens.toLocaleString()} tokens\n`
    })
  }

  if (stats.permissionDenials > 0) {
    text += `\n⚠️ *Permission Denials:* ${stats.permissionDenials}\n`
    text += stats.uniqueDenials.map((d) => `  • ${d}`).join("\n")
  }

  bot.sendMessage(chatId, text, { parse_mode: "Markdown" })
})

// ── /history — Recent session history ───────────────────────
bot.onText(/\/history\s*(\d*)/, (msg, match) => {
  const chatId = msg.chat.id
  const limit = parseInt(match[1]) || 10
  const history = sessionTracker.getHistory(limit)

  if (history.length === 0) {
    bot.sendMessage(chatId, "No session history yet. Send some messages first!")
    return
  }

  const lines = history.map((s) => {
    const time = s.timestamp.split("T")[1].split(".")[0]
    const statusIcon = s.status === "success" ? "✅" : s.status === "error" ? "❌" : "🛑"
    const duration = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : "?"
    const cost = s.costUsd ? `$${s.costUsd.toFixed(4)}` : "-"
    const tokens = s.totalTokens ? s.totalTokens.toLocaleString() : "-"
    return (
      `${statusIcon} *#${s.id}* [${time}] ${duration} | ${cost} | ${tokens} tok\n` +
      `   📁 ${s.project} | 🤖 ${s.model || "?"}\n` +
      `   ${s.prompt.slice(0, 70)}${s.prompt.length > 70 ? "..." : ""}`
    )
  })

  bot.sendMessage(chatId, `📜 *Recent Sessions (${history.length}):*\n\n${lines.join("\n\n")}`, {
    parse_mode: "Markdown",
  })
})

// ── /sessioninfo <id> — Detailed session info ───────────────
bot.onText(/\/sessioninfo\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id
  const sessionId = parseInt(match[1])
  const analysis = sessionTracker.getContextAnalysis(sessionId)

  if (!analysis) {
    bot.sendMessage(chatId, `Session #${sessionId} not found.`)
    return
  }

  const s = analysis.session
  const statusIcon = s.status === "success" ? "✅" : s.status === "error" ? "❌" : "🛑"
  const u = s.usage || {}

  let text =
    `🔍 *Session #${s.id} — Full Details*\n\n` +
    `${statusIcon} *Status:* ${s.status}\n` +
    `🕐 *Time:* ${s.timestamp}\n` +
    `👤 *User:* ${s.username}\n` +
    `📁 *Project:* ${s.project}\n` +
    `🤖 *Model:* ${s.model || "unknown"}\n` +
    `🔗 *Session ID:* \`${s.sessionId || "none"}\`\n\n` +
    `*⏱ Timing:*\n` +
    `  Wall time: ${s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : "N/A"}\n` +
    `  API time: ${s.durationApiMs ? `${(s.durationApiMs / 1000).toFixed(1)}s` : "N/A"}\n` +
    `  Turns: ${s.numTurns || 0}\n\n` +
    `*💰 Cost:* $${(s.costUsd || 0).toFixed(4)}\n\n` +
    `*🔢 Token Breakdown:*\n` +
    `  Input tokens: ${(u.inputTokens || 0).toLocaleString()}\n` +
    `  Output tokens: ${(u.outputTokens || 0).toLocaleString()}\n` +
    `  Cache read: ${(u.cacheReadTokens || 0).toLocaleString()}\n` +
    `  Cache created: ${(u.cacheCreationTokens || 0).toLocaleString()}\n` +
    `  *Total: ${(s.totalTokens || 0).toLocaleString()} tokens*\n\n` +
    `*📐 Context Window:*\n` +
    `  Window size: ${(s.contextWindow || 0).toLocaleString()} tokens\n` +
    `  Used: ${s.contextUsagePercent || 0}%\n` +
    `  Max output: ${(s.maxOutputTokens || 0).toLocaleString()} tokens\n\n` +
    `*📝 Prompt (${s.promptLength} chars):*\n` +
    `\`\`\`\n${s.prompt}\n\`\`\`\n` +
    `*📤 Response:* ${s.responseLength.toLocaleString()} chars`

  if (s.permissionDenials && s.permissionDenials.length > 0) {
    text += `\n\n⚠️ *Permission Denials:*\n${s.permissionDenials.map((d) => `  • ${d}`).join("\n")}`
  }

  if (s.error) {
    text += `\n\n❌ *Error:* ${s.error}`
  }

  if (s.stopReason && s.stopReason !== "end_turn") {
    text += `\n\n🛑 *Stop reason:* ${s.stopReason}`
  }

  bot.sendMessage(chatId, text, { parse_mode: "Markdown" })
})

// ── /context — Overall context analysis ─────────────────────
bot.onText(/\/context/, (msg) => {
  const chatId = msg.chat.id
  const analysis = sessionTracker.getContextAnalysis()
  const stats = sessionTracker.getStats()
  const running = isRunning(chatId)
  const runningSession = running ? getSession(chatId) : null
  const convoInfo = getConversationInfo(chatId)

  let text = `🧠 *Context & Usage Analysis*\n\n`

  // Current conversation state
  text += `*🔗 Current Conversation:*\n`
  if (convoInfo) {
    text += `  Session: \`${convoInfo.sessionId.slice(0, 8)}...\`\n`
    text += `  Project: ${getProjectName(chatId)}\n`
    text += `  Mode: Continuing (Claude remembers previous messages)\n`
    text += `  Use /newchat to start fresh\n`
  } else {
    text += `  No active conversation — next message starts fresh\n`
  }

  if (runningSession) {
    const elapsed = Math.round((Date.now() - runningSession.startedAt) / 1000)
    text += `  ⏳ Running: ${elapsed}s — ${runningSession.prompt.slice(0, 60)}...\n`
  }

  if (stats.empty) {
    text += `\nNo session data yet. Send some messages to build up stats.`
    bot.sendMessage(chatId, text, { parse_mode: "Markdown" })
    return
  }

  // Cost analysis
  text += `\n*💰 Cost Breakdown:*\n`
  text += `  Total spent: $${stats.totalCostUsd.toFixed(4)}\n`
  text += `  Today: $${stats.todayCostUsd.toFixed(4)}\n`
  text += `  Average per query: $${stats.avgCostPerSession.toFixed(4)}\n`

  // What's eating tokens
  text += `\n*🔢 What's Eating Your Context:*\n`
  text += `  Input (your prompts + codebase): ${stats.totalInputTokens.toLocaleString()} tokens\n`
  text += `  Output (Claude's responses): ${stats.totalOutputTokens.toLocaleString()} tokens\n`
  text += `  Cache reads (reused context): ${stats.totalCacheReadTokens.toLocaleString()} tokens\n`
  text += `  Cache created (new context): ${stats.totalCacheCreateTokens.toLocaleString()} tokens\n`

  // Top consumers
  if (analysis.mostExpensive && analysis.mostExpensive.length > 0) {
    text += `\n*💸 Most Expensive Queries:*\n`
    analysis.mostExpensive.slice(0, 3).forEach((s) => {
      text += `  #${s.id}: $${s.costUsd.toFixed(4)} — ${s.prompt.slice(0, 50)}...\n`
    })
  }

  if (analysis.biggestPrompts && analysis.biggestPrompts.length > 0) {
    text += `\n*📥 Biggest Input Queries:*\n`
    analysis.biggestPrompts.slice(0, 3).forEach((s) => {
      text += `  #${s.id}: ${(s.usage?.inputTokens || 0).toLocaleString()} input tokens — ${s.prompt.slice(0, 50)}...\n`
    })
  }

  if (analysis.biggestResponses && analysis.biggestResponses.length > 0) {
    text += `\n*📤 Biggest Output Queries:*\n`
    analysis.biggestResponses.slice(0, 3).forEach((s) => {
      text += `  #${s.id}: ${(s.usage?.outputTokens || 0).toLocaleString()} output tokens — ${s.prompt.slice(0, 50)}...\n`
    })
  }

  // Tips based on actual usage
  text += `\n*💡 Optimization Tips:*\n`
  if (stats.avgTokensPerSession > 50000) {
    text += `  ⚠️ High avg tokens/session — try shorter, focused prompts\n`
  }
  if (stats.totalCacheCreateTokens > stats.totalCacheReadTokens * 2) {
    text += `  💡 Use --continue to reuse cached context (saves cost)\n`
  }
  if (stats.permissionDenials > 0) {
    text += `  ⚠️ ${stats.permissionDenials} permission denials — check /sessioninfo for details\n`
  }
  text += `  • /newchat resets context (good when switching topics)\n`
  text += `  • /review is more efficient than describing diffs manually\n`
  text += `  • Conversation continuity reuses cache (cheaper)\n`

  bot.sendMessage(chatId, text, { parse_mode: "Markdown" })
})

// ── /running — Currently running Claude sessions ────────────
bot.onText(/\/running/, async (msg) => {
  const chatId = msg.chat.id

  // Bot's own running sessions
  const botRunning = isRunning(chatId)
  const session = botRunning ? getSession(chatId) : null

  // System-wide Claude processes
  const cliSessions = await getClaudeCLISessions()

  let text = `🏃 *Running Claude Sessions*\n\n`

  text += `*This Bot:*\n`
  if (session) {
    const elapsed = Math.round((Date.now() - session.startedAt) / 1000)
    text +=
      `  ⏳ Active — ${session.projectName}\n` +
      `  Running: ${elapsed}s\n` +
      `  Prompt: ${session.prompt.slice(0, 100)}\n`
  } else {
    text += `  💤 Idle\n`
  }

  text += `\n*System-wide Claude Processes:*\n`
  if (cliSessions.runningProcesses === "NONE") {
    text += `  No claude processes running\n`
  } else {
    const lines = cliSessions.runningProcesses.split("\n").slice(0, 10)
    text += `\`\`\`\n${lines.join("\n")}\n\`\`\`\n`
  }

  if (cliSessions.projects && cliSessions.projects.length > 0) {
    text += `\n*Claude Code Projects:*\n`
    text += cliSessions.projects.slice(0, 10).map((p) => `  📁 ${p}`).join("\n")
  }

  bot.sendMessage(chatId, text, { parse_mode: "Markdown" })
})

// ── /clearsessions — Clear session history ──────────────────
bot.onText(/\/clearsessions\s*(.*)/, (msg, match) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  const project = match[1]?.trim()
  if (project) {
    const removed = sessionTracker.clearProject(project)
    bot.sendMessage(chatId, `🗑️ Cleared ${removed} sessions for project "${project}".`)
  } else {
    const stats = sessionTracker.getStats()
    sessionTracker.clearHistory()
    bot.sendMessage(chatId, `🗑️ Cleared all ${stats.totalSessions} sessions.`)
  }
})

// ── /guard ──────────────────────────────────────────────────
bot.onText(/\/guard$/, (msg) => {
  const chatId = msg.chat.id
  const hasFace = fs.existsSync(REFERENCE_PHOTO)
  const hasScreen = fs.existsSync(REFERENCE_SCREEN)
  const running = isGuardRunning()

  bot.sendMessage(
    chatId,
    `🛡️ *Security Guard*\n\n` +
      `Status: ${running ? "🟢 ACTIVE" : "🔴 STOPPED"}\n` +
      `Face reference: ${hasFace ? "✅" : "❌ (run npm run setup-guard)"}\n` +
      `Screen reference: ${hasScreen ? "✅" : "❌"}\n\n` +
      `Commands:\n` +
      `/guardstart — Start monitoring\n` +
      `/guardstop — Stop monitoring\n` +
      `/guardsnap — Take test webcam photo\n` +
      `/guardscreen — Take test screenshot\n` +
      `/guardsetface — Set reference face (send a photo after this)\n`,
    { parse_mode: "Markdown" },
  )
})

// ── /guardstart ─────────────────────────────────────────────
bot.onText(/\/guardstart/, (msg) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  if (isGuardRunning()) {
    bot.sendMessage(chatId, "🛡️ Security guard is already running. Use /guardstop to stop it.")
    return
  }

  try {
    setGuardBot(bot, chatId)
    startSecurityGuard()
    bot.sendMessage(chatId, "🛡️ Security guard started! Monitoring every 15s...\nUse /guardstop to pause.")
    logger.security("Security guard started via Telegram", { userId: msg.from.id })
  } catch (err) {
    bot.sendMessage(chatId, `❌ ${err.message}`)
  }
})

// ── /guardstop ──────────────────────────────────────────────
bot.onText(/\/guardstop/, (msg) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  if (stopSecurityGuard()) {
    bot.sendMessage(chatId, "🛡️ Security guard stopped. Use /guardstart to resume.")
    logger.security("Security guard stopped via Telegram", { userId: msg.from.id })
  } else {
    bot.sendMessage(chatId, "Security guard is not running.")
  }
})

// ── /guardsnap ──────────────────────────────────────────────
bot.onText(/\/guardsnap/, async (msg) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  try {
    const testPhoto = path.join(__dirname, "data", "test-snap.png")
    await captureWebcam(testPhoto)

    // Compare with reference if exists
    let caption = "📸 Current webcam capture"
    if (fs.existsSync(REFERENCE_PHOTO)) {
      const similarity = await compareImages(REFERENCE_PHOTO, testPhoto)
      caption += `\nSimilarity to reference: ${(similarity * 100).toFixed(1)}%`
      caption += similarity >= 0.8 ? " ✅" : " ⚠️"
    }

    await bot.sendPhoto(chatId, testPhoto, { caption })
    fs.unlinkSync(testPhoto)
  } catch (err) {
    bot.sendMessage(chatId, `❌ Webcam capture failed: ${err.message}`)
  }
})

// ── /guardscreen ────────────────────────────────────────────
bot.onText(/\/guardscreen/, async (msg) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  try {
    const testScreen = path.join(__dirname, "data", "test-screen.png")
    await captureScreen(testScreen)
    await bot.sendPhoto(chatId, testScreen, { caption: "📸 Current screen" })
    fs.unlinkSync(testScreen)
  } catch (err) {
    bot.sendMessage(chatId, `❌ Screenshot failed: ${err.message}`)
  }
})

// ── /guardsetface — Set reference via photo message ─────────
const awaitingFacePhoto = new Set()

bot.onText(/\/guardsetface/, (msg) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return
  awaitingFacePhoto.add(chatId)
  bot.sendMessage(chatId, "📸 Send me a photo of your face to use as the reference.")
})

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id
  if (!awaitingFacePhoto.has(chatId)) return
  awaitingFacePhoto.delete(chatId)

  try {
    // Get highest resolution photo
    const photo = msg.photo[msg.photo.length - 1]
    const file = await bot.getFile(photo.file_id)
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`

    const response = await fetch(fileUrl)
    const buffer = Buffer.from(await response.arrayBuffer())
    fs.writeFileSync(REFERENCE_PHOTO, buffer)
    clearReferenceCache()

    bot.sendMessage(chatId, "✅ Reference face photo saved! Security guard will use this for comparison.")
    logger.security("Reference face updated via Telegram", { userId: msg.from.id })
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to save photo: ${err.message}`)
  }
})

// ── /setup — Connect Claude (two options) ───────────────────
const awaitingInput = new Map() // chatId -> "api_key" | "claude_email" | "claude_key_after_email"

bot.onText(/\/setup/, (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id

  if (!userManager.exists(userId)) {
    userManager.register(userId, { username: msg.from.username, firstName: msg.from.first_name })
  }

  if (userManager.hasApiKey(userId)) {
    const user = userManager.get(userId)
    bot.sendMessage(
      chatId,
      `✅ You're already connected via *${user.auth_method === "claude_login" ? "Claude Login" : "API Key"}*\n\n` +
        `/myusage — View your stats\n/removekey — Disconnect`,
      { parse_mode: "Markdown" },
    )
    return
  }

  bot.sendMessage(chatId, `🔑 *Connect Your Claude Account*\n\nChoose how to connect:`, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔑 I have an API Key", callback_data: "setup_apikey" }],
        [{ text: "📧 Login with Claude Email", callback_data: "setup_email" }],
      ],
    },
  })
})

// Handle setup button clicks
bot.on("callback_query", async (query) => {
  if (!query.data?.startsWith("setup_")) return
  const chatId = query.message.chat.id
  const userId = query.from.id

  await bot.answerCallbackQuery(query.id)

  if (query.data === "setup_apikey") {
    awaitingInput.set(chatId, "api_key")
    await bot.sendMessage(
      chatId,
      `🔑 *Paste your Anthropic API Key*\n\n` +
        `1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)\n` +
        `2. Click "Create Key"\n` +
        `3. Copy and paste it here\n\n` +
        `_Your key will be deleted from chat & encrypted immediately._`,
      { parse_mode: "Markdown", disable_web_page_preview: true },
    )
  }

  if (query.data === "setup_email") {
    awaitingInput.set(chatId, "claude_email")
    await bot.sendMessage(
      chatId,
      `📧 *Claude Email Login*\n\n` +
        `Send me the email you use for your Anthropic/Claude account.\n\n` +
        `I'll guide you through getting your API key.\n` +
        `_Your email is only used to verify your account — it's not stored._`,
      { parse_mode: "Markdown" },
    )
  }

  // Remove buttons
  bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId, message_id: query.message.message_id,
  }).catch(() => {})
})

// Catch setup input (API key or email)
bot.on("message", async (msg) => {
  const mode = awaitingInput.get(msg.chat.id)
  if (!mode) return
  if (msg.text?.startsWith("/")) return
  if (!msg.text) return

  const chatId = msg.chat.id
  const userId = msg.from.id
  const input = msg.text.trim()

  // Always delete the message for security
  bot.deleteMessage(chatId, msg.message_id).catch(() => {})

  if (!userManager.exists(userId)) {
    userManager.register(userId, { username: msg.from.username, firstName: msg.from.first_name })
  }

  // ── API Key flow ──────────────────────────────────────────
  if (mode === "api_key" || mode === "claude_key_after_email") {
    awaitingInput.delete(chatId)

    if (!isValidApiKeyFormat(input)) {
      bot.sendMessage(chatId, `❌ Invalid key format. Should start with \`sk-ant-\` (40+ chars).\nTry /setup again.`)
      return
    }

    // Validate key actually works by making a test call
    const validMsg = await bot.sendMessage(chatId, "🔄 _Validating your API key..._", { parse_mode: "Markdown" })

    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk")
      const client = new Anthropic({ apiKey: input })
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      })

      // Key works!
      if (mode === "claude_key_after_email") {
        userManager.setApiKeyFromLogin(userId, input)
      } else {
        userManager.setApiKey(userId, input)
      }
      userManager.approve(userId)

      bot.editMessageText(
        `✅ *Connected!* Your API key is valid and encrypted.\n\n` +
          `You can now send messages to Claude.\n` +
          `• /myusage — Your usage & costs\n` +
          `• /removekey — Disconnect\n` +
          `• /newchat — Fresh conversation`,
        { chat_id: chatId, message_id: validMsg.message_id, parse_mode: "Markdown" },
      )
      logger.info("USER", `New user: ${msg.from.username || userId} (${mode})`)
    } catch (err) {
      bot.editMessageText(
        `❌ *Key validation failed*\n\n` +
          `The key didn't work. Check that:\n` +
          `• It's copied correctly (starts with \`sk-ant-\`)\n` +
          `• It has API access enabled\n` +
          `• Your Anthropic account has credits\n\n` +
          `Try /setup again.`,
        { chat_id: chatId, message_id: validMsg.message_id, parse_mode: "Markdown" },
      )
    }
    return
  }

  // ── Email flow ────────────────────────────────────────────
  if (mode === "claude_email") {
    awaitingInput.delete(chatId)

    // Basic email validation
    if (!input.includes("@") || !input.includes(".")) {
      bot.sendMessage(chatId, "❌ That doesn't look like an email. Try /setup again.")
      return
    }

    awaitingInput.set(chatId, "claude_key_after_email")
    bot.sendMessage(
      chatId,
      `📧 *Great! Here's how to get your API key:*\n\n` +
        `1. Go to [console.anthropic.com](https://console.anthropic.com/)\n` +
        `2. Log in with: \`${input}\`\n` +
        `3. Go to *Settings → API Keys*\n` +
        `4. Click *"Create Key"*\n` +
        `5. Copy the key and *paste it here*\n\n` +
        `_Waiting for your API key..._`,
      { parse_mode: "Markdown", disable_web_page_preview: true },
    )
    return
  }
})

// ── /myusage — View personal usage (from DB) ────────────────
bot.onText(/\/myusage/, (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  const summary = userManager.getUsageSummary(userId)

  if (!summary || summary.total_sessions === 0) {
    bot.sendMessage(chatId, "No usage data yet. Send a message to get started!")
    return
  }

  const totalTokens = summary.total_input + summary.total_output + summary.total_cache
  const avgCost = summary.total_sessions > 0 ? summary.total_cost / summary.total_sessions : 0

  // Get daily breakdown
  const daily = userManager.getDailyBreakdown(userId, 5)
  const dailyLines = daily.map((d) =>
    `  ${d.date}: ${d.sessions} sessions, $${d.cost_usd.toFixed(4)}, ${d.total_tokens.toLocaleString()} tok`,
  ).join("\n")

  bot.sendMessage(
    chatId,
    `📊 *Your Usage*\n\n` +
      `*Sessions:* ${summary.total_sessions}\n` +
      `*Total cost:* $${summary.total_cost.toFixed(4)}\n` +
      `*Today:* $${summary.today_cost.toFixed(4)}\n` +
      `*Avg/session:* $${avgCost.toFixed(4)}\n\n` +
      `*Tokens:*\n` +
      `  Input: ${summary.total_input.toLocaleString()}\n` +
      `  Output: ${summary.total_output.toLocaleString()}\n` +
      `  Cache: ${summary.total_cache.toLocaleString()}\n` +
      `  Total: ${totalTokens.toLocaleString()}\n\n` +
      (dailyLines ? `*Last 5 Days:*\n${dailyLines}\n\n` : "") +
      `*Last session:* ${summary.last_session || "Never"}`,
    { parse_mode: "Markdown" },
  )
})

// ── /removekey — Remove API key ─────────────────────────────
bot.onText(/\/removekey/, (msg) => {
  const chatId = msg.chat.id
  userManager.removeApiKey(msg.from.id)
  bot.sendMessage(chatId, "🗑️ API key removed. Use /setup to connect a new one.")
})

// ── /users — Admin: list all users ──────────────────────────
bot.onText(/\/users$/, (msg) => {
  const chatId = msg.chat.id
  if (!isAdmin(msg.from.id)) { bot.sendMessage(chatId, "⛔ Admin only."); return }

  const users = userManager.listAll()
  const stats = userManager.globalStats()

  if (users.length === 0) {
    bot.sendMessage(chatId, "No users registered yet.")
    return
  }

  const lines = users.map((u) => {
    const status = ALLOWED_USER_IDS.includes(u.telegram_id) ? "👑" : u.is_approved ? "✅" : "⏳"
    const key = u.has_key ? "🔑" : "❌"
    const method = u.auth_method !== "none" ? ` (${u.auth_method})` : ""
    return (
      `${status} *${u.first_name || u.username || u.telegram_id}*${method}\n` +
      `  ID: \`${u.telegram_id}\` | Key: ${key}\n` +
      `  Sessions: ${u.total_sessions} | Cost: $${(u.total_cost || 0).toFixed(4)}\n` +
      `  Last: ${u.last_active_at || "Never"}`
    )
  })

  bot.sendMessage(
    chatId,
    `👥 *Users (${stats.total_users})* | 🔑 ${stats.users_with_keys} with keys\n` +
      `💰 Total: $${stats.total_cost.toFixed(4)} | Today: $${stats.today_cost.toFixed(4)}\n` +
      `📊 Sessions: ${stats.total_sessions} (${stats.today_sessions} today)\n\n` +
      `${lines.join("\n\n")}\n\n` +
      `👑 = Admin  ✅ = Approved  ⏳ = Pending`,
    { parse_mode: "Markdown" },
  )
})

// ── /approve — Admin: approve user ──────────────────────────
bot.onText(/\/approve\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id
  if (!isAdmin(msg.from.id)) { bot.sendMessage(chatId, "⛔ Admin only."); return }

  const targetId = parseInt(match[1])
  if (userManager.approve(targetId)) {
    bot.sendMessage(chatId, `✅ User ${targetId} approved.`)
    bot.sendMessage(targetId, "✅ You've been approved! Use /setup to connect your Claude API key.").catch(() => {})
  } else {
    bot.sendMessage(chatId, `❌ User ${targetId} not found.`)
  }
})

// ── /blockuser — Admin: block user ──────────────────────────
bot.onText(/\/blockuser\s+(\d+)/, (msg, match) => {
  const chatId = msg.chat.id
  if (!isAdmin(msg.from.id)) { bot.sendMessage(chatId, "⛔ Admin only."); return }

  const targetId = parseInt(match[1])
  if (userManager.block(targetId)) {
    bot.sendMessage(chatId, `🚫 User ${targetId} blocked.`)
  } else {
    bot.sendMessage(chatId, `❌ User ${targetId} not found.`)
  }
})

// ── /sys — Direct system commands (admin only) ──────────────
bot.onText(/\/sys\s*(.*)/, async (msg, match) => {
  const chatId = msg.chat.id
  if (!isAdmin(msg.from.id)) {
    bot.sendMessage(chatId, "⛔ System commands are admin-only.")
    return
  }

  const input = match[1]?.trim()
  if (!input) {
    bot.sendMessage(
      chatId,
      `🖥️ *System Commands*\n\n` +
        `Usage: \`/sys <command> [args]\`\n\n` +
        `*Power:* sleep, shutdown, restart, lock, screen-off\n` +
        `*Display:* brightness <0-100>\n` +
        `*Volume:* volume <0-100>, mute, unmute, volume-get\n` +
        `*Apps:* open-app <name>, quit-app <name>, running-apps\n` +
        `*System:* battery, uptime, disk, memory, wifi\n` +
        `*Network:* wifi-on, wifi-off, bluetooth-on, bluetooth-off\n` +
        `*DND:* dnd-on, dnd-off\n` +
        `*Theme:* dark-mode-on, dark-mode-off, dark-mode-toggle\n` +
        `*Other:* notify <title> <msg>, say <text>, screenshot, caffeinate, empty-trash\n` +
        `*Process:* kill <name|pid>\n\n` +
        `Examples:\n` +
        `\`/sys sleep\`\n` +
        `\`/sys volume 50\`\n` +
        `\`/sys open-app Safari\``,
      { parse_mode: "Markdown" },
    )
    return
  }

  const parts = input.split(/\s+/)
  const command = parts[0]
  const args = parts.slice(1).map(sanitizeShellArg)

  if (!isValidSystemCommand(command)) {
    bot.sendMessage(chatId, `❌ Unknown command: ${command}\nUse /sys for the full list.`)
    return
  }

  try {
    const result = await runSystemCommand(command, args)
    bot.sendMessage(chatId, `🖥️ ${result}`)
  } catch (err) {
    bot.sendMessage(chatId, `❌ ${err.message}`)
  }
})

// ── /permit — Check & grant macOS permissions ───────────────
bot.onText(/\/permit\s*(.*)/, async (msg, match) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return

  const action = match[1]?.trim() || "check"
  const permScript = path.join(__dirname, "scripts", "grant-permissions.sh")

  try {
    const result = await runShell(`bash "${permScript}" ${action}`, __dirname)
    bot.sendMessage(chatId, `🔐 *Permissions*\n\`\`\`\n${result}\n\`\`\``, { parse_mode: "Markdown" })
  } catch (err) {
    bot.sendMessage(chatId, `❌ ${err.message}`)
  }
})

// ── /ask — Explicit Claude query ────────────────────────────
bot.onText(/\/ask\s+(.+)/s, async (msg, match) => {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) return
  if (isRunning(chatId)) {
    bot.sendMessage(chatId, "⏳ Already processing. /cancel to stop.")
    return
  }

  const prompt = match[1].trim()
  await handleClaudeQuery(chatId, prompt, msg)
})

// ── Voice/Audio message handler ──────────────────────────────
bot.on("voice", async (msg) => handleVoiceMessage(msg))
bot.on("audio", async (msg) => handleVoiceMessage(msg))

async function handleVoiceMessage(msg) {
  const chatId = msg.chat.id
  if (!isAllowed(msg.from.id)) {
    bot.sendMessage(chatId, "⛔ Unauthorized.")
    return
  }
  if (isRunning(chatId)) {
    bot.sendMessage(chatId, "⏳ Still processing. /cancel to stop.")
    return
  }

  // Auto-detect owner
  if (!ownerChatId && isAllowed(msg.from.id)) {
    ownerChatId = chatId
    setupLogForwarding()
    setGuardBot(bot, chatId)
    logger.info("BOT", `Owner chat ID auto-detected: ${chatId}`)
  }

  const fileId = msg.voice?.file_id || msg.audio?.file_id
  if (!fileId) return

  const transcribeMsg = await bot.sendMessage(chatId, "🎙️ _Transcribing your voice..._", { parse_mode: "Markdown" })

  try {
    // Download the audio file
    const file = await bot.getFile(fileId)
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    const audioDir = path.join(__dirname, "data")
    const oggPath = path.join(audioDir, `voice-${Date.now()}.ogg`)
    const wavPath = oggPath.replace(".ogg", ".wav")

    const response = await fetch(fileUrl)
    const buffer = Buffer.from(await response.arrayBuffer())
    fs.writeFileSync(oggPath, buffer)

    // Convert to WAV using ffmpeg (Whisper needs wav/mp3)
    await new Promise((resolve, reject) => {
      const proc = spawnProc("ffmpeg", [
        "-i", oggPath, "-ar", "16000", "-ac", "1", "-y", wavPath,
      ], { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 })
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)))
      proc.on("error", reject)
    })

    // Transcribe with Whisper
    const transcription = await new Promise((resolve, reject) => {
      const proc = spawnProc("whisper", [
        wavPath,
        "--model", "base",
        "--language", "hi",
        "--output_format", "txt",
        "--output_dir", audioDir,
      ], {
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
      })

      let stdout = ""
      let stderr = ""
      proc.stdout.on("data", (d) => stdout += d.toString())
      proc.stderr.on("data", (d) => stderr += d.toString())

      proc.on("close", (code) => {
        // Read the .txt output file
        const txtPath = wavPath.replace(".wav", ".txt")
        if (fs.existsSync(txtPath)) {
          const text = fs.readFileSync(txtPath, "utf-8").trim()
          // Cleanup temp files
          try { fs.unlinkSync(oggPath) } catch {}
          try { fs.unlinkSync(wavPath) } catch {}
          try { fs.unlinkSync(txtPath) } catch {}
          resolve(text)
        } else if (code === 0) {
          resolve(stdout.trim())
        } else {
          reject(new Error(`Whisper failed: ${stderr.slice(0, 200)}`))
        }
      })
      proc.on("error", reject)
    })

    if (!transcription) {
      bot.editMessageText("🎙️ Couldn't understand the audio. Try again?", {
        chat_id: chatId,
        message_id: transcribeMsg.message_id,
      })
      return
    }

    // Show transcription, then delete it
    await bot.editMessageText(
      `🎙️ *You said:*\n_"${transcription}"_`,
      { chat_id: chatId, message_id: transcribeMsg.message_id, parse_mode: "Markdown" },
    )

    // Send to Claude
    await handleClaudeQuery(chatId, transcription, msg)

    // Delete the transcription message after response is sent
    bot.deleteMessage(chatId, transcribeMsg.message_id).catch(() => {})
  } catch (err) {
    logger.error("BOT", `Voice processing failed: ${err.message}`)
    bot.editMessageText(`❌ Voice error: ${err.message}`, {
      chat_id: chatId,
      message_id: transcribeMsg.message_id,
    }).catch(() => {})
  }
}

// ── General message handler ─────────────────────────────────
bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return
  if (msg.photo) return // handled above
  if (msg.voice || msg.audio) return // handled above

  const chatId = msg.chat.id
  const userMessage = msg.text
  if (!userMessage) return

  // Auto-detect owner chat ID
  if (!ownerChatId && isAllowed(msg.from.id)) {
    ownerChatId = chatId
    setupLogForwarding()
    setGuardBot(bot, chatId)
    logger.info("BOT", `Owner chat ID auto-detected: ${chatId}`)
  }

  if (!isAllowed(msg.from.id)) {
    bot.sendMessage(chatId, "🔑 Use /setup to connect your Claude API key and get started.")
    logger.security("Unauthorized access attempt", {
      userId: msg.from.id,
      username: msg.from.username,
    })
    return
  }

  if (isRunning(chatId)) {
    bot.sendMessage(chatId, "⏳ Still processing. /cancel to stop it.")
    return
  }

  if (isBlocked(msg.from.id)) {
    bot.sendMessage(chatId, "🚫 Too many failed attempts. Try again later.")
    return
  }

  if (isMessageTooLarge(userMessage)) {
    bot.sendMessage(chatId, "⚠️ Message too large. Keep it under 50KB.")
    return
  }

  const rl = checkRateLimit(msg.from.id)
  if (!rl.allowed) {
    bot.sendMessage(chatId, `⏳ Rate limited. Try again in ${Math.ceil(rl.resetMs / 1000)}s.`)
    return
  }

  if (!canStartSession(msg.from.id)) {
    bot.sendMessage(chatId, "⏳ You have too many concurrent sessions. Wait for one to finish.")
    return
  }

  await handleClaudeQuery(chatId, sanitizePrompt(userMessage))
})

// ── Core Claude query handler (with live streaming updates) ──
async function handleClaudeQuery(chatId, prompt, msg = null) {
  const userId = msg?.from?.id || chatId
  const projectDir = getProjectDir(chatId)
  const projectName = getProjectName(chatId)
  const startTime = Date.now()

  // Get user's API key (admins can use system key)
  const userApiKey = userManager.getApiKey(userId)
  if (!userApiKey && !isAdmin(userId)) {
    bot.sendMessage(chatId, "🔑 You need to connect your Claude API key first.\nUse /setup to get started.")
    return
  }

  incrementSession(userId)
  bot.sendChatAction(chatId, "typing")

  // Send initial status message (will be updated live)
  const statusMsg = await bot.sendMessage(
    chatId,
    `⚡ *Working on it...* (${projectName})\n\n` +
      `📝 _${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}_`,
    { parse_mode: "Markdown" },
  )

  const statusMsgId = statusMsg.message_id
  let lastStatusText = ""
  let statusUpdateTimer = null

  // Debounced status updater (avoid Telegram rate limits)
  function scheduleStatusUpdate(text) {
    if (text === lastStatusText) return
    lastStatusText = text
    if (statusUpdateTimer) clearTimeout(statusUpdateTimer)
    statusUpdateTimer = setTimeout(() => {
      bot.editMessageText(text, {
        chat_id: chatId,
        message_id: statusMsgId,
        parse_mode: "Markdown",
      }).catch(() => {})
    }, 800) // Update at most every 800ms
  }

  logger.info("BOT", `Query from chat ${chatId}`, {
    project: projectName,
    prompt: prompt.slice(0, 200),
  })

  try {
    const { result, meta } = await runClaude({
      chatId,
      prompt,
      projectDir,
      projectName,
      apiKey: userApiKey || null,
      onTyping: () => bot.sendChatAction(chatId, "typing").catch(() => {}),
      onStatusUpdate: (status) => {
        let text = ""

        if (status.type === "thinking") {
          text =
            `${status.text}\n\n` +
            `📁 *${status.project}*\n` +
            `📝 _${status.prompt}${status.prompt.length >= 80 ? "..." : ""}_`
        }

        if (status.type === "tool") {
          const elapsed = status.elapsed || 0
          const toolLines = (status.tools || []).map((t, i, arr) => {
            return i === arr.length - 1 ? `▸ ${t}` : `  ${t}`
          }).join("\n")

          text =
            `⚙️ *Working...* _(${elapsed}s, ${status.turns} step${status.turns > 1 ? "s" : ""})_\n\n` +
            `${toolLines}`
        }

        if (status.type === "progress") {
          const elapsed = status.elapsed || 0
          const toolLines = (status.tools || []).slice(-4).map(t => `  ${t}`).join("\n")

          text =
            `💬 *Wrapping up...* _(${elapsed}s)_\n\n` +
            (toolLines ? `${toolLines}\n\n` : "") +
            `✍️ _Composing final response..._`
        }

        if (text) scheduleStatusUpdate(text)
      },
    })

    // Clear any pending status update
    if (statusUpdateTimer) clearTimeout(statusUpdateTimer)

    // Delete the status message
    bot.deleteMessage(chatId, statusMsgId).catch(() => {})

    // Send the final response
    if (!result || result.trim() === "") {
      await bot.sendMessage(chatId, "_(empty response)_", { parse_mode: "Markdown" })
    } else {
      const chunks = splitMessage(result)
      for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk)
      }
    }

    // Send usage summary
    if (meta) {
      const toolCount = meta.toolLog?.length || 0
      const usageLine =
        `📊 _${(meta.durationMs / 1000).toFixed(1)}s · $${meta.costUsd?.toFixed(4)} · ` +
        `${meta.totalTokens.toLocaleString()} tok · ` +
        `${meta.numTurns || 0} turns · ${toolCount} tools_`
      await bot.sendMessage(chatId, usageLine, { parse_mode: "Markdown" })
    }

    const durationMs = Date.now() - startTime

    // Record per-user usage
    userManager.recordUsage(userId, meta)

    sessionTracker.record({
      chatId,
      userId,
      username: msg?.from?.username || msg?.from?.first_name,
      project: projectName,
      prompt,
      responseLength: result?.length || 0,
      durationMs,
      status: result === null ? "cancelled" : "success",
      meta,
    })

    logger.info("BOT", `Response sent (${result?.length || 0} chars, ${(durationMs / 1000).toFixed(1)}s)`, { project: projectName, user: userId })
    decrementSession(userId)
  } catch (err) {
    if (statusUpdateTimer) clearTimeout(statusUpdateTimer)
    decrementSession(userId)

    const durationMs = Date.now() - startTime
    bot.deleteMessage(chatId, statusMsgId).catch(() => {})
    bot.sendMessage(chatId, `❌ Error: ${sanitizeErrorMessage(err)}`)

    sessionTracker.record({
      chatId,
      userId: msg?.from?.id,
      username: msg?.from?.username || msg?.from?.first_name,
      project: projectName,
      prompt,
      responseLength: 0,
      durationMs,
      status: "error",
      error: err.message,
    })

    logger.error("BOT", `Query failed: ${err.message}`, { project: projectName })
  }
}

// ── Security Guard Inline Button Callbacks ───────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id
  const data = query.data

  if (!data?.startsWith("guard_")) return
  if (!isAllowed(query.from.id)) {
    bot.answerCallbackQuery(query.id, { text: "⛔ Unauthorized" })
    return
  }

  switch (data) {
    case "guard_shutdown":
      await bot.answerCallbackQuery(query.id, { text: "🔴 Shutting down..." })
      await bot.sendMessage(chatId, "🔴 *SHUTTING DOWN LAPTOP NOW*", { parse_mode: "Markdown" })
      logger.security("Remote shutdown triggered via Telegram", { userId: query.from.id })
      setTimeout(() => shutdownLaptop(), 1000)
      break

    case "guard_sleep":
      await bot.answerCallbackQuery(query.id, { text: "😴 Sleeping..." })
      await bot.sendMessage(chatId, "😴 *Putting laptop to sleep*", { parse_mode: "Markdown" })
      logger.security("Remote sleep triggered via Telegram", { userId: query.from.id })
      setTimeout(() => sleepLaptop(), 1000)
      break

    case "guard_lock":
      await bot.answerCallbackQuery(query.id, { text: "🔒 Locking..." })
      await bot.sendMessage(chatId, "🔒 *Screen locked*", { parse_mode: "Markdown" })
      logger.security("Remote lock triggered via Telegram", { userId: query.from.id })
      lockScreen()
      break

    case "guard_alarm":
      await bot.answerCallbackQuery(query.id, { text: "📢 Alarm sounding!" })
      await bot.sendMessage(chatId, "📢 *ALARM ACTIVATED — max volume warning playing*", { parse_mode: "Markdown" })
      logger.security("Remote alarm triggered via Telegram", { userId: query.from.id })
      soundAlarm()
      break

    case "guard_dismiss":
      await bot.answerCallbackQuery(query.id, { text: "✅ Dismissed" })
      await bot.sendMessage(chatId, "✅ Alert dismissed — it was you.")
      logger.security("Alert dismissed by owner", { userId: query.from.id })
      break

    default:
      await bot.answerCallbackQuery(query.id)
  }

  // Remove the inline keyboard after action
  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id },
    )
  } catch {}
})

// ── Graceful Shutdown ───────────────────────────────────────
process.on("SIGINT", () => {
  logger.info("BOT", "Shutting down...")
  cancelAllSessions()
  bot.stopPolling()
  process.exit(0)
})

process.on("uncaughtException", (err) => {
  logger.error("BOT", `Uncaught exception: ${err.message}`, { stack: err.stack })
})

process.on("unhandledRejection", (reason) => {
  logger.error("BOT", `Unhandled rejection: ${reason}`)
})
