/**
 * Bridge to Python trade executor (py-clob-client)
 * Handles real EIP-712 signed orders on Polymarket CLOB
 */
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import { encryptSecure, decryptSecure } from "../security.mjs"
import db from "../database.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXECUTOR = path.join(__dirname, "trade-executor.py")
const MASTER_KEY = process.env.USER_ENCRYPT_KEY || "default"

function runPython(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [EXECUTOR, ...args], {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    })

    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => (stdout += d.toString()))
    proc.stderr.on("data", (d) => (stderr += d.toString()))

    proc.on("close", (code) => {
      try {
        const result = JSON.parse(stdout)
        if (result.error) reject(new Error(result.error))
        else resolve(result)
      } catch {
        reject(new Error(stderr || stdout || `Exit code ${code}`))
      }
    })
    proc.on("error", reject)
  })
}

// ── Wallet Key Management ───────────────────────────────────

export function storeWalletKey(telegramId, privateKey) {
  const encrypted = encryptSecure(privateKey, MASTER_KEY)
  db.raw.prepare(`
    INSERT INTO pm_settings (telegram_id, private_key)
    VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET private_key = excluded.private_key
  `).run(telegramId, encrypted)
}

export function getWalletKey(telegramId) {
  const row = db.raw.prepare("SELECT private_key FROM pm_settings WHERE telegram_id = ?").get(telegramId)
  if (!row?.private_key) return null
  return decryptSecure(row.private_key, MASTER_KEY)
}

export function hasWallet(telegramId) {
  const row = db.raw.prepare("SELECT private_key FROM pm_settings WHERE telegram_id = ?").get(telegramId)
  return !!row?.private_key
}

// ── Trading Functions ───────────────────────────────────────

export async function buy(tokenId, price, size, privateKey, negRisk = false) {
  return runPython(["buy", tokenId, String(price), String(size), privateKey, negRisk ? "true" : "false"])
}

export async function sell(tokenId, price, size, privateKey, negRisk = false) {
  return runPython(["sell", tokenId, String(price), String(size), privateKey, negRisk ? "true" : "false"])
}

export async function marketBuy(tokenId, amountUsd, privateKey) {
  return runPython(["market_buy", tokenId, String(amountUsd), privateKey])
}

export async function marketSell(tokenId, amountUsd, privateKey) {
  return runPython(["market_sell", tokenId, String(amountUsd), privateKey])
}

export async function cancelOrder(orderId, privateKey) {
  return runPython(["cancel", orderId, privateKey])
}

export async function cancelAll(privateKey) {
  return runPython(["cancel_all", privateKey])
}

export async function getBalance(privateKey) {
  return runPython(["balance", privateKey])
}

export async function getOpenOrders(privateKey) {
  return runPython(["open_orders", privateKey])
}

export async function approveTrading(privateKey) {
  return runPython(["approve", privateKey], 60000) // Longer timeout for on-chain txs
}

export async function getTickSize(tokenId) {
  return runPython(["tick_size", tokenId])
}

// ── High-Level Trade Function ───────────────────────────────

/**
 * Execute a trade for a user (handles key retrieval, logging)
 */
export async function executeTrade(telegramId, { tokenId, price, size, side, marketId, question, outcome, negRisk = false }) {
  const privateKey = getWalletKey(telegramId)
  if (!privateKey) throw new Error("No wallet connected. Use /pmconnect first.")

  const tradeFn = side === "BUY" ? buy : sell
  const result = await tradeFn(tokenId, price, size, privateKey, negRisk)

  // Log to database
  db.raw.prepare(`
    INSERT INTO pm_trades (telegram_id, market_id, market_question, outcome, side, price, size_usdc, order_id, status, paper)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'placed', 0)
  `).run(telegramId, marketId || "", (question || "").slice(0, 200), outcome || "", side, price, size * price, result.order_id || "", )

  return result
}

export default {
  storeWalletKey,
  getWalletKey,
  hasWallet,
  buy,
  sell,
  marketBuy,
  marketSell,
  cancelOrder,
  cancelAll,
  getBalance,
  getOpenOrders,
  approveTrading,
  getTickSize,
  executeTrade,
}
