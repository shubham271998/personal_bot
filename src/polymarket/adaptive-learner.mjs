/**
 * Adaptive Learner — The bot's brain that evolves from mistakes
 *
 * What it does:
 *   1. Tracks win rate per strategy → adjusts allocation
 *   2. Tracks win rate per price range → avoids bad zones
 *   3. Learns which market categories it's good/bad at
 *   4. Automatically reduces losing strategies, doubles down on winners
 *   5. Stores and retrieves lessons for every decision
 *
 * The key insight: the bot starts with default allocations,
 * then SHIFTS capital toward what actually works based on real results.
 */
import db from "../database.mjs"

// ── DB ──────────────────────────────────────────────────────
db.raw.exec(`
  CREATE TABLE IF NOT EXISTS pm_strategy_weights (
    strategy     TEXT PRIMARY KEY,
    weight       REAL DEFAULT 1.0,
    base_weight  REAL DEFAULT 1.0,
    total_trades INTEGER DEFAULT 0,
    wins         INTEGER DEFAULT 0,
    losses       INTEGER DEFAULT 0,
    total_pnl    REAL DEFAULT 0,
    avg_pnl      REAL DEFAULT 0,
    win_rate     REAL DEFAULT 0,
    last_updated TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pm_price_range_stats (
    range_label  TEXT PRIMARY KEY,
    range_min    REAL,
    range_max    REAL,
    total_trades INTEGER DEFAULT 0,
    wins         INTEGER DEFAULT 0,
    total_pnl    REAL DEFAULT 0,
    should_trade INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS pm_category_stats (
    category     TEXT PRIMARY KEY,
    total_trades INTEGER DEFAULT 0,
    wins         INTEGER DEFAULT 0,
    total_pnl    REAL DEFAULT 0,
    confidence   REAL DEFAULT 0.5
  );
`)

// Initialize default strategy weights
const DEFAULT_STRATEGIES = {
  "Resolution Snipe": 1.5,    // Start high — safest strategy
  "AI Signal": 1.2,           // Claude-backed directional trades — high trust
  "NegRisk Arbitrage": 1.5,   // Risk-free
  "Arbitrage": 1.5,           // Risk-free
  "News Alpha": 0.8,          // Medium confidence
  "Momentum": 0.6,            // Lower confidence
  "Smart Brain": 0.5,         // Needs AI backing to be good
  "Long Shot": 0.3,           // Start low — most risky
}

// Initialize price range stats
const PRICE_RANGES = [
  { label: "0-10%", min: 0, max: 0.10 },
  { label: "10-20%", min: 0.10, max: 0.20 },
  { label: "20-35%", min: 0.20, max: 0.35 },
  { label: "35-50%", min: 0.35, max: 0.50 },
  { label: "51-67% (DANGER)", min: 0.51, max: 0.67 },
  { label: "67-80%", min: 0.67, max: 0.80 },
  { label: "80-90%", min: 0.80, max: 0.90 },
  { label: "90-100%", min: 0.90, max: 1.00 },
]

// Ensure defaults exist
for (const [strategy, weight] of Object.entries(DEFAULT_STRATEGIES)) {
  db.raw.prepare(`
    INSERT OR IGNORE INTO pm_strategy_weights (strategy, weight, base_weight)
    VALUES (?, ?, ?)
  `).run(strategy, weight, weight)
}

for (const range of PRICE_RANGES) {
  db.raw.prepare(`
    INSERT OR IGNORE INTO pm_price_range_stats (range_label, range_min, range_max)
    VALUES (?, ?, ?)
  `).run(range.label, range.min, range.max)
}

// Initialize category stats
for (const cat of ["sports", "crypto", "politics", "economics", "geopolitical", "entertainment", "other"]) {
  db.raw.prepare(`
    INSERT OR IGNORE INTO pm_category_stats (category) VALUES (?)
  `).run(cat)
}

const stmts = {
  getWeight: db.raw.prepare(`SELECT * FROM pm_strategy_weights WHERE strategy = ?`),
  getAllWeights: db.raw.prepare(`SELECT * FROM pm_strategy_weights ORDER BY weight DESC`),
  updateWeight: db.raw.prepare(`
    UPDATE pm_strategy_weights
    SET weight = ?, total_trades = ?, wins = ?, losses = ?, total_pnl = ?,
        avg_pnl = ?, win_rate = ?, last_updated = datetime('now')
    WHERE strategy = ?
  `),
  getPriceRange: db.raw.prepare(`SELECT * FROM pm_price_range_stats WHERE range_min <= ? AND range_max > ?`),
  updatePriceRange: db.raw.prepare(`
    UPDATE pm_price_range_stats
    SET total_trades = total_trades + 1,
        wins = wins + ?,
        total_pnl = total_pnl + ?,
        should_trade = ?
    WHERE range_label = ?
  `),
  getAllPriceRanges: db.raw.prepare(`SELECT * FROM pm_price_range_stats ORDER BY range_min`),
  addLesson: db.raw.prepare(`INSERT INTO pm_lessons (lesson_type, lesson, data) VALUES (?, ?, ?)`),

  // Category tracking
  getCategoryStats: db.raw.prepare(`SELECT * FROM pm_category_stats WHERE category = ?`),
  getAllCategoryStats: db.raw.prepare(`SELECT * FROM pm_category_stats ORDER BY total_trades DESC`),
  updateCategoryStats: db.raw.prepare(`
    UPDATE pm_category_stats
    SET total_trades = total_trades + 1,
        wins = wins + ?,
        total_pnl = total_pnl + ?,
        confidence = ?
    WHERE category = ?
  `),

  // Lessons querying — check if we've had repeated losses on similar markets
  getRecentLosses: db.raw.prepare(`
    SELECT lesson, data FROM pm_lessons
    WHERE lesson_type IN ('big_loss', 'range_disabled', 'strategy_adjustment')
    ORDER BY created_at DESC LIMIT 20
  `),
}

// ── Core Learning Functions ─────────────────────────────────

/**
 * Learn from a closed trade — updates all relevant stats
 * Call this every time a virtual or real trade closes
 */
export function learnFromTrade(trade) {
  const won = trade.pnl > 0
  const strategy = trade.strategy || "Unknown"
  const entryPrice = trade.entry_price || 0.5

  // 1. Update strategy weight
  updateStrategyWeight(strategy, won, trade.pnl)

  // 2. Update price range stats
  updatePriceRangeStats(entryPrice, won, trade.pnl)

  // 3. Update category stats (if category provided)
  if (trade.category) {
    updateCategoryStats(trade.category, won, trade.pnl)
  }

  // 4. Record lesson if notable
  if (trade.pnl < -10) {
    stmts.addLesson.run("big_loss",
      `Lost $${Math.abs(trade.pnl).toFixed(2)} on ${strategy} at ${(entryPrice * 100).toFixed(0)}% — ${trade.close_reason || "unknown reason"}`,
      JSON.stringify({ strategy, entryPrice, pnl: trade.pnl, reason: trade.close_reason, category: trade.category }),
    )
  }
  if (trade.pnl > 10) {
    stmts.addLesson.run("big_win",
      `Won $${trade.pnl.toFixed(2)} on ${strategy} at ${(entryPrice * 100).toFixed(0)}%`,
      JSON.stringify({ strategy, entryPrice, pnl: trade.pnl, category: trade.category }),
    )
  }
}

/**
 * Update strategy weight based on results
 * Winners get more capital, losers get less
 */
function updateStrategyWeight(strategy, won, pnl) {
  let row = stmts.getWeight.get(strategy)
  if (!row) {
    db.raw.prepare(`INSERT OR IGNORE INTO pm_strategy_weights (strategy, weight, base_weight) VALUES (?, 0.5, 0.5)`).run(strategy)
    row = stmts.getWeight.get(strategy)
  }

  const newTrades = (row.total_trades || 0) + 1
  const newWins = (row.wins || 0) + (won ? 1 : 0)
  const newLosses = newTrades - newWins
  const newPnl = (row.total_pnl || 0) + pnl
  const newWinRate = newTrades > 0 ? newWins / newTrades : 0
  const newAvgPnl = newTrades > 0 ? newPnl / newTrades : 0

  // Adaptive weight: start from base, adjust by performance
  // Good performance → increase weight (more capital)
  // Bad performance → decrease weight (less capital)
  let newWeight = row.base_weight

  if (newTrades >= 3) { // Need minimum 3 trades to start adjusting
    if (newWinRate >= 0.7 && newPnl > 0) {
      newWeight = row.base_weight * 1.5 // Boost winner
    } else if (newWinRate >= 0.5 && newPnl > 0) {
      newWeight = row.base_weight * 1.2 // Slight boost
    } else if (newWinRate < 0.3) {
      newWeight = row.base_weight * 0.3 // Heavily penalize
    } else if (newWinRate < 0.5 && newPnl < 0) {
      newWeight = row.base_weight * 0.5 // Reduce loser
    }
  }

  // Clamp weight between 0.1 (almost off) and 2.0 (double allocation)
  newWeight = Math.max(0.1, Math.min(2.0, newWeight))

  stmts.updateWeight.run(newWeight, newTrades, newWins, newLosses, newPnl, newAvgPnl, newWinRate, strategy)
}

/**
 * Update price range statistics
 * If a range is consistently losing → mark as should_trade = false
 */
function updatePriceRangeStats(price, won, pnl) {
  const range = PRICE_RANGES.find(r => price >= r.min && price < r.max)
  if (!range) return

  const row = stmts.getPriceRange.get(price, price)
  if (!row) return

  const newTrades = (row.total_trades || 0) + 1
  const newWins = (row.wins || 0) + (won ? 1 : 0)
  const newPnl = (row.total_pnl || 0) + pnl
  const winRate = newTrades > 0 ? newWins / newTrades : 0

  // Auto-disable range if win rate < 30% after 5+ trades
  const shouldTrade = newTrades < 5 || winRate >= 0.30 ? 1 : 0

  stmts.updatePriceRange.run(won ? 1 : 0, pnl, shouldTrade, range.label)

  if (!shouldTrade && newTrades >= 5) {
    stmts.addLesson.run("range_disabled",
      `Disabled ${range.label} range — ${(winRate * 100).toFixed(0)}% win rate after ${newTrades} trades. Too risky.`,
      null,
    )
  }
}

/**
 * Update category performance stats
 */
function updateCategoryStats(category, won, pnl) {
  const row = stmts.getCategoryStats.get(category)
  if (!row) return

  const newTrades = (row.total_trades || 0) + 1
  const newWins = (row.wins || 0) + (won ? 1 : 0)
  const winRate = newTrades > 0 ? newWins / newTrades : 0.5

  // Confidence: starts at 0.5, adjusts toward actual win rate after enough data
  const confidence = newTrades >= 5 ? winRate : 0.5

  stmts.updateCategoryStats.run(won ? 1 : 0, pnl, confidence, category)

  // Auto-lesson if category is consistently losing
  if (newTrades >= 5 && winRate < 0.25) {
    stmts.addLesson.run("category_weak",
      `Category '${category}' only ${(winRate * 100).toFixed(0)}% win rate after ${newTrades} trades — reduce exposure`,
      JSON.stringify({ category, winRate, trades: newTrades, pnl: row.total_pnl + pnl }),
    )
  }
}

// ── Query Functions ─────────────────────────────────────────

/**
 * Get the current weight for a strategy (used by trading engine)
 */
export function getStrategyWeight(strategy) {
  const row = stmts.getWeight.get(strategy)
  return row?.weight || 0.5
}

/**
 * Check if a price range is safe to trade
 */
export function isPriceRangeSafe(price) {
  const range = PRICE_RANGES.find(r => price >= r.min && price < r.max)
  if (!range) return true
  const row = stmts.getPriceRange.get(price, price)
  return row ? row.should_trade === 1 : true
}

/**
 * Get confidence multiplier for a category (0.3 to 1.5)
 * Used by Smart Brain to size bets based on past category performance
 */
export function getCategoryConfidence(category) {
  const row = stmts.getCategoryStats.get(category)
  if (!row || row.total_trades < 3) return 1.0 // Not enough data, neutral

  // Scale: 0% win rate → 0.3x, 50% → 1.0x, 80%+ → 1.5x
  const winRate = row.total_trades > 0 ? row.wins / row.total_trades : 0.5
  if (winRate >= 0.7) return 1.5
  if (winRate >= 0.5) return 1.0 + (winRate - 0.5) * 2 // 0.5→1.0, 0.7→1.4
  if (winRate >= 0.3) return 0.6 + (winRate - 0.3) * 2 // 0.3→0.6, 0.5→1.0
  return 0.3 // Below 30% win rate — barely trade this category
}

/**
 * Check if we've had repeated losses on a similar pattern
 * Returns a penalty multiplier (0.5 = halve bet, 1.0 = no penalty)
 */
export function getLessonPenalty(strategy, entryPrice) {
  try {
    const recentLosses = stmts.getRecentLosses.all()
    let matchingLosses = 0

    for (const lesson of recentLosses) {
      if (!lesson.data) continue
      try {
        const data = JSON.parse(lesson.data)
        // Check if same strategy and similar price range
        if (data.strategy === strategy && Math.abs((data.entryPrice || 0) - entryPrice) < 0.1) {
          matchingLosses++
        }
      } catch {}
    }

    // 3+ similar losses → halve the bet. 5+ → quarter it.
    if (matchingLosses >= 5) return 0.25
    if (matchingLosses >= 3) return 0.5
    return 1.0
  } catch {
    return 1.0
  }
}

/**
 * Get all strategy weights (for display)
 */
export function getAllWeights() {
  return stmts.getAllWeights.all()
}

/**
 * Get all price range stats (for display)
 */
export function getAllPriceRanges() {
  return stmts.getAllPriceRanges.all()
}

/**
 * Get all category stats (for display)
 */
export function getAllCategoryStats() {
  return stmts.getAllCategoryStats.all()
}

/**
 * Generate a learning report
 */
export function generateLearningReport() {
  const weights = getAllWeights()
  const ranges = getAllPriceRanges()
  const lessons = db.raw.prepare(`SELECT * FROM pm_lessons ORDER BY created_at DESC LIMIT 8`).all()

  const tag = process.platform === "darwin" ? "🏠" : "☁️"
  let report = `${tag} *What I've Learned*\n\n`

  // Strategy performance
  report += `*Strategy Weights (adaptive):*\n`
  for (const w of weights) {
    const bar = "█".repeat(Math.round(w.weight * 5)) + "░".repeat(10 - Math.round(w.weight * 5))
    const emoji = w.weight >= 1.2 ? "🔥" : w.weight >= 0.8 ? "✅" : w.weight >= 0.5 ? "⚠️" : "🚫"
    const stats = w.total_trades > 0 ? ` (${w.wins}W/${w.losses}L, ${(w.win_rate * 100).toFixed(0)}%)` : ` (no trades yet)`
    report += `${emoji} ${w.strategy}\n   ${bar} ${(w.weight * 100).toFixed(0)}%${stats}\n`
  }

  // Price ranges
  report += `\n*Price Range Performance:*\n`
  for (const r of ranges) {
    if (r.total_trades === 0) continue
    const winRate = r.total_trades > 0 ? (r.wins / r.total_trades * 100).toFixed(0) : 0
    const status = r.should_trade ? "✅" : "🚫"
    report += `${status} ${r.range_label}: ${winRate}% win (${r.total_trades} trades, ${r.total_pnl >= 0 ? "+" : ""}$${r.total_pnl.toFixed(2)})\n`
  }

  // Category performance
  const categories = getAllCategoryStats()
  const activeCats = categories.filter(c => c.total_trades > 0)
  if (activeCats.length > 0) {
    report += `\n*Category Performance:*\n`
    for (const c of activeCats) {
      const winRate = c.total_trades > 0 ? (c.wins / c.total_trades * 100).toFixed(0) : 0
      const conf = getCategoryConfidence(c.category)
      const emoji = conf >= 1.2 ? "🔥" : conf >= 0.8 ? "✅" : conf >= 0.5 ? "⚠️" : "🚫"
      report += `${emoji} ${c.category}: ${winRate}% win (${c.total_trades} trades, ${c.total_pnl >= 0 ? "+" : ""}$${c.total_pnl.toFixed(2)}) → ${(conf * 100).toFixed(0)}% sizing\n`
    }
  }

  // Recent lessons
  if (lessons.length > 0) {
    report += `\n*Recent Lessons:*\n`
    for (const l of lessons.slice(0, 5)) {
      const icon = l.lesson_type === "big_win" ? "✅" : l.lesson_type === "big_loss" ? "❌" : l.lesson_type === "category_weak" ? "⚠️" : "📝"
      report += `${icon} ${l.lesson}\n`
    }
  }

  return report
}

export default {
  learnFromTrade,
  getStrategyWeight,
  isPriceRangeSafe,
  getCategoryConfidence,
  getLessonPenalty,
  getAllWeights,
  getAllPriceRanges,
  getAllCategoryStats,
  generateLearningReport,
}
