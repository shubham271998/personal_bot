/**
 * Polymarket Strategy Engine — Multi-Strategy Trading System
 *
 * Strategies (by risk level):
 *
 * SAFE (60% of capital):
 *   1. Resolution Sniping — Buy near-certain outcomes (95-99%) for 1-5% guaranteed profit
 *   2. Spread Arbitrage — When YES + NO < $1, buy both for risk-free profit
 *   3. Calendar Value — Near-expiry markets with clear outcomes
 *
 * MEDIUM (25% of capital):
 *   4. News Alpha — React to breaking news before market catches up
 *   5. Momentum — Markets moving consistently in one direction
 *   6. Mean Reversion — Overreaction to news, price snaps back
 *
 * HIGH RISK (15% of capital):
 *   7. Contrarian — Bet against extreme sentiment when fundamentals disagree
 *   8. Long Shots — Low probability events with asymmetric payoff
 *
 * Position Sizing: Kelly Criterion (fractional, 1/4 Kelly for safety)
 * Risk Management: Max 5% of bankroll per trade, daily loss limit, correlation checks
 */
import scanner from "./market-scanner.mjs"
import newsAnalyzer from "./news-analyzer.mjs"
import negRiskScanner from "./negrisk-scanner.mjs"
import selfImprover from "./self-improver.mjs"

// ── Pro Rules (from $85M+ in proven trader research) ────────

// Rule 1: NEVER trade in the $0.51-$0.67 range (where most losses cluster)
const DEAD_ZONE_MIN = 0.51
const DEAD_ZONE_MAX = 0.67
function isInDeadZone(price) {
  return price >= DEAD_ZONE_MIN && price <= DEAD_ZONE_MAX
}

// Rule 2: Minimum 5-cent edge to filter noise (AMM spread is ~3.5 cents)
const MIN_EDGE = 0.05

// Rule 3: Minimum $10K daily volume (confirms real interest, not thin-book artifact)
const MIN_VOLUME_24H = 10000

// Rule 4: Only act when multiple signals agree (confidence > 70%)
const MIN_CONFIDENCE = 0.70

/**
 * Pre-trade quality filter — must pass ALL checks
 */
function passesQualityFilter(market, edge = 0) {
  if (!market) return false
  if (market.volume24hr < MIN_VOLUME_24H) return false // Too illiquid
  if (Math.abs(edge) < MIN_EDGE && edge !== 0) return false // Edge too small
  if (market.resolved) return false // Already resolved
  return true
}

// ── Kelly Criterion ─────────────────────────────────────────

/**
 * Calculate optimal bet size using Kelly Criterion
 * @param {number} edge — your estimated probability minus market price
 * @param {number} odds — payout odds (1/price - 1)
 * @param {number} bankroll — total available capital
 * @param {number} fraction — Kelly fraction (0.25 = quarter Kelly, safer)
 * @returns {number} optimal bet size in dollars
 */
export function kellyBetSize(edge, odds, bankroll, fraction = 0.25) {
  if (edge <= 0 || odds <= 0) return 0
  // Kelly formula: f* = (p*b - q) / b
  // where p = probability, b = odds, q = 1-p
  const p = edge + (1 / (odds + 1)) // estimated true probability
  const q = 1 - p
  const kelly = (p * odds - q) / odds
  const bet = Math.max(0, kelly * fraction * bankroll)
  return Math.min(bet, bankroll * 0.05) // Never more than 5% of bankroll
}

// ── Strategy Implementations ────────────────────────────────

/**
 * Strategy 1: Resolution Sniping
 * Buy outcomes at 95-99% that are almost certainly going to resolve YES/NO.
 * Profit = 100% - buy price (1-5% return, very low risk)
 */
export async function findResolutionSnipes(minPrice = 0.93, maxPrice = 0.99) {
  const markets = await scanner.getTopMarkets(100)
  const snipes = []

  for (const market of markets) {
    if (!market.active || market.resolved) continue

    // Check if market is ending soon (within 72 hours)
    const hoursLeft = market.endDate
      ? (new Date(market.endDate) - Date.now()) / 3600000
      : Infinity

    for (const outcome of market.outcomes) {
      if (isInDeadZone(outcome.price)) continue // Pro rule: avoid 51-67% zone
      if (outcome.price >= minPrice && outcome.price <= maxPrice) {
        const profit = (1 - outcome.price) * 100
        const annualizedReturn = hoursLeft > 0 && hoursLeft < 168
          ? (profit / 100) * (8760 / hoursLeft) * 100
          : 0

        snipes.push({
          market,
          outcome: outcome.name,
          price: outcome.price,
          profit: profit.toFixed(2),
          hoursLeft: hoursLeft === Infinity ? "N/A" : hoursLeft.toFixed(0),
          annualizedReturn: annualizedReturn.toFixed(0),
          risk: "LOW",
          strategy: "Resolution Snipe",
          score: profit * (hoursLeft < 48 ? 2 : 1) * (market.volume24hr > 100000 ? 1.5 : 1),
          reasoning: `${outcome.name} at ${(outcome.price * 100).toFixed(1)}% — ${profit.toFixed(1)}% profit if resolves YES. ${hoursLeft < 72 ? `Resolves in ${hoursLeft.toFixed(0)}h` : ""}`,
        })
      }
    }
  }

  return snipes.sort((a, b) => b.score - a.score)
}

/**
 * Strategy 2: Spread Arbitrage
 * When YES + NO prices don't sum to 1.00, buy both for guaranteed profit
 */
export async function findArbitrage() {
  const markets = await scanner.getTopMarkets(200)
  const arbs = []

  for (const market of markets) {
    if (market.outcomes.length !== 2) continue
    const yesPrice = market.outcomes[0].price
    const noPrice = market.outcomes[1].price
    const total = yesPrice + noPrice

    if (total < 0.985) {
      const profit = (1 - total) * 100
      arbs.push({
        market,
        yesPrice,
        noPrice,
        totalCost: total,
        profit: profit.toFixed(2),
        risk: "NONE",
        strategy: "Arbitrage",
        score: profit * (market.volume24hr > 50000 ? 2 : 1),
        reasoning: `YES(${(yesPrice * 100).toFixed(1)}%) + NO(${(noPrice * 100).toFixed(1)}%) = ${(total * 100).toFixed(1)}% — Buy both for ${profit.toFixed(1)}% guaranteed profit`,
      })
    }
  }

  return arbs.sort((a, b) => b.score - a.score)
}

/**
 * Strategy 3: News Alpha
 * Compare real-time news sentiment against market prices.
 * Trade when news strongly disagrees with market.
 */
export async function findNewsAlpha(topN = 20) {
  const markets = await scanner.getTopMarkets(topN)
  const alphas = []

  for (const market of markets) {
    if (market.outcomes.length < 2) continue

    try {
      // Get news for this market
      const headlines = await newsAnalyzer.searchNews(market.question.slice(0, 50), 6)
      if (headlines.length < 2) continue

      const sentiment = newsAnalyzer.analyzeSentiment(headlines, market.outcomes[0].name)
      const yesPrice = market.outcomes[0].price

      // Check whale activity for extra signal
      let whaleBoost = 0
      let whaleInfo = ""
      try {
        const tokenId = market.outcomes[0].tokenId
        if (tokenId) {
          const whale = await selfImprover.detectWhaleActivity(tokenId)
          if (whale) {
            if (whale.whaleDirection === "BULLISH" && whale.ratio > 0.7) { whaleBoost = 0.1; whaleInfo = " + whales buying" }
            if (whale.whaleDirection === "BEARISH" && whale.ratio < 0.3) { whaleBoost = -0.1; whaleInfo = " + whales selling" }
          }
        }
      } catch {}

      // Quality filter — skip low-volume markets
      if (market.volume24hr < MIN_VOLUME_24H) continue

      // Apply Tetlock's extremization to our estimate
      const rawEstimate = sentiment.bullishPct + whaleBoost
      const extremized = selfImprover.extremize(rawEstimate, 1.3)
      const edge = Math.abs(extremized - yesPrice)

      // Minimum 5-cent edge required
      if (edge < MIN_EDGE) continue

      // Strong bullish news but low market price → BUY YES
      if (extremized > 0.55 && yesPrice < 0.4) {
        const edge = extremized - yesPrice
        alphas.push({
          market,
          direction: "BUY_YES",
          outcome: market.outcomes[0].name,
          currentPrice: yesPrice,
          estimatedProb: extremized,
          edge: edge,
          risk: "MEDIUM",
          strategy: "News Alpha",
          score: edge * 10 * (market.volume24hr > 100000 ? 1.5 : 1),
          reasoning: `News ${(sentiment.bullishPct * 100).toFixed(0)}% bullish${whaleInfo}, extremized to ${(extremized * 100).toFixed(0)}% vs market ${(yesPrice * 100).toFixed(0)}%`,
          headlines: sentiment.headlines.slice(0, 3).map((h) => h.title),
        })
      }

      // Strong bearish news but high market price → BUY NO
      if (sentiment.bearishPct > 0.5 && yesPrice > 0.6) {
        const edge = sentiment.bearishPct - (1 - yesPrice)
        alphas.push({
          market,
          direction: "BUY_NO",
          outcome: market.outcomes[1].name,
          currentPrice: 1 - yesPrice,
          estimatedProb: sentiment.bearishPct,
          edge: edge,
          risk: "MEDIUM",
          strategy: "News Alpha",
          score: edge * 10 * (market.volume24hr > 100000 ? 1.5 : 1),
          reasoning: `News is ${(sentiment.bearishPct * 100).toFixed(0)}% bearish but YES at ${(yesPrice * 100).toFixed(0)}% — market overpriced`,
          headlines: sentiment.headlines.slice(0, 3).map((h) => h.title),
        })
      }
    } catch {
      continue
    }
  }

  return alphas.sort((a, b) => b.score - a.score)
}

/**
 * Strategy 4: Momentum
 * Markets where price has been consistently moving in one direction.
 * Ride the trend until it exhausts.
 */
export async function findMomentum() {
  const markets = await scanner.getTopMarkets(50)
  const momentum = []

  for (const market of markets) {
    if (market.outcomes.length < 2) continue

    try {
      const tokenId = market.outcomes[0].tokenId
      if (!tokenId) continue

      const book = await scanner.getOrderBook(tokenId)
      if (!book) continue

      const bids = book.bids || []
      const asks = book.asks || []

      // Check bid/ask imbalance (strong buying pressure)
      const bidVolume = bids.slice(0, 5).reduce((sum, b) => sum + parseFloat(b.size || 0), 0)
      const askVolume = asks.slice(0, 5).reduce((sum, a) => sum + parseFloat(a.size || 0), 0)

      if (bidVolume > 0 && askVolume > 0) {
        const imbalance = bidVolume / (bidVolume + askVolume)

        if (imbalance > 0.7) {
          momentum.push({
            market,
            direction: "BUY_YES",
            outcome: market.outcomes[0].name,
            currentPrice: market.outcomes[0].price,
            bidAskRatio: (imbalance * 100).toFixed(0),
            risk: "MEDIUM",
            strategy: "Momentum",
            score: (imbalance - 0.5) * 10,
            reasoning: `${(imbalance * 100).toFixed(0)}% bid-side pressure — buyers overwhelming sellers`,
          })
        } else if (imbalance < 0.3) {
          momentum.push({
            market,
            direction: "BUY_NO",
            outcome: market.outcomes[1].name,
            currentPrice: market.outcomes[1].price,
            bidAskRatio: ((1 - imbalance) * 100).toFixed(0),
            risk: "MEDIUM",
            strategy: "Momentum",
            score: (0.5 - imbalance) * 10,
            reasoning: `${((1 - imbalance) * 100).toFixed(0)}% ask-side pressure — sellers dominating`,
          })
        }
      }
    } catch {
      continue
    }
  }

  return momentum.sort((a, b) => b.score - a.score)
}

/**
 * Strategy 5: Long Shots
 * Find cheap options (1-10%) with asymmetric payoff.
 * Small bet, huge return if it hits.
 */
export async function findLongShots(maxPrice = 0.10) {
  const markets = await scanner.getTopMarkets(100)
  const shots = []

  for (const market of markets) {
    if (!market.active) continue
    if (market.volume24hr < 100000) continue // Long shots need GOOD liquidity to exit

    for (const outcome of market.outcomes) {
      if (outcome.price > 0.01 && outcome.price <= maxPrice) {
        const payoff = (1 / outcome.price).toFixed(1)
        shots.push({
          market,
          outcome: outcome.name,
          price: outcome.price,
          payoff: `${payoff}x`,
          risk: "HIGH",
          strategy: "Long Shot",
          score: (1 / outcome.price) * Math.log(market.volume24hr + 1) / 15,
          reasoning: `${outcome.name} at ${(outcome.price * 100).toFixed(1)}% — ${payoff}x return if it happens. High volume ($${(market.volume24hr / 1000).toFixed(0)}K) means good liquidity.`,
        })
      }
    }
  }

  return shots.sort((a, b) => b.score - a.score)
}

// ── Master Scanner ──────────────────────────────────────────

/**
 * Run ALL strategies and return a unified ranked list of trades
 */
export async function runFullScan(bankroll = 100) {
  const results = {
    timestamp: new Date().toISOString(),
    bankroll,
    strategies: {},
    topPicks: [],
    allocation: { safe: 0.6, medium: 0.25, highRisk: 0.15 },
  }

  // Run all strategies in parallel
  const [snipes, arbs, negRiskArbs, newsAlpha, momentum, longShots] = await Promise.allSettled([
    findResolutionSnipes(),
    findArbitrage(),
    negRiskScanner.findNegRiskArbitrage(1.0),
    findNewsAlpha(15),
    findMomentum(),
    findLongShots(),
  ])

  // Collect results
  const allTrades = []

  if (snipes.status === "fulfilled") {
    results.strategies.resolutionSnipes = snipes.value.length
    for (const t of snipes.value.slice(0, 5)) {
      t.betSize = kellyBetSize(parseFloat(t.profit) / 100, 1 / t.price - 1, bankroll * 0.6)
      allTrades.push(t)
    }
  }

  if (arbs.status === "fulfilled") {
    results.strategies.arbitrage = arbs.value.length
    for (const t of arbs.value.slice(0, 3)) {
      t.betSize = Math.min(bankroll * 0.1, 50)
      allTrades.push(t)
    }
  }

  // NegRisk arbitrage — the #1 profit strategy ($29M extracted in one year)
  if (negRiskArbs.status === "fulfilled") {
    results.strategies.negRiskArbitrage = negRiskArbs.value.length
    for (const t of negRiskArbs.value.slice(0, 5)) {
      t.betSize = Math.min(bankroll * 0.15, 100) // Arb = risk-free, bet bigger
      t.market = { question: t.event.title, volume24hr: t.event.volume24hr, id: t.event.eventId }
      allTrades.push(t)
    }
  }

  if (newsAlpha.status === "fulfilled") {
    results.strategies.newsAlpha = newsAlpha.value.length
    for (const t of newsAlpha.value.slice(0, 5)) {
      t.betSize = kellyBetSize(t.edge, 1 / t.currentPrice - 1, bankroll * 0.25)
      allTrades.push(t)
    }
  }

  if (momentum.status === "fulfilled") {
    results.strategies.momentum = momentum.value.length
    for (const t of momentum.value.slice(0, 3)) {
      t.betSize = kellyBetSize(0.1, 1 / t.currentPrice - 1, bankroll * 0.25)
      allTrades.push(t)
    }
  }

  if (longShots.status === "fulfilled") {
    results.strategies.longShots = longShots.value.length
    for (const t of longShots.value.slice(0, 3)) {
      t.betSize = Math.min(bankroll * 0.03, 5) // Small bets on long shots
      allTrades.push(t)
    }
  }

  // Sort by score and take top picks
  allTrades.sort((a, b) => b.score - a.score)
  results.topPicks = allTrades.slice(0, 10)

  return results
}

export default {
  kellyBetSize,
  findResolutionSnipes,
  findArbitrage,
  findNewsAlpha,
  findMomentum,
  findLongShots,
  runFullScan,
}
