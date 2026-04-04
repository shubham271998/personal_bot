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
const RESEARCH_INTERVAL_MS = 2 * 60 * 1000 // Run every 2 min — continuous pipeline
const MAX_MARKETS_PER_CYCLE = 5 // 5 markets per cycle (small batches, frequent runs)
const RESEARCH_TTL_HOURS = 8 // 8 hour TTL — maximize coverage
const CLAUDE_TIMEOUT_MS = 90000 // 90s for deep research

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
let turso = null

function initTurso() {
  // Read env at call time (after .env is loaded by main())
  const url = process.env.TURSO_DB_URL || ""
  const token = process.env.TURSO_DB_TOKEN || ""
  if (!url || !token) {
    console.log("[RESEARCH] No Turso credentials — research stays local only")
    return false
  }
  try {
    turso = createClient({ url, authToken: token })
    console.log("[RESEARCH] Turso connected — research will sync to cloud")
    return true
  } catch (err) {
    console.error("[RESEARCH] Turso failed:", err.message)
    return false
  }
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
  if (!turso) { console.log("[RESEARCH] Turso not connected — skipping sync"); return 0 }
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

/**
 * Quick analysis — single prompt, no tools, ~10-15 seconds
 * Good for: sports, simple yes/no, markets with clear context
 */
function askClaudeQuick(prompt) {
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

/**
 * DEEP research — full tools enabled (WebSearch, WebFetch), multi-step
 * Claude searches the web, reads articles, follows leads, synthesizes
 * Takes 30-90 seconds but produces expert-level analysis
 * Good for: geopolitical, politics, economics, crypto — high-value non-sports markets
 */
function askClaudeDeep(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format", "json",
      prompt,
    ], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000, // 2 min for deep research
    })

    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", d => stdout += d.toString())
    proc.stderr.on("data", d => stderr += d.toString())

    proc.on("close", code => {
      if (code !== 0 && !stdout) {
        return reject(new Error(`Claude deep exit ${code}: ${stderr.slice(0, 200)}`))
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

/**
 * Decide research depth
 * DEEP: everything except pure sports matchups (deep research = web search = real intel)
 * QUICK: only for live sports game outcomes (X vs Y, O/U, spreads)
 */
function shouldDoDeepResearch(market, category) {
  const q = (market.question || "").toLowerCase()
  // ONLY quick for live game outcomes — these can't be predicted by research
  const isLiveGame = /\bvs\.?\b.*\d{4}|o\/u \d|spread:.*[+-]\d|handicap:.*[+-]/i.test(q)
  const isEsportsGame = /counter-strike:|lol:|dota|valorant.*vs/i.test(q)
  if (isLiveGame || isEsportsGame) return false
  // Everything else gets deep research — web search finds real intel
  return true
}

async function analyzeMarket(market, headlines, redditPosts = [], expertSummary = "") {
  const question = market.question || ""
  const yesPrice = market.outcomes?.[0]?.price || 0.5
  const brain = await import("./smart-brain.mjs")
  const category = (brain.default?.detectCategory || brain.detectCategory)(question)
  const useDeep = shouldDoDeepResearch(market, category)

  if (useDeep) {
    return analyzeDeep(market, question, yesPrice)
  } else {
    return analyzeQuick(market, question, yesPrice, headlines, redditPosts, expertSummary)
  }
}

/**
 * DEEP RESEARCH — Claude searches the web, reads articles, thinks deeply
 * 30-90 seconds, uses WebSearch + WebFetch tools
 */
async function analyzeDeep(market, question, yesPrice) {
  const prompt = `You are a superforecaster and prediction market expert. Do DEEP research on this market.

MARKET: "${question}"
Current Polymarket price (YES): ${(yesPrice * 100).toFixed(1)}%
24h Volume: $${((market.volume24hr || 0) / 1000).toFixed(0)}K

RESEARCH STEPS:
1. Search the web for the LATEST news about this topic (use specific search queries)
2. Read at least 2-3 news articles to understand the current situation
3. Check what experts and analysts are saying
4. Consider the base rate — how often do events like this actually happen?
5. Compare what you found vs the market price — is there a real edge?

After your research, respond with ONLY this JSON block:
\`\`\`json
{"probability": 0.XX, "confidence": "low/medium/high", "direction": "YES/NO/FAIR", "reasoning": "3-4 sentences citing SPECIFIC facts, dates, and sources you found", "sources": ["source1", "source2"]}
\`\`\`

RULES:
- Search for RECENT news (April 2026). Your knowledge may be outdated.
- The market has thousands of traders. You need SPECIFIC NEW INFORMATION to disagree.
- "Will X happen by date?" — status quo wins 80%+ of the time. Be skeptical.
- War news on ceasefire market = ceasefire LESS likely, not more.
- If your research doesn't find a clear edge, say FAIR.
- Be SPECIFIC: cite article titles, dates, named officials, specific facts.`

  try {
    console.log(`[RESEARCH] 🔬 Deep research: "${question.slice(0, 40)}"...`)
    const response = await askClaudeDeep(prompt)
    const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) || response.match(/\{[\s\S]*"probability"[\s\S]*\}/)
    if (!jsonMatch) {
      // Try to extract from full response
      const lastJson = response.match(/\{[^{}]*"probability"[^{}]*\}/g)
      if (!lastJson) return null
      const analysis = JSON.parse(lastJson[lastJson.length - 1])
      return formatAnalysis(analysis, yesPrice, "deep")
    }
    const jsonStr = jsonMatch[1] || jsonMatch[0]
    const analysis = JSON.parse(jsonStr)
    return formatAnalysis(analysis, yesPrice, "deep")
  } catch (err) {
    console.error(`[RESEARCH] Deep failed for "${question.slice(0, 40)}": ${err.message}`)
    // Fallback to quick
    return analyzeQuick(market, question, yesPrice, [], [], "")
  }
}

/**
 * QUICK ANALYSIS — single prompt with provided context, ~10 seconds
 */
async function analyzeQuick(market, question, yesPrice, headlines = [], redditPosts = [], expertSummary = "") {
  const headlineText = headlines.length > 0
    ? "\n\nRecent headlines:\n" + headlines.map(h => `- ${h}`).join("\n")
    : ""
  const redditText = redditPosts.length > 0
    ? "\n\nReddit:\n" + redditPosts.map(p => `- r/${p.subreddit}: "${p.title}" (${p.score}pts)`).join("\n")
    : ""
  const expertText = expertSummary ? `\n${expertSummary}` : ""

  const prompt = `Prediction market analyst. Quick analysis:

MARKET: "${question}"
YES price: ${(yesPrice * 100).toFixed(1)}% | Vol: $${((market.volume24hr || 0) / 1000).toFixed(0)}K
${headlineText}${redditText}${expertText}

JSON only: {"probability": 0.XX, "confidence": "low/medium/high", "direction": "YES/NO/FAIR", "reasoning": "1-2 sentences"}
Rules: rarely deviate >10% from market. Status quo wins. If unsure = FAIR.`

  try {
    const response = await askClaudeQuick(prompt)
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const analysis = JSON.parse(jsonMatch[0])
    return formatAnalysis(analysis, yesPrice, "quick")
  } catch (err) {
    console.error(`[RESEARCH] Quick failed for "${question.slice(0, 40)}": ${err.message}`)
    return null
  }
}

function formatAnalysis(analysis, yesPrice, mode) {
  return {
    probability: Math.max(0.01, Math.min(0.99, parseFloat(analysis.probability) || yesPrice)),
    confidence: analysis.confidence || "low",
    direction: analysis.direction || "FAIR",
    reasoning: (analysis.reasoning || "").slice(0, 800), // More room for deep research
    sources: analysis.sources || [],
    mode, // "deep" or "quick"
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
    markets = await scanner.getTopMarkets(200) // Scan more markets — research ALL of them over time
  } catch (err) {
    console.error("[RESEARCH] Failed to fetch markets:", err.message)
    return
  }

  // Filter and prioritize: unresearched first, then expiring soon, then highest volume
  const interesting = markets.filter(m => {
    const p = m.outcomes?.[0]?.price || 0
    if (p <= 0.02 || p >= 0.98) return false // Already resolved
    if (m.volume24hr < 2000) return false // Too illiquid (lowered from 5K to cover more)
    const existing = stmts.getValid.get(m.id)
    if (existing) return false
    return true
  }).sort((a, b) => {
    // Priority: higher volume first
    return b.volume24hr - a.volume24hr
  }).slice(0, MAX_MARKETS_PER_CYCLE)

  console.log(`[RESEARCH] ${interesting.length} markets to analyze (${markets.length} total, ${stmts.count.get().c} cached)`)

  let analyzed = 0
  for (const market of interesting) {
    const category = brain.detectCategory(market.question)

    // For DEEP research: Claude does its own web search — just pass basic context
    // For QUICK: gather headlines + Reddit as input
    const brain2 = await import("./smart-brain.mjs")
    const cat = (brain2.default?.detectCategory || brain2.detectCategory)(market.question)
    const isDeep = shouldDoDeepResearch(market, cat)

    let headlines = []
    let redditPosts = []
    if (!isDeep) {
      // Quick analysis needs pre-gathered context
      try {
        const news = await newsAnalyzer.searchNews(market.question.slice(0, 40), 5)
        headlines = news.map(h => h.title).filter(Boolean)
      } catch {}
      try {
        const researcherMod = await import("./web-researcher.mjs")
        redditPosts = await researcherMod.searchReddit(market.question.slice(0, 40), 3)
      } catch {}
    }
    // Deep research: Claude CLI searches the web itself — no need for pre-gathered headlines

    const analysis = await analyzeMarket(market, headlines, redditPosts, "")
    if (!analysis) continue

    // Store in local DB
    stmts.upsert.run(
      market.id, market.question?.slice(0, 200), category,
      market.outcomes?.[0]?.price || 0, market.volume24hr || 0,
      analysis.probability, analysis.confidence, analysis.direction,
      analysis.reasoning, JSON.stringify((analysis.sources || headlines.map(h=>h.title || h)).slice(0, 5)),
    )

    analyzed++
    const emoji = analysis.direction === "YES" ? "📈" : analysis.direction === "NO" ? "📉" : "➡️"
    const mode = analysis.mode === "deep" ? "🔬" : "⚡"
    console.log(`[RESEARCH] ${mode}${emoji} ${market.question?.slice(0, 45)} | mkt:${(market.outcomes[0].price * 100).toFixed(0)}% ai:${(analysis.probability * 100).toFixed(0)}% (${analysis.confidence}) ${analysis.direction} | ${analysis.reasoning?.slice(0, 60)}`)

    // Delay: 3s after deep research, 1s after quick
    await new Promise(r => setTimeout(r, analysis.mode === "deep" ? 3000 : 1000))
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
