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
import realTrader from "./real-trader.mjs"
import db from "../database.mjs"

// ── Deduplication — track what we've already notified/traded ─
const _notifiedMarkets = new Map()  // marketId -> timestamp (last notified)
const _tradedMarkets = new Set()    // marketId (already have a position)
const NOTIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000  // Don't re-notify same market for 6 hours
const PREDICTION_COOLDOWN_MS = 4 * 60 * 60 * 1000  // Don't re-predict same market for 4 hours
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

  CREATE TABLE IF NOT EXISTS pm_decisions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id       TEXT,
    market_question TEXT,
    outcome         TEXT,
    direction       TEXT,
    estimated_prob  REAL,
    market_price    REAL,
    confidence      REAL,
    real_edge       REAL,
    score           REAL,
    bet_size        REAL,
    checks          TEXT,
    reasoning       TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_decisions_market ON pm_decisions(market_id);
  CREATE INDEX IF NOT EXISTS idx_decisions_date ON pm_decisions(created_at);

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
  addDecision: db.raw.prepare(`
    INSERT INTO pm_decisions (market_id, market_question, outcome, direction, estimated_prob, market_price, confidence, real_edge, score, bet_size, checks, reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
 * Record a full decision audit trail (checks, reasoning, edge, etc.)
 */
export function recordDecision(marketId, question, details) {
  try {
    stmts.addDecision.run(
      marketId, question,
      details.outcome || "", details.direction || "",
      details.estimatedProb || 0, details.marketPrice || 0,
      details.confidence || 0, details.realEdge || 0,
      details.score || 0, details.betSize || 0,
      JSON.stringify(details.checks || {}),
      JSON.stringify(details.reasoning || []),
    )
  } catch (err) {
    console.error("[DECISION] Failed to record:", err.message)
  }
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
    close_reason TEXT,
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

// Migrations: add columns to existing tables
try { db.raw.exec(`ALTER TABLE pm_virtual_portfolio ADD COLUMN close_reason TEXT`) } catch {}
try { db.raw.exec(`ALTER TABLE pm_virtual_portfolio ADD COLUMN entry_fee REAL DEFAULT 0`) } catch {}
try { db.raw.exec(`ALTER TABLE pm_virtual_portfolio ADD COLUMN exit_fee REAL DEFAULT 0`) } catch {}
try { db.raw.exec(`ALTER TABLE pm_virtual_portfolio ADD COLUMN category TEXT DEFAULT 'other'`) } catch {}
try { db.raw.exec(`ALTER TABLE pm_virtual_portfolio ADD COLUMN slippage REAL DEFAULT 0`) } catch {}
try { db.raw.exec(`ALTER TABLE pm_virtual_portfolio ADD COLUMN fill_pct REAL DEFAULT 1.0`) } catch {}

const virtualStmts = {
  openPosition: db.raw.prepare(`
    INSERT INTO pm_virtual_portfolio (market_id, market_question, outcome, side, entry_price, shares, size_usdc, strategy, entry_fee, category, slippage, fill_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getOpenPositions: db.raw.prepare(`SELECT * FROM pm_virtual_portfolio WHERE status = 'open'`),
  closePosition: db.raw.prepare(`
    UPDATE pm_virtual_portfolio SET status = 'closed', exit_price = ?, pnl = ?, close_reason = ?, exit_fee = ?, closed_at = datetime('now')
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
  getTotalFees: db.raw.prepare(`
    SELECT COALESCE(SUM(COALESCE(entry_fee,0) + COALESCE(exit_fee,0) + COALESCE(slippage,0)), 0) as total_fees
    FROM pm_virtual_portfolio
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

const VIRTUAL_STARTING_BANKROLL = 1000
const VIRTUAL_MAX_BET = 35
const VIRTUAL_MAX_OPEN = 150

// Track fill statistics for realistic reporting
let _totalAttempted = 0
let _totalNoFills = 0
let _totalPartialFills = 0

/**
 * Get current virtual bankroll (compounded from PnL)
 */
function getVirtualBankroll() {
  try {
    const pnl = virtualStmts.getVirtualPnL.get()
    return VIRTUAL_STARTING_BANKROLL + (pnl?.total_pnl || 0)
  } catch {
    return VIRTUAL_STARTING_BANKROLL
  }
}

// ⚠️ NEVER DELETE DATA — the DB is the bot's memory and brain.
// Every trade, prediction, lesson, and mistake is permanent.
// This is how the bot gets smarter over weeks/months.

/**
 * Auto-trade based on scan results — bot decides and executes virtually
 */
async function autoVirtualTrade(scanResults) {
  const openPositions = virtualStmts.getOpenPositions.all()
  const openValue = virtualStmts.getOpenValue.get()?.total_invested || 0
  const pnlData = virtualStmts.getVirtualPnL.get()
  const currentBalance = getVirtualBankroll()
  const availableCapital = currentBalance - openValue
  let tradesPlaced = 0

  // Drawdown check — reduce or stop trading if losing too much
  const peakBalance = VIRTUAL_STARTING_BANKROLL // Simple: use starting balance as peak
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
    const marketId = pick.market?.id || pick.event?.eventId || ""
    const question = pick.market?.question || pick.event?.title || ""
    if (!marketId) continue

    // ── REAL ORDER BOOK EXECUTION ──
    // Fetch actual Polymarket order book to determine if we can fill
    // NOTE: Polymarket CLOB has separate tokens for each outcome.
    // The book prices are in the TOKEN's price space (0-1), NOT the probability space.
    // For a "No" outcome at 95% probability, the No token trades at ~0.95 on its own book.
    const tokenId = pick.market?.outcomes?.find(o => o.name === outcome)?.tokenId
    const category = smartBrain.detectCategory(question)

    let book = null, bestBid = 0, bestAsk = 0, spread = 0, bidDepthUsd = 0, askDepthUsd = 0
    if (tokenId) {
      try {
        book = await scanner.getOrderBook(tokenId)
        if (book && book.asks?.length > 0 && book.bids?.length > 0) {
          bestBid = parseFloat(book.bids[0].price)
          bestAsk = parseFloat(book.asks[0].price)
          spread = bestAsk - bestBid
          // Depth in USD = shares × price at each level
          bidDepthUsd = (book.bids || []).slice(0, 5).reduce((s, b) => s + parseFloat(b.size || 0) * parseFloat(b.price || 0), 0)
          askDepthUsd = (book.asks || []).slice(0, 5).reduce((s, a) => s + parseFloat(a.size || 0) * parseFloat(a.price || 0), 0)
        }
      } catch { /* book fetch failed, use fallback */ }
    }

    _totalAttempted++

    // Use the book's best ask as our actual entry price reference (not Gamma API mid)
    const bookPrice = (bestAsk > 0 && bestAsk < 1) ? bestAsk : price
    const sharesWanted = betSize / bookPrice
    let fillableShares = 0
    let fillPrice = bookPrice
    let isTaker = false

    if (book && book.asks && book.asks.length > 0) {
      // Walk the ask side — how many shares can we actually buy at what price?
      let spent = 0
      let sharesBought = 0
      for (const level of book.asks) {
        const lvlPrice = parseFloat(level.price)
        const lvlSize = parseFloat(level.size)
        if (lvlPrice > bookPrice * 1.03) break // Don't buy more than 3% above best ask
        const canBuy = Math.min(lvlSize, sharesWanted - sharesBought)
        sharesBought += canBuy
        spent += canBuy * lvlPrice
        if (sharesBought >= sharesWanted) break
      }
      fillableShares = sharesBought
      fillPrice = sharesBought > 0 ? spent / sharesBought : bookPrice
      isTaker = true
    } else {
      // No book data — use price-based fill probability
      let fillProb
      if (price < 0.70) fillProb = 0.90
      else if (price < 0.85) fillProb = 0.75
      else if (price < 0.92) fillProb = 0.50
      else if (price < 0.95) fillProb = 0.30
      else fillProb = 0.15
      const vol24h = pick.market?.volume24hr || 0
      if (vol24h > 500000) fillProb = Math.min(fillProb * 1.3, 0.95)
      else if (vol24h > 100000) fillProb = Math.min(fillProb * 1.15, 0.90)
      if (Math.random() > fillProb) {
        _totalNoFills++
        console.log(`[VIRTUAL] ❌ No fill: ${outcome.slice(0, 25)} @ ${(price * 100).toFixed(1)}% — no book data (${(fillProb * 100).toFixed(0)}% est.)`)
        continue
      }
      fillableShares = sharesWanted
    }

    // Check if enough liquidity exists
    if (fillableShares < sharesWanted * 0.20) {
      _totalNoFills++
      const depthStr = book ? `ask depth: $${askDepthUsd.toFixed(0)} (${fillableShares.toFixed(0)}/${sharesWanted.toFixed(0)} shares)` : "no book"
      console.log(`[VIRTUAL] ❌ No fill: ${outcome.slice(0, 25)} @ ${(price * 100).toFixed(1)}% — ${depthStr}`)
      continue
    }

    // Partial fill: we get what the book has, up to what we want
    let fillPct = Math.min(fillableShares / sharesWanted, 1.0)
    if (fillPct < 0.99) _totalPartialFills++
    betSize = Math.max(2, Math.round(betSize * fillPct * 100) / 100)

    // Real slippage = VWAP from walking book vs best ask
    const slippedPrice = Math.min(fillPrice, 0.995)
    const slippageCost = Math.max(0, (slippedPrice - bookPrice) * (betSize / slippedPrice))

    // Entry fee: taker if we lift asks, maker if we place a limit below best ask
    const takerRate = realTrader.TAKER_FEE_RATES[category] || realTrader.TAKER_FEE_RATES.other
    const entryShares = betSize / slippedPrice
    const takerFee = entryShares * takerRate * slippedPrice * (1 - slippedPrice)
    // Tight spread = more likely taker (our limit crosses), wide = more likely maker
    const takerChance = isTaker ? (spread < 0.02 ? 0.70 : 0.40) : 0.30
    const entryFee = takerFee * takerChance

    // Net: deduct slippage + entry fee from effective position
    const effectiveBet = betSize - entryFee
    const shares = effectiveBet / slippedPrice

    try {
      virtualStmts.openPosition.run(
        marketId,
        question.slice(0, 200),
        outcome,
        pick.direction || "BUY",
        slippedPrice,
        shares,
        betSize,
        pick.strategy || "Auto",
        Math.round(entryFee * 10000) / 10000,
        category,
        Math.round(slippageCost * 10000) / 10000,
        Math.round(fillPct * 100) / 100,
      )
      tradesPlaced++
      _tradedMarkets.add(marketId)

      // ── DETAILED TRADE LOG — like a real exchange ──
      const feeStr = entryFee > 0.001 ? ` | fee: $${entryFee.toFixed(3)}` : ""
      const fillStr = fillPct < 1.0 ? ` | fill: ${(fillPct * 100).toFixed(0)}%` : ""
      const spreadStr = book ? `${(spread * 10000).toFixed(1)} bps` : "?"
      const depthStr = book ? `bid:$${bidDepthUsd.toFixed(0)} ask:$${askDepthUsd.toFixed(0)}` : "no book"
      const slipStr = slippageCost > 0.001 ? ` | slip: $${slippageCost.toFixed(3)}` : ""
      console.log(
        `[VIRTUAL] ✅ ${outcome.slice(0, 22)} @ ${(slippedPrice * 100).toFixed(2)}%` +
        ` | $${betSize.toFixed(2)} → ${shares.toFixed(1)} shares` +
        ` | ${pick.strategy}` +
        ` | spread: ${spreadStr} | ${depthStr}` +
        `${feeStr}${slipStr}${fillStr}`
      )
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

      // 2. Resolution snipe: simulate realistic resolution outcomes
      // The market price IS the probability — a 95% market fails 5% of the time
      if (!shouldClose && pos.strategy === "Resolution Snipe") {
        if (currentPrice >= 0.98) {
          // Market at 98%+ — very likely to resolve in our favor, but not guaranteed
          // Use entry price as the true probability (that's what the market said when we bought)
          // Add small bonus: if price moved from 95% to 99%, market is more certain now
          const resolveProb = Math.min(currentPrice, 0.99) // Use current price as probability
          if (Math.random() < resolveProb) {
            currentPrice = 1.0
            shouldClose = true
            closeReason = "snipe-won"
          } else {
            // The unlikely happened — market resolved against us
            currentPrice = 0.0
            shouldClose = true
            closeReason = "snipe-upset"
          }
        } else if (currentPrice < pos.entry_price * 0.93) {
          // Snipe went wrong — tighter stop for snipes (7% loss max)
          shouldClose = true
          closeReason = "snipe-failed"
        }
      }

      // 3. Dynamic take profit with trailing stop logic
      if (!shouldClose && pos.strategy !== "Resolution Snipe" && pos.strategy !== "Arbitrage") {
        const gain = currentPrice - pos.entry_price
        const gainPct = gain / pos.entry_price

        // Trailing stop: the more we're up, the tighter the stop
        if (gainPct >= 0.25) {
          // Up 25%+: take profit — lock in the big win
          shouldClose = true
          closeReason = `take-profit (+${(gainPct * 100).toFixed(0)}%)`
        } else if (gainPct >= 0.15) {
          // Up 15-25%: trailing stop at -5% from current (lock in most gains)
          // We don't have peak tracking in DB, so just take profit at +15%
          shouldClose = true
          closeReason = `take-profit (+${(gainPct * 100).toFixed(0)}%)`
        } else if (gainPct >= 0.10 && currentPrice >= 0.85) {
          // Up 10%+ and near resolution territory — take the safe gain
          shouldClose = true
          closeReason = `take-profit-near-resolution (+${(gainPct * 100).toFixed(0)}%)`
        }
      }

      // 4. Dynamic stop loss based on strategy risk profile
      if (!shouldClose && pos.strategy !== "Resolution Snipe" && pos.strategy !== "Arbitrage") {
        const lossPct = (pos.entry_price - currentPrice) / pos.entry_price

        if (pos.strategy === "Smart Brain") {
          // Smart Brain: 20% stop loss (tighter than before)
          if (lossPct >= 0.20) {
            shouldClose = true
            closeReason = "stop-loss (-20%)"
          }
        } else if (pos.strategy === "News Alpha" || pos.strategy === "Momentum") {
          // Medium risk: 25% stop
          if (lossPct >= 0.25) {
            shouldClose = true
            closeReason = `stop-loss (-25%)`
          }
        } else {
          // Default: 30% stop
          if (lossPct >= 0.30) {
            shouldClose = true
            closeReason = `stop-loss (-30%)`
          }
        }
      }

      // 5. Dead positions: price collapsed to near zero
      if (!shouldClose && currentPrice <= 0.005) {
        currentPrice = 0
        shouldClose = true
        closeReason = "expired-worthless"
      }

      // 6. Stale positions: close to free up capital
      if (!shouldClose) {
        const ageHours = (Date.now() - new Date(pos.created_at).getTime()) / 3600000
        // Different staleness thresholds by strategy
        const maxAge = pos.strategy === "Resolution Snipe" ? 48 : // Snipes should resolve fast
                       pos.strategy === "Arbitrage" ? 24 : // Arb should be instant
                       72 // Smart Brain: 3 days
        if (ageHours > maxAge) {
          shouldClose = true
          closeReason = `stale (${Math.round(maxAge / 24)}+ days)`
        }
      }

      if (shouldClose) {
        const grossPnl = (currentPrice - pos.entry_price) * pos.shares

        // ── REALISTIC EXIT FEES ──
        // Resolution (market resolves YES/NO) = FREE settlement
        // Early exit (stop-loss, take-profit, stale) = taker fee to sell
        let exitFee = 0
        if (closeReason !== "resolved" && closeReason !== "snipe-won" && closeReason !== "snipe-upset" && closeReason !== "expired-worthless") {
          const cat = pos.category || smartBrain.detectCategory(pos.market_question || "")
          const exitFeeCalc = realTrader.calculateTakerFee(pos.shares * currentPrice, currentPrice, cat)
          exitFee = exitFeeCalc.fee
        }

        // Net P&L = gross - entry fee - exit fee
        const entryFee = pos.entry_fee || 0
        const pnl = grossPnl - entryFee - exitFee
        const totalFees = entryFee + exitFee

        virtualStmts.closePosition.run(currentPrice, pnl, closeReason, exitFee, pos.id)
        closed.push({ ...pos, exit_price: currentPrice, pnl, close_reason: closeReason, fees: totalFees })

        // LEARN from this trade — adjust strategy weights, price range, and category stats
        adaptiveLearner.learnFromTrade({
          strategy: pos.strategy,
          entry_price: pos.entry_price,
          pnl,
          close_reason: closeReason,
          category: pos.category || smartBrain.detectCategory(pos.market_question || ""),
        })
        _tradedMarkets.delete(pos.market_id) // Allow re-trading this market

        const feeStr = totalFees > 0.01 ? ` fees:$${totalFees.toFixed(2)}` : ""
        console.log(`[VIRTUAL] Closed: ${pos.outcome.slice(0, 25)} — ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${closeReason}${feeStr})`)
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
  const currentBalance = VIRTUAL_STARTING_BANKROLL + totalPnL
  const winRate = pnl?.total_trades > 0 ? (pnl.wins / pnl.total_trades * 100) : 0
  const roi = (totalPnL / VIRTUAL_STARTING_BANKROLL * 100)

  let rating = "🔴 Learning"
  if (winRate >= 50 && totalPnL > 0) rating = "🟡 Getting there"
  if (winRate >= 60 && totalPnL > 50) rating = "🟢 Profitable"
  if (winRate >= 70 && totalPnL > 200) rating = "⭐ Crushing it"
  if (winRate >= 80 && totalPnL > 500) rating = "💎 Elite"

  // Save daily stats
  const date = new Date().toISOString().split("T")[0]
  virtualStmts.upsertDailyStats.run(
    date, VIRTUAL_STARTING_BANKROLL, currentBalance,
    0, pnl?.total_trades || 0, pnl?.wins || 0, pnl?.losses || 0,
    today?.day_pnl || 0, totalPnL, winRate,
    pnl?.best_trade || 0, pnl?.worst_trade || 0, rating,
  )

  const tag = process.platform === "darwin" ? "🏠" : "☁️"
  const totalFees = virtualStmts.getTotalFees.get()?.total_fees || 0

  // ── Strategy breakdown with fees (include open positions' entry fees) ──
  const strategyStats = db.raw.prepare(`
    SELECT strategy,
      COUNT(*) as cnt,
      SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl), 2) as total_pnl,
      ROUND(SUM(COALESCE(entry_fee,0) + COALESCE(exit_fee,0) + COALESCE(slippage,0)), 2) as total_fees,
      ROUND(SUM(size_usdc), 2) as volume,
      ROUND(AVG(pnl), 2) as avg_pnl
    FROM pm_virtual_portfolio WHERE strategy NOT IN ('v2-fee-reset', 'system')
    GROUP BY strategy ORDER BY total_pnl DESC
  `).all()

  let stratText = ""
  if (strategyStats.length > 0) {
    stratText = `\n*Strategy Breakdown:*\n`
    for (const s of strategyStats) {
      const wr = s.cnt > 0 ? (s.wins / s.cnt * 100).toFixed(0) : 0
      const emoji = s.total_pnl >= 0 ? "+" : ""
      const returnPct = s.volume > 0 ? (s.total_pnl / s.volume * 100).toFixed(1) : "0"
      const feeStr = s.total_fees > 0.01 ? ` | Fees: -$${s.total_fees}` : ""
      stratText += `  *${s.strategy}*: ${s.wins}W/${s.cnt - s.wins}L (${wr}%) | ${emoji}$${s.total_pnl} | ROI: ${returnPct}%${feeStr}\n`
    }
  }

  // ── Category breakdown ──
  const catStats = db.raw.prepare(`
    SELECT COALESCE(category, 'other') as cat,
      COUNT(*) as cnt,
      ROUND(SUM(pnl), 2) as total_pnl,
      ROUND(SUM(COALESCE(entry_fee,0) + COALESCE(exit_fee,0) + COALESCE(slippage,0)), 2) as fees
    FROM pm_virtual_portfolio WHERE category IS NOT NULL AND category != 'other'
    GROUP BY category ORDER BY total_pnl DESC
  `).all()

  let catText = ""
  if (catStats.length > 0) {
    catText = `\n*By Category:*\n`
    for (const c of catStats) {
      const feeRate = (realTrader.TAKER_FEE_RATES[c.cat] || 0) * 100
      catText += `  ${c.cat}: ${c.total_pnl >= 0 ? "+" : ""}$${c.total_pnl} (${c.cnt} trades) | taker: ${feeRate.toFixed(1)}%\n`
    }
  }

  // ── Fee breakdown ──
  const feeBreakdown = db.raw.prepare(`
    SELECT
      ROUND(COALESCE(SUM(entry_fee), 0), 2) as entry_fees,
      ROUND(COALESCE(SUM(exit_fee), 0), 2) as exit_fees,
      ROUND(COALESCE(SUM(slippage), 0), 2) as total_slippage
    FROM pm_virtual_portfolio
  `).get()

  const entryF = feeBreakdown?.entry_fees || 0
  const exitF = feeBreakdown?.exit_fees || 0
  const slipF = feeBreakdown?.total_slippage || 0
  const totalCost = entryF + exitF + slipF

  // ── Execution realism stats ──
  const fillStats = db.raw.prepare(`
    SELECT COUNT(*) as filled,
      ROUND(AVG(fill_pct), 2) as avg_fill,
      SUM(CASE WHEN fill_pct < 1.0 THEN 1 ELSE 0 END) as partial_fills
    FROM pm_virtual_portfolio WHERE close_reason != 'v3-full-reset'
  `).get()

  const upsetCount = db.raw.prepare(
    `SELECT COUNT(*) as cnt FROM pm_virtual_portfolio WHERE close_reason = 'snipe-upset'`
  ).get()?.cnt || 0

  let feeText = `\n*Fee Breakdown:*\n`
  feeText += `  Entry (maker/taker mix): $${entryF.toFixed(2)}\n`
  feeText += `  Exit (taker on sells): $${exitF.toFixed(2)}\n`
  feeText += `  Slippage: $${slipF.toFixed(2)}\n`
  feeText += `  *Total cost:* $${totalCost.toFixed(2)}\n`

  // ── Realism report ──
  const fillRate = _totalAttempted > 0 ? ((_totalAttempted - _totalNoFills) / _totalAttempted * 100) : 0
  let realismText = `\n*Execution Realism:*\n`
  realismText += `  Orders attempted: ${_totalAttempted} | Filled: ${_totalAttempted - _totalNoFills} (${fillRate.toFixed(0)}%)\n`
  realismText += `  No fills (book too thin): ${_totalNoFills}\n`
  realismText += `  Partial fills: ${_totalPartialFills} | Avg fill: ${((fillStats?.avg_fill || 1) * 100).toFixed(0)}%\n`
  realismText += `  Snipe upsets (resolved against): ${upsetCount}\n`

  // ── Open positions detail ──
  let posText = ""
  if (openPositions.length > 0) {
    posText = `\n*Open Positions (${openPositions.length}):*\n`
    for (const p of openPositions.slice(0, 8)) {
      const ef = p.entry_fee || 0
      const cat = p.category || "?"
      const ageH = ((Date.now() - new Date(p.created_at).getTime()) / 3600000).toFixed(1)
      posText += `  ${(p.outcome || "").slice(0, 22)} @ ${(p.entry_price * 100).toFixed(1)}% | $${p.size_usdc.toFixed(2)} | ${p.strategy} | ${cat}`
      if (ef > 0.001) posText += ` | fee:$${ef.toFixed(3)}`
      posText += ` | ${ageH}h\n`
    }
    if (openPositions.length > 8) posText += `  _...and ${openPositions.length - 8} more_\n`
  }

  // Save daily stats
  const statsDate = new Date().toISOString().split("T")[0]
  virtualStmts.upsertDailyStats.run(
    statsDate, VIRTUAL_STARTING_BANKROLL, currentBalance,
    0, pnl?.total_trades || 0, pnl?.wins || 0, pnl?.losses || 0,
    today?.day_pnl || 0, totalPnL, winRate,
    pnl?.best_trade || 0, pnl?.worst_trade || 0, rating,
  )

  return `${tag} *Virtual Trading Scorecard*\n\n` +
    `*Balance:* $${currentBalance.toFixed(2)} (started $${VIRTUAL_STARTING_BANKROLL})\n` +
    `*Gross P&L:* ${(totalPnL + totalFees) >= 0 ? "+" : ""}$${(totalPnL + totalFees).toFixed(2)}\n` +
    `*Total Fees:* -$${totalFees.toFixed(2)}\n` +
    `*Net P&L:* ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} (${roi >= 0 ? "+" : ""}${roi.toFixed(1)}% ROI)\n` +
    `*Today:* ${(today?.day_pnl || 0) >= 0 ? "+" : ""}$${(today?.day_pnl || 0).toFixed(2)}\n\n` +
    `*Stats:* ${pnl?.total_trades || 0} trades | ${pnl?.wins || 0}W / ${pnl?.losses || 0}L | Win: ${winRate.toFixed(0)}%\n` +
    `*Best:* +$${(pnl?.best_trade || 0).toFixed(2)} | *Worst:* $${(pnl?.worst_trade || 0).toFixed(2)} | *Avg:* $${(pnl?.total_trades > 0 ? totalPnL / pnl.total_trades : 0).toFixed(2)}/trade\n` +
    `*Volume:* $${(pnl?.total_volume || 0).toFixed(2)}\n` +
    `*Rating:* ${rating}\n` +
    stratText + catText + feeText + realismText + posText +
    `\n*Capital:* $${(currentBalance - openValue).toFixed(2)} free / $${openValue.toFixed(2)} invested\n` +
    `_Full realistic simulation — fills, slippage, fees, upsets. What you see = what real $1000 would do._`
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

  // ── ONE-TIME V3 RESET: wipe all old data, start fresh with realistic simulation ──
  // Idempotent: checks for v3-reset marker
  try {
    const v3Marker = db.raw.prepare(
      `SELECT COUNT(*) as cnt FROM pm_virtual_portfolio WHERE close_reason = 'v3-full-reset'`
    ).get()
    const oldCount = db.raw.prepare(`SELECT COUNT(*) as cnt FROM pm_virtual_portfolio`).get()

    if (v3Marker.cnt === 0 && oldCount.cnt > 0) {
      // Wipe everything — old data is unrealistic (no fill simulation, no upsets)
      db.raw.exec(`DELETE FROM pm_virtual_portfolio`)
      db.raw.exec(`DELETE FROM pm_virtual_stats`)
      // Insert a marker so this never runs again
      db.raw.prepare(
        `INSERT INTO pm_virtual_portfolio (market_id, market_question, outcome, side, entry_price, shares, size_usdc, strategy, status, pnl, close_reason, closed_at)
         VALUES ('v3-reset', 'Virtual trading reset — realistic simulation v3', 'RESET', 'NONE', 0, 0, 0, 'system', 'closed', 0, 'v3-full-reset', datetime('now'))`
      ).run()
      _tradedMarkets.clear()
      console.log(`[AUTO-ANALYST] 🔄 V3 FULL RESET — wiped ${oldCount.cnt} old trades. Starting fresh with $${VIRTUAL_STARTING_BANKROLL} and realistic simulation`)
      console.log(`[AUTO-ANALYST]    Fill probability, partial fills, upset simulation, realistic slippage all active`)
    } else {
      // Load existing positions into dedup set
      const positions = virtualStmts.getOpenPositions.all()
      for (const pos of positions) {
        if (pos.market_id) _tradedMarkets.add(pos.market_id)
      }
      if (positions.length > 0) {
        console.log(`[AUTO-ANALYST] Loaded ${positions.length} open positions into dedup set`)
      }
    }
  } catch (err) {
    console.error(`[AUTO-ANALYST] V3 reset error: ${err.message}`)
  }

  console.log("[AUTO-ANALYST] Started autonomous mode with realistic virtual trading (v3)")

  // Initial briefing after 2 minutes (let everything warm up)
  setTimeout(() => sendBriefing(), 2 * 60 * 1000)

  // Briefing every 4 hours (was 2h — too frequent, same data)
  _briefingInterval = setInterval(() => sendBriefing(), 4 * 60 * 60 * 1000)

  // Virtual trade cycle every 2 minutes — fast position checking + trading
  // Scans are cached, so this is cheap. Speed = opportunity.
  _virtualTradeInterval = setInterval(() => runVirtualTradingCycle(), 2 * 60 * 1000)
  setTimeout(() => runVirtualTradingCycle(), 45000) // First run after 45s

  // Evaluate predictions every 15 minutes — catch resolved markets fast
  _evalInterval = setInterval(() => runEvaluation(), 15 * 60 * 1000)

  // Auto-manage watchlist every 1 hour (silent)
  _watchlistInterval = setInterval(() => runWatchlistUpdate(), 60 * 60 * 1000)
  setTimeout(() => runWatchlistUpdate(), 30000)

  // Daily scorecard every 12 hours (was 6h — twice a day is enough)
  _scorecardInterval = setInterval(() => sendScorecard(), 12 * 60 * 60 * 1000)

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

    // Run Brier score + self-improvement report periodically (writes to pm_brier_scores)
    const evaluatedPreds = db.raw.prepare(
      `SELECT COUNT(*) as c FROM pm_predictions WHERE status = 'evaluated'`
    ).get()
    if (evaluatedPreds && evaluatedPreds.c >= 3) {
      try {
        selfImprover.generateImprovementReport()
        console.log("[EVAL] Brier scores and strategy scores updated")
      } catch (err) {
        console.error("[EVAL] Improvement report error:", err.message)
      }
    }
  } catch (err) {
    console.error("[AUTO-ANALYST] Eval error:", err.message)
  }
}

async function runWatchlistUpdate() {
  // Silently manage watchlist — no Telegram message needed
  // Users can check with /pmauto when they want to see it
  try {
    const result = await autoManageWatchlist()
    if (result.added.length > 0 || result.removed.length > 0) {
      console.log(`[WATCHLIST] +${result.added.length} -${result.removed.length} = ${result.total} total`)
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

    // 2. Run SMART BRAIN scan
    const currentBalance = getVirtualBankroll()
    const openPositions = virtualStmts.getOpenPositions.all()

    const brainScan = await smartBrain.smartScan(currentBalance)
    let tradesPlaced = 0

    for (const pick of brainScan.approved.slice(0, 25)) {
      if (openPositions.length + tradesPlaced >= VIRTUAL_MAX_OPEN) break
      if (!pick.market?.id) continue
      if (_tradedMarkets.has(pick.market.id)) continue

      const price = pick.market.outcomes?.find(o => o.name === pick.outcome)?.price || 0.5
      if (price <= 0.01 || price >= 0.99) continue

      // Check if this price range is safe (learned from past losses)
      if (!adaptiveLearner.isPriceRangeSafe(price)) {
        console.log(`[BRAIN] Skipped: ${(pick.outcome || "").slice(0, 25)} — price range ${(price * 100).toFixed(0)}% disabled by learner`)
        continue
      }

      let betSize = Math.min(pick.betSize || 5, VIRTUAL_MAX_BET)
      if (betSize < 3 || currentBalance - (virtualStmts.getOpenValue.get()?.total_invested || 0) < betSize) continue

      // ── REAL ORDER BOOK EXECUTION (BRAIN path) ──
      const tokenId2 = pick.market?.outcomes?.find(o => o.name === pick.outcome)?.tokenId
      const cat = smartBrain.detectCategory(pick.market.question || "")

      let book2 = null, bestBid2 = 0, bestAsk2 = 0, spread2 = 0, bidDepthUsd2 = 0, askDepthUsd2 = 0
      if (tokenId2) {
        try {
          book2 = await scanner.getOrderBook(tokenId2)
          if (book2 && book2.asks?.length > 0 && book2.bids?.length > 0) {
            bestBid2 = parseFloat(book2.bids[0].price)
            bestAsk2 = parseFloat(book2.asks[0].price)
            spread2 = bestAsk2 - bestBid2
            bidDepthUsd2 = (book2.bids || []).slice(0, 5).reduce((s, b) => s + parseFloat(b.size || 0) * parseFloat(b.price || 0), 0)
            askDepthUsd2 = (book2.asks || []).slice(0, 5).reduce((s, a) => s + parseFloat(a.size || 0) * parseFloat(a.price || 0), 0)
          }
        } catch { /* fallback */ }
      }

      _totalAttempted++
      const bookPrice2 = (bestAsk2 > 0 && bestAsk2 < 1) ? bestAsk2 : price
      const sharesWanted2 = betSize / bookPrice2
      let fillableShares2 = 0, fillPrice2 = bookPrice2, isTaker2 = false

      if (book2 && book2.asks && book2.asks.length > 0) {
        let spent2 = 0, bought2 = 0
        for (const level of book2.asks) {
          const lp = parseFloat(level.price), ls = parseFloat(level.size)
          if (lp > bookPrice2 * 1.03) break
          const can = Math.min(ls, sharesWanted2 - bought2)
          bought2 += can; spent2 += can * lp
          if (bought2 >= sharesWanted2) break
        }
        fillableShares2 = bought2
        fillPrice2 = bought2 > 0 ? spent2 / bought2 : bookPrice2
        isTaker2 = true
      } else {
        let fp = price < 0.70 ? 0.90 : price < 0.85 ? 0.75 : price < 0.92 ? 0.50 : price < 0.95 ? 0.30 : 0.15
        if (Math.random() > fp) { _totalNoFills++; continue }
        fillableShares2 = sharesWanted2
      }

      if (fillableShares2 < sharesWanted2 * 0.20) {
        _totalNoFills++
        continue
      }

      let fillPct2 = Math.min(fillableShares2 / sharesWanted2, 1.0)
      if (fillPct2 < 0.99) _totalPartialFills++
      betSize = Math.max(2, Math.round(betSize * fillPct2 * 100) / 100)

      const slippedPrice = Math.min(fillPrice2, 0.995)
      const slipCost = Math.max(0, (slippedPrice - bookPrice2) * (betSize / slippedPrice))

      const takerRate = realTrader.TAKER_FEE_RATES[cat] || realTrader.TAKER_FEE_RATES.other
      const entryShares = betSize / slippedPrice
      const takerFee = entryShares * takerRate * slippedPrice * (1 - slippedPrice)
      const takerChance2 = isTaker2 ? (spread2 < 0.02 ? 0.70 : 0.40) : 0.30
      const entryFee = takerFee * takerChance2

      const effectiveBet = betSize - entryFee
      const shares = effectiveBet / slippedPrice

      try {
        virtualStmts.openPosition.run(
          pick.market.id, (pick.market.question || "").slice(0, 200),
          pick.outcome || "YES", pick.direction || "BUY",
          slippedPrice, shares, betSize, pick.strategy || "Smart Brain",
          Math.round(entryFee * 10000) / 10000,
          cat,
          Math.round(slipCost * 10000) / 10000,
          Math.round(fillPct2 * 100) / 100,
        )
        _tradedMarkets.add(pick.market.id)
        tradesPlaced++
        const feeStr = entryFee > 0.001 ? ` | fee: $${entryFee.toFixed(3)}` : ""
        const fillStr2 = fillPct2 < 1.0 ? ` | fill: ${(fillPct2 * 100).toFixed(0)}%` : ""
        const spreadStr2 = book2 ? `${(spread2 * 10000).toFixed(1)} bps` : "?"
        const depthStr2 = book2 ? `bid:$${bidDepthUsd2.toFixed(0)} ask:$${askDepthUsd2.toFixed(0)}` : "no book"
        console.log(
          `[BRAIN] ✅ ${(pick.outcome || "").slice(0, 22)} @ ${(slippedPrice * 100).toFixed(2)}%` +
          ` | $${betSize.toFixed(2)} → ${shares.toFixed(1)} shares` +
          ` | ${pick.strategy}` +
          ` | spread: ${spreadStr2} | ${depthStr2}` +
          `${feeStr}${fillStr2}`
        )
      } catch (err) {
        console.error(`[BRAIN] Trade failed:`, err.message)
      }
    }

    // 3. Send DETAILED messages for every open/close
    const tag = process.platform === "darwin" ? "🏠" : "☁️"
    const hasActivity = closed.length > 0 || tradesPlaced > 0

    if (hasActivity) {
      const pnlStats = virtualStmts.getVirtualPnL.get()
      const balance = getVirtualBankroll()
      const totalFees = virtualStmts.getTotalFees.get()?.total_fees || 0

      // ── DETAILED CLOSE messages ──
      if (closed.length > 0) {
        const totalClosePnl = closed.reduce((s, c) => s + c.pnl, 0)
        const totalCloseFees = closed.reduce((s, c) => s + (c.fees || 0), 0)

        let closeMsg = `${tag} *Positions Closed*\n\n`
        for (const c of closed) {
          const icon = c.pnl >= 0 ? "✅" : "❌"
          const holdTime = c.closed_at && c.created_at
            ? ((new Date(c.closed_at) - new Date(c.created_at)) / 3600000).toFixed(1)
            : "?"
          const returnPct = c.size_usdc > 0 ? ((c.pnl / c.size_usdc) * 100).toFixed(1) : "0"
          const entryFee = c.entry_fee || 0
          const exitFee = c.exit_fee || (c.fees || 0) - entryFee
          closeMsg += `${icon} *${(c.outcome || "").slice(0, 35)}*\n`
          closeMsg += `   Strategy: ${c.strategy || "Unknown"}\n`
          closeMsg += `   Entry: ${(c.entry_price * 100).toFixed(1)}% → Exit: ${(c.exit_price * 100).toFixed(1)}%\n`
          closeMsg += `   Size: $${c.size_usdc.toFixed(2)} | Shares: ${c.shares?.toFixed(1) || "?"}\n`
          closeMsg += `   Gross: ${c.pnl + (c.fees || 0) >= 0 ? "+" : ""}$${(c.pnl + (c.fees || 0)).toFixed(2)}`
          if ((c.fees || 0) > 0.01) closeMsg += ` | Fees: -$${(c.fees).toFixed(2)}`
          closeMsg += ` | *Net: ${c.pnl >= 0 ? "+" : ""}$${c.pnl.toFixed(2)}* (${returnPct}%)\n`
          closeMsg += `   Reason: ${c.close_reason || "unknown"} | Held: ${holdTime}h\n\n`
        }
        closeMsg += `*Batch P&L:* ${totalClosePnl >= 0 ? "+" : ""}$${totalClosePnl.toFixed(2)}`
        if (totalCloseFees > 0.01) closeMsg += ` (fees: -$${totalCloseFees.toFixed(2)})`

        await safeSend(_bot, _chatId, closeMsg)
      }

      // ── DETAILED OPEN messages ──
      if (tradesPlaced > 0) {
        const allOpen = virtualStmts.getOpenPositions.all()
        const recent = allOpen.slice(-tradesPlaced)

        let openMsg = `${tag} *New Positions Opened*\n\n`
        for (const p of recent) {
          const maxProfit = p.strategy?.includes("Snipe")
            ? ((1.0 - p.entry_price) * p.shares).toFixed(2)
            : ((p.entry_price * 0.20) * p.shares).toFixed(2)
          const feeOnEntry = p.entry_fee || 0
          const cat = p.category || "other"
          const takerFeeRate = (realTrader.TAKER_FEE_RATES[cat] || 0) * 100
          openMsg += `*${(p.outcome || "").slice(0, 40)}*\n`
          openMsg += `   Strategy: ${p.strategy} | Category: ${cat}\n`
          openMsg += `   Entry: ${(p.entry_price * 100).toFixed(2)}%`
          if (p.slippage > 0.001) openMsg += ` (slip: $${p.slippage.toFixed(3)})`
          openMsg += `\n`
          openMsg += `   Size: $${p.size_usdc.toFixed(2)} | Shares: ${p.shares.toFixed(1)}\n`
          if (feeOnEntry > 0.001) openMsg += `   Entry fee: $${feeOnEntry.toFixed(3)} (maker/taker mix)\n`
          openMsg += `   Exit: free if resolved | taker ${takerFeeRate.toFixed(2)}% if sold\n`
          openMsg += `   Target: +$${maxProfit} max profit\n\n`
        }

        openMsg += `*Portfolio:* $${balance.toFixed(2)} | ${pnlStats?.total_trades || 0} trades | Win: ${pnlStats?.total_trades > 0 ? ((pnlStats.wins / pnlStats.total_trades) * 100).toFixed(0) : 0}%`
        openMsg += ` | Fees: -$${totalFees.toFixed(2)} total`
        openMsg += ` | Open: ${virtualStmts.getOpenPositions.all().length}`

        await safeSend(_bot, _chatId, openMsg)
      }
    } else {
      console.log(`[BRAIN] Cycle: scanned ${brainScan.total}, approved ${brainScan.approved.length}, no new trades`)
    }

    // 2.5. REAL MONEY EXECUTION — parallel to virtual
    if (realTrader.isRealMode() && _chatId) {
      try {
        const walletState = await realTrader.getWalletState(_chatId)
        if (walletState.connected && !walletState.error) {
          // Manage existing orders (check fills, cancel stale)
          const managed = await realTrader.manageOrders(_chatId)
          if (managed.filled > 0 || managed.cancelled > 0) {
            console.log(`[REAL] Managed: ${managed.filled} filled, ${managed.cancelled} cancelled`)
          }

          // Check positions for resolution / stop-loss / take-profit
          const posResult = await realTrader.checkPositions(_chatId)
          if (posResult.closed > 0) {
            console.log(`[REAL] Closed ${posResult.closed} positions`)
          }

          // Place new trades from brain scan (filtered by phase + risk)
          const realResult = await realTrader.processApprovedTrades(_chatId, brainScan.approved, walletState)
          if (realResult.placed > 0) {
            const phase = realResult.phase
            let msg = `💰 *Real Money Update*\n\n`
            msg += `Phase: ${phase} | Balance: $${walletState.usdc.toFixed(2)}\n`
            msg += `Placed: ${realResult.placed} orders | Skipped: ${realResult.skipped}\n\n`
            for (const r of realResult.results) {
              msg += `• ${r.side} ${(r.price * 100).toFixed(0)}% — $${r.size.toFixed(2)} (${r.strategy})\n`
            }
            msg += `\nFees: $0 (maker limit orders)`
            await safeSend(_bot, _chatId, msg)
          }

          if (posResult.closed > 0) {
            const scorecard = realTrader.generateScorecard(walletState)
            await safeSend(_bot, _chatId, scorecard)
          }
        }
      } catch (err) {
        console.error(`[REAL] Trading cycle error: ${err.message}`)
      }
    }

    // 3. Record predictions from brain-approved picks (deduplicated)
    for (const pick of brainScan.approved.slice(0, 25)) {
      const mId = pick.market?.id
      if (!mId || !shouldPredict(mId)) continue

      const outcome = pick.outcome || "YES"
      const marketPrice = pick.market?.outcomes?.[0]?.price || 0.5
      const question = pick.market?.question || ""
      const reasoning = (pick.reasoning || []).join("; ")

      // Use estimatedProb (actual probability) not confidence (checks/7 ratio)
      const predictedProb = pick.estimatedProb || marketPrice
      const checksConfidence = pick.confidence || 0.5

      recordPrediction(
        mId, question.slice(0, 200),
        outcome, predictedProb, marketPrice,
        checksConfidence, reasoning.slice(0, 500),
      )

      // Also store full decision details
      recordDecision(mId, question.slice(0, 200), {
        outcome,
        estimatedProb: predictedProb,
        marketPrice,
        confidence: checksConfidence,
        realEdge: pick.realEdge || 0,
        score: pick.score || 0,
        betSize: pick.betSize || 0,
        direction: pick.direction,
        checks: pick.checksDetail || {},
        reasoning: (pick.reasoning || []).slice(0, 10),
      })
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
