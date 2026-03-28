/**
 * Claude Session Tracker — stores real token usage, costs, and session metadata
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { runShell } from "./claude-runner.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, "../data")
const HISTORY_FILE = path.join(DATA_DIR, "session-history.json")

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const sessionHistory = []
const MAX_HISTORY = 500

class SessionTracker {
  constructor() {
    this._load()
  }

  _load() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"))
        sessionHistory.push(...(data.sessions || []))
      }
    } catch {}
  }

  _save() {
    try {
      fs.writeFileSync(
        HISTORY_FILE,
        JSON.stringify({ sessions: sessionHistory.slice(-MAX_HISTORY) }, null, 2),
      )
    } catch {}
  }

  /**
   * Record a session with real Claude metadata
   */
  record({ chatId, userId, username, project, prompt, responseLength, durationMs, status, error = null, meta = null }) {
    const entry = {
      id: sessionHistory.length + 1,
      timestamp: new Date().toISOString(),
      chatId,
      userId,
      username: username || "unknown",
      project,
      prompt: prompt.slice(0, 500),
      promptLength: prompt.length,
      responseLength: responseLength || 0,
      durationMs,
      status,
      error: error ? error.slice(0, 200) : null,
      // Real data from Claude JSON output
      sessionId: meta?.sessionId || null,
      costUsd: meta?.costUsd || 0,
      model: meta?.model || "unknown",
      numTurns: meta?.numTurns || 0,
      stopReason: meta?.stopReason || null,
      permissionDenials: meta?.permissionDenials || [],
      contextWindow: meta?.contextWindow || 0,
      maxOutputTokens: meta?.maxOutputTokens || 0,
      usage: meta?.usage || {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      totalTokens: meta?.totalTokens || 0,
      contextUsagePercent: meta?.contextUsagePercent || 0,
      durationApiMs: meta?.durationApiMs || 0,
    }
    sessionHistory.push(entry)
    this._save()
    return entry
  }

  getHistory(limit = 20) {
    return sessionHistory.slice(-limit).reverse()
  }

  getById(id) {
    return sessionHistory.find((s) => s.id === id) || null
  }

  /**
   * Get comprehensive stats
   */
  getStats() {
    if (sessionHistory.length === 0) {
      return { totalSessions: 0, empty: true }
    }

    const successful = sessionHistory.filter((s) => s.status === "success")
    const today = new Date().toISOString().split("T")[0]
    const todaySessions = sessionHistory.filter((s) => s.timestamp.startsWith(today))
    const oneHourAgo = Date.now() - 3600000
    const lastHourSessions = sessionHistory.filter((s) => new Date(s.timestamp).getTime() > oneHourAgo)

    const totalCost = sessionHistory.reduce((s, e) => s + (e.costUsd || 0), 0)
    const todayCost = todaySessions.reduce((s, e) => s + (e.costUsd || 0), 0)
    const totalInput = sessionHistory.reduce((s, e) => s + (e.usage?.inputTokens || 0), 0)
    const totalOutput = sessionHistory.reduce((s, e) => s + (e.usage?.outputTokens || 0), 0)
    const totalCacheRead = sessionHistory.reduce((s, e) => s + (e.usage?.cacheReadTokens || 0), 0)
    const totalCacheCreate = sessionHistory.reduce((s, e) => s + (e.usage?.cacheCreationTokens || 0), 0)
    const totalTokens = sessionHistory.reduce((s, e) => s + (e.totalTokens || 0), 0)
    const totalApiTime = successful.reduce((s, e) => s + (e.durationApiMs || 0), 0)
    const totalWallTime = successful.reduce((s, e) => s + (e.durationMs || 0), 0)

    // Per-project breakdown
    const projectStats = {}
    sessionHistory.forEach((s) => {
      if (!projectStats[s.project]) {
        projectStats[s.project] = { count: 0, cost: 0, tokens: 0 }
      }
      projectStats[s.project].count++
      projectStats[s.project].cost += s.costUsd || 0
      projectStats[s.project].tokens += s.totalTokens || 0
    })

    // Permission denials
    const allDenials = sessionHistory.flatMap((s) => s.permissionDenials || [])

    return {
      totalSessions: sessionHistory.length,
      successfulSessions: successful.length,
      failedSessions: sessionHistory.filter((s) => s.status === "error").length,
      cancelledSessions: sessionHistory.filter((s) => s.status === "cancelled").length,
      successRate: `${((successful.length / sessionHistory.length) * 100).toFixed(1)}%`,
      todaySessions: todaySessions.length,
      lastHourSessions: lastHourSessions.length,
      // Cost
      totalCostUsd: totalCost,
      todayCostUsd: todayCost,
      avgCostPerSession: sessionHistory.length > 0 ? totalCost / sessionHistory.length : 0,
      // Tokens
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCacheReadTokens: totalCacheRead,
      totalCacheCreateTokens: totalCacheCreate,
      totalTokens,
      avgTokensPerSession: sessionHistory.length > 0 ? Math.round(totalTokens / sessionHistory.length) : 0,
      // Time
      avgApiTimeMs: successful.length > 0 ? Math.round(totalApiTime / successful.length) : 0,
      avgWallTimeMs: successful.length > 0 ? Math.round(totalWallTime / successful.length) : 0,
      // Breakdowns
      projectStats,
      permissionDenials: allDenials.length,
      uniqueDenials: [...new Set(allDenials)],
    }
  }

  /**
   * Get detailed context analysis
   */
  getContextAnalysis(sessionId = null) {
    if (sessionId) {
      const s = this.getById(sessionId)
      if (!s) return null
      return { session: s, type: "single" }
    }

    // Overall analysis
    const sorted = [...sessionHistory]
      .filter((s) => s.totalTokens > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens)

    // Find what's eating context
    const bigPrompts = [...sessionHistory]
      .filter((s) => s.usage?.inputTokens > 0)
      .sort((a, b) => (b.usage?.inputTokens || 0) - (a.usage?.inputTokens || 0))
      .slice(0, 5)

    const bigResponses = [...sessionHistory]
      .filter((s) => s.usage?.outputTokens > 0)
      .sort((a, b) => (b.usage?.outputTokens || 0) - (a.usage?.outputTokens || 0))
      .slice(0, 5)

    const mostExpensive = [...sessionHistory]
      .filter((s) => s.costUsd > 0)
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 5)

    return {
      type: "overall",
      topByTokens: sorted.slice(0, 5),
      biggestPrompts: bigPrompts,
      biggestResponses: bigResponses,
      mostExpensive,
    }
  }

  clearHistory() {
    sessionHistory.length = 0
    this._save()
  }

  clearProject(projectName) {
    const before = sessionHistory.length
    const filtered = sessionHistory.filter((s) => s.project !== projectName)
    sessionHistory.length = 0
    sessionHistory.push(...filtered)
    this._save()
    return before - sessionHistory.length
  }
}

/**
 * Get system-wide Claude info
 */
async function getClaudeCLISessions() {
  try {
    const procs = await runShell(
      "ps aux | grep -E '[c]laude' | grep -v grep || echo 'NONE'",
      "/tmp",
    ).catch(() => "NONE")

    const homeDir = process.env.HOME || "/tmp"
    const claudeDir = path.join(homeDir, ".claude")
    let projects = []
    try {
      const projectsDir = path.join(claudeDir, "projects")
      if (fs.existsSync(projectsDir)) {
        projects = fs.readdirSync(projectsDir).filter((f) => !f.startsWith("."))
      }
    } catch {}

    return { runningProcesses: procs.trim(), projects }
  } catch (err) {
    return { error: err.message }
  }
}

export const sessionTracker = new SessionTracker()
export { getClaudeCLISessions }
export default sessionTracker
