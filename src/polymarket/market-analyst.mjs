/**
 * Market Analyst — Reads AI research from database
 *
 * Architecture:
 *   Local Mac → Claude CLI → deep analysis → pm_research (local DB + Turso cloud)
 *   Cloud Bot → reads pm_research from Turso → uses AI probability for trading
 *
 * The local research daemon does the heavy lifting (free, uses CLI OAuth).
 * This module just reads the cached results.
 *
 * Fallback: If no research cached AND ANTHROPIC_API_KEY available, calls Haiku directly.
 */
import db from "../database.mjs"

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ""
let Anthropic = null

// Ensure research table exists locally
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

const researchStmts = {
  get: db.raw.prepare(`SELECT * FROM pm_research WHERE market_id = ? AND expires_at > datetime('now')`),
  count: db.raw.prepare(`SELECT COUNT(*) as c FROM pm_research WHERE expires_at > datetime('now')`),
}

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
 * Get cached research for a market (from local DB, synced from Turso)
 */
export function getCachedResearch(marketId) {
  try {
    const row = researchStmts.get.get(marketId)
    if (!row) return null
    return {
      probability: row.ai_probability,
      confidence: row.ai_confidence,
      direction: row.ai_direction,
      reasoning: row.ai_reasoning,
      model: row.ai_model || "claude-cli",
      cached: true,
      researchedAt: row.researched_at,
    }
  } catch { return null }
}

/**
 * Get count of available research
 */
export function getResearchCount() {
  try { return researchStmts.count.get()?.c || 0 } catch { return 0 }
}

/**
 * Analyze a market — first checks research cache (from local daemon), then fallback to Haiku API
 *
 * @param {object} market - Market data from scanner
 * @param {string[]} headlines - News headlines about this topic
 * @param {object} context - Additional context (crypto data, sports scores, etc.)
 * @returns {{ probability: number, direction: string, confidence: string, reasoning: string }}
 */
export async function analyzeMarket(market, headlines = [], context = {}) {
  // FIRST: check cached research from local daemon (free, Claude CLI powered)
  const cached = getCachedResearch(market.id)
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

  // Build context string
  let contextStr = ""
  if (headlines.length > 0) {
    contextStr += "\nRecent headlines:\n" + headlines.map(h => `- ${h.title || h}`).join("\n")
  }
  if (context.crypto) {
    contextStr += `\nCrypto: ${context.crypto.coin} at $${context.crypto.price}, ${context.crypto.change24h > 0 ? "+" : ""}${context.crypto.change24h?.toFixed(1)}% 24h, Fear & Greed: ${context.crypto.fearGreed?.value} (${context.crypto.fearGreed?.label})`
  }
  if (context.sports?.events?.length > 0) {
    contextStr += "\nSports scores:\n" + context.sports.events.slice(0, 3).map(e => {
      const teams = e.competitors?.map(c => `${c.team} (${c.record || ""}) ${c.score || ""}`).join(" vs ")
      return `- ${e.shortName}: ${e.status} — ${teams}`
    }).join("\n")
  }
  if (context.priceHistory) {
    contextStr += `\nPrice trend: ${context.priceHistory.trend}, momentum ${(context.priceHistory.momentum * 100).toFixed(1)}%`
  }

  const prompt = `You are a prediction market analyst. Analyze this Polymarket question and estimate the TRUE probability.

MARKET: "${question}"
Current YES price: ${(yesPrice * 100).toFixed(1)}% (this is what the market thinks)
Current NO price: ${(noPrice * 100).toFixed(1)}%
24h Volume: $${(volume / 1000).toFixed(0)}K
${contextStr}

Based on the headlines and your knowledge, answer STRICTLY in this JSON format:
{
  "probability": <your estimate 0.01-0.99 for YES>,
  "confidence": "<low/medium/high>",
  "direction": "<YES if you think market underprices YES, NO if overprices, FAIR if correctly priced>",
  "reasoning": "<1-2 sentences explaining WHY, referencing specific headlines or facts>"
}

RULES:
- The market has thousands of traders. If you're not sure, say the market is FAIR.
- Most "Will dramatic event happen by date?" markets resolve NO. Default to skepticism.
- Don't confuse "news exists about topic" with "event is likely." War news ≠ ceasefire likely.
- Be HONEST about your confidence. "low" means you're guessing.
- Your probability should rarely deviate more than 10% from market price unless you have strong reason.`

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    })

    const text = response.content?.[0]?.text || ""
    // Extract JSON from response
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
    console.error(`[ANALYST] Claude analysis failed: ${err.message}`)
    return null
  }
}

/**
 * Check if analysis is available (cached research OR API key)
 */
export function isAvailable() {
  return getResearchCount() > 0 || !!ANTHROPIC_KEY
}

export default { analyzeMarket, isAvailable, getCachedResearch, getResearchCount }
