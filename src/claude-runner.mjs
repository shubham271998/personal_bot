/**
 * Claude CLI Runner with streaming status updates
 *
 * Uses --output-format stream-json to show real-time progress:
 * - Tool calls (Read, Edit, Bash, Grep, Agent, etc.)
 * - Subagent spawns
 * - Thinking/working status
 * - Final result replaces all temp messages
 */
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import logger from "./logger.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SYSTEM_SCRIPT = path.join(__dirname, "..", "scripts", "pocket-system.sh")

const SYSTEM_PROMPT_ADDON = `
You have full system-level access via a helper script. For ANY system operation (sleep, shutdown, restart, volume, brightness, apps, wifi, bluetooth, etc.), use this command:

bash ${SYSTEM_SCRIPT} <command> [args]

Available commands: sleep, shutdown, restart, lock, screen-off, brightness <0-100>, volume <0-100>, mute, unmute, volume-get, open-app <name>, quit-app <name>, force-quit-app <name>, running-apps, battery, uptime, disk, memory, wifi, wifi-on, wifi-off, bluetooth-on, bluetooth-off, dnd-on, dnd-off, clipboard-get, clipboard-set <text>, notify <title> <msg>, say <text>, screenshot [path], caffeinate [secs], decaffeinate, empty-trash, eject-all, dark-mode-on, dark-mode-off, dark-mode-toggle, kill <name|pid>, open-url <url>, open-chrome [url], open-safari [url], google <query>, youtube [query], youtube-play <song>, spotify-play [song], spotify-pause, spotify-next, spotify-prev, spotify-now, spotify-volume [0-100], music-play [song], music-pause, music-next, media-play-pause, media-next, media-prev

RULES:
- ALWAYS use the helper script. NEVER use sudo, pmset, or shutdown directly.
- The script handles all permissions automatically — no sudo needed.
- For unknown system tasks, run: bash ${SYSTEM_SCRIPT} help
- Execute system commands immediately without asking for confirmation — the user trusts this bot.
- For music: use ONE command only. "spotify-play <song>" or "youtube-play <song>" — do NOT open multiple tabs or run multiple commands. One command does everything.
- For "play song X" → use: bash ${SYSTEM_SCRIPT} spotify-play X
- For "play X on YouTube" → use: bash ${SYSTEM_SCRIPT} youtube-play X
- NEVER use "open" or "open-url" for music. Use spotify-play or youtube-play instead.
`.trim()

// ── Cool loading messages ───────────────────────────────────
const THINKING_MESSAGES = [
  "🧠 Thinking deeply...",
  "⚡ On it...",
  "🔮 Working my magic...",
  "🛠️ Let me figure this out...",
  "💭 Processing your request...",
  "🚀 Getting things done...",
  "🎯 Diving into it...",
  "⚙️ Spinning up the gears...",
]

const TOOL_ICONS = {
  Read: "📖",
  Edit: "✏️",
  Write: "📝",
  Bash: "💻",
  Grep: "🔍",
  Glob: "📂",
  Agent: "🤖",
  WebSearch: "🌐",
  WebFetch: "🌐",
  TodoWrite: "📋",
  Skill: "⚡",
  NotebookEdit: "📓",
}

function getToolIcon(name) {
  if (name.startsWith("mcp__")) return "🔌"
  return TOOL_ICONS[name] || "🔧"
}

function randomThinking() {
  return THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)]
}

function formatToolUse(name, input) {
  const icon = getToolIcon(name)

  if (name === "Read") return `${icon} Reading \`${shortenPath(input.file_path)}\``
  if (name === "Edit") return `${icon} Editing \`${shortenPath(input.file_path)}\``
  if (name === "Write") return `${icon} Writing \`${shortenPath(input.file_path)}\``
  if (name === "Bash") return `${icon} Running: \`${(input.command || "").slice(0, 60)}\``
  if (name === "Grep") return `${icon} Searching for \`${(input.pattern || "").slice(0, 40)}\``
  if (name === "Glob") return `${icon} Finding files: \`${(input.pattern || "").slice(0, 40)}\``
  if (name === "Agent") return `${icon} Spawning subagent: ${(input.description || input.prompt || "").slice(0, 50)}`
  if (name === "WebSearch") return `${icon} Searching web: ${(input.query || "").slice(0, 50)}`
  if (name === "WebFetch") return `${icon} Fetching URL`
  if (name === "Skill") return `${icon} Running skill: ${input.skill || ""}`
  if (name.startsWith("mcp__")) return `${icon} MCP: ${name.replace("mcp__", "").slice(0, 40)}`

  return `${icon} ${name}`
}

function shortenPath(p) {
  if (!p) return "?"
  const parts = p.split("/")
  if (parts.length > 3) return `.../${parts.slice(-2).join("/")}`
  return p
}

// ── Session tracking ────────────────────────────────────────
const activeSessions = new Map()
const chatSessionIds = new Map()

export function isRunning(chatId) {
  return activeSessions.has(chatId)
}

export function getSession(chatId) {
  return activeSessions.get(chatId)
}

export function getConversationInfo(chatId) {
  return chatSessionIds.get(chatId) || null
}

export function cancelSession(chatId) {
  const session = activeSessions.get(chatId)
  if (session) {
    session.proc.kill("SIGTERM")
    activeSessions.delete(chatId)
    logger.info("CLAUDE", `Cancelled session for chat ${chatId}`)
    return true
  }
  return false
}

export function cancelAllSessions() {
  for (const [chatId, session] of activeSessions) {
    session.proc.kill("SIGTERM")
    logger.info("CLAUDE", `Force-killed session for chat ${chatId}`)
  }
  activeSessions.clear()
}

export function resetConversation(chatId) {
  chatSessionIds.delete(chatId)
}

// ── Main runner ─────────────────────────────────────────────

/**
 * Run claude CLI with streaming output and live Telegram updates
 */
export function runClaude({
  chatId,
  prompt,
  projectDir,
  projectName = "default",
  onTyping,
  onStatusUpdate,
  extraFlags = [],
  newConversation = false,
  apiKey = null,
}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()

    const CLAUDE_TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT_MS) || 300000
    const skipPerms = process.env.CLAUDE_SKIP_PERMISSIONS !== "false"

    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      ...(skipPerms ? ["--dangerously-skip-permissions"] : []),
      "--append-system-prompt", SYSTEM_PROMPT_ADDON,
    ]

    const prevSession = chatSessionIds.get(chatId)
    if (!newConversation && prevSession && prevSession.projectDir === projectDir) {
      args.push("--resume", prevSession.sessionId)
    }

    args.push(...extraFlags)
    args.push(prompt)

    const isResuming = args.includes("--resume")
    logger.info("CLAUDE", `Running in ${projectName}: ${prompt.slice(0, 100)}...`, {
      resuming: isResuming,
    })

    // Use per-user API key if provided, otherwise fall back to system key
    const procEnv = { ...process.env }
    if (apiKey) {
      procEnv.ANTHROPIC_API_KEY = apiKey
    }

    const proc = spawn("claude", args, {
      cwd: projectDir,
      env: procEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

    activeSessions.set(chatId, {
      proc,
      projectName,
      startedAt,
      prompt: prompt.slice(0, 200),
    })

    // Kill if running too long
    const timeoutHandle = setTimeout(() => {
      logger.warn("CLAUDE", `Session timed out after ${CLAUDE_TIMEOUT / 1000}s — killing`)
      proc.kill("SIGTERM")
    }, CLAUDE_TIMEOUT)

    let buffer = ""
    let stderr = ""
    let finalResult = ""
    let finalMeta = null
    const toolLog = []
    let turnCount = 0

    // ── Parse streaming events ──────────────────────────────
    proc.stdout.on("data", (data) => {
      buffer += data.toString()

      // Process complete JSON lines
      const lines = buffer.split("\n")
      buffer = lines.pop() || "" // Keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          handleStreamEvent(event)
        } catch {
          // Not valid JSON, skip
        }
      }
    })

    function handleStreamEvent(event) {
      const { type, subtype } = event

      if (type === "system" && subtype === "init") {
        // Session started
        if (onStatusUpdate) {
          onStatusUpdate({
            type: "thinking",
            text: randomThinking(),
            project: projectName,
            prompt: prompt.slice(0, 80),
          })
        }
        return
      }

      if (type === "assistant") {
        const msg = event.message || {}
        const content = msg.content || []

        for (const block of content) {
          if (block.type === "tool_use") {
            turnCount++
            const desc = formatToolUse(block.name, block.input || {})
            toolLog.push(desc)

            if (onStatusUpdate) {
              onStatusUpdate({
                type: "tool",
                text: desc,
                tools: toolLog.slice(-6), // Show last 6 tools
                elapsed: Math.round((Date.now() - startedAt) / 1000),
                turns: turnCount,
              })
            }
          }

          if (block.type === "text" && block.text) {
            // Intermediate text (not final)
            if (onStatusUpdate) {
              onStatusUpdate({
                type: "progress",
                text: `💬 Composing response...`,
                tools: toolLog.slice(-6),
                elapsed: Math.round((Date.now() - startedAt) / 1000),
                turns: turnCount,
              })
            }
          }
        }
        return
      }

      if (type === "result") {
        finalResult = event.result || ""

        finalMeta = {
          sessionId: event.session_id,
          durationMs: event.duration_ms,
          durationApiMs: event.duration_api_ms,
          numTurns: event.num_turns,
          costUsd: event.total_cost_usd,
          stopReason: event.stop_reason,
          permissionDenials: event.permission_denials || [],
          usage: {
            inputTokens: event.usage?.input_tokens || 0,
            outputTokens: event.usage?.output_tokens || 0,
            cacheReadTokens: event.usage?.cache_read_input_tokens || 0,
            cacheCreationTokens: event.usage?.cache_creation_input_tokens || 0,
          },
          model: Object.keys(event.modelUsage || {})[0] || "unknown",
          contextWindow: Object.values(event.modelUsage || {})[0]?.contextWindow || 0,
          maxOutputTokens: Object.values(event.modelUsage || {})[0]?.maxOutputTokens || 0,
          toolLog,
        }

        finalMeta.totalTokens =
          finalMeta.usage.inputTokens +
          finalMeta.usage.outputTokens +
          finalMeta.usage.cacheReadTokens +
          finalMeta.usage.cacheCreationTokens

        finalMeta.contextUsagePercent = finalMeta.contextWindow > 0
          ? ((finalMeta.totalTokens / finalMeta.contextWindow) * 100).toFixed(2)
          : 0

        // Save session ID
        if (event.session_id) {
          chatSessionIds.set(chatId, {
            sessionId: event.session_id,
            projectDir,
          })
        }
        return
      }
    }

    proc.stderr.on("data", (data) => {
      stderr += data.toString()
    })

    const typingInterval = setInterval(() => {
      if (onTyping) onTyping()
    }, 4000)

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle)
      clearInterval(typingInterval)
      activeSessions.delete(chatId)

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          handleStreamEvent(JSON.parse(buffer))
        } catch {}
      }

      if (code === null) {
        resolve({ result: null, meta: null })
        return
      }

      if (code !== 0 && !finalResult) {
        // Strip any API keys or secrets from error output
        const safeStderr = stderr.replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]")
          .replace(/ANTHROPIC_API_KEY=[^\s]+/g, "[REDACTED]")
          .slice(0, 500)
        reject(new Error(`Claude exited with code ${code}\n${safeStderr}`))
        return
      }

      logger.info("CLAUDE", `Done (${((finalMeta?.durationMs || 0) / 1000).toFixed(1)}s, $${finalMeta?.costUsd?.toFixed(4)}, ${finalMeta?.totalTokens || 0} tokens)`, {
        projectName,
      })

      resolve({
        result: finalResult,
        meta: finalMeta,
      })
    })

    proc.on("error", (err) => {
      clearInterval(typingInterval)
      activeSessions.delete(chatId)
      logger.error("CLAUDE", `Process error: ${err.message}`)
      reject(err)
    })
  })
}

/**
 * Run a raw shell command in a project directory
 */
export function runShell(command, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", command], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    })

    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", (d) => (stdout += d.toString()))
    proc.stderr.on("data", (d) => (stderr += d.toString()))

    proc.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`Exit ${code}: ${stderr}`))
    })

    proc.on("error", reject)
  })
}
