/**
 * Research Daemon — Background process that uses Claude CLI for deep market analysis
 *
 * Architecture:
 *   Local Mac (this daemon) → Claude CLI (free, OAuth session) → deep analysis
 *                           → Turso Cloud DB ← Cloud bot reads for trading decisions
 *
 * Runs as a background cron on the local machine while it's up.
 * When laptop sleeps, research pauses. Cloud bot uses cached research.
 *
 * What it does:
 *   1. Fetches top markets from Polymarket
 *   2. Gathers context (headlines, crypto data, sports scores)
 *   3. Asks Claude CLI to analyze each market deeply
 *   4. Stores analysis in local DB + syncs to Turso cloud
 *   5. Cloud bot reads pm_research table for AI-powered decisions
 */
import { spawn } from "child_process"
import { createClient } from "@libsql/client"
import Database from "better-sqlite3"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_DIR = process.env.DB_DIR || path.resolve(__dirname, "../../data")
const DB_PATH = path.join(DB_DIR, "bot.db")

// ── Config ─────────────────────────────────────────────────
const RESEARCH_INTERVAL_MS = 30 * 60 * 1000 // Research cycle every 30 min
const MAX_MARKETS_PER_CYCLE = 15 // Analyze top 15 interesting markets
const RESEARCH_TTL_HOURS = 6 // Research is stale after 6 hours
const CLAUDE_TIMEOUT_MS = 60000 // 60s per market analysis

// ── DB Setup ───────────────────────────────────────────────
const db = new Database(DB_PATH)
db.pragma("journal_mode = WAL")

db.exec(`
  CREATE TABLE IF NOT EXISTS pm_research (
    market_id      TEXT PRIMARY KEY,
    market_question TEXT,
    category       TEXT,
    yes_price      REAL,
    volume_24h     REAL,
    ai_probability REAL,
    ai_confidence  TEXT,
    ai_direction   TEXT,
    ai_reasoning   TEXT,
    ai_headlines   TEXT,
    ai_model       TEXT DEFAULT 'claude-cli',
    researched_at  TEXT DEFAULT (datetime('now')),
    expires_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_research_expires ON pm_research(expires_at);
`)

const stmts = {
  upsert: db.prepare(`
    INSERT INTO pm_research (market_id, market_question, category, yes_price, volume_24h,
      ai_probability, ai_confidence, ai_direction, ai_reasoning, ai_headlines, ai_model, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claude-cli', datetime('now', '+6 hours'))
    ON CONFLICT(market_id) DO UPDATE SET
      market_question=excluded.market_question, category=excluded.category,
      yes_price=excluded.yes_price, volume_24h=excluded.volume_24h,
      ai_probability=excluded.ai_probability, ai_confidence=excluded.ai_confidence,
      ai_direction=excluded.ai_direction, ai_reasoning=excluded.ai_reasoning,
      ai_headlines=excluded.ai_headlines, researched_at=datetime('now'),
      expires_at=datetime('now', '+6 hours')
  `),
  getValid: db.prepare(`SELECT * FROM pm_research WHERE market_id = ? AND expires_at > datetime('now')`),
  getAllValid: db.prepare(`SELECT * FROM pm_research WHERE expires_at > datetime('now') ORDER BY volume_24h DESC`),
  cleanExpired: db.prepare(`DELETE FROM pm_research WHERE expires_at < datetime('now', '-1 day')`),
  count: db.prepare(`SELECT COUNT(*) as c FROM pm_research WHERE expires_at > datetime('now')`),
}

// ── Turso sync ─────────────────────────────────────────────
const TURSO_URL = process.env.TURSO_DB_URL || ""
const TURSO_TOKEN = process.env.TURSO_DB_TOKEN || ""
let turso = null

function initTurso() {
  if (!TURSO_URL || !TURSO_TOKEN) return false
  try {
    turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN })
    console.log("[RESEARCH] Turso connected")
    return true
  } catch { return false }
}

async function setupTursoTable() {
  if (!turso) return
  try {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS pm_research (
        market_id TEXT PRIMARY KEY, market_question TEXT, category TEXT,
        yes_price REAL, volume_24h REAL, ai_probability REAL, ai_confidence TEXT,
        ai_direction TEXT, ai_reasoning TEXT, ai_headlines TEXT, ai_model TEXT,
        researched_at TEXT, expires_at TEXT
      )
    `)
  } catch {}
}

async function syncToTurso() {
  if (!turso) return 0
  const rows = stmts.getAllValid.all()
  let synced = 0
  for (const r of rows) {
    try {
      await turso.execute({
        sql: `INSERT OR REPLACE INTO pm_research (market_id, market_question, category, yes_price, volume_24h,
          ai_probability, ai_confidence, ai_direction, ai_reasoning, ai_headlines, ai_model, researched_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [r.market_id, r.market_question, r.category, r.yes_price, r.volume_24h,
          r.ai_probability, r.ai_confidence, r.ai_direction, r.ai_reasoning, r.ai_headlines,
          r.ai_model, r.researched_at, r.expires_at],
      })
      synced++
    } catch {}
  }
  if (synced > 0) console.log(`[RESEARCH] Synced ${synced} analyses to Turso`)
  return synced
}

// ── Claude CLI runner ──────────────────────────────────────

function askClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", "--output-format", "json", prompt], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CLAUDE_TIMEOUT_MS,
    })

    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", d => stdout += d.toString())
    proc.stderr.on("data", d => stderr += d.toString())

    proc.on("close", code => {
      if (code !== 0 && !stdout) {
        return reject(new Error(`Claude CLI exit ${code}: ${stderr.slice(0, 200)}`))
      }
      try {
        const parsed = JSON.parse(stdout)
        resolve(parsed.result || stdout)
      } catch {
        resolve(stdout.trim())
      }
    })
    proc.on("error", reject)
  })
}

// ── Market analysis ────────────────────────────────────────

async function analyzeMarket(market, headlines) {
  const question = market.question || ""
  const yesPrice = market.outcomes?.[0]?.price || 0.5

  const headlineText = headlines.length > 0
    ? "\n\nRecent headlines:\n" + headlines.map(h => `- ${h}`).join("\n")
    : "\n\n(No recent headlines found)"

  const prompt = `You are an expert prediction market analyst. Analyze this Polymarket question and give your probability estimate.

MARKET: "${question}"
Current market price (YES): ${(yesPrice * 100).toFixed(1)}%
24h Volume: $${((market.volume24hr || 0) / 1000).toFixed(0)}K
${headlineText}

Respond ONLY with this JSON (no other text):
{"probability": 0.XX, "confidence": "low/medium/high", "direction": "YES/NO/FAIR", "reasoning": "1-2 sentences"}

RULES:
- probability: your honest estimate (0.01-0.99) for YES outcome
- The market price reflects thousands of traders. You need STRONG reason to deviate >10%.
- Most "Will dramatic event happen by date?" → NO. Status quo usually wins.
- "War news" about a "ceasefire?" market = ceasefire LESS likely, not more.
- direction: YES = you think market underprices YES. NO = overprices. FAIR = correct.
- If uncertain, say FAIR with market price as probability.`

  try {
    const response = await askClaude(prompt)
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const analysis = JSON.parse(jsonMatch[0])
    return {
      probability: Math.max(0.01, Math.min(0.99, parseFloat(analysis.probability) || yesPrice)),
      confidence: analysis.confidence || "low",
      direction: analysis.direction || "FAIR",
      reasoning: (analysis.reasoning || "").slice(0, 500),
    }
  } catch (err) {
    console.error(`[RESEARCH] Analysis failed for "${question.slice(0, 40)}": ${err.message}`)
    return null
  }
}

// ── Main research cycle ────────────────────────────────────

async function runResearchCycle() {
  console.log("[RESEARCH] Starting research cycle...")

  // Import scanner dynamically (it uses api-client which needs warmup)
  let scanner, newsAnalyzer, brain
  try {
    const apiClient = await import("./api-client.mjs")
    await apiClient.warmup()
    scanner = (await import("./market-scanner.mjs")).default
    newsAnalyzer = (await import("./news-analyzer.mjs")).default
    brain = (await import("./smart-brain.mjs")).default
  } catch (err) {
    console.error("[RESEARCH] Failed to load modules:", err.message)
    return
  }

  // Fetch markets
  let markets
  try {
    markets = await scanner.getTopMarkets(100)
  } catch (err) {
    console.error("[RESEARCH] Failed to fetch markets:", err.message)
    return
  }

  // Filter to interesting markets (not already resolved, good volume, interesting odds)
  const interesting = markets.filter(m => {
    const p = m.outcomes?.[0]?.price || 0
    if (p <= 0.02 || p >= 0.98) return false // Already resolved
    if (m.volume24hr < 5000) return false // Too illiquid
    // Check if we already have fresh research
    const existing = stmts.getValid.get(m.id)
    if (existing) return false // Already researched and not expired
    return true
  }).sort((a, b) => b.volume24hr - a.volume24hr).slice(0, MAX_MARKETS_PER_CYCLE)

  console.log(`[RESEARCH] ${interesting.length} markets to analyze (${markets.length} total, ${stmts.count.get().c} cached)`)

  let analyzed = 0
  for (const market of interesting) {
    const category = brain.detectCategory(market.question)

    // Get headlines
    let headlines = []
    try {
      const news = await newsAnalyzer.searchNews(market.question.slice(0, 40), 5)
      headlines = news.map(h => h.title).filter(Boolean)
    } catch {}

    // Ask Claude CLI
    const analysis = await analyzeMarket(market, headlines)
    if (!analysis) continue

    // Store in local DB
    stmts.upsert.run(
      market.id, market.question?.slice(0, 200), category,
      market.outcomes?.[0]?.price || 0, market.volume24hr || 0,
      analysis.probability, analysis.confidence, analysis.direction,
      analysis.reasoning, JSON.stringify(headlines.slice(0, 5)),
    )

    analyzed++
    const emoji = analysis.direction === "YES" ? "📈" : analysis.direction === "NO" ? "📉" : "➡️"
    console.log(`[RESEARCH] ${emoji} ${market.question?.slice(0, 50)} | mkt:${(market.outcomes[0].price * 100).toFixed(0)}% ai:${(analysis.probability * 100).toFixed(0)}% (${analysis.confidence}) | ${analysis.reasoning?.slice(0, 60)}`)

    // Small delay between Claude calls
    await new Promise(r => setTimeout(r, 2000))
  }

  // Sync to Turso
  await syncToTurso()

  // Cleanup old research
  stmts.cleanExpired.run()

  const total = stmts.count.get().c
  console.log(`[RESEARCH] Cycle done: ${analyzed} new analyses, ${total} total cached`)
}

// ── Entry point ────────────────────────────────────────────

async function main() {
  console.log("[RESEARCH] Research daemon starting...")
  console.log("[RESEARCH] Interval: every " + (RESEARCH_INTERVAL_MS / 60000) + " min")
  console.log("[RESEARCH] Max markets per cycle: " + MAX_MARKETS_PER_CYCLE)

  // Load env
  try {
    const fs = await import("fs")
    const envPath = path.resolve(__dirname, "../../.env")
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, "utf-8").split("\n")
      for (const line of lines) {
        if (line.startsWith("#") || !line.includes("=")) continue
        const [key, ...val] = line.split("=")
        if (!process.env[key.trim()]) process.env[key.trim()] = val.join("=").trim()
      }
    }
  } catch {}

  initTurso()
  await setupTursoTable()

  // First run immediately
  await runResearchCycle()

  // Then every 30 min
  setInterval(() => runResearchCycle().catch(console.error), RESEARCH_INTERVAL_MS)
}

// Allow both direct execution and import
export { stmts, syncToTurso }
export default { stmts, syncToTurso }

// Run if executed directly
if (process.argv[1]?.includes("research-daemon")) {
  main().catch(console.error)
}
