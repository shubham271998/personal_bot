/**
 * Database — SQLite persistence for users, sessions, and usage
 *
 * Tables:
 *   users        — registration, auth, admin status
 *   api_keys     — encrypted API keys (separate for security)
 *   sessions     — per-session usage tracking
 *   daily_usage  — aggregated daily stats per user
 */
import Database from "better-sqlite3"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_DIR = process.env.DB_DIR || path.resolve(__dirname, "../data")
const DB_PATH = path.join(DB_DIR, "bot.db")

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH, { verbose: process.env.DB_DEBUG === "true" ? console.log : undefined })

// Enable WAL mode for better concurrent performance
db.pragma("journal_mode = WAL")
db.pragma("foreign_keys = ON")

// ── Schema ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id    INTEGER PRIMARY KEY,
    username       TEXT,
    first_name     TEXT,
    auth_method    TEXT DEFAULT 'none',
    is_approved    INTEGER DEFAULT 0,
    is_admin       INTEGER DEFAULT 0,
    registered_at  TEXT DEFAULT (datetime('now')),
    last_active_at TEXT DEFAULT (datetime('now')),
    settings       TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    telegram_id    INTEGER PRIMARY KEY REFERENCES users(telegram_id),
    encrypted_key  TEXT NOT NULL,
    key_set_at     TEXT DEFAULT (datetime('now')),
    last_used_at   TEXT,
    total_uses     INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id    INTEGER REFERENCES users(telegram_id),
    project        TEXT,
    prompt         TEXT,
    response_len   INTEGER DEFAULT 0,
    duration_ms    INTEGER DEFAULT 0,
    cost_usd       REAL DEFAULT 0,
    input_tokens   INTEGER DEFAULT 0,
    output_tokens  INTEGER DEFAULT 0,
    cache_tokens   INTEGER DEFAULT 0,
    model          TEXT,
    status         TEXT DEFAULT 'success',
    error          TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_usage (
    telegram_id    INTEGER REFERENCES users(telegram_id),
    date           TEXT,
    sessions       INTEGER DEFAULT 0,
    cost_usd       REAL DEFAULT 0,
    input_tokens   INTEGER DEFAULT 0,
    output_tokens  INTEGER DEFAULT 0,
    cache_tokens   INTEGER DEFAULT 0,
    PRIMARY KEY (telegram_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(telegram_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(created_at);
  CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_usage(date);
`)

// ── Prepared Statements ─────────────────────────────────────
const stmts = {
  // Users
  upsertUser: db.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = COALESCE(excluded.username, username),
      first_name = COALESCE(excluded.first_name, first_name),
      last_active_at = datetime('now')
  `),
  getUser: db.prepare(`SELECT * FROM users WHERE telegram_id = ?`),
  approveUser: db.prepare(`UPDATE users SET is_approved = 1 WHERE telegram_id = ?`),
  blockUser: db.prepare(`UPDATE users SET is_approved = 0 WHERE telegram_id = ?`),
  setAuthMethod: db.prepare(`UPDATE users SET auth_method = ? WHERE telegram_id = ?`),
  touchUser: db.prepare(`UPDATE users SET last_active_at = datetime('now') WHERE telegram_id = ?`),
  listUsers: db.prepare(`
    SELECT u.*, ak.encrypted_key IS NOT NULL as has_key,
           (SELECT COUNT(*) FROM sessions s WHERE s.telegram_id = u.telegram_id) as total_sessions,
           (SELECT COALESCE(SUM(cost_usd), 0) FROM sessions s WHERE s.telegram_id = u.telegram_id) as total_cost
    FROM users u LEFT JOIN api_keys ak ON u.telegram_id = ak.telegram_id
    ORDER BY u.last_active_at DESC
  `),

  // API Keys
  setApiKey: db.prepare(`
    INSERT INTO api_keys (telegram_id, encrypted_key)
    VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      encrypted_key = excluded.encrypted_key,
      key_set_at = datetime('now')
  `),
  getApiKey: db.prepare(`SELECT encrypted_key FROM api_keys WHERE telegram_id = ?`),
  deleteApiKey: db.prepare(`DELETE FROM api_keys WHERE telegram_id = ?`),
  touchApiKey: db.prepare(`
    UPDATE api_keys SET last_used_at = datetime('now'), total_uses = total_uses + 1
    WHERE telegram_id = ?
  `),

  // Sessions
  insertSession: db.prepare(`
    INSERT INTO sessions (telegram_id, project, prompt, response_len, duration_ms, cost_usd,
      input_tokens, output_tokens, cache_tokens, model, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getUserSessions: db.prepare(`
    SELECT * FROM sessions WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?
  `),

  // Daily Usage
  upsertDailyUsage: db.prepare(`
    INSERT INTO daily_usage (telegram_id, date, sessions, cost_usd, input_tokens, output_tokens, cache_tokens)
    VALUES (?, date('now'), 1, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, date) DO UPDATE SET
      sessions = sessions + 1,
      cost_usd = cost_usd + excluded.cost_usd,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_tokens = cache_tokens + excluded.cache_tokens
  `),
  getUserUsageSummary: db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_tokens), 0) as total_cache,
      MAX(created_at) as last_session
    FROM sessions WHERE telegram_id = ?
  `),
  getUserTodayCost: db.prepare(`
    SELECT COALESCE(cost_usd, 0) as cost FROM daily_usage
    WHERE telegram_id = ? AND date = date('now')
  `),
  getUserDailyBreakdown: db.prepare(`
    SELECT date, sessions, cost_usd, input_tokens + output_tokens + cache_tokens as total_tokens
    FROM daily_usage WHERE telegram_id = ? ORDER BY date DESC LIMIT ?
  `),

  // Global stats
  globalStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM users WHERE is_approved = 1) as approved_users,
      (SELECT COUNT(*) FROM api_keys) as users_with_keys,
      (SELECT COUNT(*) FROM sessions) as total_sessions,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM sessions) as total_cost,
      (SELECT COUNT(*) FROM sessions WHERE date(created_at) = date('now')) as today_sessions,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM sessions WHERE date(created_at) = date('now')) as today_cost
  `),
}

// ── Public API ──────────────────────────────────────────────
export default {
  // Users
  upsertUser(telegramId, username, firstName) {
    stmts.upsertUser.run(telegramId, username || null, firstName || null)
  },

  getUser(telegramId) {
    return stmts.getUser.get(telegramId) || null
  },

  approveUser(telegramId) {
    return stmts.approveUser.run(telegramId).changes > 0
  },

  blockUser(telegramId) {
    return stmts.blockUser.run(telegramId).changes > 0
  },

  setAuthMethod(telegramId, method) {
    stmts.setAuthMethod.run(method, telegramId)
  },

  touchUser(telegramId) {
    stmts.touchUser.run(telegramId)
  },

  listUsers() {
    return stmts.listUsers.all()
  },

  // API Keys
  setApiKey(telegramId, encryptedKey) {
    stmts.setApiKey.run(telegramId, encryptedKey)
  },

  getApiKey(telegramId) {
    const row = stmts.getApiKey.get(telegramId)
    return row?.encrypted_key || null
  },

  deleteApiKey(telegramId) {
    return stmts.deleteApiKey.run(telegramId).changes > 0
  },

  touchApiKey(telegramId) {
    stmts.touchApiKey.run(telegramId)
  },

  hasApiKey(telegramId) {
    return !!stmts.getApiKey.get(telegramId)
  },

  // Sessions
  recordSession(telegramId, { project, prompt, responseLen, durationMs, costUsd, inputTokens, outputTokens, cacheTokens, model, status, error }) {
    stmts.insertSession.run(
      telegramId, project || "default", (prompt || "").slice(0, 500),
      responseLen || 0, durationMs || 0, costUsd || 0,
      inputTokens || 0, outputTokens || 0, cacheTokens || 0,
      model || "unknown", status || "success", error || null,
    )
    // Update daily aggregates
    stmts.upsertDailyUsage.run(
      telegramId, costUsd || 0, inputTokens || 0, outputTokens || 0, cacheTokens || 0,
    )
  },

  getUserSessions(telegramId, limit = 10) {
    return stmts.getUserSessions.all(telegramId, limit)
  },

  getUserUsageSummary(telegramId) {
    const summary = stmts.getUserUsageSummary.get(telegramId)
    const today = stmts.getUserTodayCost.get(telegramId)
    return {
      ...summary,
      today_cost: today?.cost || 0,
    }
  },

  getUserDailyBreakdown(telegramId, days = 7) {
    return stmts.getUserDailyBreakdown.all(telegramId, days)
  },

  // Global
  globalStats() {
    return stmts.globalStats.get()
  },

  // Raw db access for migrations
  raw: db,

  close() {
    db.close()
  },
}
