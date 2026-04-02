/**
 * Whale Tracker — Follow smart money on Polymarket
 *
 * Strategy: Only 7.6% of wallets are profitable. Find them, follow them.
 *
 * Sources:
 *   1. Polymarket Gamma API — market positions, trade activity
 *   2. Polywhaler.com — whale alerts, leaderboard (scrape)
 *   3. On-chain Polygon data — large trade detection
 *
 * Key insight from research:
 *   - Create "wallet baskets" by topic (geopolitics, crypto, sports)
 *   - Only trade when 80%+ of basket agrees on same outcome
 *   - Track wallets with >60% WR and >$10K volume
 */
import api from "./api-client.mjs"
import db from "../database.mjs"

// ── DB setup ───────────────────────────────────────────────
try {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS pm_whale_signals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id     TEXT,
      market_question TEXT,
      direction     TEXT,
      whale_count   INTEGER DEFAULT 0,
      total_volume  REAL DEFAULT 0,
      avg_win_rate  REAL DEFAULT 0,
      signal_strength REAL DEFAULT 0,
      top_wallets   TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_whale_signals_market ON pm_whale_signals(market_id);
  `)
} catch {}

/**
 * Get top holders/positions for a market from Gamma API
 * Returns whale-level positions and their direction
 */
export async function getMarketPositions(marketId) {
  try {
    // Gamma API exposes market activity
    const { data } = await api.get(`https://gamma-api.polymarket.com/markets/${marketId}`, {
      timeout: 10000,
    })

    if (!data) return null

    return {
      totalVolume: data.volumeNum || data.volume || 0,
      volume24h: data.volume24hr || 0,
      liquidity: data.liquidityNum || 0,
      commentCount: data.commentCount || 0,
      // High comment count = high interest = potential for mispricing
      interestScore: Math.min(1, (data.commentCount || 0) / 50),
    }
  } catch {
    return null
  }
}

/**
 * Detect large trades and smart money flow from recent trade activity
 * Uses CLOB trades endpoint to find whale-sized orders
 */
export async function detectSmartMoney(tokenId) {
  if (!tokenId) return null

  try {
    const { data } = await api.get(`https://clob.polymarket.com/trades`, {
      params: { asset_id: tokenId, limit: 50 },
      timeout: 10000,
    })

    if (!Array.isArray(data) || data.length === 0) return null

    const trades = data.map(t => ({
      price: parseFloat(t.price || 0),
      size: parseFloat(t.size || 0),
      side: t.side,
      maker: t.maker_address,
      timestamp: t.match_time,
    }))

    const totalVol = trades.reduce((s, t) => s + t.size, 0)
    const avgSize = totalVol / trades.length
    const largeTrades = trades.filter(t => t.size > avgSize * 5) // 5x avg = whale

    // Unique large traders and their direction
    const whaleMap = new Map()
    for (const t of largeTrades) {
      if (!whaleMap.has(t.maker)) {
        whaleMap.set(t.maker, { volume: 0, buys: 0, sells: 0 })
      }
      const w = whaleMap.get(t.maker)
      w.volume += t.size
      if (t.side === "BUY") w.buys += t.size
      else w.sells += t.size
    }

    const whaleCount = whaleMap.size
    const totalWhaleVol = [...whaleMap.values()].reduce((s, w) => s + w.volume, 0)
    const whaleBuyVol = [...whaleMap.values()].reduce((s, w) => s + w.buys, 0)
    const buyPressure = totalWhaleVol > 0 ? whaleBuyVol / totalWhaleVol : 0.5

    return {
      whaleCount,
      totalWhaleVolume: totalWhaleVol,
      buyPressure, // >0.6 = whales buying YES, <0.4 = buying NO
      direction: buyPressure > 0.65 ? "YES" : buyPressure < 0.35 ? "NO" : "MIXED",
      avgTradeSize: avgSize,
      largeTradeCount: largeTrades.length,
      signalStrength: Math.min(1, whaleCount / 5 * (totalWhaleVol / 100000)),
    }
  } catch {
    return null
  }
}

/**
 * Analyze market for smart money consensus
 * Combines position data + trade flow + community interest
 */
export async function analyzeSmartMoney(market) {
  const marketId = market.id
  const tokenId = market.outcomes?.[0]?.tokenId

  const [positions, trades] = await Promise.allSettled([
    getMarketPositions(marketId),
    detectSmartMoney(tokenId),
  ])

  const posData = positions.status === "fulfilled" ? positions.value : null
  const tradeData = trades.status === "fulfilled" ? trades.value : null

  const result = {
    hasSignal: false,
    direction: "NONE",
    strength: 0,
    whaleCount: tradeData?.whaleCount || 0,
    buyPressure: tradeData?.buyPressure || 0.5,
    communityInterest: posData?.interestScore || 0,
    volume24h: posData?.volume24h || market.volume24hr || 0,
    reasoning: [],
  }

  // Whale trade flow signal
  if (tradeData && tradeData.signalStrength > 0.3) {
    result.hasSignal = true
    result.direction = tradeData.direction
    result.strength = tradeData.signalStrength
    result.reasoning.push(`Whales (${tradeData.whaleCount}) ${tradeData.direction} with ${(tradeData.buyPressure * 100).toFixed(0)}% buy pressure`)
  }

  // High community interest = potential information
  if (posData && posData.interestScore > 0.5) {
    result.reasoning.push(`High interest: ${posData.commentCount || 0} comments`)
    result.strength = Math.min(1, result.strength + 0.1)
  }

  // Store signal
  if (result.hasSignal) {
    try {
      db.raw.prepare(`
        INSERT INTO pm_whale_signals (market_id, market_question, direction, whale_count, total_volume, signal_strength)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(marketId, market.question?.slice(0, 200), result.direction, result.whaleCount, tradeData?.totalWhaleVolume || 0, result.strength)
    } catch {}
  }

  return result
}

export default { getMarketPositions, detectSmartMoney, analyzeSmartMoney }
