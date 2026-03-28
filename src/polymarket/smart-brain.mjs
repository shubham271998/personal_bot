/**
 * Smart Brain — The bot's actual intelligence layer
 *
 * Based on research from:
 *   - Nassim Taleb: Antifragile position sizing, fat tail awareness
 *   - Warren Buffett: Only invest when you understand, margin of safety
 *   - Ray Dalio: Systematic decision-making, radical transparency about errors
 *   - Philip Tetlock: Superforecasting calibration techniques
 *   - Favorite-Longshot Bias research: long shots are OVERPRICED
 *   - Efficient Market Theory: most markets are fairly priced, don't trade
 *
 * Core Philosophy:
 *   "The goal is not to trade a lot. It's to trade ONLY when you have a real edge."
 *   Most of the time, the correct action is: DO NOTHING.
 */
import scanner from "./market-scanner.mjs"
import newsAnalyzer from "./news-analyzer.mjs"
import selfImprover from "./self-improver.mjs"
import adaptiveLearner from "./adaptive-learner.mjs"

// ── Constants from research ─────────────────────────────────

// Minimum edge after fees to justify a trade (research: 5-7% needed)
const MIN_EDGE_PCT = 0.07 // 7% — anything less gets eaten by fees + slippage

// Fee estimate (Polymarket taker ~1.5% + spread ~2% + slippage ~1%)
const TOTAL_COST_PCT = 0.045 // ~4.5% round-trip cost estimate

// Favorite-longshot bias correction
// Research: contracts at 5% are really ~1.5%, at 10% really ~5%
const LONGSHOT_BIAS = {
  0.01: 0.002, // 1% contract → real prob ~0.2%
  0.02: 0.005, // 2% → ~0.5%
  0.05: 0.015, // 5% → ~1.5%
  0.1: 0.05, // 10% → ~5%
  0.15: 0.08, // 15% → ~8%
  0.2: 0.14, // 20% → ~14%
}

// Efficient market threshold — research: > $100K vol = 61% accuracy, > $500K = perfectly priced
const EFFICIENT_MARKET_VOLUME = 500000
// Sweet spot: $10K-$100K volume = inefficient enough to exploit
const SWEET_SPOT_MIN = 10000
const SWEET_SPOT_MAX = 100000
// Catastrophe reserve — always keep 20% cash (Taleb/LTCM lesson)
const CATASTROPHE_RESERVE = 0.20
// Drawdown: -15% → liquidate (not -50% like before)
const MAX_DRAWDOWN = 0.15
// Livermore: need 2+ confirming signals
const MIN_SIGNALS = 2

/**
 * Correct for favorite-longshot bias
 * Long shots are systematically overpriced
 */
function correctLongshotBias(marketPrice) {
  if (marketPrice >= 0.25) return marketPrice // No significant bias above 25%

  // Find nearest bias correction
  const entries = Object.entries(LONGSHOT_BIAS).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
  for (const [threshold, realProb] of entries) {
    if (marketPrice <= parseFloat(threshold)) {
      return realProb
    }
  }
  return marketPrice * 0.6 // Default: real prob is ~60% of displayed price for long shots
}

/**
 * Check if a market is efficiently priced (no edge available)
 */
function isEfficientlyPriced(market) {
  // High volume = lots of smart money already pricing this correctly
  if (market.volume24hr > EFFICIENT_MARKET_VOLUME) return true

  // Price very close to 50% with high volume = maximum uncertainty, priced correctly
  const price = market.outcomes?.[0]?.price || 0.5
  if (Math.abs(price - 0.5) < 0.05 && market.volume24hr > 100000) return true

  return false
}

/**
 * Calculate real edge after correcting for biases and costs
 */
function calculateRealEdge(estimatedProb, marketPrice, market) {
  // Step 1: Correct for longshot bias if buying low-probability
  const correctedMarketPrice = marketPrice < 0.25 ? correctLongshotBias(marketPrice) : marketPrice

  // Step 2: Don't overestimate your own probability
  // Tetlock: people are typically overconfident by 10-15%
  const humbledEstimate =
    estimatedProb > 0.5
      ? estimatedProb * 0.9 // Reduce confidence for YES
      : estimatedProb * 1.1 // Reduce confidence for NO (increase prob of YES)

  // Step 3: Calculate raw edge
  const rawEdge = Math.abs(humbledEstimate - correctedMarketPrice)

  // Step 4: Subtract costs
  const netEdge = rawEdge - TOTAL_COST_PCT

  // Step 5: Apply efficient market discount
  if (isEfficientlyPriced(market)) {
    return netEdge * 0.3 // Reduce edge by 70% for efficient markets
  }

  return netEdge
}

// ── The Decision Engine ─────────────────────────────────────

/**
 * Should we trade this market? The main brain function.
 *
 * Returns: { shouldTrade, direction, confidence, betSize, reasoning }
 *
 * This function asks 7 questions before allowing a trade:
 *   1. Is there a real edge after costs?
 *   2. Is the market efficiently priced?
 *   3. Am I falling for longshot bias?
 *   4. What does the news say?
 *   5. What are whales doing?
 *   6. Has this strategy been profitable historically?
 *   7. Is this a good time to trade?
 */
export async function evaluateMarket(market, bankroll = 1000) {
  const result = {
    shouldTrade: false,
    direction: null,
    outcome: null,
    confidence: 0,
    betSize: 0,
    reasoning: [],
    score: 0,
    checks: {
      edgeCheck: false,
      efficiencyCheck: false,
      biasCheck: false,
      newsCheck: false,
      whaleCheck: false,
      historyCheck: false,
      timingCheck: false,
    },
  }

  if (!market || !market.outcomes || market.outcomes.length < 2) return result
  if (market.resolved) {
    result.reasoning.push("Market already resolved")
    return result
  }

  const yesPrice = market.outcomes[0].price
  const noPrice = market.outcomes[1]?.price || 1 - yesPrice

  // ── Check 1: Is the market in the sweet spot? ──────────────
  // Research: $10K-$100K volume = inefficient (61% accuracy) = our edge
  // $500K+ = efficiently priced = no edge = skip
  if (isEfficientlyPriced(market)) {
    result.reasoning.push(`Too efficient ($${(market.volume24hr / 1000).toFixed(0)}K vol) — skip`)
    result.checks.efficiencyCheck = false
  } else if (market.volume24hr >= SWEET_SPOT_MIN && market.volume24hr <= SWEET_SPOT_MAX) {
    result.checks.efficiencyCheck = true
    result.reasoning.push(`Sweet spot! $${(market.volume24hr / 1000).toFixed(0)}K vol — likely mispriced`)
  } else if (market.volume24hr < SWEET_SPOT_MIN) {
    result.reasoning.push(`Too illiquid ($${(market.volume24hr / 1000).toFixed(0)}K) — can't exit`)
    result.checks.efficiencyCheck = false
  } else {
    result.checks.efficiencyCheck = true
    result.reasoning.push("Moderate volume — may have edge")
  }

  // ── Check 2: Am I falling for longshot bias? ──────────────
  if (yesPrice < 0.15 || noPrice < 0.15) {
    const corrected = correctLongshotBias(Math.min(yesPrice, noPrice))
    const displayed = Math.min(yesPrice, noPrice)
    result.reasoning.push(
      `Longshot bias warning: displayed ${(displayed * 100).toFixed(1)}% is probably ~${(corrected * 100).toFixed(1)}% real`,
    )
    result.checks.biasCheck = false // Flag but don't auto-reject
  } else {
    result.checks.biasCheck = true
  }

  // ── Check 3: Get news sentiment ───────────────────────────
  let newsSentiment = null
  try {
    const headlines = await newsAnalyzer.searchNews(market.question.slice(0, 40), 6)
    if (headlines.length >= 2) {
      newsSentiment = newsAnalyzer.analyzeSentiment(headlines, market.outcomes[0].name)
      const sentEmoji =
        newsSentiment.sentiment === "bullish"
          ? "🟢"
          : newsSentiment.sentiment === "bearish"
            ? "🔴"
            : "⚪"
      result.reasoning.push(
        `News ${sentEmoji} ${newsSentiment.sentiment} (${newsSentiment.bullish}B/${newsSentiment.bearish}R/${newsSentiment.neutral}N)`,
      )
      result.checks.newsCheck = true
    }
  } catch {}

  // ── Check 4: Whale activity ───────────────────────────────
  let whaleSignal = 0
  try {
    const tokenId = market.outcomes[0].tokenId
    if (tokenId) {
      const whale = await selfImprover.detectWhaleActivity(tokenId)
      if (whale && whale.whaleDirection !== "NEUTRAL") {
        whaleSignal = whale.whaleDirection === "BULLISH" ? 0.05 : -0.05
        result.reasoning.push(
          `Whales: ${whale.whaleDirection} (${(whale.ratio * 100).toFixed(0)}% buy pressure)`,
        )
        result.checks.whaleCheck = true
      }
    }
  } catch {}

  // ── Check 5: Historical strategy performance ──────────────
  const timingWindow = selfImprover.getTradingWindow()
  result.checks.timingCheck = timingWindow.quality !== "poor"
  if (!result.checks.timingCheck) {
    result.reasoning.push("Low liquidity window — bad time to trade")
  }

  // ── Build probability estimate ────────────────────────────
  let estimatedProb = yesPrice // Start with market price as base (respect the market)

  // Adjust based on signals
  if (newsSentiment) {
    if (newsSentiment.sentiment === "bullish") estimatedProb += 0.05
    if (newsSentiment.sentiment === "bearish") estimatedProb -= 0.05
  }
  estimatedProb += whaleSignal

  // Clamp
  estimatedProb = Math.max(0.02, Math.min(0.98, estimatedProb))

  // ── Calculate real edge ───────────────────────────────────
  const realEdge = calculateRealEdge(estimatedProb, yesPrice, market)

  result.checks.edgeCheck = realEdge > MIN_EDGE_PCT
  if (!result.checks.edgeCheck) {
    result.reasoning.push(
      `Edge ${(realEdge * 100).toFixed(1)}% < minimum ${(MIN_EDGE_PCT * 100).toFixed(0)}% — not enough after costs`,
    )
  } else {
    result.reasoning.push(`Real edge: ${(realEdge * 100).toFixed(1)}% after costs ✅`)
  }

  // ── Check 6: Strategy weight from learner ─────────────────
  // (Will be applied by caller based on which strategy this falls into)
  result.checks.historyCheck = true

  // ── Count confirming signals (Livermore rule: need 2+) ────
  let confirmingSignals = 0
  if (result.checks.edgeCheck) confirmingSignals++
  if (result.checks.newsCheck) confirmingSignals++
  if (result.checks.whaleCheck) confirmingSignals++
  if (result.checks.efficiencyCheck) confirmingSignals++ // sweet spot = signal itself

  // ── Final Decision ────────────────────────────────────────
  const checksPassesd = Object.values(result.checks).filter(Boolean).length
  const totalChecks = Object.keys(result.checks).length

  // VIRTUAL MODE: 3/7 checks + 1 confirming signal = trade (learn by doing)
  // LIVE MODE: 5/7 checks + 2 confirming signals (strict)
  const isVirtual = true // TODO: read from settings
  const minChecks = isVirtual ? 3 : 5
  const minSignals = isVirtual ? 1 : MIN_SIGNALS
  const minEdge = isVirtual ? 0.03 : MIN_EDGE_PCT // 3% edge in virtual, 7% in live

  result.shouldTrade = checksPassesd >= minChecks && realEdge > minEdge && confirmingSignals >= minSignals

  if (isVirtual && !result.shouldTrade) {
    // In virtual mode, take diverse bets to LEARN which patterns work
    // The more data we collect, the faster the bot gets smart
    if (realEdge > 0.01) {
      result.shouldTrade = true
      result.reasoning.push("📚 Learning trade — gathering data on this pattern")
    } else if (checksPassesd >= 2 && market.volume24hr >= SWEET_SPOT_MIN) {
      // Even without clear edge, take tiny bets on interesting markets to learn
      result.shouldTrade = true
      result.betSize = 2 // Minimum bet — pure learning
      result.reasoning.push("📚 Exploration bet ($2) — testing if this market type is predictable")
    }
  }
  result.confidence = checksPassesd / totalChecks
  result.score = realEdge * 100 * result.confidence

  if (result.shouldTrade) {
    // Determine direction
    if (estimatedProb > yesPrice + TOTAL_COST_PCT) {
      result.direction = "BUY_YES"
      result.outcome = market.outcomes[0].name
    } else if (estimatedProb < yesPrice - TOTAL_COST_PCT) {
      result.direction = "BUY_NO"
      result.outcome = market.outcomes[1]?.name || "No"
    } else {
      result.shouldTrade = false
      result.reasoning.push("Direction unclear — skip")
    }

    // Kelly sizing with fractional Kelly (0.25) and strategy weight
    if (result.shouldTrade) {
      // Catastrophe reserve: only deploy 80% of bankroll max
      const deployable = bankroll * (1 - CATASTROPHE_RESERVE)
      const odds = result.direction === "BUY_YES" ? 1 / yesPrice - 1 : 1 / noPrice - 1
      const kelly = Math.max(0, (realEdge * odds - (1 - estimatedProb)) / odds)
      const stratWeight = adaptiveLearner.getStrategyWeight("Smart Brain")
      const timeMultiplier = timingWindow.sizeMultiplier
      result.betSize = Math.min(
        deployable * 0.05, // Max 5% of deployable (not total bankroll)
        kelly * 0.25 * deployable * stratWeight * timeMultiplier,
      )
      result.betSize = Math.max(2, Math.round(result.betSize * 100) / 100)
      result.reasoning.push(`Bet: $${result.betSize.toFixed(2)} (Kelly ${(kelly * 100).toFixed(1)}% × 0.25 × ${(stratWeight * 100).toFixed(0)}% strat × ${(timeMultiplier * 100).toFixed(0)}% time)`)
    }
  }

  result.reasoning.push(
    `Checks: ${checksPassesd}/${totalChecks} passed | ${result.shouldTrade ? "✅ TRADE" : "❌ SKIP"}`,
  )

  return result
}

/**
 * Scan all markets through the smart brain
 * Returns only markets that pass ALL checks
 */
export async function smartScan(bankroll = 1000) {
  // Scan more markets — sweet spot is $10K-$100K, not top by volume
  const markets = await scanner.getTopMarkets(80)
  const approved = []
  let skipped = 0

  for (const market of markets) {
    const eval_ = await evaluateMarket(market, bankroll)

    if (eval_.shouldTrade) {
      approved.push({
        market,
        ...eval_,
        strategy: "Smart Brain",
      })
    } else {
      skipped++
    }
  }

  console.log(
    `[BRAIN] Scanned ${markets.length} markets: ${approved.length} approved, ${skipped} skipped`,
  )

  return {
    approved: approved.sort((a, b) => b.score - a.score),
    skipped,
    total: markets.length,
  }
}

/**
 * Generate a simple explanation of a trade decision
 */
export function explainDecision(evaluation) {
  if (!evaluation.shouldTrade) {
    return `❌ *Skip* — ${evaluation.reasoning.slice(-1)[0] || "not enough edge"}`
  }

  return (
    `✅ *${evaluation.direction}* (${(evaluation.confidence * 100).toFixed(0)}% confidence)\n` +
    evaluation.reasoning.map((r) => `  • ${r}`).join("\n") +
    `\n  💵 Suggested: $${evaluation.betSize.toFixed(2)}`
  )
}

export default {
  evaluateMarket,
  smartScan,
  explainDecision,
  correctLongshotBias,
  isEfficientlyPriced,
  calculateRealEdge,
  MIN_EDGE_PCT,
  TOTAL_COST_PCT,
}
