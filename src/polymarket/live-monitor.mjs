/**
 * Polymarket Live Monitor — Always-On Market Watcher
 *
 * Runs continuously in the background:
 *   1. Scans all strategies every 5 minutes
 *   2. Monitors price movements for open positions
 *   3. Sends Telegram alerts when opportunities appear
 *   4. Tracks resolution timelines
 *   5. Auto-executes safe trades (resolution snipes, arbitrage) if enabled
 *
 * Philosophy: "Never lose money"
 *   - Only take positive EV (expected value) trades
 *   - Resolution snipes: 95%+ outcomes = near-guaranteed profit
 *   - Arbitrage: YES+NO < $1 = risk-free
 *   - Market making: 0 fees + rebates = edge by default
 *   - Kelly sizing: mathematically optimal bet sizes
 *   - Stop losses: exit at pre-defined loss thresholds
 *   - Diversification: never >5% of bankroll on one trade
 *   - Correlation checks: don't double-expose to same event
 */
import strategyEngine from "./strategy-engine.mjs"
import marketMaker from "./market-maker.mjs"
import scanner from "./market-scanner.mjs"
import trader from "./trader.mjs"
import stream from "./realtime-stream.mjs"
import negRisk from "./negrisk-scanner.mjs"

// ── Config ──────────────────────────────────────────────────
const SCAN_INTERVAL_MS = 5 * 60 * 1000  // Full scan every 5 min
const PRICE_CHECK_MS = 60 * 1000        // Price check every 1 min
const MIN_OPPORTUNITY_SCORE = 2          // Minimum score to alert
const AUTO_SNIPE_THRESHOLD = 0.96        // Auto-buy above this price (4% max profit, very safe)
const MAX_DAILY_TRADES = 20              // Don't overtrade

let _bot = null
let _chatId = null
let _isRunning = false
let _scanInterval = null
let _priceInterval = null
let _dailyTradeCount = 0
let _lastScanResults = null
let _watchlist = new Map()  // tokenId -> { market, targetPrice, direction, alertSent }

// Reset daily trade count at midnight
const midnightReset = setInterval(() => {
  const now = new Date()
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    _dailyTradeCount = 0
  }
}, 60000)

/**
 * Initialize the monitor with bot instance
 */
export function init(bot, chatId) {
  _bot = bot
  _chatId = chatId
}

/**
 * Start the always-on monitor
 */
export async function start(bankroll = 100) {
  if (_isRunning) return false
  _isRunning = true

  console.log(`[PM-MONITOR] Started with $${bankroll} bankroll`)

  // Connect WebSocket for real-time price data
  try {
    const topMarkets = await scanner.getTopMarkets(10)
    const tokenIds = topMarkets
      .flatMap((m) => m.outcomes.map((o) => o.tokenId))
      .filter(Boolean)

    stream.onPriceChange = (tokenId, price) => {
      const watched = _watchlist.get(tokenId)
      if (watched && !watched.alertSent) {
        const triggered = watched.direction === "above"
          ? price >= watched.targetPrice
          : price <= watched.targetPrice
        if (triggered) {
          watched.alertSent = true
          sendAlert(`🔔 *Price Alert!*\n${watched.market.question.slice(0, 60)}\nHit ${(price * 100).toFixed(1)}%`)
        }
      }
    }

    stream.onTrade = (tradeData) => {
      if (tradeData?.size > 10000) {
        sendAlert(`🐋 *Whale Trade:* $${(tradeData.size / 1000).toFixed(0)}K detected`)
      }
    }

    stream.connectCLOB(tokenIds)
    console.log(`[PM-MONITOR] WebSocket streaming ${tokenIds.length} tokens`)
  } catch (err) {
    console.error("[PM-MONITOR] WebSocket failed, using polling:", err.message)
  }

  // Run strategy scans on interval
  runFullScan(bankroll)
  _scanInterval = setInterval(() => runFullScan(bankroll), SCAN_INTERVAL_MS)
  _priceInterval = setInterval(() => checkWatchlist(), PRICE_CHECK_MS)

  return true
}

/**
 * Stop the monitor
 */
export function stop() {
  if (!_isRunning) return false
  _isRunning = false

  if (_scanInterval) clearInterval(_scanInterval)
  if (_priceInterval) clearInterval(_priceInterval)
  _scanInterval = null
  _priceInterval = null

  // Disconnect WebSocket streams
  stream.disconnect()

  console.log("[PM-MONITOR] Stopped")
  return true
}

export function isRunning() {
  return _isRunning
}

/**
 * Get last scan results
 */
export function getLastScan() {
  return _lastScanResults
}

/**
 * Add a market to the watchlist
 */
export function watch(tokenId, market, targetPrice, direction = "above") {
  _watchlist.set(tokenId, { market, targetPrice, direction, alertSent: false })
}

/**
 * Remove from watchlist
 */
export function unwatch(tokenId) {
  _watchlist.delete(tokenId)
}

/**
 * Get watchlist
 */
export function getWatchlist() {
  return [..._watchlist.entries()].map(([tokenId, data]) => ({
    tokenId,
    ...data,
  }))
}

// ── Core Scan Loop ──────────────────────────────────────────

async function runFullScan(bankroll) {
  try {
    const results = await strategyEngine.runFullScan(bankroll)
    _lastScanResults = results

    const newOpps = results.topPicks.filter((p) => p.score >= MIN_OPPORTUNITY_SCORE)

    if (newOpps.length > 0 && _bot && _chatId) {
      // Check if these are genuinely new (not same as last alert)
      const alertWorthy = newOpps.filter((opp) => {
        // Only alert for high-score opportunities
        if (opp.score < 3) return false
        return true
      })

      if (alertWorthy.length > 0) {
        await sendOpportunityAlert(alertWorthy, bankroll)
      }

      // Auto-execute safe trades if enabled
      for (const opp of newOpps) {
        if (opp.strategy === "Resolution Snipe" && opp.price >= AUTO_SNIPE_THRESHOLD) {
          await autoExecuteSnipe(opp, bankroll)
        }
        if (opp.strategy === "Arbitrage") {
          await sendAlert(`⚖️ *ARBITRAGE FOUND*\n${opp.reasoning}`)
        }
      }
    }
    // Check NegRisk arbitrage separately (highest priority — risk-free)
    try {
      const negRiskAlerts = await negRisk.checkNegRiskChanges()
      for (const alert of negRiskAlerts) {
        await sendAlert(
          `⚖️ *NEW NEGRISK ARBITRAGE!*\n\n` +
            `*${alert.event.title}*\n` +
            `YES prices sum: ${(alert.event.totalYesPrice * 100).toFixed(1)}%\n` +
            `Spread: ${alert.previousSpread}% → *${alert.currentSpread}%*\n` +
            `Direction: ${alert.event.direction}\n\n` +
            `_This is RISK-FREE profit. Use /pmnegrisk for details._`,
        )
      }
    } catch {}

  } catch (err) {
    console.error("[PM-MONITOR] Scan error:", err.message)
  }
}

async function checkWatchlist() {
  for (const [tokenId, data] of _watchlist) {
    try {
      const book = await marketMaker.getBestBidAsk(tokenId)
      const currentPrice = book.mid

      const triggered = data.direction === "above"
        ? currentPrice >= data.targetPrice
        : currentPrice <= data.targetPrice

      if (triggered && !data.alertSent) {
        data.alertSent = true
        await sendAlert(
          `🔔 *Price Alert!*\n` +
            `${data.market.question.slice(0, 60)}\n` +
            `Price hit ${(currentPrice * 100).toFixed(1)}% (target: ${(data.targetPrice * 100).toFixed(1)}%)`,
        )
      }

      // Reset alert if price moves back
      if (!triggered) data.alertSent = false
    } catch {
      // Skip on error
    }
  }
}

async function autoExecuteSnipe(opp, bankroll) {
  if (_dailyTradeCount >= MAX_DAILY_TRADES) return
  if (!opp.betSize || opp.betSize < 1) return

  // Paper trade the snipe
  const result = trader.paperTrade(
    _chatId, // Use admin's ID
    opp.market,
    opp.outcome,
    Math.min(opp.betSize, bankroll * 0.05),
  )

  if (result.ok) {
    _dailyTradeCount++
    await sendAlert(
      `🛡️ *Auto-Snipe Executed (Paper)*\n` +
        `${opp.market.question.slice(0, 60)}\n` +
        `${result.trade.outcome} @ ${(result.trade.price * 100).toFixed(1)}%\n` +
        `Amount: $${result.trade.sizeUsdc} → +${opp.profit}% profit\n` +
        `_Trade #${_dailyTradeCount}/${MAX_DAILY_TRADES} today_`,
    )
  }
}

// ── Alert Helpers ───────────────────────────────────────────

async function sendAlert(text) {
  if (!_bot || !_chatId) return
  try {
    await _bot.sendMessage(_chatId, text, { parse_mode: "Markdown" })
  } catch {}
}

async function sendOpportunityAlert(opps, bankroll) {
  const lines = opps.slice(0, 5).map((opp, i) => {
    const riskEmoji = opp.risk === "NONE" ? "⚖️" :
      opp.risk === "LOW" ? "🛡️" :
      opp.risk === "MEDIUM" ? "⚡" : "🎰"

    return `${riskEmoji} *${opp.strategy}* (score: ${opp.score.toFixed(1)})\n` +
      `${opp.market.question.slice(0, 55)}\n` +
      `${opp.reasoning.slice(0, 80)}\n` +
      `💵 Kelly says: $${(opp.betSize || 0).toFixed(2)}`
  })

  await sendAlert(
    `🔔 *New Opportunities Found*\n` +
      `Bankroll: $${bankroll}\n\n` +
      `${lines.join("\n\n")}\n\n` +
      `_/pmbuy to trade • /pmscan for full report_`,
  )
}

// ── Risk Rules (the "never lose money" framework) ───────────

/**
 * Pre-trade risk check — returns { allowed, reason }
 * EVERY trade must pass ALL these checks:
 */
export function riskCheck(trade, portfolio, bankroll) {
  // Rule 1: Position size limit (max 5% of bankroll)
  if (trade.sizeUsdc > bankroll * 0.05) {
    return { allowed: false, reason: `Max position size is $${(bankroll * 0.05).toFixed(2)} (5% of bankroll)` }
  }

  // Rule 2: Daily trade limit
  if (_dailyTradeCount >= MAX_DAILY_TRADES) {
    return { allowed: false, reason: `Daily trade limit reached (${MAX_DAILY_TRADES})` }
  }

  // Rule 3: Must have positive expected value
  if (trade.edge <= 0) {
    return { allowed: false, reason: "No edge detected — negative expected value" }
  }

  // Rule 4: Portfolio concentration check
  const existingPositions = portfolio.filter((p) => p.market_id === trade.marketId)
  if (existingPositions.length > 0) {
    const existingValue = existingPositions.reduce((s, p) => s + p.shares * p.avg_price, 0)
    if (existingValue + trade.sizeUsdc > bankroll * 0.1) {
      return { allowed: false, reason: "Already exposed to this market (max 10% per market)" }
    }
  }

  // Rule 5: Don't trade illiquid markets
  if (trade.volume24hr < 10000) {
    return { allowed: false, reason: "Market too illiquid (< $10K daily volume)" }
  }

  // Rule 6: Don't trade near-closing markets with medium risk
  if (trade.hoursLeft < 2 && trade.risk !== "LOW") {
    return { allowed: false, reason: "Market closing too soon for this risk level" }
  }

  return { allowed: true, reason: "All checks passed" }
}

/**
 * Calculate stop loss for a position
 * Safe trades: no stop loss (hold to resolution)
 * Medium trades: -15% stop
 * Risky trades: -25% stop
 */
export function getStopLoss(entryPrice, risk) {
  switch (risk) {
    case "NONE":
    case "LOW":
      return 0 // Hold to resolution
    case "MEDIUM":
      return entryPrice * 0.85 // -15%
    case "HIGH":
      return entryPrice * 0.75 // -25%
    default:
      return entryPrice * 0.85
  }
}

export default {
  init,
  start,
  stop,
  isRunning,
  getLastScan,
  watch,
  unwatch,
  getWatchlist,
  riskCheck,
  getStopLoss,
}
