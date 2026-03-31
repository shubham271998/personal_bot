/**
 * News Analyzer for Polymarket Edge Detection
 *
 * Fetches real-time news and compares sentiment with market odds
 * to find mispricings before the market catches up.
 *
 * Improvements over v1:
 *   - Negation detection ("not likely" = bearish, not bullish)
 *   - Strength scoring (strong consensus vs mixed signals)
 *   - Recency weighting (newer headlines matter more)
 *   - Google News fallback headers
 */
import axios from "axios"

/**
 * Search news for a topic and extract key signals
 * Uses Google News RSS as a free source
 */
export async function searchNews(query, limit = 5) {
  try {
    const encoded = encodeURIComponent(query)
    const { data } = await axios.get(
      `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`,
      {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/rss+xml, application/xml, text/xml",
        },
      },
    )

    // Parse RSS XML
    const items = []
    const matches = data.matchAll(/<item>([\s\S]*?)<\/item>/g)
    for (const match of matches) {
      const xml = match[1]
      const title = xml.match(/<title>(.*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, "$1") || ""
      const link = xml.match(/<link>(.*?)<\/link>/)?.[1] || xml.match(/<link\/>(.*?)(?=<)/)?.[1] || ""
      const pubDate = xml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || ""
      const source = xml.match(/<source.*?>(.*?)<\/source>/)?.[1] || ""

      if (title) {
        items.push({
          title,
          link,
          pubDate,
          source,
          ageHours: pubDate ? (Date.now() - new Date(pubDate).getTime()) / 3600000 : 999,
        })
      }
      if (items.length >= limit) break
    }

    return items
  } catch (err) {
    console.error(`News search failed: ${err.message}`)
    return []
  }
}

// ── Sentiment Analysis ────────────────────────────────────────

const POSITIVE_PATTERNS = [
  // Strong positive
  { pattern: /\b(confirms?|confirmed|approved|passed|signed|wins?|won|victory|succeeds?|breakthrough)\b/i, weight: 2 },
  // Moderate positive
  { pattern: /\b(likely|expected|leads?|ahead|gains?|rises?|surges?|launches?|deal|supports?|agrees?|accepts?)\b/i, weight: 1 },
  // Mild positive
  { pattern: /\b(considers?|plans?|proposes?|moves?\s+toward|progress|optimis)/i, weight: 0.5 },
]

const NEGATIVE_PATTERNS = [
  // Strong negative
  { pattern: /\b(fails?|failed|rejected?|blocked|denied|defeated?|collapses?|killed|dead|impossible|cancelled?)\b/i, weight: 2 },
  // Moderate negative
  { pattern: /\b(unlikely|drops?|falls?|crashes?|opposes?|refuses?|delays?|stalls?|loses?|lost|behind)\b/i, weight: 1 },
  // Mild negative
  { pattern: /\b(uncertain|doubts?|questions?|struggles?|challenges?|pessimis|concerns?)\b/i, weight: 0.5 },
]

// Negation patterns — flip sentiment when these precede positive/negative words
const NEGATION_PATTERNS = /\b(not|no|n't|never|neither|unlikely to|fails? to|won't|cannot|can't|doesn't|didn't|hasn't|haven't|isn't|aren't|wasn't|weren't)\b/i

/**
 * Score a single headline for sentiment
 * Returns: { score: -1 to +1, weight: how confident }
 */
function scoreHeadline(title) {
  const lower = title.toLowerCase()

  // Check for negation in headline
  const hasNegation = NEGATION_PATTERNS.test(lower)

  let posScore = 0
  let negScore = 0

  for (const { pattern, weight } of POSITIVE_PATTERNS) {
    const matches = lower.match(pattern)
    if (matches) posScore += weight * matches.length
  }

  for (const { pattern, weight } of NEGATIVE_PATTERNS) {
    const matches = lower.match(pattern)
    if (matches) negScore += weight * matches.length
  }

  // Negation flips the dominant sentiment
  if (hasNegation) {
    // "not likely to pass" → flip positive to negative
    // But "not rejected" → flip negative to positive
    if (posScore > negScore) {
      // Positive words negated → bearish
      const temp = posScore
      posScore = negScore * 0.5
      negScore = temp * 0.8 // Negated positive isn't as strong as direct negative
    } else if (negScore > posScore) {
      // Negative words negated → bullish (but weaker)
      const temp = negScore
      negScore = posScore * 0.5
      posScore = temp * 0.6 // Negated negative isn't as strong as direct positive
    }
  }

  const totalWeight = posScore + negScore
  if (totalWeight === 0) return { score: 0, weight: 0 }

  const score = (posScore - negScore) / Math.max(posScore + negScore, 1)
  return { score, weight: Math.min(totalWeight, 5) / 5 }
}

/**
 * Analyze sentiment of headlines for a market question
 * Returns: { bullish, bearish, neutral, strength, sentiment, headlines }
 */
export function analyzeSentiment(headlines, yesOutcome) {
  let bullish = 0
  let bearish = 0
  let neutral = 0
  let totalScore = 0
  let totalWeight = 0

  for (const h of headlines) {
    const { score, weight } = scoreHeadline(h.title)

    // Recency weighting: headlines < 6h old get 2x weight, < 24h get 1.5x
    const ageHours = h.ageHours || 999
    const recencyMultiplier = ageHours < 6 ? 2.0 : ageHours < 24 ? 1.5 : ageHours < 72 ? 1.0 : 0.5

    const adjustedWeight = weight * recencyMultiplier

    if (score > 0.15) bullish++
    else if (score < -0.15) bearish++
    else neutral++

    totalScore += score * adjustedWeight
    totalWeight += adjustedWeight
  }

  const total = headlines.length || 1
  const normalizedScore = totalWeight > 0 ? totalScore / totalWeight : 0
  const strength = Math.min(1, Math.abs(normalizedScore)) // 0 to 1

  return {
    bullish,
    bearish,
    neutral,
    bullishPct: bullish / total,
    bearishPct: bearish / total,
    strength, // How strong is the consensus (0 = mixed, 1 = unanimous)
    normalizedScore, // -1 (bearish) to +1 (bullish)
    sentiment: normalizedScore > 0.15 ? "bullish" : normalizedScore < -0.15 ? "bearish" : "neutral",
    headlines: headlines.slice(0, 5),
  }
}

/**
 * Compare news sentiment with market price to find edges
 */
export function findNewsEdge(market, sentiment) {
  const yesPrice = market.outcomes[0]?.price || 0.5

  // Require minimum strength to act on news
  if (sentiment.strength < 0.3) return null

  // If news is bullish but market says low probability → potential buy
  if (sentiment.sentiment === "bullish" && yesPrice < 0.4 && sentiment.strength >= 0.4) {
    return {
      direction: "BUY_YES",
      confidence: Math.min(0.85, sentiment.strength),
      reason: `News is bullish (strength ${(sentiment.strength * 100).toFixed(0)}%, ${sentiment.bullish}/${sentiment.bullish + sentiment.bearish + sentiment.neutral} positive) but market only at ${(yesPrice * 100).toFixed(0)}%`,
    }
  }

  // If news is bearish but market says high probability → potential buy NO
  if (sentiment.sentiment === "bearish" && yesPrice > 0.6 && sentiment.strength >= 0.4) {
    return {
      direction: "BUY_NO",
      confidence: Math.min(0.85, sentiment.strength),
      reason: `News is bearish (strength ${(sentiment.strength * 100).toFixed(0)}%, ${sentiment.bearish} negative) but market at ${(yesPrice * 100).toFixed(0)}%`,
    }
  }

  return null
}

export default { searchNews, analyzeSentiment, findNewsEdge }
