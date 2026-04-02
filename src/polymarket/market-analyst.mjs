/**
 * Market Analyst — Uses Claude AI to UNDERSTAND markets before betting
 *
 * The problem: keyword matching can't understand "Trump pushes war with Iran,
 * drops ceasefire odds" means ceasefire is LESS likely. Only an LLM can.
 *
 * Flow:
 *   1. Gather context (headlines, market data, price history)
 *   2. Ask Claude Haiku to analyze: what's the real probability?
 *   3. Compare Claude's estimate vs market price → find edge
 *
 * Cost: ~$0.001 per analysis (Haiku) — cheaper than one bad trade
 * Only called for markets that pass cheap checks (5-10 per cycle, not all 150)
 */

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ""
let Anthropic = null

// Lazy-load SDK only when needed
async function getClient() {
  if (!ANTHROPIC_KEY) return null
  if (!Anthropic) {
    try {
      const mod = await import("@anthropic-ai/sdk")
      Anthropic = mod.default
    } catch {
      return null
    }
  }
  return new Anthropic({ apiKey: ANTHROPIC_KEY })
}

/**
 * Ask Claude to analyze a market and estimate the real probability
 *
 * @param {object} market - Market data from scanner
 * @param {string[]} headlines - News headlines about this topic
 * @param {object} context - Additional context (crypto data, sports scores, etc.)
 * @returns {{ probability: number, direction: string, confidence: string, reasoning: string }}
 */
export async function analyzeMarket(market, headlines = [], context = {}) {
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
 * Quick check if analysis is available (has API key)
 */
export function isAvailable() {
  return !!ANTHROPIC_KEY
}

export default { analyzeMarket, isAvailable }
