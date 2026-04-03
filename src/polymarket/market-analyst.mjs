/**
 * Market Analyst — Reads AI research for trading decisions
 *
 * Architecture:
 *   Local Mac → Claude CLI → deep analysis → Turso cloud DB
 *   Cloud Bot → reads pm_research from Turso DIRECTLY → uses AI probability
 *
 * Two modes:
 *   - Cloud (Railway): reads Turso directly for freshest research
 *   - Local: reads local SQLite (research daemon writes here)
 *
 * Fallback: If no research AND ANTHROPIC_API_KEY available, calls Haiku API.
 */
import db from "../database.mjs"
import { createClient } from "@libsql/client"

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ""
const TURSO_URL = process.env.TURSO_DB_URL || ""
const TURSO_TOKEN = process.env.TURSO_DB_TOKEN || ""
const IS_CLOUD = process.platform !== "darwin" // Railway = Linux, Local = macOS

let Anthropic = null
let tursoClient = null

// Connect to Turso for direct reads (cloud bot)
if (IS_CLOUD && TURSO_URL && TURSO_TOKEN) {
  try {
    tursoClient = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN })
    console.log("[ANALYST] Direct Turso connection for research reads")
  } catch (err) {
    console.error("[ANALYST] Turso connect failed:", err.message)
  }
}

// Ensure local research table exists
try {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS pm_research (
      market_id TEXT PRIMARY KEY, market_question TEXT, category TEXT,
      yes_price REAL, volume_24h REAL, ai_probability REAL, ai_confidence TEXT,
      ai_direction TEXT, ai_reasoning TEXT, ai_headlines TEXT, ai_model TEXT,
      researched_at TEXT, expires_at TEXT
    )
  `)
} catch {}

const localStmts = {
  get: db.raw.prepare(`SELECT * FROM pm_research WHERE market_id = ? AND expires_at > datetime('now')`),
  count: db.raw.prepare(`SELECT COUNT(*) as c FROM pm_research WHERE expires_at > datetime('now')`),
}

// ── Research lookup ────────────────────────────────────────

/**
 * Get cached research for a market
 * Cloud: reads Turso directly (freshest data from local daemon)
 * Local: reads local SQLite
 */
export async function getCachedResearch(marketId) {
  // Cloud bot: read from Turso directly (always fresh)
  if (tursoClient) {
    try {
      const result = await tursoClient.execute({
        sql: "SELECT * FROM pm_research WHERE market_id = ? AND expires_at > datetime('now')",
        args: [marketId],
      })
      const row = result.rows?.[0]
      if (row) {
        return {
          probability: Number(row.ai_probability),
          confidence: row.ai_confidence,
          direction: row.ai_direction,
          reasoning: row.ai_reasoning,
          model: row.ai_model || "claude-cli",
          cached: true,
          researchedAt: row.researched_at,
          source: "turso-direct",
        }
      }
    } catch (err) {
      console.error("[ANALYST] Turso read failed:", err.message)
    }
  }

  // Local fallback: read from local SQLite
  try {
    const row = localStmts.get.get(marketId)
    if (!row) return null
    return {
      probability: row.ai_probability,
      confidence: row.ai_confidence,
      direction: row.ai_direction,
      reasoning: row.ai_reasoning,
      model: row.ai_model || "claude-cli",
      cached: true,
      researchedAt: row.researched_at,
      source: "local-db",
    }
  } catch {
    return null
  }
}

/**
 * Get count of available research
 */
export async function getResearchCount() {
  if (tursoClient) {
    try {
      const result = await tursoClient.execute("SELECT COUNT(*) as c FROM pm_research WHERE expires_at > datetime('now')")
      return Number(result.rows?.[0]?.c) || 0
    } catch {}
  }
  try { return localStmts.count.get()?.c || 0 } catch { return 0 }
}

// ── Haiku API fallback ─────────────────────────────────────

async function getClient() {
  if (!ANTHROPIC_KEY) return null
  if (!Anthropic) {
    try {
      const mod = await import("@anthropic-ai/sdk")
      Anthropic = mod.default
    } catch { return null }
  }
  return new Anthropic({ apiKey: ANTHROPIC_KEY })
}

/**
 * Analyze a market — checks Turso research first, then local cache, then Haiku API
 */
export async function analyzeMarket(market, headlines = [], context = {}) {
  // FIRST: check research (Turso direct for cloud, local SQLite for local)
  const cached = await getCachedResearch(market.id)
  if (cached) {
    return cached
  }

  // FALLBACK: call Haiku API directly (costs ~$0.001)
  const client = await getClient()
  if (!client) return null

  const question = market.question || ""
  const yesPrice = market.outcomes?.[0]?.price || 0.5
  const noPrice = market.outcomes?.[1]?.price || 0.5
  const volume = market.volume24hr || 0

  let contextStr = ""
  if (headlines.length > 0) {
    contextStr += "\nRecent headlines:\n" + headlines.map(h => `- ${h.title || h}`).join("\n")
  }
  if (context.crypto) {
    contextStr += `\nCrypto: ${context.crypto.coin} at $${context.crypto.price}, ${context.crypto.change24h > 0 ? "+" : ""}${context.crypto.change24h?.toFixed(1)}% 24h`
  }

  const prompt = `You are a prediction market analyst. Analyze this Polymarket question and estimate the TRUE probability.

MARKET: "${question}"
Current YES price: ${(yesPrice * 100).toFixed(1)}%
Current NO price: ${(noPrice * 100).toFixed(1)}%
24h Volume: $${(volume / 1000).toFixed(0)}K
${contextStr}

Respond STRICTLY in JSON: {"probability": 0.XX, "confidence": "low/medium/high", "direction": "YES/NO/FAIR", "reasoning": "1-2 sentences"}

RULES:
- The market has thousands of traders. Rarely deviate >10% from market price.
- Most "Will dramatic event happen by date?" → NO. Status quo wins.
- War news on ceasefire market = ceasefire LESS likely.
- If uncertain, say FAIR with market price as probability.`

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    })

    const text = response.content?.[0]?.text || ""
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const analysis = JSON.parse(jsonMatch[0])
    return {
      probability: Math.max(0.01, Math.min(0.99, parseFloat(analysis.probability) || yesPrice)),
      confidence: analysis.confidence || "low",
      direction: analysis.direction || "FAIR",
      reasoning: analysis.reasoning || "",
      model: "haiku",
      cost: (response.usage?.input_tokens || 0) * 0.00000025 + (response.usage?.output_tokens || 0) * 0.00000125,
    }
  } catch (err) {
    console.error(`[ANALYST] Haiku failed: ${err.message}`)
    return null
  }
}

/**
 * Check if analysis is available
 */
export async function isAvailable() {
  const count = await getResearchCount()
  return count > 0 || !!ANTHROPIC_KEY
}

export default { analyzeMarket, isAvailable, getCachedResearch, getResearchCount }
