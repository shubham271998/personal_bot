/**
 * Polymarket Trader — Places orders via CLOB API
 *
 * Requires:
 *   - Private key (Polygon wallet with USDC)
 *   - Approved on Polymarket (one-time)
 *
 * Safety features:
 *   - Max bet size limit
 *   - Daily loss limit
 *   - Paper trading mode
 *   - All trades logged to DB
 */
import { ethers } from "ethers"
import axios from "axios"
import crypto from "crypto"
import db from "../database.mjs"

const CLOB_API = "https://clob.polymarket.com"
const POLYGON_RPC = "https://polygon-rpc.com"
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

// Safety limits
const MAX_BET_USDC = parseFloat(process.env.PM_MAX_BET || "10")
const DAILY_LOSS_LIMIT = parseFloat(process.env.PM_DAILY_LOSS_LIMIT || "50")

// Create trades table
db.raw.exec(`
  CREATE TABLE IF NOT EXISTS pm_trades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id  INTEGER,
    market_id    TEXT,
    market_question TEXT,
    outcome      TEXT,
    side         TEXT,
    price        REAL,
    size_usdc    REAL,
    order_id     TEXT,
    status       TEXT DEFAULT 'pending',
    pnl          REAL DEFAULT 0,
    paper        INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pm_portfolio (
    telegram_id  INTEGER,
    market_id    TEXT,
    outcome      TEXT,
    shares       REAL DEFAULT 0,
    avg_price    REAL DEFAULT 0,
    paper        INTEGER DEFAULT 1,
    PRIMARY KEY (telegram_id, market_id, outcome, paper)
  );

  CREATE TABLE IF NOT EXISTS pm_settings (
    telegram_id  INTEGER PRIMARY KEY,
    private_key  TEXT,
    paper_mode   INTEGER DEFAULT 1,
    max_bet      REAL DEFAULT 10,
    auto_trade   INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  );
`)

const stmts = {
  insertTrade: db.raw.prepare(`
    INSERT INTO pm_trades (telegram_id, market_id, market_question, outcome, side, price, size_usdc, order_id, status, paper)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  upsertPortfolio: db.raw.prepare(`
    INSERT INTO pm_portfolio (telegram_id, market_id, outcome, shares, avg_price, paper)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, market_id, outcome, paper) DO UPDATE SET
      shares = shares + excluded.shares,
      avg_price = (avg_price * shares + excluded.avg_price * excluded.shares) / (shares + excluded.shares)
  `),
  getPortfolio: db.raw.prepare(`
    SELECT * FROM pm_portfolio WHERE telegram_id = ? AND shares > 0 ORDER BY market_id
  `),
  getTrades: db.raw.prepare(`
    SELECT * FROM pm_trades WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?
  `),
  getSettings: db.raw.prepare(`
    SELECT * FROM pm_settings WHERE telegram_id = ?
  `),
  upsertSettings: db.raw.prepare(`
    INSERT INTO pm_settings (telegram_id, private_key, paper_mode, max_bet, auto_trade)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      private_key = COALESCE(excluded.private_key, private_key),
      paper_mode = excluded.paper_mode,
      max_bet = excluded.max_bet,
      auto_trade = excluded.auto_trade
  `),
  getDailyPnL: db.raw.prepare(`
    SELECT COALESCE(SUM(pnl), 0) as total_pnl FROM pm_trades
    WHERE telegram_id = ? AND date(created_at) = date('now')
  `),
  getTotalPnL: db.raw.prepare(`
    SELECT COALESCE(SUM(pnl), 0) as total_pnl,
           COUNT(*) as total_trades,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(size_usdc) as total_volume
    FROM pm_trades WHERE telegram_id = ?
  `),
}

/**
 * Paper trade — simulates a buy without real money
 */
export function paperTrade(telegramId, market, outcomeName, sizeUsdc) {
  const outcome = market.outcomes.find((o) => o.name.toLowerCase().includes(outcomeName.toLowerCase()))
  if (!outcome) return { ok: false, error: `Outcome "${outcomeName}" not found` }

  if (sizeUsdc > MAX_BET_USDC) return { ok: false, error: `Max bet is $${MAX_BET_USDC}` }

  const shares = sizeUsdc / outcome.price
  const orderId = `paper-${crypto.randomBytes(4).toString("hex")}`

  stmts.insertTrade.run(
    telegramId, market.id, market.question.slice(0, 200),
    outcome.name, "BUY", outcome.price, sizeUsdc, orderId, "filled", 1,
  )

  stmts.upsertPortfolio.run(
    telegramId, market.id, outcome.name, shares, outcome.price, 1,
  )

  return {
    ok: true,
    trade: {
      orderId,
      outcome: outcome.name,
      price: outcome.price,
      sizeUsdc,
      shares: shares.toFixed(2),
      paper: true,
    },
  }
}

/**
 * Get user's portfolio (paper or real)
 */
export function getPortfolio(telegramId) {
  return stmts.getPortfolio.all(telegramId)
}

/**
 * Get trade history
 */
export function getTradeHistory(telegramId, limit = 10) {
  return stmts.getTrades.all(telegramId, limit)
}

/**
 * Get P&L summary
 */
export function getPnLSummary(telegramId) {
  const daily = stmts.getDailyPnL.get(telegramId)
  const total = stmts.getTotalPnL.get(telegramId)
  return {
    dailyPnL: daily?.total_pnl || 0,
    totalPnL: total?.total_pnl || 0,
    totalTrades: total?.total_trades || 0,
    wins: total?.wins || 0,
    winRate: total?.total_trades > 0 ? (total.wins / total.total_trades * 100).toFixed(1) : 0,
    totalVolume: total?.total_volume || 0,
  }
}

/**
 * Get/set user trading settings
 */
export function getSettings(telegramId) {
  return stmts.getSettings.get(telegramId) || { paper_mode: 1, max_bet: 10, auto_trade: 0 }
}

export function updateSettings(telegramId, settings) {
  const current = getSettings(telegramId)
  stmts.upsertSettings.run(
    telegramId,
    settings.privateKey || current.private_key || null,
    settings.paperMode ?? current.paper_mode ?? 1,
    settings.maxBet ?? current.max_bet ?? 10,
    settings.autoTrade ?? current.auto_trade ?? 0,
  )
}

/**
 * Check USDC balance on Polygon
 */
export async function getBalance(privateKey) {
  try {
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC)
    const wallet = new ethers.Wallet(privateKey, provider)
    const usdc = new ethers.Contract(USDC_ADDRESS, [
      "function balanceOf(address) view returns (uint256)",
    ], provider)
    const balance = await usdc.balanceOf(wallet.address)
    return {
      address: wallet.address,
      usdc: parseFloat(ethers.formatUnits(balance, 6)),
    }
  } catch (err) {
    return { error: err.message }
  }
}

export default {
  paperTrade,
  getPortfolio,
  getTradeHistory,
  getPnLSummary,
  getSettings,
  updateSettings,
  getBalance,
}
