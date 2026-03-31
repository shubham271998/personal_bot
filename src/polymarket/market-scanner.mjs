/**
 * Polymarket Market Scanner
 *
 * Fetches markets, analyzes odds, finds mispricings.
 * Uses Gamma API for market data and news analysis for edge detection.
 */
import api from "./api-client.mjs"

const GAMMA_API = "https://gamma-api.polymarket.com"
const CLOB_API = "https://clob.polymarket.com"

/**
 * Fetch active markets sorted by volume
 */
export async function getTopMarkets(limit = 20) {
  const { data } = await api.get(`${GAMMA_API}/markets`, {
    params: { limit, active: true, closed: false, order: "volume24hr", ascending: false },
    timeout: 10000,
  })
  return data.map(parseMarket)
}

/**
 * Fetch markets by category/tag
 */
export async function getMarketsByTag(tag, limit = 20) {
  const { data } = await api.get(`${GAMMA_API}/markets`, {
    params: { limit, active: true, closed: false, tag_id: tag, order: "volume24hr", ascending: false },
    timeout: 10000,
  })
  return data.map(parseMarket)
}

/**
 * Search markets by keyword
 */
export async function searchMarkets(query, limit = 10) {
  const { data } = await api.get(`${GAMMA_API}/markets`, {
    params: { limit, active: true, closed: false, order: "volume24hr", ascending: false },
    timeout: 10000,
  })
  const q = query.toLowerCase()
  return data
    .filter((m) => m.question.toLowerCase().includes(q) || (m.description || "").toLowerCase().includes(q))
    .map(parseMarket)
}

/**
 * Get a single market by ID or slug
 */
export async function getMarket(idOrSlug) {
  try {
    const { data } = await api.get(`${GAMMA_API}/markets/${idOrSlug}`, { timeout: 10000 })
    return parseMarket(data)
  } catch {
    // Try slug search
    const { data } = await api.get(`${GAMMA_API}/markets`, {
      params: { slug: idOrSlug, limit: 1 },
      timeout: 10000,
    })
    return data[0] ? parseMarket(data[0]) : null
  }
}

/**
 * Get order book for a market
 */
export async function getOrderBook(tokenId) {
  try {
    const { data } = await api.get(`${CLOB_API}/book`, {
      params: { token_id: tokenId },
      timeout: 10000,
    })
    return data
  } catch {
    return null
  }
}

/**
 * Find markets with potential edge (mispriced based on heuristics)
 */
export async function findOpportunities(limit = 50) {
  const markets = await getTopMarkets(limit)
  const opportunities = []

  for (const market of markets) {
    const signals = analyzeMarket(market)
    if (signals.score > 0) {
      opportunities.push({ market, signals })
    }
  }

  // Sort by opportunity score
  return opportunities.sort((a, b) => b.signals.score - a.signals.score)
}

/**
 * Analyze a market for trading signals
 */
function analyzeMarket(market) {
  const signals = {
    score: 0,
    reasons: [],
  }

  // Signal 1: High volume + extreme price (near 0% or 100%) = potential resolution profit
  for (const outcome of market.outcomes) {
    if (outcome.price >= 0.95 && market.volume24hr > 100000) {
      signals.score += 1
      signals.reasons.push(`${outcome.name} at ${(outcome.price * 100).toFixed(1)}% — near resolution, low risk`)
    }
    if (outcome.price <= 0.05 && market.volume24hr > 100000) {
      signals.score += 0.5
      signals.reasons.push(`${outcome.name} at ${(outcome.price * 100).toFixed(1)}% — cheap lottery ticket`)
    }
  }

  // Signal 2: Binary market where prices don't add to ~100% (arbitrage)
  if (market.outcomes.length === 2) {
    const total = market.outcomes[0].price + market.outcomes[1].price
    if (total < 0.97) {
      signals.score += 3
      signals.reasons.push(`Prices sum to ${(total * 100).toFixed(1)}% — potential arbitrage (buy both for guaranteed profit)`)
    }
    if (total > 1.03) {
      signals.score += 1
      signals.reasons.push(`Prices sum to ${(total * 100).toFixed(1)}% — overpriced, market uncertainty`)
    }
  }

  // Signal 3: High volume spike (something is happening)
  if (market.volume24hr > 500000) {
    signals.score += 0.5
    signals.reasons.push(`High volume: $${(market.volume24hr / 1000).toFixed(0)}K in 24h`)
  }

  // Signal 4: End date approaching (resolution imminent)
  if (market.endDate) {
    const hoursLeft = (new Date(market.endDate) - Date.now()) / 3600000
    if (hoursLeft > 0 && hoursLeft < 48) {
      signals.score += 1
      signals.reasons.push(`Resolving in ${hoursLeft.toFixed(0)}h — price should converge`)
    }
  }

  return signals
}

/**
 * Parse raw market data into clean format
 */
function parseMarket(raw) {
  const outcomes = JSON.parse(raw.outcomes || "[]")
  const prices = JSON.parse(raw.outcomePrices || "[]")
  const tokenIds = JSON.parse(raw.clobTokenIds || "[]")

  // Triple-check resolution status (some markets report active=true after resolving)
  const isTrulyActive = raw.active && !raw.closed && raw.acceptingOrders !== false
  const isTrulyClosed = raw.closed || raw.acceptingOrders === false || raw.umaResolutionStatus === "resolved"

  return {
    id: raw.id,
    question: raw.question,
    slug: raw.slug,
    description: (raw.description || "").slice(0, 300),
    resolved: isTrulyClosed,
    volume24hr: raw.volume24hr || 0,
    volumeTotal: raw.volumeNum || 0,
    endDate: raw.endDate,
    active: isTrulyActive,
    outcomes: outcomes.map((name, i) => ({
      name,
      price: parseFloat(prices[i] || 0),
      tokenId: tokenIds[i] || null,
    })),
  }
}

export default {
  getTopMarkets,
  getMarketsByTag,
  searchMarkets,
  getMarket,
  getOrderBook,
  findOpportunities,
}
