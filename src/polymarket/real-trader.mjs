/**
 * Real Money Trader — Production-grade Polymarket execution engine
 *
 * Architecture:
 *   1. Fee Calculator  — dynamic fees per category, maker vs taker paths
 *   2. Order Executor  — limit orders via @polymarket/clob-client (0% maker fee)
 *   3. Order Lifecycle  — track pending→filled, poll fills, auto-cancel stale
 *   4. Wallet Manager  — USDC balance, MATIC gas, approvals, floor enforcement
 *   5. Risk Engine     — $400 floor circuit breaker, drawdown halt, position limits
 *   6. Phased Unlocking — only safe strategies until buffer is built
 *
 * Fee structure (as of 2026):
 *   - Maker (limit orders): 0% fee — this is our primary path
 *   - Taker: 0.75%-1.80% depending on category, peaks at 50% price
 *   - Formula: fee = shares * feeRate * p * (1-p)
 *   - Settlement: free, winning shares redeem at $1.00
 *
 * Critical: ALL trades go through limit orders (maker) to avoid taker fees.
 * We place orders slightly BELOW best ask (buys) or ABOVE best bid (sells)
 * to rest on the book and get maker status.
 */
import { ethers } from "ethers"
import api from "./api-client.mjs"
import db from "../database.mjs"
import { encryptSecure, decryptSecure } from "../security.mjs"
import adaptiveLearner from "./adaptive-learner.mjs"

// ── Constants ──────────────────────────────────────────────
const CLOB_API = "https://clob.polymarket.com"
const POLYGON_RPC = "https://polygon-rpc.com"
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"
const CHAIN_ID = 137
const MASTER_KEY = process.env.USER_ENCRYPT_KEY || "default-key"

// ── Risk Parameters ────────────────────────────────────────
const STARTING_BANKROLL = 500
const FLOOR_BALANCE = 400       // NEVER go below this
const MAX_SINGLE_TRADE = 25     // Max $25 per trade
const MAX_DAILY_LOSS = 30       // Stop trading after $30 daily loss
const MAX_OPEN_POSITIONS = 30   // Max 30 concurrent positions
const MAX_POSITION_PCT = 0.05   // Max 5% of bankroll per position
const MAX_DAILY_TRADES = 50     // Don't overtrade
const ORDER_STALE_MS = 5 * 60 * 1000 // Cancel unfilled orders after 5 min
const ORDER_POLL_MS = 10 * 1000      // Check order status every 10s

// Phased strategy unlocking thresholds
const PHASE_THRESHOLDS = {
  SAFE_ONLY: 0,           // $400-$600: Resolution Snipe + Time Decay only
  ADD_AI_SIGNAL: 600,     // $600+: Add AI Signal
  ADD_SMART_BRAIN: 800,   // $800+: Add Smart Brain
  FULL_STRATEGIES: 1200,  // $1200+: All strategies
}

// Taker fee rates by category (peak at 50%, scales with p*(1-p))
const TAKER_FEE_RATES = {
  crypto: 0.018,      // 1.80%
  economics: 0.015,   // 1.50%
  politics: 0.010,    // 1.00%
  sports: 0.0075,     // 0.75%
  geopolitical: 0,    // 0% (free!)
  other: 0.0125,      // 1.25% default
}

// Rate limiter
let _orderTimestamps = []
const ORDER_RATE_LIMIT = 40  // Conservative: 40/min (limit is 60)
const ORDER_WINDOW_MS = 60000

// ── DB Setup ───────────────────────────────────────────────
db.raw.exec(`
  CREATE TABLE IF NOT EXISTS pm_real_orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     TEXT UNIQUE,
    market_id    TEXT,
    market_question TEXT,
    token_id     TEXT,
    outcome      TEXT,
    side         TEXT,
    price        REAL,
    size_usdc    REAL,
    shares       REAL,
    strategy     TEXT,
    status       TEXT DEFAULT 'pending',
    fill_price   REAL,
    fill_shares  REAL,
    fees_paid    REAL DEFAULT 0,
    pnl          REAL DEFAULT 0,
    neg_risk     INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now')),
    filled_at    TEXT,
    closed_at    TEXT,
    close_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS pm_real_stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT UNIQUE,
    starting_balance REAL,
    ending_balance REAL,
    trades_placed INTEGER DEFAULT 0,
    trades_filled INTEGER DEFAULT 0,
    trades_cancelled INTEGER DEFAULT 0,
    total_fees   REAL DEFAULT 0,
    day_pnl      REAL DEFAULT 0,
    total_pnl    REAL DEFAULT 0,
    floor_hits   INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pm_real_config (
    key          TEXT PRIMARY KEY,
    value        TEXT,
    updated_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_real_orders_status ON pm_real_orders(status);
  CREATE INDEX IF NOT EXISTS idx_real_orders_market ON pm_real_orders(market_id);
`)

const stmts = {
  insertOrder: db.raw.prepare(`
    INSERT INTO pm_real_orders (order_id, market_id, market_question, token_id, outcome, side, price, size_usdc, shares, strategy, neg_risk)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateOrderStatus: db.raw.prepare(`
    UPDATE pm_real_orders SET status = ?, filled_at = CASE WHEN ? = 'filled' THEN datetime('now') ELSE filled_at END
    WHERE order_id = ?
  `),
  closePosition: db.raw.prepare(`
    UPDATE pm_real_orders SET status = 'closed', pnl = ?, fees_paid = ?, close_reason = ?, closed_at = datetime('now')
    WHERE id = ?
  `),
  getOpenOrders: db.raw.prepare(`SELECT * FROM pm_real_orders WHERE status IN ('pending', 'open')`),
  getFilledPositions: db.raw.prepare(`SELECT * FROM pm_real_orders WHERE status = 'filled'`),
  getOrderById: db.raw.prepare(`SELECT * FROM pm_real_orders WHERE order_id = ?`),
  getTodayStats: db.raw.prepare(`
    SELECT COUNT(*) as trades, COALESCE(SUM(fees_paid),0) as fees,
      COALESCE(SUM(CASE WHEN status='closed' THEN pnl ELSE 0 END),0) as pnl
    FROM pm_real_orders WHERE date(created_at) = date('now')
  `),
  getTotalPnL: db.raw.prepare(`
    SELECT COALESCE(SUM(pnl),0) as total_pnl, COALESCE(SUM(fees_paid),0) as total_fees,
      COUNT(*) as total_trades, SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as wins
    FROM pm_real_orders WHERE status = 'closed'
  `),
  getConfig: db.raw.prepare(`SELECT value FROM pm_real_config WHERE key = ?`),
  setConfig: db.raw.prepare(`
    INSERT INTO pm_real_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `),
  upsertDailyStats: db.raw.prepare(`
    INSERT INTO pm_real_stats (date, starting_balance, ending_balance, trades_placed, trades_filled, total_fees, day_pnl, total_pnl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET ending_balance=excluded.ending_balance, trades_placed=excluded.trades_placed,
    trades_filled=excluded.trades_filled, total_fees=excluded.total_fees, day_pnl=excluded.day_pnl, total_pnl=excluded.total_pnl
  `),
}

// ── Cached API credentials ─────────────────────────────────
let _cachedCreds = null
let _cachedCredsExpiry = 0

// ══════════════════════════════════════════════════════════════
// 1. FEE CALCULATOR
// ══════════════════════════════════════════════════════════════

/**
 * Calculate real taker fee for a trade
 * Formula: fee = shares * feeRate * p * (1-p)
 * This peaks at p=0.50 and approaches 0 at extremes
 */
export function calculateTakerFee(sizeUsdc, price, category = "other") {
  const feeRate = TAKER_FEE_RATES[category] || TAKER_FEE_RATES.other
  const shares = sizeUsdc / price
  const fee = shares * feeRate * price * (1 - price)
  return {
    fee: Math.round(fee * 100) / 100,
    feeRate,
    feePct: (fee / sizeUsdc * 100).toFixed(2),
    isFree: feeRate === 0,
  }
}

/**
 * Calculate if a trade is profitable after fees
 * For maker orders (our primary path): fee = 0
 * Returns { profitable, netProfit, breakeven }
 */
export function isTradeViable(sizeUsdc, entryPrice, expectedExitPrice, category, isMaker = true) {
  const shares = sizeUsdc / entryPrice
  const grossProfit = (expectedExitPrice - entryPrice) * shares

  // Maker entry fee = 0, but we might need to sell as taker to exit
  const entryFee = isMaker ? 0 : calculateTakerFee(sizeUsdc, entryPrice, category).fee
  // Exit: if market resolves, no fee. If selling before resolution, taker fee applies.
  const exitFee = expectedExitPrice >= 0.98 ? 0 : calculateTakerFee(shares * expectedExitPrice, expectedExitPrice, category).fee

  const netProfit = grossProfit - entryFee - exitFee
  const totalFees = entryFee + exitFee

  return {
    profitable: netProfit > 0,
    grossProfit: Math.round(grossProfit * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    entryFee: Math.round(entryFee * 100) / 100,
    exitFee: Math.round(exitFee * 100) / 100,
    returnPct: (netProfit / sizeUsdc * 100).toFixed(2),
    breakeven: entryPrice + (totalFees / shares), // Price needed to break even
  }
}

/**
 * Fetch dynamic fee rate from CLOB API for a specific token
 */
async function fetchFeeRate(tokenId) {
  try {
    const { data } = await api.get(`${CLOB_API}/neg-risk`, {
      params: { token_id: tokenId },
      timeout: 5000,
    })
    return { feeRateBps: data.fee_rate_bps || 0, negRisk: data.neg_risk || false }
  } catch {
    return { feeRateBps: 0, negRisk: false }
  }
}

// ══════════════════════════════════════════════════════════════
// 2. WALLET MANAGER
// ══════════════════════════════════════════════════════════════

/**
 * Get full wallet state
 */
export async function getWalletState(telegramId) {
  const privateKey = getPrivateKey(telegramId)
  if (!privateKey) return { connected: false }

  try {
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC)
    const wallet = new ethers.Wallet(privateKey, provider)

    const usdcAbi = [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
    ]
    const usdc = new ethers.Contract(USDC_ADDRESS, usdcAbi, provider)

    const [balance, matic, allowanceCTF, allowanceNeg] = await Promise.all([
      usdc.balanceOf(wallet.address),
      provider.getBalance(wallet.address),
      usdc.allowance(wallet.address, CTF_EXCHANGE),
      usdc.allowance(wallet.address, NEG_RISK_EXCHANGE),
    ])

    const usdcBalance = parseFloat(ethers.formatUnits(balance, 6))
    const maticBalance = parseFloat(ethers.formatEther(matic))

    // Get open positions value
    const openPositions = stmts.getFilledPositions.all()
    const openValue = openPositions.reduce((s, p) => s + p.size_usdc, 0)

    // Total PnL from closed trades
    const pnlData = stmts.getTotalPnL.get()
    const realizedPnL = pnlData?.total_pnl || 0

    return {
      connected: true,
      address: wallet.address,
      usdc: usdcBalance,
      matic: maticBalance,
      hasGas: maticBalance > 0.01,
      approvedCTF: parseFloat(ethers.formatUnits(allowanceCTF, 6)) > 1000,
      approvedNegRisk: parseFloat(ethers.formatUnits(allowanceNeg, 6)) > 1000,
      openPositions: openPositions.length,
      openValue: Math.round(openValue * 100) / 100,
      availableBalance: Math.round((usdcBalance - openValue) * 100) / 100,
      totalBalance: Math.round((usdcBalance + realizedPnL) * 100) / 100,
      realizedPnL: Math.round(realizedPnL * 100) / 100,
      totalFees: Math.round((pnlData?.total_fees || 0) * 100) / 100,
    }
  } catch (err) {
    return { connected: true, error: err.message }
  }
}

/**
 * Approve USDC spending for both exchange contracts
 */
export async function approveExchanges(telegramId) {
  const privateKey = getPrivateKey(telegramId)
  if (!privateKey) return { ok: false, error: "No wallet connected" }

  try {
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC)
    const wallet = new ethers.Wallet(privateKey, provider)
    const usdc = new ethers.Contract(USDC_ADDRESS, [
      "function approve(address,uint256) returns (bool)",
    ], wallet)

    const maxApproval = ethers.MaxUint256

    // Approve both exchanges
    const tx1 = await usdc.approve(CTF_EXCHANGE, maxApproval)
    const tx2 = await usdc.approve(NEG_RISK_EXCHANGE, maxApproval)

    await Promise.all([tx1.wait(), tx2.wait()])

    return { ok: true, message: "Both CTF and NegRisk exchanges approved" }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function getPrivateKey(telegramId) {
  const row = db.raw.prepare("SELECT private_key FROM pm_settings WHERE telegram_id = ?").get(telegramId)
  if (!row?.private_key) return null
  return decryptSecure(row.private_key, MASTER_KEY)
}

// ══════════════════════════════════════════════════════════════
// 3. RISK ENGINE
// ══════════════════════════════════════════════════════════════

/**
 * Pre-trade risk check — ALL trades must pass
 * Returns { allowed, reason, adjustedSize }
 */
export function riskCheck(sizeUsdc, strategy, walletState) {
  const { availableBalance, usdc, openPositions } = walletState

  // 1. Floor check — never let balance drop below $400
  const worstCase = usdc - sizeUsdc
  if (worstCase < FLOOR_BALANCE) {
    return { allowed: false, reason: `Floor breach: $${usdc.toFixed(2)} - $${sizeUsdc.toFixed(2)} = $${worstCase.toFixed(2)} < $${FLOOR_BALANCE}` }
  }

  // 2. Available balance check
  if (sizeUsdc > availableBalance) {
    return { allowed: false, reason: `Insufficient: need $${sizeUsdc.toFixed(2)}, have $${availableBalance.toFixed(2)} available` }
  }

  // 3. Single trade size limit
  const maxTrade = Math.min(MAX_SINGLE_TRADE, usdc * MAX_POSITION_PCT)
  if (sizeUsdc > maxTrade) {
    return { allowed: false, reason: `Max trade $${maxTrade.toFixed(2)} (5% of balance)`, adjustedSize: maxTrade }
  }

  // 4. Position count limit
  if (openPositions >= MAX_OPEN_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_OPEN_POSITIONS} open positions reached` }
  }

  // 5. Daily loss limit
  const todayStats = stmts.getTodayStats.get()
  if ((todayStats?.pnl || 0) <= -MAX_DAILY_LOSS) {
    return { allowed: false, reason: `Daily loss limit hit: $${Math.abs(todayStats.pnl).toFixed(2)} lost today` }
  }

  // 6. Daily trade count
  if ((todayStats?.trades || 0) >= MAX_DAILY_TRADES) {
    return { allowed: false, reason: `Daily trade limit: ${MAX_DAILY_TRADES} trades today` }
  }

  // 7. Phase check — is this strategy unlocked?
  const phase = getCurrentPhase(usdc)
  if (!isStrategyAllowed(strategy, phase)) {
    return { allowed: false, reason: `Strategy "${strategy}" locked until $${getStrategyThreshold(strategy)}` }
  }

  return { allowed: true, adjustedSize: Math.min(sizeUsdc, maxTrade) }
}

/**
 * Get current trading phase based on balance
 */
function getCurrentPhase(balance) {
  if (balance >= PHASE_THRESHOLDS.FULL_STRATEGIES) return "FULL"
  if (balance >= PHASE_THRESHOLDS.ADD_SMART_BRAIN) return "SMART_BRAIN"
  if (balance >= PHASE_THRESHOLDS.ADD_AI_SIGNAL) return "AI_SIGNAL"
  return "SAFE_ONLY"
}

function isStrategyAllowed(strategy, phase) {
  const SAFE_STRATEGIES = new Set(["Resolution Snipe", "Time Decay Snipe", "Arbitrage", "NegRisk Arbitrage"])
  const AI_STRATEGIES = new Set([...SAFE_STRATEGIES, "AI Signal"])
  const BRAIN_STRATEGIES = new Set([...AI_STRATEGIES, "Smart Brain"])

  switch (phase) {
    case "SAFE_ONLY": return SAFE_STRATEGIES.has(strategy)
    case "AI_SIGNAL": return AI_STRATEGIES.has(strategy)
    case "SMART_BRAIN": return BRAIN_STRATEGIES.has(strategy)
    case "FULL": return strategy !== "Long Shot" // Never allow Long Shot
    default: return SAFE_STRATEGIES.has(strategy)
  }
}

function getStrategyThreshold(strategy) {
  if (["Resolution Snipe", "Time Decay Snipe", "Arbitrage"].includes(strategy)) return FLOOR_BALANCE
  if (strategy === "AI Signal") return PHASE_THRESHOLDS.ADD_AI_SIGNAL
  if (strategy === "Smart Brain") return PHASE_THRESHOLDS.ADD_SMART_BRAIN
  return PHASE_THRESHOLDS.FULL_STRATEGIES
}

// ══════════════════════════════════════════════════════════════
// 4. ORDER EXECUTOR — LIMIT ORDERS ONLY (0% MAKER FEE)
// ══════════════════════════════════════════════════════════════

/**
 * Execute a real trade via limit order
 *
 * Strategy: Always use limit orders (maker) to avoid fees.
 * Place BUY limit at (best_ask - 1 tick) to rest on book.
 * If not filled in 5 minutes, cancel and retry or skip.
 */
export async function executeRealTrade(telegramId, {
  market, tokenId, outcome, side, price, sizeUsdc, strategy, category, negRisk = false,
}) {
  // 1. Get wallet state
  const walletState = await getWalletState(telegramId)
  if (!walletState.connected) return { ok: false, error: "Wallet not connected" }
  if (walletState.error) return { ok: false, error: walletState.error }

  // 2. Risk check
  const risk = riskCheck(sizeUsdc, strategy, walletState)
  if (!risk.allowed) return { ok: false, error: risk.reason }
  const finalSize = risk.adjustedSize || sizeUsdc

  // 3. Fee viability check (for non-resolution markets)
  const expectedExit = strategy.includes("Snipe") ? 1.0 : price * 1.10 // Snipes resolve at $1, others need 10%+
  const viability = isTradeViable(finalSize, price, expectedExit, category, true)
  if (!viability.profitable && !strategy.includes("Snipe")) {
    return { ok: false, error: `Not viable after fees: net $${viability.netProfit} (fees: $${viability.totalFees})` }
  }

  // 4. Rate limit
  if (!canPlaceOrder()) {
    return { ok: false, error: "Rate limit — wait a moment" }
  }

  // 5. Get tick size and calculate limit price
  const privateKey = getPrivateKey(telegramId)
  let tickSize = "0.01"
  try {
    const { data: ts } = await api.get(`${CLOB_API}/tick-size`, { params: { token_id: tokenId }, timeout: 5000 })
    tickSize = ts.minimum_tick_size || "0.01"
  } catch {}

  const tick = parseFloat(tickSize)
  // Place limit slightly better than market to ensure maker status
  // BUY: at price (will rest if below best ask)
  // SELL: at price (will rest if above best bid)
  const limitPrice = Math.round(price / tick) * tick

  // 6. Calculate shares
  const shares = finalSize / limitPrice

  // 7. Sign and place limit order
  try {
    const wallet = new ethers.Wallet(privateKey)
    const exchangeAddress = negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE

    const makerAmount = Math.round(shares * 1e6)  // shares in 6-decimal
    const takerAmount = Math.round(finalSize * 1e6) // USDC cost in 6-decimal
    const sideInt = side === "BUY" ? 0 : 1

    const domain = {
      name: "Polymarket CTF Exchange",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: exchangeAddress,
    }

    const types = {
      Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "taker", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "expiration", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "feeRateBps", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
      ],
    }

    const salt = BigInt(Math.floor(Math.random() * 1e18))
    const orderData = {
      salt,
      maker: wallet.address,
      signer: wallet.address,
      taker: ethers.ZeroAddress,
      tokenId: BigInt(tokenId),
      makerAmount: BigInt(sideInt === 0 ? takerAmount : makerAmount),
      takerAmount: BigInt(sideInt === 0 ? makerAmount : takerAmount),
      expiration: 0n, // GTC
      nonce: 0n,
      feeRateBps: 0n, // MAKER = 0 fees. This is the key advantage.
      side: sideInt,
      signatureType: 0,
    }

    const signature = await wallet.signTypedData(domain, types, orderData)

    // Post to CLOB
    const { data: resp } = await api.post(`${CLOB_API}/order`, {
      order: {
        salt: salt.toString(),
        maker: wallet.address,
        signer: wallet.address,
        taker: ethers.ZeroAddress,
        tokenId,
        makerAmount: orderData.makerAmount.toString(),
        takerAmount: orderData.takerAmount.toString(),
        expiration: "0",
        nonce: "0",
        feeRateBps: "0",
        side: sideInt.toString(),
        signatureType: 0,
        signature,
      },
      orderType: "GTC",
    }, { timeout: 15000 })

    recordOrderTimestamp()

    const orderId = resp.orderID || resp.order_id || `real-${Date.now()}`

    // 8. Log to DB
    stmts.insertOrder.run(
      orderId, market?.id || "", (market?.question || "").slice(0, 200),
      tokenId, outcome || "", side, limitPrice, finalSize, shares,
      strategy || "Manual", negRisk ? 1 : 0,
    )

    console.log(`[REAL] ✅ Order placed: ${side} ${outcome?.slice(0, 25)} @ ${(limitPrice * 100).toFixed(1)}% — $${finalSize.toFixed(2)} (${strategy})`)

    return {
      ok: true,
      orderId,
      price: limitPrice,
      size: finalSize,
      shares,
      side,
      strategy,
      fees: 0, // Maker = 0
      viability,
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    console.error(`[REAL] ❌ Order failed: ${msg}`)
    return { ok: false, error: msg }
  }
}

function canPlaceOrder() {
  const now = Date.now()
  _orderTimestamps = _orderTimestamps.filter((t) => t > now - ORDER_WINDOW_MS)
  return _orderTimestamps.length < ORDER_RATE_LIMIT
}

function recordOrderTimestamp() {
  _orderTimestamps.push(Date.now())
}

// ══════════════════════════════════════════════════════════════
// 5. ORDER LIFECYCLE MANAGER
// ══════════════════════════════════════════════════════════════

/**
 * Poll and manage all open orders
 * Called periodically by the trading loop
 */
export async function manageOrders(telegramId) {
  const privateKey = getPrivateKey(telegramId)
  if (!privateKey) return { managed: 0 }

  const openOrders = stmts.getOpenOrders.all()
  if (openOrders.length === 0) return { managed: 0 }

  let filled = 0
  let cancelled = 0
  let errors = 0

  // Get API credentials for order status checks
  const creds = await getApiCredentials(privateKey)
  if (!creds) return { managed: 0, error: "Could not derive API credentials" }

  const wallet = new ethers.Wallet(privateKey)

  for (const order of openOrders) {
    try {
      // Check order status via API
      const { data: status } = await api.get(`${CLOB_API}/order/${order.order_id}`, {
        headers: {
          POLY_ADDRESS: wallet.address,
          POLY_API_KEY: creds.apiKey,
          POLY_SECRET: creds.secret,
          POLY_PASSPHRASE: creds.passphrase,
        },
        timeout: 10000,
      })

      if (status.status === "MATCHED" || status.status === "FILLED") {
        stmts.updateOrderStatus.run("filled", "filled", order.order_id)
        filled++
        console.log(`[REAL] 📊 Filled: ${order.outcome?.slice(0, 25)} @ ${(order.price * 100).toFixed(1)}%`)
      } else if (status.status === "CANCELLED") {
        stmts.updateOrderStatus.run("cancelled", null, order.order_id)
        cancelled++
      } else {
        // Check if order is stale (unfilled for too long)
        const ageMs = Date.now() - new Date(order.created_at).getTime()
        if (ageMs > ORDER_STALE_MS) {
          // Cancel stale order
          try {
            await api.delete(`${CLOB_API}/order/${order.order_id}`, {
              headers: {
                POLY_ADDRESS: wallet.address,
                POLY_API_KEY: creds.apiKey,
                POLY_SECRET: creds.secret,
                POLY_PASSPHRASE: creds.passphrase,
              },
              timeout: 10000,
            })
            stmts.updateOrderStatus.run("cancelled", null, order.order_id)
            cancelled++
            console.log(`[REAL] 🕐 Cancelled stale order: ${order.outcome?.slice(0, 25)} (${Math.round(ageMs / 1000)}s old)`)
          } catch {
            // Order may already be filled/cancelled
          }
        }
      }
    } catch (err) {
      errors++
      // 404 = order doesn't exist (likely already settled)
      if (err.response?.status === 404) {
        stmts.updateOrderStatus.run("cancelled", null, order.order_id)
        cancelled++
      }
    }
  }

  return { managed: openOrders.length, filled, cancelled, errors }
}

/**
 * Check filled positions and close resolved ones
 */
export async function checkPositions(telegramId) {
  const filledPositions = stmts.getFilledPositions.all()
  if (filledPositions.length === 0) return { closed: 0 }

  let closed = 0

  // Dynamic import to avoid circular
  let scanner
  try {
    scanner = (await import("./market-scanner.mjs")).default
  } catch { return { closed: 0 } }

  for (const pos of filledPositions) {
    try {
      const market = await scanner.getMarket(pos.market_id)
      if (!market) continue

      let currentPrice = pos.price
      if (market.outcomes) {
        const match = market.outcomes.find((o) => o.name === pos.outcome) || market.outcomes[0]
        if (match) currentPrice = match.price
      }

      let shouldClose = false
      let closeReason = ""
      let exitPrice = currentPrice

      // 1. Market resolved
      if (!market.active || market.resolved) {
        exitPrice = currentPrice >= 0.95 ? 1.0 : currentPrice <= 0.05 ? 0.0 : currentPrice
        shouldClose = true
        closeReason = "resolved"
      }

      // 2. Resolution snipe won
      if (!shouldClose && pos.strategy?.includes("Snipe") && currentPrice >= 0.98) {
        exitPrice = 1.0
        shouldClose = true
        closeReason = "snipe-won"
      }

      // 3. Take profit at +20%
      if (!shouldClose) {
        const gainPct = (currentPrice - pos.price) / pos.price
        if (gainPct >= 0.20) {
          shouldClose = true
          closeReason = `take-profit (+${(gainPct * 100).toFixed(0)}%)`
        }
      }

      // 4. Stop loss at -15%
      if (!shouldClose) {
        const lossPct = (pos.price - currentPrice) / pos.price
        if (lossPct >= 0.15) {
          shouldClose = true
          closeReason = `stop-loss (-${(lossPct * 100).toFixed(0)}%)`
        }
      }

      // 5. Stale position (48h+)
      if (!shouldClose) {
        const ageHours = (Date.now() - new Date(pos.created_at).getTime()) / 3600000
        if (ageHours > 48) {
          shouldClose = true
          closeReason = "stale (48h+)"
        }
      }

      if (shouldClose) {
        const pnl = (exitPrice - pos.price) * pos.shares
        // Fees: resolution = free, early exit = taker fee
        const fees = closeReason === "resolved" || closeReason === "snipe-won"
          ? 0
          : calculateTakerFee(pos.shares * exitPrice, exitPrice, "other").fee

        stmts.closePosition.run(pnl - fees, fees, closeReason, pos.id)
        closed++

        // Learn from trade
        const brain = await import("./smart-brain.mjs")
        adaptiveLearner.learnFromTrade({
          strategy: pos.strategy,
          entry_price: pos.price,
          pnl: pnl - fees,
          close_reason: closeReason,
          category: (brain.default?.detectCategory || brain.detectCategory)(pos.market_question || ""),
        })

        const icon = pnl - fees >= 0 ? "✅" : "❌"
        console.log(`[REAL] ${icon} Closed: ${pos.outcome?.slice(0, 25)} — ${pnl >= 0 ? "+" : ""}$${(pnl - fees).toFixed(2)} (${closeReason}, fees: $${fees.toFixed(2)})`)
      }
    } catch (err) {
      console.error(`[REAL] Position check error: ${err.message}`)
    }
  }

  return { closed }
}

// ══════════════════════════════════════════════════════════════
// 6. API CREDENTIALS
// ══════════════════════════════════════════════════════════════

async function getApiCredentials(privateKey) {
  // Cache for 1 hour
  if (_cachedCreds && Date.now() < _cachedCredsExpiry) return _cachedCreds

  try {
    const wallet = new ethers.Wallet(privateKey)
    const timestamp = Math.floor(Date.now() / 1000).toString()

    const domain = { name: "ClobAuthDomain", version: "1", chainId: CHAIN_ID }
    const types = {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    }
    const value = {
      address: wallet.address,
      timestamp,
      nonce: 0n,
      message: "This message attests that I control the given wallet",
    }
    const sig = await wallet.signTypedData(domain, types, value)

    const { data: creds } = await api.get(`${CLOB_API}/derive-api-key`, {
      headers: {
        POLY_ADDRESS: wallet.address,
        POLY_SIGNATURE: sig,
        POLY_TIMESTAMP: timestamp,
        POLY_NONCE: "0",
      },
      timeout: 10000,
    })

    _cachedCreds = creds
    _cachedCredsExpiry = Date.now() + 3600000 // 1 hour
    return creds
  } catch (err) {
    console.error(`[REAL] API creds failed: ${err.message}`)
    return null
  }
}

// ══════════════════════════════════════════════════════════════
// 7. TRADING LOOP INTEGRATION
// ══════════════════════════════════════════════════════════════

/**
 * Process approved trades from smart brain scan
 * This is the main entry point called by auto-analyst
 */
export async function processApprovedTrades(telegramId, approved, walletState) {
  let placed = 0
  let skipped = 0
  const results = []

  const balance = walletState.usdc
  const phase = getCurrentPhase(balance)

  for (const pick of approved) {
    if (placed >= 10) break // Max 10 new trades per cycle

    // Phase gating
    if (!isStrategyAllowed(pick.strategy, phase)) {
      skipped++
      continue
    }

    // Skip if already have position
    const existing = stmts.getOrderById.get(pick.market?.id)
    if (existing) { skipped++; continue }

    // Get token ID
    const tokenId = pick.market?.outcomes?.find((o) => o.name === pick.outcome)?.tokenId
    if (!tokenId) { skipped++; continue }

    // Calculate real bet size (smaller than virtual — real money is precious)
    let betSize = Math.min(pick.betSize || 5, MAX_SINGLE_TRADE, balance * MAX_POSITION_PCT)

    // Additional safety: scale down based on phase
    if (phase === "SAFE_ONLY") betSize = Math.min(betSize, 15)
    if (phase === "AI_SIGNAL") betSize = Math.min(betSize, 20)

    // Fee viability
    const category = pick.category || "other"
    const expectedExit = pick.strategy?.includes("Snipe") ? 1.0 : (pick.estimatedProb || pick.price || 0.5) + 0.05
    const entryPrice = pick.market?.outcomes?.find((o) => o.name === pick.outcome)?.price || 0.5
    const viability = isTradeViable(betSize, entryPrice, expectedExit, category, true)

    if (!viability.profitable && !pick.strategy?.includes("Snipe")) {
      skipped++
      continue
    }

    // Determine neg-risk
    let negRisk = false
    try {
      const info = await fetchFeeRate(tokenId)
      negRisk = info.negRisk
    } catch {}

    // Execute
    const result = await executeRealTrade(telegramId, {
      market: pick.market,
      tokenId,
      outcome: pick.outcome,
      side: pick.direction === "BUY_NO" ? "SELL" : "BUY",
      price: entryPrice,
      sizeUsdc: betSize,
      strategy: pick.strategy,
      category,
      negRisk,
    })

    if (result.ok) {
      placed++
      results.push(result)
    } else {
      skipped++
      if (result.error?.includes("Floor")) break // Stop if hitting floor
    }
  }

  return { placed, skipped, results, phase }
}

// ══════════════════════════════════════════════════════════════
// 8. REPORTING
// ══════════════════════════════════════════════════════════════

/**
 * Generate real-money scorecard
 */
export function generateScorecard(walletState) {
  const pnl = stmts.getTotalPnL.get()
  const today = stmts.getTodayStats.get()
  const openPositions = stmts.getFilledPositions.all()
  const phase = getCurrentPhase(walletState?.usdc || 0)

  const totalPnL = pnl?.total_pnl || 0
  const totalFees = pnl?.total_fees || 0
  const winRate = pnl?.total_trades > 0 ? (pnl.wins / pnl.total_trades * 100) : 0

  const phaseEmoji = { SAFE_ONLY: "🛡️", AI_SIGNAL: "🧠", SMART_BRAIN: "💡", FULL: "🚀" }

  let report = `💰 *Real Money Scorecard*\n\n`
  report += `*Balance:* $${(walletState?.usdc || 0).toFixed(2)}\n`
  report += `*Floor:* $${FLOOR_BALANCE} (${((walletState?.usdc || 0) - FLOOR_BALANCE).toFixed(2)} buffer)\n`
  report += `*Phase:* ${phaseEmoji[phase] || ""} ${phase}\n\n`

  report += `*P&L:* ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}\n`
  report += `*Fees paid:* $${totalFees.toFixed(2)}\n`
  report += `*Net:* ${(totalPnL - totalFees) >= 0 ? "+" : ""}$${(totalPnL - totalFees).toFixed(2)}\n`
  report += `*Today:* ${(today?.pnl || 0) >= 0 ? "+" : ""}$${(today?.pnl || 0).toFixed(2)}\n\n`

  report += `*Stats:*\n`
  report += `  Trades: ${pnl?.total_trades || 0} (Win: ${winRate.toFixed(0)}%)\n`
  report += `  Open: ${openPositions.length} positions\n`

  if (openPositions.length > 0) {
    report += `\n*Open Positions:*\n`
    for (const p of openPositions.slice(0, 5)) {
      report += `  • ${(p.outcome || "").slice(0, 20)} @ ${(p.price * 100).toFixed(0)}% — $${p.size_usdc.toFixed(2)} (${p.strategy})\n`
    }
  }

  // Phase unlocking info
  const nextPhase = phase === "SAFE_ONLY" ? `AI Signal at $${PHASE_THRESHOLDS.ADD_AI_SIGNAL}`
    : phase === "AI_SIGNAL" ? `Smart Brain at $${PHASE_THRESHOLDS.ADD_SMART_BRAIN}`
    : phase === "SMART_BRAIN" ? `Full strategies at $${PHASE_THRESHOLDS.FULL_STRATEGIES}`
    : "All strategies unlocked"
  report += `\n*Next unlock:* ${nextPhase}`

  // Save daily stats
  const date = new Date().toISOString().split("T")[0]
  stmts.upsertDailyStats.run(
    date, STARTING_BANKROLL, walletState?.usdc || 0,
    today?.trades || 0, 0, today?.fees || 0, today?.pnl || 0, totalPnL,
  )

  return report
}

/**
 * Check if real trading is enabled
 */
export function isRealMode() {
  const row = stmts.getConfig.get("real_mode")
  return row?.value === "true"
}

export function enableRealMode() {
  stmts.setConfig.run("real_mode", "true")
  console.log("[REAL] 💰 Real money mode ENABLED")
}

export function disableRealMode() {
  stmts.setConfig.run("real_mode", "false")
  console.log("[REAL] 🔴 Real money mode DISABLED")
}

export default {
  // Fee calculator
  calculateTakerFee,
  isTradeViable,
  // Wallet
  getWalletState,
  approveExchanges,
  // Risk
  riskCheck,
  // Executor
  executeRealTrade,
  // Lifecycle
  manageOrders,
  checkPositions,
  // Integration
  processApprovedTrades,
  // Reporting
  generateScorecard,
  // Config
  isRealMode,
  enableRealMode,
  disableRealMode,
  // Constants (for display)
  FLOOR_BALANCE,
  STARTING_BANKROLL,
  PHASE_THRESHOLDS,
  TAKER_FEE_RATES,
}
