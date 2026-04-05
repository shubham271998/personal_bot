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
import strategyEngine from "./strategy-engine.mjs"
import researcher from "./web-researcher.mjs"
import analyst from "./market-analyst.mjs"
import whaleTracker from "./whale-tracker.mjs"

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

// ── Category Detection ─────────────────────────────────────

const CATEGORY_PATTERNS = {
  sports: /\bvs\.?\b|versus|match|game\s+\d|nba|nfl|nhl|mlb|premier\s+league|la\s+liga|bundesliga|serie\s+a|ufc|boxing|tennis|cricket|esports|bo[1-5]|playoff|championship|super\s+bowl|world\s+cup|world\s+series|stanley\s+cup|\b(lakers|celtics|warriors|chiefs|eagles|devils|hurricanes|kraken|sabres|canucks|flames|yankees|dodgers)\b/i,
  crypto: /\bbitcoin\b|btc|\betherea?um\b|eth|\bsolana\b|sol|\bcrypto\b|token|defi|blockchain|nft|stablecoin|altcoin|mining|halving|\b(doge|xrp|ada|bnb|avax|matic|dot)\b/i,
  politics: /\belection\b|president|congress|senate|house|democrat|republican|gop|vote|ballot|poll|governor|mayor|primary|nomination|campaign|cabinet|impeach|legislation|bill\s+pass/i,
  economics: /\bfed\b|interest\s+rate|inflation|gdp|jobs?\s+report|unemployment|cpi|ppi|fomc|treasury|tariff|trade\s+war|recession|stimulus|monetary\s+policy|bps\b|basis\s+points/i,
  geopolitical: /\bwar\b|military|missile|invasion|sanction|nato|attack|ceasefire|peace\s+deal|nuclear|troops|drone\s+strike|escalat/i,
  entertainment: /\boscar|grammy|emmy|box\s+office|movie|album|artist|celebrity|award|netflix|disney/i,
}

// Categories where we can have edge via news/data analysis
const TRADEABLE_CATEGORIES = new Set(["crypto", "politics", "economics", "geopolitical"])
// Categories we can only trade on near-resolution (>90% or <10%) for snipe profit
const SNIPE_ONLY_CATEGORIES = new Set(["sports", "entertainment"])

/**
 * Detect market category from question text
 */
function detectCategory(question) {
  for (const [cat, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(question)) return cat
  }
  return "other"
}

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
 * Returns: { shouldTrade, direction, confidence, betSize, reasoning, estimatedProb, ... }
 *
 * This function asks 8 questions before allowing a trade:
 *   1. Do I understand this market category?
 *   2. Is there a real edge after costs?
 *   3. Is the market efficiently priced?
 *   4. Am I falling for longshot bias?
 *   5. What does the news say?
 *   6. What are whales doing?
 *   7. Has this strategy been profitable historically?
 *   8. Is this a good time to trade?
 */
export async function evaluateMarket(market, bankroll = 1000) {
  const result = {
    shouldTrade: false,
    direction: null,
    outcome: null,
    confidence: 0,
    estimatedProb: 0,
    realEdge: 0,
    betSize: 0,
    reasoning: [],
    score: 0,
    category: "other",
    checksDetail: {},
    checks: {
      categoryCheck: false,
      edgeCheck: false,
      efficiencyCheck: false,
      biasCheck: false,
      newsCheck: false,
      whaleCheck: false,
      researchCheck: false,
      historyCheck: false,
      timingCheck: false,
      priceRangeCheck: false,
    },
  }

  if (!market || !market.outcomes || market.outcomes.length < 2) return result
  if (market.resolved) {
    result.reasoning.push("Market already resolved")
    return result
  }

  const yesPrice = market.outcomes[0].price
  const noPrice = market.outcomes[1]?.price || 1 - yesPrice
  const question = market.question || ""

  // Pre-compute market context flags used throughout evaluation
  const isNegativeOutcome = /\bceasefire\b|peace\b|end\s+(of\s+)?(war|conflict|military)|fall\b|leave\b|resign|step\s+down|out\s+by/i.test(question)
  const isStatusQuoUnlikely = yesPrice < 0.25 // Market already thinks it's unlikely

  // ── Check 0: Category — do I understand this market? ──────
  const category = detectCategory(question)
  result.category = category

  // Research is EXPENSIVE (web search, API calls) — only run for promising markets
  // Defer research until after cheap checks pass
  let research = null

  if (SNIPE_ONLY_CATEGORIES.has(category)) {
    const isSnipeTerritory = yesPrice >= 0.93 || yesPrice <= 0.07
    const hasOddsEdge = research?.signals?.some(s => s.source === "odds_comparison" && s.strength >= 0.3)

    if (!isSnipeTerritory && !hasOddsEdge) {
      // Sports: skip UNLESS sportsbook odds show mispricing or near resolution
      result.reasoning.push(`${category.toUpperCase()} market — no sportsbook edge, not near resolution`)
      result.checks.categoryCheck = false
      result.checksDetail = { ...result.checks }
      return result
    }
    if (hasOddsEdge) {
      result.reasoning.push(`${category.toUpperCase()} market — sportsbook odds show edge!`)
    } else {
      result.reasoning.push(`${category.toUpperCase()} market — snipe territory (${(yesPrice * 100).toFixed(0)}%)`)
    }
    result.checks.categoryCheck = true
  } else if (category === "geopolitical" && isStatusQuoUnlikely) {
    // LEARNED: geopolitical "will X happen?" at <25% → almost always resolves NO
    // Only trade the NO side (betting AGAINST dramatic events happening)
    result.checks.categoryCheck = true
    result.reasoning.push(`geopolitical + unlikely (${(yesPrice * 100).toFixed(0)}%) — favor NO side (status quo wins)`)
  } else if (TRADEABLE_CATEGORIES.has(category)) {
    result.checks.categoryCheck = true
    result.reasoning.push(`${category} market — news/data edge possible`)
  } else {
    result.checks.categoryCheck = true
    result.reasoning.push(`Uncategorized market — proceeding cautiously`)
  }

  // ── Check 1: Price range safety (learned from past) ────────
  if (!adaptiveLearner.isPriceRangeSafe(yesPrice)) {
    result.reasoning.push(`Price range ${(yesPrice * 100).toFixed(0)}% disabled by adaptive learner — skip`)
    result.checks.priceRangeCheck = false
    result.checksDetail = { ...result.checks }
    return result // Hard reject — we learned this range loses money
  }
  result.checks.priceRangeCheck = true

  // ── Check 2: Is the market in the sweet spot? ──────────────
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

  // ── Check 3: Am I falling for longshot bias? ──────────────
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

  // ── Check 4: Get news sentiment ───────────────────────────
  let newsSentiment = null
  let newsSignalStrength = 0 // -1 to +1
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
        `News ${sentEmoji} ${newsSentiment.sentiment} (${newsSentiment.bullish}B/${newsSentiment.bearish}R/${newsSentiment.neutral}N, strength: ${(newsSentiment.strength * 100).toFixed(0)}%)`,
      )

      // News signal depends on category and strength
      if (TRADEABLE_CATEGORIES.has(category) && newsSentiment.strength >= 0.3) {
        newsSignalStrength = newsSentiment.sentiment === "bullish" ? newsSentiment.strength : -newsSentiment.strength
        result.checks.newsCheck = true
      } else if (newsSentiment.strength >= 0.5) {
        // Very strong news signal even for unknown categories
        newsSignalStrength = newsSentiment.sentiment === "bullish" ? newsSentiment.strength * 0.5 : -newsSentiment.strength * 0.5
        result.checks.newsCheck = true
      }
    }
  } catch {}

  // ── Check 5: Smart money / whale tracking ──────────────────
  let whaleSignal = 0
  try {
    const smartMoney = await whaleTracker.analyzeSmartMoney(market)
    if (smartMoney && smartMoney.hasSignal) {
      whaleSignal = smartMoney.direction === "YES" ? smartMoney.strength * 0.04 : smartMoney.direction === "NO" ? -smartMoney.strength * 0.04 : 0
      result.reasoning.push(
        `Smart money: ${smartMoney.direction} (${smartMoney.whaleCount} whales, ${(smartMoney.buyPressure * 100).toFixed(0)}% buy, strength ${(smartMoney.strength * 100).toFixed(0)}%)`,
      )
      result.checks.whaleCheck = true
    }
  } catch {
    // Fallback to basic order book check
    try {
      const tokenId = market.outcomes[0].tokenId
      if (tokenId) {
        const whale = await selfImprover.detectWhaleActivity(tokenId)
        if (whale && whale.whaleDirection !== "NEUTRAL") {
          const whaleStrength = Math.abs(whale.ratio - 0.5) * 2
          if (whaleStrength > 0.3) {
            whaleSignal = whale.whaleDirection === "BULLISH" ? whaleStrength * 0.04 : -whaleStrength * 0.04
            result.checks.whaleCheck = true
          }
        }
      }
    } catch {}
  }

  // ── Check 6: Trading window ───────────────────────────────
  const timingWindow = selfImprover.getTradingWindow()
  result.checks.timingCheck = timingWindow.quality !== "poor"
  if (!result.checks.timingCheck) {
    result.reasoning.push("Low liquidity window — bad time to trade")
  }

  // ── Check 7: Strategy weight from learner ─────────────────
  const stratWeight = adaptiveLearner.getStrategyWeight("Smart Brain")
  // Don't fully kill Smart Brain — it needs to keep trading (small bets) to learn and improve
  // Only pause if weight is truly at minimum (0.1)
  result.checks.historyCheck = stratWeight > 0.1
  if (!result.checks.historyCheck) {
    result.reasoning.push(`Smart Brain strategy weight at minimum (${(stratWeight * 100).toFixed(0)}%) — paused`)
  }

  // ── Run research ONLY if cheap checks look promising ────────
  const cheapChecksPassed = [result.checks.categoryCheck, result.checks.priceRangeCheck,
    result.checks.efficiencyCheck, result.checks.biasCheck, result.checks.historyCheck].filter(Boolean).length
  if (cheapChecksPassed >= 3) {
    try {
      research = await researcher.researchMarket(market, category)
    } catch {}
  }

  // ── Build probability estimate ────────────────────────────
  // PRIORITY: If Claude AI analysis is available, use it as PRIMARY signal.
  // Claude can actually READ headlines and UNDERSTAND context — keyword matching can't.
  let estimatedProb = yesPrice
  let usedClaude = false

  if ((await analyst.isAvailable()) && cheapChecksPassed >= 3) {
    try {
      // Gather context for Claude
      const headlines = []
      try {
        const news = await newsAnalyzer.searchNews(question.slice(0, 40), 6)
        headlines.push(...news)
      } catch {}

      const context = {}
      if (research?.cryptoContext) context.crypto = research.cryptoContext
      if (research?.sportsContext) context.sports = research.sportsContext
      if (research?.priceHistory) context.priceHistory = research.priceHistory

      const analysis = await analyst.analyzeMarket(market, headlines, context)
      if (analysis) {
        usedClaude = true
        result.checks.researchCheck = true

        const claudeProb = analysis.probability
        const claudeDirection = analysis.direction // YES, NO, or FAIR

        if (claudeDirection === "FAIR") {
          // Claude says fairly priced — use market price, don't trade on Smart Brain
          estimatedProb = yesPrice
          result.reasoning.push(`🧠 Claude: FAIR at ${(claudeProb * 100).toFixed(0)}% (${analysis.confidence}) — ${analysis.reasoning}`)
        } else {
          // Claude sees edge! Trust it more when it has a directional call
          // YES/NO signals are rare (only 7% of markets) — these are high-value
          const blendWeight = analysis.confidence === "high" ? 0.6 : analysis.confidence === "medium" ? 0.5 : 0.3
          estimatedProb = claudeProb * blendWeight + yesPrice * (1 - blendWeight)
          result.reasoning.push(`🧠 Claude: ${claudeDirection} ${(claudeProb * 100).toFixed(0)}% (${analysis.confidence}) — ${analysis.reasoning}`)
          result.reasoning.push(`Blend: ${(blendWeight * 100).toFixed(0)}% Claude + ${((1 - blendWeight) * 100).toFixed(0)}% market → ${(estimatedProb * 100).toFixed(1)}%`)
        }
      }
    } catch (err) {
      console.error(`[BRAIN] Claude analysis failed: ${err.message}`)
    }
  }

  // Fallback: if Claude unavailable, use signal-based estimation (capped ±5%)
  if (!usedClaude) {
    let totalAdjustment = 0
    const MAX_TOTAL_ADJUSTMENT = 0.05

    // News signal (capped, direction-aware)
    if (newsSentiment && newsSignalStrength !== 0) {
      let newsImpact = newsSignalStrength * 0.03
      if (isNegativeOutcome && newsSentiment.sentiment === "bullish") {
        newsImpact = -Math.abs(newsImpact) * 0.5
      }
      totalAdjustment += newsImpact
    }

    // Whale signal (capped)
    if (whaleSignal !== 0) {
      totalAdjustment += Math.sign(whaleSignal) * Math.min(Math.abs(whaleSignal), 0.02)
    }

    // Research signals
    if (research?.signals?.length > 0) {
      result.checks.researchCheck = true
      let researchAdj = 0
      for (const sig of research.signals) {
        let impact = sig.direction === "bullish" ? sig.strength * 0.02 : -sig.strength * 0.02
        if (isNegativeOutcome && sig.source !== "odds_comparison" && sig.direction === "bullish") {
          impact = -Math.abs(impact) * 0.5
        }
        researchAdj += impact
        result.reasoning.push(`${sig.source}: ${sig.detail}`)
      }
      totalAdjustment += Math.max(-0.03, Math.min(0.03, researchAdj))

      // Sportsbook odds override
      const oddsSignal = research.signals.find(s => s.source === "odds_comparison")
      if (oddsSignal && research.sportsbookOdds) {
        estimatedProb = research.sportsbookOdds.impliedProbability * 0.6 + yesPrice * 0.4
        totalAdjustment = 0
        result.reasoning.push(`Sportsbook: ${(research.sportsbookOdds.impliedProbability * 100).toFixed(0)}%`)
      }
    }

    // Status quo bias
    if (isStatusQuoUnlikely && totalAdjustment > 0) {
      totalAdjustment *= 0.3
    }

    totalAdjustment = Math.max(-MAX_TOTAL_ADJUSTMENT, Math.min(MAX_TOTAL_ADJUSTMENT, totalAdjustment))
    estimatedProb += totalAdjustment
    result.reasoning.push(`Signal-based (no AI): mkt ${(yesPrice * 100).toFixed(1)}% ${totalAdjustment >= 0 ? "+" : ""}${(totalAdjustment * 100).toFixed(1)}%`)
  }

  // Near-resolution momentum
  if (yesPrice > 0.90) {
    estimatedProb = Math.max(estimatedProb, yesPrice + 0.02)
  }

  // Clamp
  estimatedProb = Math.max(0.02, Math.min(0.98, estimatedProb))
  result.estimatedProb = estimatedProb

  // ── Calculate real edge ───────────────────────────────────
  const realEdge = calculateRealEdge(estimatedProb, yesPrice, market)
  result.realEdge = realEdge

  result.checks.edgeCheck = realEdge > MIN_EDGE_PCT
  if (!result.checks.edgeCheck) {
    result.reasoning.push(
      `Edge ${(realEdge * 100).toFixed(1)}% < minimum ${(MIN_EDGE_PCT * 100).toFixed(0)}% — not enough after costs`,
    )
  } else {
    result.reasoning.push(`Real edge: ${(realEdge * 100).toFixed(1)}% after costs ✅`)
  }

  // ── Count confirming signals (Livermore rule: need 2+) ────
  let confirmingSignals = 0
  if (result.checks.edgeCheck) confirmingSignals++
  if (result.checks.newsCheck) confirmingSignals++
  if (result.checks.whaleCheck) confirmingSignals++
  if (result.checks.researchCheck) confirmingSignals++ // web/social/odds/crypto research
  if (result.checks.efficiencyCheck) confirmingSignals++ // sweet spot = signal itself

  // ── Final Decision ────────────────────────────────────────
  const checksPassesd = Object.values(result.checks).filter(Boolean).length
  const totalChecks = Object.keys(result.checks).length

  // Did Claude give a directional call (YES or NO)?
  const claudeHasDirection = usedClaude && result.reasoning.some(r => r.includes("🧠 Claude: YES") || r.includes("🧠 Claude: NO"))
  const claudeSaidFair = usedClaude && result.reasoning.some(r => r.includes("🧠 Claude: FAIR"))

  if (claudeHasDirection) {
    // CLAUDE HAS AN OPINION — this is rare (only 7% of markets) and valuable
    // Relax requirements: Claude's directional call IS the edge signal
    const minEdge = 0.02 // Lower edge threshold when Claude backs it
    result.shouldTrade = realEdge > minEdge && checksPassesd >= 3
    result.reasoning.push("Claude directional call → relaxed thresholds (rare high-value signal)")
  } else if (claudeSaidFair) {
    // Claude says FAIR — no Smart Brain trade on this market
    result.shouldTrade = false
    result.reasoning.push("Claude says FAIR — no edge, skipping Smart Brain")
  } else if (!usedClaude) {
    // No Claude available — strict requirements
    const minChecks = 5
    const minEdge = 0.03
    const minSignals = 3 // Need 3+ signals without AI backing
    result.shouldTrade = checksPassesd >= minChecks && realEdge > minEdge && confirmingSignals >= minSignals
    if (!result.shouldTrade) {
      result.reasoning.push("No AI backing — strict mode, need 5 checks + 3 signals")
    }
  } else {
    // Claude available but no clear direction and not FAIR (shouldn't happen often)
    result.shouldTrade = checksPassesd >= 4 && realEdge > 0.03 && confirmingSignals >= 2
  }

  result.confidence = checksPassesd / totalChecks
  result.checksDetail = { ...result.checks }
  result.researchSummary = research ? {
    sources: research.sources?.length || 0,
    signals: research.signals?.length || 0,
    direction: research.overallDirection,
    sportsbookEdge: research.sportsbookOdds ? (research.sportsbookOdds.impliedProbability - yesPrice).toFixed(3) : null,
  } : null
  result.score = realEdge * 100 * result.confidence * (TRADEABLE_CATEGORIES.has(category) ? 1.2 : 0.8)

  if (result.shouldTrade) {
    // Determine direction — PREFER NO SIDE on geopolitical/unlikely events
    // Data: all Smart Brain losses were from buying YES on "will X happen?" markets
    if (category === "geopolitical" && isStatusQuoUnlikely) {
      // Geopolitical + unlikely = ONLY buy NO (bet against dramatic events)
      if (estimatedProb < yesPrice - TOTAL_COST_PCT) {
        result.direction = "BUY_NO"
        result.outcome = market.outcomes[1]?.name || "No"
        result.reasoning.push("Geopolitical: betting NO (status quo wins)")
      } else {
        result.shouldTrade = false
        result.reasoning.push("Geopolitical: won't buy YES on unlikely events — every time we did, we lost")
      }
    } else if (estimatedProb > yesPrice + TOTAL_COST_PCT) {
      result.direction = "BUY_YES"
      result.outcome = market.outcomes[0].name
    } else if (estimatedProb < yesPrice - TOTAL_COST_PCT) {
      result.direction = "BUY_NO"
      result.outcome = market.outcomes[1]?.name || "No"
    } else {
      result.shouldTrade = false
      result.reasoning.push("Direction unclear — skip")
    }

    // ── PRECISION SIZING — bet size scales with balance, edge, and confidence ──
    // Data shows: $10-25 bets have 100% WR and $14.85 avg profit
    // Tiny $3 bets: 41% WR, lose money. Huge $60 bets: blown up by upsets.
    // Sweet spot: $15-25 on high-conviction trades. Treat virtual as real money.
    if (result.shouldTrade) {
      const isSportsBrain = SNIPE_ONLY_CATEGORIES.has(category) || /\bvs\.?\b|win on 2026|o\/u|spread|handicap/i.test(question)

      // Scale with bankroll — deploy 85% (keep only 15% reserve, not 30%)
      // At $1,487: deployable = $1,264
      const deployable = bankroll * 0.85

      // SPREAD WIDE, BET SMALL — more markets, smaller bets, let AI find edge
      let baseBet
      if (realEdge > 0.10 && usedClaude) {
        baseBet = deployable * 0.025 // 2.5% max even on best edge
        result.reasoning.push(`HIGH EDGE ${(realEdge * 100).toFixed(0)}% + AI → small precise bet`)
      } else if (realEdge > 0.05 && usedClaude) {
        baseBet = deployable * 0.02
      } else if (realEdge > 0.05) {
        baseBet = deployable * 0.015
      } else {
        baseBet = deployable * 0.01
      }

      // Price range multiplier — 20-35% range is proven (75% WR, $1.79/trade)
      if (yesPrice >= 0.20 && yesPrice <= 0.35) {
        baseBet *= 1.3 // Boost for sweet spot range
      }

      // Lesson penalty
      const lessonPenalty = adaptiveLearner.getLessonPenalty("Smart Brain", yesPrice)
      baseBet *= lessonPenalty

      // SPORTS: hard cap $10
      if (isSportsBrain) {
        result.betSize = Math.min(baseBet, 10)
      } else {
        // Small bets, many markets — max $25 per trade
        result.betSize = Math.min(baseBet, 25)
      }

      // Floor: minimum $8 (data shows tiny bets lose money, $10-25 range is profitable)
      result.betSize = Math.max(8, Math.round(result.betSize * 100) / 100)

      result.reasoning.push(`Bet: $${result.betSize.toFixed(2)}${isSportsBrain ? ' [SPORTS $10]' : ''} (edge:${(realEdge * 100).toFixed(0)}% bankroll:$${bankroll.toFixed(0)} → ${(result.betSize/bankroll*100).toFixed(1)}%)`)
    }
  }

  result.reasoning.push(
    `Checks: ${checksPassesd}/${totalChecks} | Signals: ${confirmingSignals} | ${result.shouldTrade ? "✅ TRADE" : "❌ SKIP"}`,
  )

  return result
}

/**
 * Scan all markets through the smart brain + safe strategies
 * Returns approved trades from both Smart Brain analysis AND safe strategies (snipes, arb)
 */
export async function smartScan(bankroll = 1000) {
  // Scan ALL markets — deploy capital across the entire market
  const markets = await scanner.getTopMarkets(200)
  // Pass bankroll to strategies so sizing compounds
  const effectiveBankroll = bankroll
  const approved = []
  let skipped = 0

  // 1. Smart Brain evaluation on all markets
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

  // 2. Safe strategies: Resolution Snipes (low risk, guaranteed small profit)
  try {
    const snipes = await strategyEngine.findResolutionSnipes(0.91, 0.99) // Wider range
    for (const snipe of snipes.slice(0, 30)) { // Many small snipes across markets
      if (approved.some(a => a.market?.id === snipe.market?.id)) continue

      // Snipe sizing — scales with bankroll for compound growth
      const snipeCategory = detectCategory(snipe.market?.question || "")
      const isSportsSnipe = SNIPE_ONLY_CATEGORIES.has(snipeCategory) || /\bvs\.?\b|win on 2026|o\/u|spread|handicap/i.test(snipe.market?.question || "")
      // Small snipe bets across MANY markets — spread wide
      const betSize = isSportsSnipe
        ? Math.min(8, bankroll * 0.006) // Sports: $8 max
        : Math.min(bankroll * 0.015, 20) // Non-sports snipe: 1.5%, max $20
      approved.push({
        market: snipe.market,
        shouldTrade: true,
        direction: "BUY_YES",
        outcome: snipe.outcome,
        confidence: 0.9,
        estimatedProb: snipe.price + 0.02, // We expect it to resolve to 1.0
        realEdge: (1 - snipe.price) - TOTAL_COST_PCT,
        betSize,
        reasoning: [snipe.reasoning, `Safe snipe: ${snipe.profit}% profit if resolves`],
        score: parseFloat(snipe.profit) * 2, // Score snipes high — they're safe money
        category: "snipe",
        strategy: "Resolution Snipe",
        checksDetail: { safeStrategy: true },
      })
    }
  } catch (err) {
    console.error("[BRAIN] Snipe scan failed:", err.message)
  }

  // 3. AI Signal Trades — directly trade Claude's YES/NO directional calls
  // These are the 33 untapped signals where Claude found edge
  try {
    const researchCount = await analyst.getResearchCount()
    if (researchCount > 0) {
      for (const market of markets) {
        if (approved.some(a => a.market?.id === market.id)) continue
        if (approved.length >= 40) break // More markets — spread wide

        const research = await analyst.getCachedResearch(market.id)
        if (!research || research.direction === "FAIR") continue

        const yp = market.outcomes?.[0]?.price || 0.5
        const aiProb = research.probability
        const edge = Math.abs(aiProb - yp)

        // Only trade if edge > 5% and medium+ confidence
        if (edge < 0.05) continue
        if (research.confidence === "low") continue

        // Price range safety
        if (!adaptiveLearner.isPriceRangeSafe(yp)) continue

        const isSports = /\bvs\.?\b|win on 2026|o\/u|spread|handicap|esports/i.test(market.question || "")
        const direction = research.direction === "YES" ? "BUY_YES" : "BUY_NO"
        const outcome = direction === "BUY_YES" ? market.outcomes[0]?.name : market.outcomes[1]?.name || "No"

        // AI Signal — small precise bets, let AI research prove itself across many markets
        let betSize
        if (edge > 0.15 && research.confidence === "high") {
          betSize = bankroll * 0.02 // 2% even on best edge
        } else if (edge > 0.10) {
          betSize = bankroll * 0.015
        } else {
          betSize = bankroll * 0.01
        }
        betSize = Math.min(betSize, 25) // Max $25
        if (isSports) betSize = Math.min(betSize, 8)

        approved.push({
          market,
          shouldTrade: true,
          direction,
          outcome,
          confidence: research.confidence === "high" ? 0.85 : 0.7,
          estimatedProb: aiProb,
          realEdge: edge,
          betSize,
          reasoning: [`🧠 AI Signal: Claude says ${research.direction} at ${(aiProb * 100).toFixed(0)}% vs market ${(yp * 100).toFixed(0)}% (${(edge * 100).toFixed(1)}% edge)`, research.reasoning?.slice(0, 100)],
          score: edge * 100 * (research.confidence === "high" ? 1.5 : 1.0),
          category: "ai_signal",
          strategy: "AI Signal",
          checksDetail: { aiResearch: true, direction: research.direction },
        })
      }
    }
  } catch (err) {
    console.error("[BRAIN] AI Signal scan failed:", err.message)
  }

  // 4. Arbitrage opportunities (risk-free)
  try {
    const arbs = await strategyEngine.findArbitrage()
    for (const arb of arbs.slice(0, 3)) {
      if (approved.some(a => a.market?.id === arb.market?.id)) continue
      const betSize = Math.min(bankroll * 0.10, 50) // Up to 10% on arb — it's risk-free
      approved.push({
        market: arb.market,
        shouldTrade: true,
        direction: "ARBITRAGE",
        outcome: "BOTH",
        confidence: 0.95,
        estimatedProb: 1.0,
        realEdge: parseFloat(arb.profit) / 100,
        betSize,
        reasoning: [arb.reasoning],
        score: parseFloat(arb.profit) * 3, // Score arb highest — guaranteed profit
        category: "arbitrage",
        strategy: "Arbitrage",
        checksDetail: { safeStrategy: true },
      })
    }
  } catch (err) {
    console.error("[BRAIN] Arb scan failed:", err.message)
  }

  console.log(
    `[BRAIN] Scanned ${markets.length} markets: ${approved.length} approved (${approved.filter(a => a.strategy === "Smart Brain").length} brain + ${approved.filter(a => a.strategy === "Resolution Snipe").length} snipes + ${approved.filter(a => a.strategy === "Arbitrage").length} arb), ${skipped} skipped`,
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
    `✅ *${evaluation.direction}* (${(evaluation.confidence * 100).toFixed(0)}% confidence, est. ${(evaluation.estimatedProb * 100).toFixed(0)}% prob)\n` +
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
  detectCategory,
  TRADEABLE_CATEGORIES,
  SNIPE_ONLY_CATEGORIES,
  MIN_EDGE_PCT,
  TOTAL_COST_PCT,
}
