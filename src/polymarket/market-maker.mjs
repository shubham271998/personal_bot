/**
 * Polymarket Market Maker
 *
 * Places limit orders on BOTH sides of a market (buy + sell).
 * Captures the spread as profit. Makers pay ZERO fees + earn rebates.
 *
 * This is the most consistently profitable Polymarket strategy.
 *
 * How it works:
 *   1. Get midpoint price
 *   2. Place BUY order at (mid - spread/2)
 *   3. Place SELL order at (mid + spread/2)
 *   4. When both fill, profit = spread × size
 *   5. Rinse and repeat
 *
 * Risk: Adverse selection (informed traders pick you off).
 * Mitigation: Wider spreads on volatile markets, position limits.
 */
import axios from "axios"

const CLOB_API = "https://clob.polymarket.com"

/**
 * Get current midpoint price for a token
 */
export async function getMidpoint(tokenId) {
  const { data } = await axios.get(`${CLOB_API}/midpoint`, {
    params: { token_id: tokenId },
    timeout: 5000,
  })
  return parseFloat(data.mid || 0)
}

/**
 * Get best bid and ask
 */
export async function getBestBidAsk(tokenId) {
  const { data } = await axios.get(`${CLOB_API}/book`, {
    params: { token_id: tokenId },
    timeout: 5000,
  })

  const bestBid = data.bids?.[0] ? parseFloat(data.bids[0].price) : 0
  const bestAsk = data.asks?.[0] ? parseFloat(data.asks[0].price) : 1
  const spread = bestAsk - bestBid
  const mid = (bestBid + bestAsk) / 2

  const bidDepth = (data.bids || []).slice(0, 5).reduce((s, b) => s + parseFloat(b.size || 0), 0)
  const askDepth = (data.asks || []).slice(0, 5).reduce((s, a) => s + parseFloat(a.size || 0), 0)

  return { bestBid, bestAsk, spread, mid, bidDepth, askDepth }
}

/**
 * Calculate optimal spread for market making
 *
 * Factors:
 *   - Market volatility (wider spread for volatile)
 *   - Liquidity depth (wider if thin book)
 *   - Time to resolution (tighter near resolution)
 *   - Fee rebates (can afford tighter since makers earn rebates)
 */
export function calculateOptimalSpread(market, bookData) {
  let baseSpread = 0.03 // 3% base spread

  // Adjust for liquidity
  const totalDepth = bookData.bidDepth + bookData.askDepth
  if (totalDepth < 10000) baseSpread += 0.02 // Thin book, wider spread
  if (totalDepth > 1000000) baseSpread -= 0.01 // Deep book, can be tighter

  // Adjust for time to resolution
  if (market.endDate) {
    const hoursLeft = (new Date(market.endDate) - Date.now()) / 3600000
    if (hoursLeft < 24) baseSpread += 0.02 // Near resolution = more risk
    if (hoursLeft > 720) baseSpread -= 0.005 // Long-dated = less risk
  }

  // Adjust for current price extremes
  const price = bookData.mid
  if (price < 0.1 || price > 0.9) baseSpread += 0.02 // Extreme prices = more directional risk

  // Minimum spread (must cover any residual costs)
  return Math.max(0.01, Math.min(baseSpread, 0.08))
}

/**
 * Generate market making order pairs
 * Returns { buyOrders, sellOrders } with prices and sizes
 */
export function generateMMOrders(mid, spread, totalSize, levels = 3) {
  const buyOrders = []
  const sellOrders = []
  const sizePerLevel = totalSize / levels

  for (let i = 0; i < levels; i++) {
    const offset = (spread / 2) * (1 + i * 0.5) // Widen each level

    const buyPrice = Math.max(0.001, Math.round((mid - offset) * 1000) / 1000)
    const sellPrice = Math.min(0.999, Math.round((mid + offset) * 1000) / 1000)

    buyOrders.push({ price: buyPrice, size: sizePerLevel })
    sellOrders.push({ price: sellPrice, size: sizePerLevel })
  }

  return { buyOrders, sellOrders }
}

/**
 * Find best markets for market making
 * Criteria: high volume, reasonable spread, not too near resolution
 */
export async function findMMOpportunities(markets) {
  const opportunities = []

  for (const market of markets) {
    if (market.outcomes.length < 2) continue
    if (!market.outcomes[0].tokenId) continue

    try {
      const tokenId = market.outcomes[0].tokenId
      const book = await getBestBidAsk(tokenId)

      // Skip if spread is too thin (others already making this market)
      if (book.spread < 0.005) continue
      // Skip if no depth
      if (book.bidDepth < 100 || book.askDepth < 100) continue

      const optimalSpread = calculateOptimalSpread(market, book)
      const profitPerRound = optimalSpread * 100

      // Estimated daily revenue based on volume
      const dailyTurnover = market.volume24hr * 0.01 // Assume we capture 1% of volume
      const dailyRevenue = dailyTurnover * optimalSpread

      opportunities.push({
        market,
        tokenId,
        currentSpread: (book.spread * 100).toFixed(2),
        optimalSpread: (optimalSpread * 100).toFixed(2),
        mid: book.mid,
        bidDepth: book.bidDepth,
        askDepth: book.askDepth,
        profitPerRound: profitPerRound.toFixed(2),
        estDailyRevenue: dailyRevenue.toFixed(2),
        score: dailyRevenue * (book.spread > optimalSpread ? 1.5 : 1),
      })
    } catch {
      continue
    }
  }

  return opportunities.sort((a, b) => b.score - a.score)
}

/**
 * Paper simulate a market making session
 * Tracks theoretical P&L if orders were filled proportionally
 */
export function simulateMMSession(mid, spread, size, fillRate = 0.3) {
  const halfSpread = spread / 2
  const buyPrice = mid - halfSpread
  const sellPrice = mid + halfSpread

  const filledSize = size * fillRate
  const revenue = filledSize * spread
  const rebateEstimate = filledSize * 0.001 // ~0.1% maker rebate

  return {
    buyPrice: buyPrice.toFixed(3),
    sellPrice: sellPrice.toFixed(3),
    spread: (spread * 100).toFixed(2) + "%",
    filledSize: filledSize.toFixed(2),
    grossProfit: revenue.toFixed(4),
    rebate: rebateEstimate.toFixed(4),
    totalProfit: (revenue + rebateEstimate).toFixed(4),
  }
}

export default {
  getMidpoint,
  getBestBidAsk,
  calculateOptimalSpread,
  generateMMOrders,
  findMMOpportunities,
  simulateMMSession,
}
