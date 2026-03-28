/**
 * Self-Improvement Engine — Makes the bot smarter over time
 *
 * Implements:
 *   1. Brier Score — gold standard prediction accuracy metric
 *   2. Calibration tracking — am I overconfident or underconfident?
 *   3. Bayesian belief updating — update probabilities with new evidence
 *   4. Strategy performance ranking — which strategies actually make money
 *   5. Feature importance tracking — what signals predict movements
 *   6. Superforecasting techniques (Tetlock) automated
 *   7. Whale wallet tracking — follow the smart money
 */
import db from "../database.mjs"
import axios from "axios"

// ── DB Tables ───────────────────────────────────────────────
db.raw.exec(`
  CREATE TABLE IF NOT EXISTS pm_brier_scores (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    period       TEXT,
    brier_score  REAL,
    calibration  REAL,
    resolution   REAL,
    total_preds  INTEGER,
    correct      INTEGER,
    overconfident_pct REAL,
    underconfident_pct REAL,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pm_strategy_scores (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy     TEXT,
    total_trades INTEGER,
    wins         INTEGER,
    losses       INTEGER,
    total_pnl    REAL,
    avg_pnl      REAL,
    win_rate     REAL,
    sharpe_ratio REAL,
    best_trade   REAL,
    worst_trade  REAL,
    grade        TEXT,
    updated_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pm_whale_wallets (
    address      TEXT PRIMARY KEY,
    label        TEXT,
    total_volume REAL DEFAULT 0,
    win_rate     REAL DEFAULT 0,
    last_seen    TEXT,
    trust_score  REAL DEFAULT 0.5,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pm_lessons (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_type  TEXT,
    lesson       TEXT,
    data         TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
`)

// ── Brier Score Calculator ──────────────────────────────────

/**
 * Calculate Brier score from predictions
 * Lower is better: 0 = perfect, 0.25 = random, 1 = worst
 */
export function calculateBrierScore(predictions) {
  if (predictions.length === 0) return { brierScore: 0.25, calibration: 0, resolution: 0 }

  let brierSum = 0
  const bins = Array.from({ length: 10 }, () => ({ forecasts: [], outcomes: [] }))
  const baseRate = predictions.filter(p => p.was_correct).length / predictions.length

  for (const pred of predictions) {
    const forecast = pred.predicted_prob
    const outcome = pred.was_correct ? 1 : 0

    // Brier score component
    brierSum += (forecast - outcome) ** 2

    // Bin for calibration
    const binIdx = Math.min(9, Math.floor(forecast * 10))
    bins[binIdx].forecasts.push(forecast)
    bins[binIdx].outcomes.push(outcome)
  }

  const brierScore = brierSum / predictions.length

  // Calibration (lower = better calibrated)
  let calibration = 0
  let resolution = 0
  for (const bin of bins) {
    if (bin.forecasts.length === 0) continue
    const avgForecast = bin.forecasts.reduce((a, b) => a + b, 0) / bin.forecasts.length
    const avgOutcome = bin.outcomes.reduce((a, b) => a + b, 0) / bin.outcomes.length
    const weight = bin.forecasts.length / predictions.length
    calibration += weight * (avgForecast - avgOutcome) ** 2
    resolution += weight * (avgOutcome - baseRate) ** 2
  }

  return { brierScore, calibration, resolution, baseRate }
}

/**
 * Generate text-based calibration curve
 */
export function generateCalibrationChart(predictions) {
  const bins = Array.from({ length: 10 }, () => ({ count: 0, correct: 0 }))

  for (const pred of predictions) {
    const binIdx = Math.min(9, Math.floor(pred.predicted_prob * 10))
    bins[binIdx].count++
    if (pred.was_correct) bins[binIdx].correct++
  }

  let chart = "Predicted → Actual (perfect = diagonal)\n"
  chart += "```\n"
  for (let i = 0; i < 10; i++) {
    const predicted = `${i * 10}-${(i + 1) * 10}%`
    const actual = bins[i].count > 0 ? (bins[i].correct / bins[i].count * 100).toFixed(0) : "--"
    const bar = bins[i].count > 0 ? "█".repeat(Math.round(bins[i].correct / bins[i].count * 10)) : ""
    const gap = bins[i].count > 0
      ? Math.abs((bins[i].correct / bins[i].count) - ((i + 0.5) / 10))
      : 0
    const gapIcon = gap > 0.15 ? "⚠️" : gap > 0.05 ? "~" : "✓"
    chart += `${predicted.padEnd(8)} ${bar.padEnd(10)} ${actual.padStart(3)}% (n=${bins[i].count}) ${gapIcon}\n`
  }
  chart += "```"
  return chart
}

// ── Strategy Scoring ────────────────────────────────────────

/**
 * Score each strategy based on its track record
 */
export function scoreStrategies() {
  const strategies = db.raw.prepare(`
    SELECT strategy,
           COUNT(*) as total_trades,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
           SUM(pnl) as total_pnl,
           AVG(pnl) as avg_pnl,
           MAX(pnl) as best_trade,
           MIN(pnl) as worst_trade
    FROM pm_virtual_portfolio WHERE status = 'closed'
    GROUP BY strategy
  `).all()

  const scored = strategies.map(s => {
    const winRate = s.total_trades > 0 ? s.wins / s.total_trades : 0

    // Grade: A-F based on win rate + profitability
    let grade = "F"
    if (winRate >= 0.8 && s.total_pnl > 0) grade = "A+"
    else if (winRate >= 0.7 && s.total_pnl > 0) grade = "A"
    else if (winRate >= 0.6 && s.total_pnl > 0) grade = "B"
    else if (winRate >= 0.5 && s.total_pnl > 0) grade = "C"
    else if (winRate >= 0.4) grade = "D"

    return { ...s, win_rate: winRate, grade }
  })

  // Save to DB
  for (const s of scored) {
    db.raw.prepare(`
      INSERT INTO pm_strategy_scores (strategy, total_trades, wins, losses, total_pnl, avg_pnl, win_rate, best_trade, worst_trade, grade)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.strategy, s.total_trades, s.wins, s.losses, s.total_pnl, s.avg_pnl, s.win_rate, s.best_trade, s.worst_trade, s.grade)
  }

  return scored
}

/**
 * Get strategy allocation advice based on performance
 */
export function getStrategyAdvice() {
  const strategies = scoreStrategies()
  if (strategies.length === 0) return "Not enough data yet. Need more trades to evaluate strategies."

  const sorted = strategies.sort((a, b) => b.total_pnl - a.total_pnl)
  const best = sorted[0]
  const worst = sorted[sorted.length - 1]

  let advice = `*Strategy Report Card:*\n\n`
  for (const s of sorted) {
    const emoji = s.grade.startsWith("A") ? "🌟" : s.grade === "B" ? "👍" : s.grade === "C" ? "😐" : "👎"
    advice += `${emoji} *${s.strategy}*: Grade ${s.grade}\n`
    advice += `   ${s.wins}W/${s.losses}L (${(s.win_rate * 100).toFixed(0)}%) | P&L: ${s.total_pnl >= 0 ? "+" : ""}$${s.total_pnl.toFixed(2)}\n`
  }

  advice += `\n*My takeaway:*\n`
  if (best.total_pnl > 0) {
    advice += `• ${best.strategy} is my best performer — I should do more of this\n`
  }
  if (worst.total_pnl < 0) {
    advice += `• ${worst.strategy} is losing money — I should reduce or stop\n`
  }

  // Record lesson
  recordLesson("strategy_review", `Best: ${best.strategy} (${best.grade}), Worst: ${worst.strategy} (${worst.grade})`)

  return advice
}

// ── Superforecasting Techniques ─────────────────────────────

/**
 * Extremize a probability (Tetlock's technique)
 * Pushes predictions away from 50% — aggregated forecasts are too moderate
 */
export function extremize(p, d = 1.5) {
  if (p <= 0.01 || p >= 0.99) return p
  const odds = Math.pow(p / (1 - p), d)
  return odds / (1 + odds)
}

/**
 * Bayesian update — adjust probability with new evidence
 */
export function bayesianUpdate(prior, likelihoodRatio) {
  const posteriorOdds = (prior / (1 - prior)) * likelihoodRatio
  const posterior = posteriorOdds / (1 + posteriorOdds)
  return Math.max(0.01, Math.min(0.99, posterior))
}

/**
 * Estimate base rate for a market category
 */
export function getBaseRate(category) {
  const baseRates = {
    "politics": 0.50,     // Binary political outcomes
    "sports": 0.50,       // Head-to-head matchups
    "crypto": 0.45,       // "Will X reach Y price" — usually doesn't
    "geopolitical": 0.15, // Wars, regime changes — rare events
    "economic": 0.40,     // Fed decisions, economic indicators
    "default": 0.50,
  }
  return baseRates[category] || baseRates.default
}

// ── Whale Tracking ──────────────────────────────────────────

/**
 * Detect large trades (whale activity) from recent market data
 */
export async function detectWhaleActivity(tokenId) {
  try {
    const { data: book } = await axios.get(`https://clob.polymarket.com/book`, {
      params: { token_id: tokenId },
      timeout: 5000,
    })

    const largeBids = (book.bids || []).filter(b => parseFloat(b.size) > 50000)
    const largeAsks = (book.asks || []).filter(a => parseFloat(a.size) > 50000)

    const buyPressure = largeBids.reduce((s, b) => s + parseFloat(b.size), 0)
    const sellPressure = largeAsks.reduce((s, a) => s + parseFloat(a.size), 0)
    const total = buyPressure + sellPressure

    return {
      largeBids: largeBids.length,
      largeAsks: largeAsks.length,
      buyPressure,
      sellPressure,
      whaleDirection: total > 0 ? (buyPressure > sellPressure ? "BULLISH" : "BEARISH") : "NEUTRAL",
      ratio: total > 0 ? buyPressure / total : 0.5,
    }
  } catch {
    return null
  }
}

// ── Lessons System ──────────────────────────────────────────

function recordLesson(type, lesson, data = null) {
  db.raw.prepare(`INSERT INTO pm_lessons (lesson_type, lesson, data) VALUES (?, ?, ?)`).run(
    type, lesson, data ? JSON.stringify(data) : null,
  )
}

export function getRecentLessons(limit = 10) {
  return db.raw.prepare(`SELECT * FROM pm_lessons ORDER BY created_at DESC LIMIT ?`).all(limit)
}

// ── Full Self-Improvement Report ────────────────────────────

/**
 * Generate comprehensive self-improvement report
 */
export function generateImprovementReport() {
  // Get evaluated predictions
  const predictions = db.raw.prepare(
    `SELECT * FROM pm_predictions WHERE status = 'evaluated'`
  ).all()

  if (predictions.length < 3) {
    return `🧠 *Self-Improvement Report*\n\n_Need at least 3 evaluated predictions. Currently have ${predictions.length}. Waiting for markets to resolve..._`
  }

  const brier = calculateBrierScore(predictions)
  const calibChart = generateCalibrationChart(predictions)
  const strategyAdvice = getStrategyAdvice()
  const lessons = getRecentLessons(5)

  // Brier score interpretation
  let brierRating = "❌ Bad"
  if (brier.brierScore < 0.1) brierRating = "🌟 Superforecaster level"
  else if (brier.brierScore < 0.15) brierRating = "✅ Very good"
  else if (brier.brierScore < 0.20) brierRating = "👍 Good"
  else if (brier.brierScore < 0.25) brierRating = "😐 Average (coin flip)"

  // Calibration insight
  let calibInsight = ""
  if (brier.calibration > 0.05) {
    // Check if overconfident or underconfident
    const overconfident = predictions.filter(p => p.predicted_prob > 0.5 && !p.was_correct).length
    const underconfident = predictions.filter(p => p.predicted_prob < 0.5 && p.was_correct).length
    if (overconfident > underconfident) {
      calibInsight = "I'm *overconfident* — predicting things will happen more than they do. I should be more cautious."
    } else {
      calibInsight = "I'm *underconfident* — things happen more often than I predict. I should be bolder."
    }
  } else {
    calibInsight = "My calibration looks good — predictions match reality."
  }

  // Save Brier score
  const period = new Date().toISOString().split("T")[0]
  db.raw.prepare(`
    INSERT INTO pm_brier_scores (period, brier_score, calibration, resolution, total_preds, correct)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(period, brier.brierScore, brier.calibration, brier.resolution, predictions.length, predictions.filter(p => p.was_correct).length)

  // Record lesson
  recordLesson("brier_score", `Brier: ${brier.brierScore.toFixed(3)}, Calibration: ${brier.calibration.toFixed(3)}`)

  const lessonLines = lessons.slice(0, 3).map(l => `• ${l.lesson}`).join("\n")

  const tag = process.platform === "darwin" ? "🏠" : "☁️"
  return `${tag} *Self-Improvement Report*\n\n` +
    `*Brier Score:* ${brier.brierScore.toFixed(3)} — ${brierRating}\n` +
    `  Calibration: ${brier.calibration.toFixed(3)} (lower = better)\n` +
    `  Resolution: ${brier.resolution.toFixed(3)} (higher = better)\n` +
    `  Predictions: ${predictions.length}\n\n` +
    `*Calibration:* ${calibInsight}\n\n` +
    `${calibChart}\n\n` +
    `${strategyAdvice}\n\n` +
    (lessonLines ? `*Recent Lessons:*\n${lessonLines}\n` : "")
}

export default {
  calculateBrierScore,
  generateCalibrationChart,
  scoreStrategies,
  getStrategyAdvice,
  extremize,
  bayesianUpdate,
  getBaseRate,
  detectWhaleActivity,
  getRecentLessons,
  generateImprovementReport,
}
