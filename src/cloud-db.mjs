/**
 * Cloud Database — Turso (LibSQL) for permanent data storage
 *
 * ⚠️ This data is PERMANENT. It NEVER gets cleared.
 * The cloud DB is the bot's long-term memory across all deploys.
 *
 * Architecture:
 *   Local SQLite (fast, for real-time operations)
 *     ↕ syncs to ↕
 *   Turso Cloud DB (permanent, survives everything)
 *
 * Both local and cloud bots sync to the SAME Turso DB.
 * This means:
 *   - Cloud bot learns → Local bot sees the learning
 *   - Local bot's data → backed up to cloud
 *   - Redeploy Railway → data still there
 *   - Laptop dies → data still there
 */
import { createClient } from "@libsql/client"

const TURSO_URL = process.env.TURSO_DB_URL || ""
const TURSO_TOKEN = process.env.TURSO_DB_TOKEN || ""

let client = null
let isConnected = false

/**
 * Initialize cloud DB connection
 */
export function init() {
  if (!TURSO_URL || !TURSO_TOKEN) {
    console.log("[CLOUD-DB] No Turso credentials — running local only")
    return false
  }

  try {
    client = createClient({
      url: TURSO_URL,
      authToken: TURSO_TOKEN,
    })
    isConnected = true
    console.log("[CLOUD-DB] Connected to Turso (Mumbai)")
    return true
  } catch (err) {
    console.error("[CLOUD-DB] Connection failed:", err.message)
    return false
  }
}

/**
 * Create all tables in cloud DB (mirrors local schema)
 */
export async function setupTables() {
  if (!client) return

  const tables = [
    `CREATE TABLE IF NOT EXISTS pm_virtual_portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT, market_question TEXT, outcome TEXT, side TEXT,
      entry_price REAL, shares REAL, size_usdc REAL, strategy TEXT,
      status TEXT DEFAULT 'open', exit_price REAL, pnl REAL DEFAULT 0,
      close_reason TEXT, created_at TEXT, closed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pm_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT, market_question TEXT, predicted_outcome TEXT,
      predicted_prob REAL, market_price REAL, confidence REAL, reasoning TEXT,
      status TEXT DEFAULT 'open', actual_outcome TEXT, was_correct INTEGER,
      profit_if_bet REAL, evaluated_at TEXT, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pm_strategy_weights (
      strategy TEXT PRIMARY KEY, weight REAL DEFAULT 1.0, base_weight REAL DEFAULT 1.0,
      total_trades INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0,
      total_pnl REAL DEFAULT 0, avg_pnl REAL DEFAULT 0, win_rate REAL DEFAULT 0,
      last_updated TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pm_price_range_stats (
      range_label TEXT PRIMARY KEY, range_min REAL, range_max REAL,
      total_trades INTEGER DEFAULT 0, wins INTEGER DEFAULT 0,
      total_pnl REAL DEFAULT 0, should_trade INTEGER DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS pm_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_type TEXT, lesson TEXT, data TEXT, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pm_brier_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT, brier_score REAL, calibration REAL, resolution REAL,
      total_preds INTEGER, correct INTEGER, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pm_eval_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period TEXT, total_predictions INTEGER, correct INTEGER,
      accuracy REAL, avg_confidence REAL, calibration_error REAL,
      profit_score REAL, notes TEXT, created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT, market_question TEXT, outcome TEXT, direction TEXT,
      estimated_prob REAL, market_price REAL, confidence REAL,
      real_edge REAL, score REAL, bet_size REAL,
      checks TEXT, reasoning TEXT, created_at TEXT
    )`,
  ]

  for (const sql of tables) {
    try { await client.execute(sql) } catch {}
  }

  console.log("[CLOUD-DB] Tables ready")
}

/**
 * Sync local SQLite data UP to cloud Turso
 * Call this periodically (every 5 min)
 */
export async function syncToCloud(localDb) {
  if (!client || !localDb) return { synced: 0 }

  let synced = 0

  try {
    // Sync closed trades
    const closedTrades = localDb.prepare(
      `SELECT * FROM pm_virtual_portfolio WHERE status = 'closed' ORDER BY id DESC LIMIT 50`
    ).all()

    for (const t of closedTrades) {
      try {
        await client.execute({
          sql: `INSERT OR REPLACE INTO pm_virtual_portfolio (id, market_id, market_question, outcome, side, entry_price, shares, size_usdc, strategy, status, exit_price, pnl, close_reason, created_at, closed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [t.id, t.market_id, t.market_question, t.outcome, t.side, t.entry_price, t.shares, t.size_usdc, t.strategy, t.status, t.exit_price, t.pnl, t.close_reason, t.created_at, t.closed_at],
        })
        synced++
      } catch {}
    }

    // Sync strategy weights
    const weights = localDb.prepare(`SELECT * FROM pm_strategy_weights`).all()
    for (const w of weights) {
      try {
        await client.execute({
          sql: `INSERT OR REPLACE INTO pm_strategy_weights (strategy, weight, base_weight, total_trades, wins, losses, total_pnl, avg_pnl, win_rate, last_updated)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [w.strategy, w.weight, w.base_weight, w.total_trades, w.wins, w.losses, w.total_pnl, w.avg_pnl, w.win_rate, w.last_updated],
        })
        synced++
      } catch {}
    }

    // Sync lessons
    const lessons = localDb.prepare(`SELECT * FROM pm_lessons ORDER BY id DESC LIMIT 50`).all()
    for (const l of lessons) {
      try {
        await client.execute({
          sql: `INSERT OR IGNORE INTO pm_lessons (id, lesson_type, lesson, data, created_at) VALUES (?, ?, ?, ?, ?)`,
          args: [l.id, l.lesson_type, l.lesson, l.data, l.created_at],
        })
        synced++
      } catch {}
    }

    // Sync predictions
    const preds = localDb.prepare(`SELECT * FROM pm_predictions ORDER BY id DESC LIMIT 50`).all()
    for (const p of preds) {
      try {
        await client.execute({
          sql: `INSERT OR REPLACE INTO pm_predictions (id, market_id, market_question, predicted_outcome, predicted_prob, market_price, confidence, reasoning, status, actual_outcome, was_correct, profit_if_bet, evaluated_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [p.id, p.market_id, p.market_question, p.predicted_outcome, p.predicted_prob, p.market_price, p.confidence, p.reasoning, p.status, p.actual_outcome, p.was_correct, p.profit_if_bet, p.evaluated_at, p.created_at],
        })
        synced++
      } catch {}
    }

    // Sync Brier scores
    const brier = localDb.prepare(`SELECT * FROM pm_brier_scores ORDER BY id DESC LIMIT 20`).all()
    for (const b of brier) {
      try {
        await client.execute({
          sql: `INSERT OR IGNORE INTO pm_brier_scores (id, period, brier_score, calibration, resolution, total_preds, correct, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [b.id, b.period, b.brier_score, b.calibration, b.resolution, b.total_preds, b.correct, b.created_at],
        })
        synced++
      } catch {}
    }

    // Sync price range stats
    const ranges = localDb.prepare(`SELECT * FROM pm_price_range_stats`).all()
    for (const r of ranges) {
      try {
        await client.execute({
          sql: `INSERT OR REPLACE INTO pm_price_range_stats (range_label, range_min, range_max, total_trades, wins, total_pnl, should_trade)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [r.range_label, r.range_min, r.range_max, r.total_trades, r.wins, r.total_pnl, r.should_trade],
        })
        synced++
      } catch {}
    }

    // Sync eval scores
    try {
      const evals = localDb.prepare(`SELECT * FROM pm_eval_scores ORDER BY id DESC LIMIT 20`).all()
      for (const e of evals) {
        try {
          await client.execute({
            sql: `INSERT OR IGNORE INTO pm_eval_scores (id, period, total_predictions, correct, accuracy, avg_confidence, calibration_error, profit_score, notes, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [e.id, e.period, e.total_predictions, e.correct, e.accuracy, e.avg_confidence, e.calibration_error, e.profit_score, e.notes, e.created_at],
          })
          synced++
        } catch {}
      }
    } catch {}

    // Sync decisions (recent 50)
    try {
      const decisions = localDb.prepare(`SELECT * FROM pm_decisions ORDER BY id DESC LIMIT 50`).all()
      for (const d of decisions) {
        try {
          await client.execute({
            sql: `INSERT OR IGNORE INTO pm_decisions (id, market_id, market_question, outcome, direction, estimated_prob, market_price, confidence, real_edge, score, bet_size, checks, reasoning, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [d.id, d.market_id, d.market_question, d.outcome, d.direction, d.estimated_prob, d.market_price, d.confidence, d.real_edge, d.score, d.bet_size, d.checks, d.reasoning, d.created_at],
          })
          synced++
        } catch {}
      }
    } catch {}
  } catch (err) {
    console.error("[CLOUD-DB] Sync error:", err.message)
  }

  if (synced > 0) console.log(`[CLOUD-DB] Synced ${synced} records to cloud`)
  return { synced }
}

/**
 * Pull cloud data DOWN to local (for new installs or recovery)
 */
export async function pullFromCloud(localDb) {
  if (!client || !localDb) return { pulled: 0 }

  let pulled = 0

  try {
    // Pull strategy weights (most important for continuity)
    const weights = await client.execute("SELECT * FROM pm_strategy_weights")
    for (const w of weights.rows) {
      try {
        localDb.prepare(`INSERT OR REPLACE INTO pm_strategy_weights (strategy, weight, base_weight, total_trades, wins, losses, total_pnl, avg_pnl, win_rate, last_updated)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          w.strategy, w.weight, w.base_weight, w.total_trades, w.wins, w.losses, w.total_pnl, w.avg_pnl, w.win_rate, w.last_updated,
        )
        pulled++
      } catch {}
    }

    // Pull lessons
    const lessons = await client.execute("SELECT * FROM pm_lessons ORDER BY id DESC LIMIT 100")
    for (const l of lessons.rows) {
      try {
        localDb.prepare(`INSERT OR IGNORE INTO pm_lessons (id, lesson_type, lesson, data, created_at) VALUES (?, ?, ?, ?, ?)`).run(
          l.id, l.lesson_type, l.lesson, l.data, l.created_at,
        )
        pulled++
      } catch {}
    }

    // Pull price range stats
    const ranges = await client.execute("SELECT * FROM pm_price_range_stats")
    for (const r of ranges.rows) {
      try {
        localDb.prepare(`INSERT OR REPLACE INTO pm_price_range_stats (range_label, range_min, range_max, total_trades, wins, total_pnl, should_trade)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          r.range_label, r.range_min, r.range_max, r.total_trades, r.wins, r.total_pnl, r.should_trade,
        )
        pulled++
      } catch {}
    }

    // Pull AI research (local daemon pushes → Turso → cloud bot pulls)
    try {
      localDb.prepare(`CREATE TABLE IF NOT EXISTS pm_research (
        market_id TEXT PRIMARY KEY, market_question TEXT, category TEXT,
        yes_price REAL, volume_24h REAL, ai_probability REAL, ai_confidence TEXT,
        ai_direction TEXT, ai_reasoning TEXT, ai_headlines TEXT, ai_model TEXT,
        researched_at TEXT, expires_at TEXT
      )`).run()
    } catch {}

    try {
      const research = await client.execute("SELECT * FROM pm_research WHERE expires_at > datetime('now')")
      for (const r of research.rows) {
        try {
          localDb.prepare(`INSERT OR REPLACE INTO pm_research (market_id, market_question, category, yes_price, volume_24h,
            ai_probability, ai_confidence, ai_direction, ai_reasoning, ai_headlines, ai_model, researched_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            r.market_id, r.market_question, r.category, r.yes_price, r.volume_24h,
            r.ai_probability, r.ai_confidence, r.ai_direction, r.ai_reasoning, r.ai_headlines,
            r.ai_model, r.researched_at, r.expires_at,
          )
          pulled++
        } catch {}
      }
    } catch {}
  } catch (err) {
    console.error("[CLOUD-DB] Pull error:", err.message)
  }

  if (pulled > 0) console.log(`[CLOUD-DB] Pulled ${pulled} records from cloud`)
  return { pulled }
}

/**
 * Get cloud DB stats
 */
export async function getStats() {
  if (!client) return null

  try {
    const tables = ["pm_virtual_portfolio", "pm_predictions", "pm_lessons", "pm_strategy_weights", "pm_brier_scores", "pm_eval_scores", "pm_decisions", "pm_research"]
    const stats = {}
    for (const table of tables) {
      try {
        const result = await client.execute(`SELECT COUNT(*) as c FROM ${table}`)
        stats[table] = result.rows[0].c
      } catch { stats[table] = 0 }
    }
    return stats
  } catch {
    return null
  }
}

export default {
  init,
  setupTables,
  syncToCloud,
  pullFromCloud,
  getStats,
  get connected() { return isConnected },
}
