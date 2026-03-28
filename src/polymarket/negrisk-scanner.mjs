/**
 * NegRisk Arbitrage Scanner
 *
 * NegRisk markets are multi-outcome events (e.g., "Who wins 2028 election?")
 * where all YES prices should sum to exactly $1.00.
 *
 * When they don't:
 *   Sum < $1.00 → Buy ALL YES shares = guaranteed profit (one MUST win)
 *   Sum > $1.00 → Buy ALL NO shares = guaranteed profit (all but one must lose)
 *
 * This strategy extracted $29M in one year. 73% of all arbitrage profits.
 * Top arbitrageur made $2M from this alone.
 */
import axios from "axios"

const GAMMA_API = "https://gamma-api.polymarket.com"

/**
 * Fetch all neg-risk events with their markets
 */
export async function getNegRiskEvents(limit = 100) {
  // Get events that use neg-risk (multi-outcome)
  const { data } = await axios.get(`${GAMMA_API}/events`, {
    params: {
      limit,
      active: true,
      closed: false,
      order: "volume24hr",
      ascending: false,
    },
    timeout: 15000,
  })

  // Filter to events with multiple markets (neg-risk)
  const negRiskEvents = []
  for (const event of data) {
    const markets = event.markets || []
    if (markets.length < 3) continue // Need 3+ outcomes to be interesting

    const outcomes = []
    let hasClosedMarket = false

    for (const m of markets) {
      if (m.closed) { hasClosedMarket = true; continue }
      const prices = JSON.parse(m.outcomePrices || "[]")
      const names = JSON.parse(m.outcomes || "[]")
      const tokens = JSON.parse(m.clobTokenIds || "[]")

      if (prices.length >= 1) {
        outcomes.push({
          marketId: m.id,
          name: names[0] || m.question,
          yesPrice: parseFloat(prices[0] || 0),
          noPrice: parseFloat(prices[1] || 1),
          yesTokenId: tokens[0] || null,
          noTokenId: tokens[1] || null,
          volume24hr: m.volume24hr || 0,
        })
      }
    }

    if (outcomes.length >= 3 && !hasClosedMarket) {
      const totalYesPrice = outcomes.reduce((sum, o) => sum + o.yesPrice, 0)

      negRiskEvents.push({
        eventId: event.id,
        title: event.title || event.slug,
        slug: event.slug,
        outcomes,
        totalYesPrice,
        spread: Math.abs(1 - totalYesPrice),
        direction: totalYesPrice < 1 ? "BUY_ALL_YES" : "BUY_ALL_NO",
        volume24hr: event.volume24hr || 0,
      })
    }
  }

  return negRiskEvents
}

/**
 * Find NegRisk arbitrage opportunities
 * Returns events where total YES price != $1.00 (profit opportunity)
 */
export async function findNegRiskArbitrage(minSpreadPct = 1.5) {
  const events = await getNegRiskEvents(200)
  const opportunities = []

  for (const event of events) {
    const spreadPct = event.spread * 100

    if (spreadPct >= minSpreadPct) {
      const profitPerDollar = event.spread
      const direction = event.direction

      // Calculate exact trade
      let tradeDetails
      if (direction === "BUY_ALL_YES") {
        // Sum < $1: buy all YES. One wins → payout $1. Cost = sum of all YES prices.
        const cost = event.totalYesPrice
        const profit = 1 - cost
        tradeDetails = {
          action: "Buy YES on ALL outcomes",
          totalCost: cost,
          guaranteedPayout: 1.0,
          profit,
          profitPct: (profit / cost * 100).toFixed(2),
          trades: event.outcomes.map((o) => ({
            name: o.name,
            side: "BUY",
            price: o.yesPrice,
            tokenId: o.yesTokenId,
          })),
        }
      } else {
        // Sum > $1: more complex, buy NO on everything
        const noCost = event.outcomes.reduce((sum, o) => sum + o.noPrice, 0)
        const profit = event.outcomes.length - 1 - noCost // (n-1) NO tokens pay out
        tradeDetails = {
          action: "Buy NO on ALL outcomes",
          totalCost: noCost,
          guaranteedPayout: event.outcomes.length - 1,
          profit: Math.max(0, profit),
          profitPct: noCost > 0 ? ((profit / noCost) * 100).toFixed(2) : "0",
          trades: event.outcomes.map((o) => ({
            name: o.name,
            side: "BUY",
            price: o.noPrice,
            tokenId: o.noTokenId,
          })),
        }
      }

      opportunities.push({
        event,
        direction,
        spreadPct: spreadPct.toFixed(2),
        tradeDetails,
        score: spreadPct * Math.log(event.volume24hr + 1) / 10,
        risk: "NONE", // Arbitrage = risk-free
        strategy: "NegRisk Arbitrage",
        reasoning: `${event.title}: YES prices sum to ${(event.totalYesPrice * 100).toFixed(1)}% (should be 100%). ${direction === "BUY_ALL_YES" ? "Buy all YES" : "Buy all NO"} for ${spreadPct.toFixed(1)}% guaranteed profit.`,
      })
    }
  }

  return opportunities.sort((a, b) => b.score - a.score)
}

/**
 * Monitor NegRisk events for real-time arbitrage
 * Returns events where spread just widened (fresh opportunity)
 */
let _lastSpreads = new Map()

export async function checkNegRiskChanges() {
  const events = await getNegRiskEvents(50)
  const alerts = []

  for (const event of events) {
    const prevSpread = _lastSpreads.get(event.eventId) || 0
    const currentSpread = event.spread * 100

    // Alert if spread widened by >0.5% (new arb appeared)
    if (currentSpread > prevSpread + 0.5 && currentSpread > 1.0) {
      alerts.push({
        event,
        previousSpread: prevSpread.toFixed(2),
        currentSpread: currentSpread.toFixed(2),
        type: "NEW_ARB",
      })
    }

    _lastSpreads.set(event.eventId, currentSpread)
  }

  return alerts
}

export default {
  getNegRiskEvents,
  findNegRiskArbitrage,
  checkNegRiskChanges,
}
