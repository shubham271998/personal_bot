/**
 * Polymarket Auto-Analyst — Autonomous Market Intelligence
 *
 * Runs 24/7 without user input:
 *   1. Proactively sends market analysis with simple charts
 *   2. Auto-manages watchlist (adds/removes based on opportunity)
 *   3. Self-evaluates predictions vs outcomes (learns from mistakes)
 *   4. Stores all evaluations for continuous improvement
 *   5. Sends daily briefings + instant alerts
 */
import scanner from "./market-scanner.mjs"
import negRisk from "./negrisk-scanner.mjs"
import newsAnalyzer from "./news-analyzer.mjs"
import strategyEngine from "./strategy-engine.mjs"
import selfImprover from "./self-improver.mjs"
import adaptiveLearner from "./adaptive-learner.mjs"
import smartBrain from "./smart-brain.mjs"
import db from "../database.mjs"

// ── Deduplication — track what we've already notified/traded ─
const _notifiedMarkets = new Map()  // marketId -> timestamp (last notified)
const _tradedMarkets = new Set()    // marketId (already have a position)
const NOTIFY_COOLDOWN_MS = 4 * 60 * 60 * 1000  // Don't re-notify same market for 4 hours
const PREDICTION_COOLDOWN_MS = 2 * 60 * 60 * 1000  // Don't re-predict same market for 2 hours
const _predictedMarkets = new Map() // marketId -> timestamp

function shouldNotify(marketId) {
  const last = _notifiedMarkets.get(marketId)
  if (last && Date.now() - last < NOTIFY_COOLDOWN_MS) return false
  _notifiedMarkets.set(marketId, Date.now())
  return true
}

function shouldPredict(marketId) {
  const last = _predictedMarkets.get(marketId)
  if (last && Date.now() - last < PREDICTION_COOLDOWN_MS) return false
  _predictedMarkets.set(marketId, Date.now())
  return true
}

// Cleanup old entries every hour
setInterval(() => {
  const cutoff = Date.now() - NOTIFY_COOLDOWN_MS * 2
  for (const [k, v] of _notifiedMarkets) { if (v < cutoff) _notifiedMarkets.delete(k) }
  for (const [k, v] of _predictedMarkets) { if (v < cutoff) _predictedMarkets.delete(k) }
}, 3600000)

// ── Safe Telegram sender (handles markdown errors) ──────────
function escapeMarkdown(text) {
  if (!text) return ""
  return text.replace(/([*_`\[\]])/g, "\\$1")
}

async function safeSend(bot, chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...opts })
  } catch {
    // Markdown failed — send as plain text (strip markdown)
    const plain = text.replace(/\*|_|`/g, "").replace(/\\/g, "")
    return await bot.sendMessage(chatId, plain).catch(() => {})
  }
}

// ── DB Tables for self-evaluation ───────────────────────────
db.raw.exec(`
  CREATE TABLE IF NOT EXISTS pm_predictions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id    TEXT,
    market_question TEXT,
    predicted_outcome TEXT,
    predicted_prob REAL,
    market_price  REAL,
    confidence    REAL,
    reasoning     TEXT,
    status        TEXT DEFAULT 'open',
    actual_outcome TEXT,
    was_correct   INTEGER,
    profit_if_bet REAL,
    evaluated_at  TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pm_eval_scores (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    period       TEXT,
    total_predictions INTEGER,
    correct      INTEGER,
    accuracy     REAL,
    avg_confidence REAL,
    calibration_error REAL,
    profit_score REAL,
    notes        TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pm_auto_watchlist (
    token_id     TEXT PRIMARY KEY,
    market_id    TEXT,
    market_question TEXT,
    added_reason TEXT,
    entry_price  REAL,
    current_price REAL,
    target_price REAL,
    direction    TEXT,
    score        REAL,
    last_checked TEXT DEFAULT (datetime('now')),
    created_at   TEXT DEFAULT (datetime('now'))
  );
`)

const stmts = {
  addPrediction: db.raw.prepare(`
    INSERT INTO pm_predictions (market_id, market_question, predicted_outcome, predicted_prob, market_price, confidence, reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getOpenPredictions: db.raw.prepare(`SELECT * FROM pm_predictions WHERE status = 'open'`),
  evaluatePrediction: db.raw.prepare(`
    UPDATE pm_predictions SET status = 'evaluated', actual_outcome = ?, was_correct = ?, profit_if_bet = ?, evaluated_at = datetime('now')
    WHERE id = ?
  `),
  getRecentEvals: db.raw.prepare(`
    SELECT * FROM pm_predictions WHERE status = 'evaluated' ORDER BY evaluated_at DESC LIMIT ?
  `),
  getAccuracy: db.raw.prepare(`
    SELECT COUNT(*) as total, SUM(was_correct) as correct,
           AVG(confidence) as avg_conf, AVG(predicted_prob) as avg_pred_prob
    FROM pm_predictions WHERE status = 'evaluated'
  `),
  saveEvalScore: db.raw.prepare(`
    INSERT INTO pm_eval_scores (period, total_predictions, correct, accuracy, avg_confidence, calibration_error, profit_score, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getEvalHistory: db.raw.prepare(`SELECT * FROM pm_eval_scores ORDER BY created_at DESC LIMIT ?`),

  // Auto watchlist
  upsertWatch: db.raw.prepare(`
    INSERT INTO pm_auto_watchlist (token_id, market_id, market_question, added_reason, entry_price, current_price, target_price, direction, score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_id) DO UPDATE SET current_price = excluded.current_price, last_checked = datetime('now'), score = excluded.score
  `),
  getWatchlist: db.raw.prepare(`SELECT * FROM pm_auto_watchlist ORDER BY score DESC`),
  removeWatch: db.raw.prepare(`DELETE FROM pm_auto_watchlist WHERE token_id = ?`),
  updateWatchPrice: db.raw.prepare(`UPDATE pm_auto_watchlist SET current_price = ?, last_checked = datetime('now') WHERE token_id = ?`),
}

// ── Chart Generation (text-based for Telegram) ──────────────

function makeBarChart(items, maxWidth = 20) {
  if (items.length === 0) return ""
  const maxVal = Math.max(...items.map((i) => i.value))
  return items.map((item) => {
    const barLen = maxVal > 0 ? Math.round((item.value / maxVal) * maxWidth) : 0
    const bar = "█".repeat(barLen) + "░".repeat(maxWidth - barLen)
    return `${item.label.padEnd(15)} ${bar} ${item.display}`
  }).join("\n")
}

function makeMiniChart(prices, width = 20) {
  if (prices.length < 2) return ""
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const range = max - min || 1
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

  // Sample prices to fit width
  const step = Math.max(1, Math.floor(prices.length / width))
  let chart = ""
  for (let i = 0; i < prices.length; i += step) {
    const normalized = (prices[i] - min) / range
    const blockIdx = Math.min(7, Math.floor(normalized * 8))
    chart += blocks[blockIdx]
  }

  const trend = prices[prices.length - 1] > prices[0] ? "📈" : prices[prices.length - 1] < prices[0] ? "📉" : "➡️"
  return `${chart} ${trend}`
}

// ── Core Analysis Functions ─────────────────────────────────

/**
 * Generate a full market briefing (sent proactively)
 */
export async function generateBriefing() {
  const markets = await scanner.getTopMarkets(15)
  const scan = await strategyEngine.runFullScan(100)

  const tag = process.platform === "darwin" ? "🏠" : "☁️"
  let msg = `${tag} *Market Briefing*\n`
  msg += `_${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}_\n\n`

  // Top movers
  msg += `*🔥 Hot Markets:*\n`
  for (const m of markets.slice(0, 5)) {
    const yesPrice = m.outcomes[0]?.price || 0
    const chartItems = m.outcomes.slice(0, 2).map((o) => ({
      label: o.name.slice(0, 14),
      value: o.price * 100,
      display: `${(o.price * 100).toFixed(0)}%`,
    }))
    msg += `\n*${escapeMarkdown(m.question.slice(0, 55))}*\n`
    msg += `\`\`\`\n${makeBarChart(chartItems)}\n\`\`\`\n`
    msg += `Vol: $${(m.volume24hr / 1000).toFixed(0)}K\n`
  }

  // Strategy picks
  if (scan.topPicks.length > 0) {
    msg += `\n*🎯 My Picks Right Now:*\n`
    for (const pick of scan.topPicks.slice(0, 3)) {
      const emoji = pick.risk === "NONE" ? "⚖️" : pick.risk === "LOW" ? "🛡️" : pick.risk === "MEDIUM" ? "⚡" : "🎰"
      msg += `\n${emoji} *${pick.strategy}*\n`
      msg += `${escapeMarkdown(pick.market?.question?.slice(0, 50) || "Unknown")}\n`
      msg += `${pick.reasoning?.slice(0, 80) || ""}\n`
      msg += `💵 Suggested: $${(pick.betSize || 0).toFixed(2)}\n`
    }
  } else {
    msg += `\n_No strong picks right now. Markets look fairly priced._\n`
  }

  return msg
}

/**
 * Analyze a specific market with simple explanation + chart
 */
export async function analyzeMarketSimple(market) {
  const yesPrice = market.outcomes[0]?.price || 0
  const noPrice = market.outcomes[1]?.price || 0

  // Get news
  let newsText = ""
  try {
    const headlines = await newsAnalyzer.searchNews(market.question.slice(0, 40), 5)
    const sentiment = newsAnalyzer.analyzeSentiment(headlines, market.outcomes[0]?.name)
    const sentEmoji = sentiment.sentiment === "bullish" ? "🟢" : sentiment.sentiment === "bearish" ? "🔴" : "⚪"
    newsText = `\n*What the news says:* ${sentEmoji} ${sentiment.sentiment}\n`
    if (headlines.length > 0) {
      newsText += headlines.slice(0, 3).map((h) => `• ${h.title.slice(0, 60)}`).join("\n") + "\n"
    }
  } catch {}

  // Simple bar chart
  const chart = makeBarChart(
    market.outcomes.slice(0, 2).map((o) => ({
      label: o.name.slice(0, 14),
      value: o.price * 100,
      display: `${(o.price * 100).toFixed(1)}%`,
    })),
  )

  // My take
  let myTake = ""
  if (yesPrice > 0.90) myTake = "Looks almost certain. Safe to snipe if you want a small guaranteed profit."
  else if (yesPrice < 0.10) myTake = "Very unlikely to happen. Could be a lottery ticket if you have a reason."
  else if (yesPrice >= 0.51 && yesPrice <= 0.67) myTake = "⚠️ Danger zone (51-67%). Most losses happen here. I'd avoid this one."
  else if (yesPrice > 0.67) myTake = "Leaning YES but not certain. Only bet if you have strong conviction."
  else if (yesPrice < 0.51 && yesPrice > 0.10) myTake = "Market thinks it's unlikely. Check the news — could be underpriced."

  return {
    text: `*${market.question}*\n\n` +
      `\`\`\`\n${chart}\n\`\`\`\n` +
      `📊 Volume: $${(market.volume24hr / 1000).toFixed(0)}K/24h\n` +
      newsText +
      `\n*My take:* ${myTake}\n`,
    yesPrice,
    noPrice,
  }
}

// ── Self-Evaluation System ──────────────────────────────────

/**
 * Record a prediction for future evaluation
 */
export function recordPrediction(marketId, question, predictedOutcome, predictedProb, marketPrice, confidence, reasoning) {
  stmts.addPrediction.run(marketId, question, predictedOutcome, predictedProb, marketPrice, confidence, reasoning)
}

/**
 * Check open predictions against resolved markets
 */
export async function evaluateOpenPredictions() {
  const open = stmts.getOpenPredictions.all()
  const evaluated = []

  for (const pred of open) {
    try {
      const market = await scanner.getMarket(pred.market_id)
      if (!market || market.active) continue // Still open

      // Market resolved — check if we were right
      const resolvedOutcome = market.outcomes.find((o) => o.price >= 0.99)?.name || "Unknown"
      const wasCorrect = resolvedOutcome.toLowerCase().includes(pred.predicted_outcome.toLowerCase()) ? 1 : 0
      const profitIfBet = wasCorrect ? (1 - pred.market_price) : -pred.market_price

      stmts.evaluatePrediction.run(resolvedOutcome, wasCorrect, profitIfBet, pred.id)
      evaluated.push({ ...pred, actual_outcome: resolvedOutcome, was_correct: wasCorrect, profit_if_bet: profitIfBet })
    } catch {
      continue
    }
  }

  return evaluated
}

/**
 * Generate self-evaluation report
 */
export function getEvalReport() {
  const stats = stmts.getAccuracy.get()
  const recent = stmts.getRecentEvals.all(10)

  if (!stats || stats.total === 0) {
    return { text: "No predictions evaluated yet. I'll start tracking soon!", stats: null }
  }

  const accuracy = (stats.correct / stats.total * 100).toFixed(1)
  const calibrationError = Math.abs(stats.avg_pred_prob - stats.correct / stats.total)

  // Rating based on accuracy
  let rating = "🔴 Needs improvement"
  if (accuracy >= 70) rating = "🟡 Getting better"
  if (accuracy >= 80) rating = "🟢 Good"
  if (accuracy >= 90) rating = "⭐ Excellent"

  const recentLines = recent.slice(0, 5).map((r) => {
    const icon = r.was_correct ? "✅" : "❌"
    return `${icon} ${r.market_question.slice(0, 40)}\n   Predicted: ${r.predicted_outcome} (${(r.predicted_prob * 100).toFixed(0)}%) | Actual: ${r.actual_outcome}`
  })

  return {
    text: `*🧠 Self-Evaluation Report*\n\n` +
      `*Overall:* ${rating}\n` +
      `Accuracy: *${accuracy}%* (${stats.correct}/${stats.total})\n` +
      `Avg confidence: ${(stats.avg_conf * 100).toFixed(0)}%\n` +
      `Calibration error: ${(calibrationError * 100).toFixed(1)}%\n\n` +
      (recentLines.length > 0 ? `*Recent Predictions:*\n${recentLines.join("\n\n")}\n\n` : "") +
      `_Lower calibration error = better. I'm learning from every prediction._`,
    stats: { accuracy, total: stats.total, correct: stats.correct, calibrationError },
  }
}

/**
 * Save periodic evaluation score (for tracking improvement over time)
 */
export function saveEvalScore() {
  const stats = stmts.getAccuracy.get()
  if (!stats || stats.total === 0) return

  const accuracy = stats.correct / stats.total
  const calibrationError = Math.abs(stats.avg_pred_prob - accuracy)
  const period = new Date().toISOString().split("T")[0]

  stmts.saveEvalScore.run(
    period, stats.total, stats.correct, accuracy,
    stats.avg_conf, calibrationError, 0, null,
  )
}

// ── Auto-Watchlist Management ───────────────────────────────

/**
 * Auto-decide what to watch based on current market conditions
 */
export async function autoManageWatchlist() {
  const markets = await scanner.getTopMarkets(30)
  const added = []
  const removed = []

  for (const market of markets) {
    if (market.outcomes.length < 2) continue
    const outcome = market.outcomes[0]
    if (!outcome.tokenId) continue

    const yesPrice = outcome.price
    const score = calculateWatchScore(market)

    // Add if interesting enough
    if (score > 3) {
      let reason = ""
      if (yesPrice >= 0.90) reason = "Near resolution — snipe opportunity"
      else if (yesPrice <= 0.10) reason = "Long shot — watching for movement"
      else if (market.volume24hr > 500000) reason = "High volume — something's happening"
      else reason = "Interesting odds movement"

      stmts.upsertWatch.run(
        outcome.tokenId, market.id, market.question.slice(0, 200),
        reason, yesPrice, yesPrice,
        yesPrice > 0.5 ? 1.0 : 0.0, // Target: resolution
        yesPrice > 0.5 ? "above" : "below",
        score,
      )
      added.push(market.question.slice(0, 40))
    }
  }

  // Remove stale watches (markets that resolved or lost interest)
  const watchlist = stmts.getWatchlist.all()
  for (const w of watchlist) {
    try {
      const market = await scanner.getMarket(w.market_id)
      if (!market || !market.active) {
        stmts.removeWatch.run(w.token_id)
        removed.push(w.market_question.slice(0, 40))
      }
    } catch {
      continue
    }
  }

  return { added, removed, total: stmts.getWatchlist.all().length }
}

function calculateWatchScore(market) {
  let score = 0
  const price = market.outcomes[0]?.price || 0.5

  // High volume = noteworthy
  if (market.volume24hr > 1000000) score += 3
  else if (market.volume24hr > 500000) score += 2
  else if (market.volume24hr > 100000) score += 1

  // Near resolution prices (snipe territory)
  if (price >= 0.93 || price <= 0.07) score += 3

  // Ending soon
  if (market.endDate) {
    const hoursLeft = (new Date(market.endDate) - Date.now()) / 3600000
    if (hoursLeft > 0 && hoursLeft < 48) score += 2
  }

  // Avoid dead zone
  if (price >= 0.51 && price <= 0.67) score -= 2

  return score
}

/**
 * Get current auto-watchlist
 */
export function getAutoWatchlist() {
  return stmts.getWatchlist.all()
}

// ── Virtual Trading Engine ──────────────────────────────────
// Bot auto-trades with virtual $1000 bankroll, tracks everything

db.raw.exec(`
  CREATE TABLE IF NOT EXISTS pm_virtual_portfolio (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id    TEXT,
    market_question TEXT,
    outcome      TEXT,
    side         TEXT,
    entry_price  REAL,
    shares       REAL,
    size_usdc    REAL,
    strategy     TEXT,
    status       TEXT DEFAULT 'open',
    exit_price   REAL,
    pnl          REAL DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now')),
    closed_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS pm_virtual_stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT UNIQUE,
    starting_balance REAL,
    ending_balance REAL,
    trades_opened INTEGER DEFAULT 0,
    trades_closed INTEGER DEFAULT 0,
    wins         INTEGER DEFAULT 0,
    losses       INTEGER DEFAULT 0,
    day_pnl      REAL DEFAULT 0,
    total_pnl    REAL DEFAULT 0,
    win_rate     REAL DEFAULT 0,
    best_trade   REAL DEFAULT 0,
    worst_trade  REAL DEFAULT 0,
    rating       TEXT DEFAULT '🔴'
  );
`)

const virtualStmts = {
  openPosition: db.raw.prepare(`
    INSERT INTO pm_virtual_portfolio (market_id, market_question, outcome, side, entry_price, shares, size_usdc, strategy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getOpenPositions: db.raw.prepare(`SELECT * FROM pm_virtual_portfolio WHERE status = 'open'`),
  closePosition: db.raw.prepare(`
    UPDATE pm_virtual_portfolio SET status = 'closed', exit_price = ?, pnl = ?, closed_at = datetime('now')
    WHERE id = ?
  `),
  getAllPositions: db.raw.prepare(`SELECT * FROM pm_virtual_portfolio ORDER BY created_at DESC LIMIT ?`),
  getVirtualPnL: db.raw.prepare(`
    SELECT COALESCE(SUM(pnl), 0) as total_pnl,
           COUNT(*) as total_trades,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
           MAX(pnl) as best_trade,
           MIN(pnl) as worst_trade,
           COALESCE(SUM(size_usdc), 0) as total_volume
    FROM pm_virtual_portfolio WHERE status = 'closed'
  `),
  getTodayPnL: db.raw.prepare(`
    SELECT COALESCE(SUM(pnl), 0) as day_pnl, COUNT(*) as trades
    FROM pm_virtual_portfolio WHERE status = 'closed' AND date(closed_at) = date('now')
  `),
  getOpenValue: db.raw.prepare(`
    SELECT COALESCE(SUM(size_usdc), 0) as total_invested FROM pm_virtual_portfolio WHERE status = 'open'
  `),
  upsertDailyStats: db.raw.prepare(`
    INSERT INTO pm_virtual_stats (date, starting_balance, ending_balance, trades_opened, trades_closed, wins, losses, day_pnl, total_pnl, win_rate, best_trade, worst_trade, rating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET ending_balance=excluded.ending_balance, trades_closed=excluded.trades_closed,
    wins=excluded.wins, losses=excluded.losses, day_pnl=excluded.day_pnl, total_pnl=excluded.total_pnl,
    win_rate=excluded.win_rate, best_trade=excluded.best_trade, worst_trade=excluded.worst_trade, rating=excluded.rating
  `),
  getDailyStats: db.raw.prepare(`SELECT * FROM pm_virtual_stats ORDER BY date DESC LIMIT ?`),
}

const VIRTUAL_BANKROLL = 1000
const VIRTUAL_MAX_BET = 30 // $30 max per trade (smaller bets, more learning)
const VIRTUAL_MAX_OPEN = 20 // Max 20 open positions (more data points)

/**
 * Auto-trade based on scan results — bot decides and executes virtually
 */
async function autoVirtualTrade(scanResults) {
  const openPositions = virtualStmts.getOpenPositions.all()
  const openValue = virtualStmts.getOpenValue.get()?.total_invested || 0
  const pnlData = virtualStmts.getVirtualPnL.get()
  const currentBalance = VIRTUAL_BANKROLL + (pnlData?.total_pnl || 0)
  const availableCapital = currentBalance - openValue
  let tradesPlaced = 0

  // Drawdown check — reduce or stop trading if losing too much
  const peakBalance = VIRTUAL_BANKROLL // Simple: use starting balance as peak
  const drawdownKelly = selfImprover.getDrawdownAdjustedKelly(1.0, currentBalance, peakBalance)
  if (drawdownKelly === 0) {
    console.log(`[VIRTUAL] HALTED — drawdown too deep. Balance: $${currentBalance.toFixed(2)}`)
    return 0
  }

  // Time-of-day check — trade smaller during low liquidity
  const tradingWindow = selfImprover.getTradingWindow()
  const timeMultiplier = tradingWindow.sizeMultiplier

  console.log(`[VIRTUAL] Scan: ${scanResults.topPicks.length} picks | Open: ${openPositions.length}/${VIRTUAL_MAX_OPEN} | Balance: $${currentBalance.toFixed(2)} | Window: ${tradingWindow.window} (${tradingWindow.quality}) | Drawdown adj: ${(drawdownKelly * 100).toFixed(0)}%`)

  for (const pick of scanResults.topPicks) {
    if (openPositions.length + tradesPlaced >= VIRTUAL_MAX_OPEN) break
    if (pick.score < 0.5) continue
    if (!pick.market?.id) continue

    // Don't double up on same market (check DB + in-memory)
    const mId = pick.market?.id || pick.event?.eventId || ""
    if (!mId) continue
    if (openPositions.some((p) => p.market_id === mId)) continue
    if (_tradedMarkets.has(mId)) continue

    // Get adaptive strategy weight (learned from past performance)
    const strategyWeight = adaptiveLearner.getStrategyWeight(pick.strategy || "Unknown")

    // Check if this price range is safe (learned from past losses)
    if (!adaptiveLearner.isPriceRangeSafe(price)) {
      console.log(`[VIRTUAL] Skipped: ${outcome.slice(0, 25)} — price range ${(price * 100).toFixed(0)}% disabled by learner`)
      continue
    }

    // Calculate bet size: base × drawdown × time × strategy_weight
    let baseBet = Math.max(5, Math.min(pick.betSize || 10, VIRTUAL_MAX_BET, availableCapital * 0.1))
    let betSize = baseBet * drawdownKelly * timeMultiplier * strategyWeight
    betSize = Math.max(2, Math.round(betSize * 100) / 100) // Min $2, round to cents
    if (availableCapital < betSize) continue

    // Get proper outcome and price based on strategy type
    let outcome, price
    if (pick.strategy === "NegRisk Arbitrage") {
      outcome = pick.direction || "ARBITRAGE"
      price = pick.event?.totalYesPrice || 0.95
    } else {
      outcome = pick.outcome || pick.market?.outcomes?.[0]?.name || "YES"
      price = pick.currentPrice || pick.price || 0
    }
    if (price <= 0.01 || price >= 0.99) continue
    const shares = betSize / price
    const marketId = pick.market?.id || pick.event?.eventId || ""
    const question = pick.market?.question || pick.event?.title || ""

    // Skip if no market identifier
    if (!marketId) continue

    try {
      virtualStmts.openPosition.run(
        marketId,
        question.slice(0, 200),
        outcome,
        pick.direction || "BUY",
        price,
        shares,
        betSize,
        pick.strategy || "Auto",
      )
      tradesPlaced++
      _tradedMarkets.add(marketId)
      console.log(`[VIRTUAL] Traded: ${outcome.slice(0, 30)} @ ${(price * 100).toFixed(1)}% — $${betSize.toFixed(2)} (${pick.strategy})`)
    } catch (err) {
      console.error(`[VIRTUAL] Trade failed:`, err.message)
    }
  }

  return tradesPlaced
}

/**
 * Check open virtual positions and close resolved ones
 */
async function checkVirtualPositions() {
  const openPositions = virtualStmts.getOpenPositions.all()
  const closed = []

  for (const pos of openPositions) {
    try {
      let market = null
      let currentPrice = pos.entry_price
      let marketClosed = false

      try {
        market = await scanner.getMarket(pos.market_id)
      } catch {}

      if (market) {
        marketClosed = !market.active
        if (market.outcomes) {
          // Try exact match first, then partial
          const match = market.outcomes.find((o) => o.name === pos.outcome) ||
            market.outcomes.find((o) => o.name.toLowerCase().includes(pos.outcome.toLowerCase())) ||
            market.outcomes[0]
          if (match) currentPrice = match.price
        }
      }

      let shouldClose = false
      let closeReason = ""

      // 1. Market resolved or closed (triple-check: closed + active + accepting_orders)
      const isResolved = marketClosed || market?.resolved
      if (isResolved || (!market && pos.created_at)) {
        const ageHours = (Date.now() - new Date(pos.created_at).getTime()) / 3600000
        if (isResolved || ageHours > 24) {
          if (currentPrice >= 0.95) currentPrice = 1.0
          else if (currentPrice <= 0.05) currentPrice = 0.0
          shouldClose = true
          closeReason = "resolved"
        }
      }

      // 2. Resolution snipe: price near 100% or market closed
      if (!shouldClose && pos.strategy === "Resolution Snipe") {
        if (currentPrice >= 0.98) {
          currentPrice = 1.0
          shouldClose = true
          closeReason = "snipe-won"
        } else if (currentPrice < pos.entry_price * 0.90) {
          // Snipe went wrong — cut loss
          shouldClose = true
          closeReason = "snipe-failed"
        }
      }

      // 3. Take profit: price moved +15% from entry
      if (!shouldClose && pos.strategy !== "Resolution Snipe") {
        if (currentPrice >= pos.entry_price + 0.15) {
          shouldClose = true
          closeReason = "take-profit"
        }
      }

      // 4. Stop loss: -30% for risky, -15% for medium
      if (!shouldClose && pos.strategy !== "Resolution Snipe" && pos.strategy !== "Arbitrage") {
        const stopPct = pos.strategy === "Long Shot" ? 0.50 : 0.70
        if (currentPrice < pos.entry_price * stopPct) {
          shouldClose = true
          closeReason = `stop-loss (${((1 - stopPct) * 100).toFixed(0)}%)`
        }
      }

      // 5. Long shots at 0 → write off
      if (!shouldClose && pos.strategy === "Long Shot" && currentPrice <= 0.005) {
        currentPrice = 0
        shouldClose = true
        closeReason = "expired-worthless"
      }

      // 6. Stale positions: open for >7 days with no movement → close
      if (!shouldClose) {
        const ageHours = (Date.now() - new Date(pos.created_at).getTime()) / 3600000
        if (ageHours > 168) { // 7 days
          shouldClose = true
          closeReason = "stale (7+ days)"
        }
      }

      if (shouldClose) {
        const pnl = (currentPrice - pos.entry_price) * pos.shares
        virtualStmts.closePosition.run(currentPrice, pnl, pos.id)
        closed.push({ ...pos, exit_price: currentPrice, pnl, close_reason: closeReason })

        // LEARN from this trade — adjust weights for future
        adaptiveLearner.learnFromTrade({
          strategy: pos.strategy,
          entry_price: pos.entry_price,
          pnl,
          close_reason: closeReason,
        })
        _tradedMarkets.delete(pos.market_id) // Allow re-trading this market

        console.log(`[VIRTUAL] Closed: ${pos.outcome.slice(0, 25)} — ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${closeReason})`)
      }
    } catch (err) {
      console.error(`[VIRTUAL] Position check error: ${err.message}`)
      continue
    }
  }

  return closed
}

/**
 * Generate daily scorecard
 */
function generateScorecard() {
  const pnl = virtualStmts.getVirtualPnL.get()
  const today = virtualStmts.getTodayPnL.get()
  const openPositions = virtualStmts.getOpenPositions.all()
  const openValue = virtualStmts.getOpenValue.get()?.total_invested || 0

  const totalPnL = pnl?.total_pnl || 0
  const currentBalance = VIRTUAL_BANKROLL + totalPnL
  const winRate = pnl?.total_trades > 0 ? (pnl.wins / pnl.total_trades * 100) : 0
  const roi = (totalPnL / VIRTUAL_BANKROLL * 100)

  let rating = "🔴 Learning"
  if (winRate >= 50 && totalPnL > 0) rating = "🟡 Getting there"
  if (winRate >= 60 && totalPnL > 50) rating = "🟢 Profitable"
  if (winRate >= 70 && totalPnL > 200) rating = "⭐ Crushing it"
  if (winRate >= 80 && totalPnL > 500) rating = "💎 Elite"

  // Save daily stats
  const date = new Date().toISOString().split("T")[0]
  virtualStmts.upsertDailyStats.run(
    date, VIRTUAL_BANKROLL, currentBalance,
    0, pnl?.total_trades || 0, pnl?.wins || 0, pnl?.losses || 0,
    today?.day_pnl || 0, totalPnL, winRate,
    pnl?.best_trade || 0, pnl?.worst_trade || 0, rating,
  )

  // Open positions summary
  const posLines = openPositions.slice(0, 5).map((p) =>
    `  • ${p.outcome.slice(0, 20)} @ ${(p.entry_price * 100).toFixed(0)}% — $${p.size_usdc.toFixed(2)} (${p.strategy})`,
  ).join("\n")

  const tag = process.platform === "darwin" ? "🏠" : "☁️"

  // Learning insights
  const recentClosed = db.raw.prepare(
    `SELECT strategy, COUNT(*) as cnt, SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as wins, SUM(pnl) as total_pnl
     FROM pm_virtual_portfolio WHERE status='closed' GROUP BY strategy`
  ).all()

  let learningText = ""
  if (recentClosed.length > 0) {
    learningText = `\n*What I'm learning:*\n`
    for (const s of recentClosed) {
      const wr = s.cnt > 0 ? (s.wins / s.cnt * 100).toFixed(0) : 0
      const emoji = s.total_pnl >= 0 ? "✅" : "❌"
      learningText += `${emoji} ${s.strategy}: ${wr}% win rate, ${s.total_pnl >= 0 ? "+" : ""}$${s.total_pnl.toFixed(2)}\n`
    }
  }

  return `${tag} *Virtual Trading Scorecard*\n\n` +
    `*Balance:* $${currentBalance.toFixed(2)} (started $${VIRTUAL_BANKROLL})\n` +
    `*Total P&L:* ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} (${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%)\n` +
    `*Today:* ${(today?.day_pnl || 0) >= 0 ? "+" : ""}$${(today?.day_pnl || 0).toFixed(2)}\n\n` +
    `*Stats:*\n` +
    `  Trades: ${pnl?.total_trades || 0} (${pnl?.wins || 0}W / ${pnl?.losses || 0}L)\n` +
    `  Win rate: ${winRate.toFixed(0)}%\n` +
    `  Best trade: +$${(pnl?.best_trade || 0).toFixed(2)}\n` +
    `  Worst trade: $${(pnl?.worst_trade || 0).toFixed(2)}\n` +
    `  Volume: $${(pnl?.total_volume || 0).toFixed(2)}\n\n` +
    `*Rating:* ${rating}\n\n` +
    (openPositions.length > 0 ? `*Open Positions (${openPositions.length}):*\n${posLines}\n\n` : "") +
    `*Capital:* $${(currentBalance - openValue).toFixed(2)} free / $${openValue.toFixed(2)} invested\n` +
    learningText + `\n` +
    `_Virtual money — tracking to prove the system works before going live_`
}

/**
 * Get daily stats history
 */
export function getDailyHistory(days = 7) {
  return virtualStmts.getDailyStats.all(days)
}

// ── Proactive Analysis Loop ─────────────────────────────────

let _bot = null
let _chatId = null
let _briefingInterval = null
let _evalInterval = null
let _watchlistInterval = null
let _virtualTradeInterval = null
let _scorecardInterval = null
let _isRunning = false

export function init(bot, chatId) {
  _bot = bot
  _chatId = chatId
}

/**
 * Start the autonomous analyst
 */
export function startAutonomous() {
  if (_isRunning) return false
  _isRunning = true

  // Load existing open positions into dedup set (persist across restarts)
  try {
    const openPositions = virtualStmts.getOpenPositions.all()
    for (const pos of openPositions) {
      if (pos.market_id) _tradedMarkets.add(pos.market_id)
    }
    console.log(`[AUTO-ANALYST] Loaded ${openPositions.length} open positions into dedup set`)
  } catch {}

  console.log("[AUTO-ANALYST] Started autonomous mode with virtual trading")

  // Initial briefing after 30 seconds
  setTimeout(() => sendBriefing(), 30000)

  // Briefing every 2 hours
  _briefingInterval = setInterval(() => sendBriefing(), 2 * 60 * 60 * 1000)

  // Virtual trade + evaluate every 10 minutes
  _virtualTradeInterval = setInterval(() => runVirtualTradingCycle(), 5 * 60 * 1000) // Every 5 min in learning mode
  setTimeout(() => runVirtualTradingCycle(), 60000) // First run after 1 min

  // Evaluate predictions every 30 minutes
  _evalInterval = setInterval(() => runEvaluation(), 30 * 60 * 1000)

  // Auto-manage watchlist every 15 minutes
  _watchlistInterval = setInterval(() => runWatchlistUpdate(), 15 * 60 * 1000)
  setTimeout(() => runWatchlistUpdate(), 10000)

  // Daily scorecard at end of day (every 6 hours to not miss it)
  _scorecardInterval = setInterval(() => sendScorecard(), 6 * 60 * 60 * 1000)

  return true
}

export function stopAutonomous() {
  if (!_isRunning) return false
  _isRunning = false
  if (_briefingInterval) clearInterval(_briefingInterval)
  if (_evalInterval) clearInterval(_evalInterval)
  if (_watchlistInterval) clearInterval(_watchlistInterval)
  if (_virtualTradeInterval) clearInterval(_virtualTradeInterval)
  if (_scorecardInterval) clearInterval(_scorecardInterval)
  console.log("[AUTO-ANALYST] Stopped")
  return true
}

async function sendBriefing() {
  if (!_bot || !_chatId) return
  try {
    const briefing = await generateBriefing()
    await safeSend(_bot, _chatId, briefing)

    // Predictions are now recorded in runVirtualTradingCycle (deduplicated)
  } catch (err) {
    console.error("[AUTO-ANALYST] Briefing error:", err.message)
  }
}

async function runEvaluation() {
  if (!_bot || !_chatId) return
  try {
    const evaluated = await evaluateOpenPredictions()
    if (evaluated.length > 0) {
      const correct = evaluated.filter((e) => e.was_correct).length
      const total = evaluated.length

      let msg = `🧠 *Prediction Check-In*\n\n`
      msg += `Just evaluated ${total} predictions: ${correct}/${total} correct\n\n`

      for (const e of evaluated.slice(0, 3)) {
        const icon = e.was_correct ? "✅" : "❌"
        msg += `${icon} ${e.market_question.slice(0, 50)}\n`
        msg += `   I said: ${e.predicted_outcome} | Actual: ${e.actual_outcome}\n\n`
      }

      // Save periodic score
      saveEvalScore()

      await safeSend(_bot, _chatId, msg)
    }
  } catch (err) {
    console.error("[AUTO-ANALYST] Eval error:", err.message)
  }
}

async function runWatchlistUpdate() {
  if (!_bot || !_chatId) return
  try {
    const result = await autoManageWatchlist()
    if (result.added.length > 0) {
      await safeSend(_bot, _chatId,
        `👀 Watchlist Updated\n\n` +
          `Added ${result.added.length} markets:\n` +
          result.added.map((a) => `• ${escapeMarkdown(a)}`).join("\n") +
          `\n\n📊 Total watching: ${result.total}`,
      )
    }
  } catch (err) {
    console.error("[AUTO-ANALYST] Watchlist error:", err.message)
  }
}

async function runVirtualTradingCycle() {
  if (!_bot || !_chatId) { console.log("[VIRTUAL] Skipped — no bot/chatId"); return }
  console.log("[VIRTUAL] Running trading cycle...")
  try {
    // 1. Check and close resolved positions
    const closed = await checkVirtualPositions()
    if (closed.length > 0) {
      const totalPnl = closed.reduce((s, c) => s + c.pnl, 0)
      const lines = closed.map((c) => {
        const icon = c.pnl >= 0 ? "✅" : "❌"
        const reason = c.close_reason ? ` (${c.close_reason})` : ""
        return `${icon} ${c.outcome.slice(0, 25)} — ${c.pnl >= 0 ? "+" : ""}$${c.pnl.toFixed(2)}${reason}`
      })

      const tag = process.platform === "darwin" ? "🏠" : "☁️"
      const pnlStats = virtualStmts.getVirtualPnL.get()
      const balance = VIRTUAL_BANKROLL + (pnlStats?.total_pnl || 0)

      await safeSend(_bot, _chatId,
        `${tag} *Positions Closed*\n\n${lines.join("\n")}\n\n` +
          `Session P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}\n` +
          `Balance: $${balance.toFixed(2)} / $${VIRTUAL_BANKROLL}\n` +
          `Win rate: ${pnlStats?.total_trades > 0 ? (pnlStats.wins / pnlStats.total_trades * 100).toFixed(0) : 0}%`,
      )
    }

    // 2. Run SMART BRAIN scan (replaces dumb strategy scan)
    const pnlData = virtualStmts.getVirtualPnL.get()
    const currentBalance = VIRTUAL_BANKROLL + (pnlData?.total_pnl || 0)
    const openPositions = virtualStmts.getOpenPositions.all()

    const brainScan = await smartBrain.smartScan(currentBalance)
    let tradesPlaced = 0

    for (const pick of brainScan.approved.slice(0, 3)) {
      if (openPositions.length + tradesPlaced >= VIRTUAL_MAX_OPEN) break
      if (!pick.market?.id) continue
      if (_tradedMarkets.has(pick.market.id)) continue

      const price = pick.market.outcomes?.find(o => o.name === pick.outcome)?.price || 0.5
      if (price <= 0.01 || price >= 0.99) continue

      const betSize = Math.min(pick.betSize || 5, VIRTUAL_MAX_BET)
      if (betSize < 2 || currentBalance - (virtualStmts.getOpenValue.get()?.total_invested || 0) < betSize) continue

      const shares = betSize / price

      try {
        virtualStmts.openPosition.run(
          pick.market.id, (pick.market.question || "").slice(0, 200),
          pick.outcome || "YES", pick.direction || "BUY",
          price, shares, betSize, "Smart Brain",
        )
        _tradedMarkets.add(pick.market.id)
        tradesPlaced++
        console.log(`[BRAIN] Traded: ${(pick.outcome || "").slice(0, 25)} @ ${(price * 100).toFixed(1)}% — $${betSize.toFixed(2)} (${(pick.confidence * 100).toFixed(0)}% conf)`)
      } catch (err) {
        console.error(`[BRAIN] Trade failed:`, err.message)
      }
    }

    const tag = process.platform === "darwin" ? "🏠" : "☁️"
    if (tradesPlaced > 0) {
      const allOpen = virtualStmts.getOpenPositions.all()
      const recent = allOpen.slice(-tradesPlaced)
      const lines = recent.map((p) =>
        `• ${p.outcome.slice(0, 25)} @ ${(p.entry_price * 100).toFixed(0)}% — $${p.size_usdc.toFixed(2)}`,
      )
      await safeSend(_bot, _chatId,
        `${tag} *Smart Trade* (${brainScan.approved.length} approved / ${brainScan.skipped} skipped)\n\n${lines.join("\n")}\n\n` +
          `_Checks: edge>7%, no longshot bias, whale + news confirmed_`,
      )
    } else if (brainScan.approved.length === 0) {
      // Every few cycles, report that we're watching but not trading
      console.log(`[BRAIN] No trades — all ${brainScan.total} markets failed quality checks`)
    }

    // 3. Record predictions from brain-approved picks (deduplicated)
    for (const pick of brainScan.approved.slice(0, 3)) {
      const mId = pick.market?.id
      if (!mId || !shouldPredict(mId)) continue

      const outcome = pick.outcome || "YES"
      const marketPrice = pick.market?.outcomes?.[0]?.price || 0.5
      const question = pick.market?.question || ""
      const reasoning = (pick.reasoning || []).join("; ")

      recordPrediction(
        mId, question.slice(0, 200),
        outcome, pick.confidence || 0.5, marketPrice,
        pick.confidence || 0.5, reasoning.slice(0, 300),
      )
    }
  } catch (err) {
    console.error("[AUTO-ANALYST] Virtual trading error:", err.message)
  }
}

async function sendScorecard() {
  if (!_bot || !_chatId) return
  try {
    const scorecard = generateScorecard()
    await safeSend(_bot, _chatId, scorecard)
  } catch (err) {
    console.error("[AUTO-ANALYST] Scorecard error:", err.message)
  }
}

export default {
  init,
  startAutonomous,
  stopAutonomous,
  generateBriefing,
  generateScorecard,
  analyzeMarketSimple,
  recordPrediction,
  evaluateOpenPredictions,
  getEvalReport,
  saveEvalScore,
  autoManageWatchlist,
  getAutoWatchlist,
  getDailyHistory,
}
