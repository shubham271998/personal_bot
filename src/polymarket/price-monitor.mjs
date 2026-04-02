/**
 * Real-Time Crypto Price Monitor
 *
 * Connects to Binance WebSocket for BTC/ETH/SOL prices.
 * Detects significant price moves that could affect Polymarket crypto contracts.
 *
 * When BTC moves ±1% in 5 min → potential edge on Polymarket crypto markets.
 * This data feeds into Smart Brain for faster crypto market decisions.
 *
 * NO REAL MONEY — this is for intelligence gathering only.
 */

const BINANCE_WS = "wss://stream.binance.com:9443/ws"
const PRICE_MOVE_THRESHOLD = 0.008 // 0.8% move = significant

// Price state
const prices = {
  BTC: { current: 0, fiveMinAgo: 0, oneHourAgo: 0, lastUpdate: 0 },
  ETH: { current: 0, fiveMinAgo: 0, oneHourAgo: 0, lastUpdate: 0 },
  SOL: { current: 0, fiveMinAgo: 0, oneHourAgo: 0, lastUpdate: 0 },
}

let ws = null
let isConnected = false
let onPriceAlert = null // Callback when significant move detected

/**
 * Connect to Binance WebSocket for real-time prices
 */
export function connect() {
  if (isConnected) return

  try {
    // Dynamic import WebSocket (node built-in in Node 22+, or ws package)
    import("ws").then(({ default: WebSocket }) => {
      const streams = "btcusdt@miniTicker/ethusdt@miniTicker/solusdt@miniTicker"
      ws = new WebSocket(`${BINANCE_WS}/${streams}`)

      ws.on("open", () => {
        isConnected = true
        console.log("[PRICE-MONITOR] Connected to Binance WebSocket")
      })

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString())
          handleTicker(msg)
        } catch {}
      })

      ws.on("close", () => {
        isConnected = false
        // Don't reconnect — fall back to polling
        console.log("[PRICE-MONITOR] WebSocket closed, switching to polling fallback")
        startPollingFallback()
      })

      ws.on("error", (err) => {
        // 451 = geo-blocked (Binance blocked on Railway Singapore)
        // Don't spam reconnect, just use polling
        if (err.message?.includes("451") || err.message?.includes("Unexpected server response")) {
          console.log("[PRICE-MONITOR] Binance WS geo-blocked, using polling")
          if (ws) { ws.removeAllListeners(); ws.close(); ws = null }
          isConnected = false
          startPollingFallback()
        }
      })
    }).catch(() => {
      console.log("[PRICE-MONITOR] WebSocket module not available — using polling fallback")
      startPollingFallback()
    })
  } catch {
    startPollingFallback()
  }
}

function handleTicker(msg) {
  const symbol = msg.s // e.g., "BTCUSDT"
  const price = parseFloat(msg.c) // Current close price
  if (!symbol || !price) return

  const coin = symbol.replace("USDT", "")
  if (!prices[coin]) return

  const now = Date.now()
  const state = prices[coin]

  // Track 5-min-ago price
  if (now - state.lastUpdate > 5 * 60 * 1000 || state.fiveMinAgo === 0) {
    state.fiveMinAgo = state.current || price
  }
  // Track 1-hour-ago price
  if (now - state.lastUpdate > 60 * 60 * 1000 || state.oneHourAgo === 0) {
    state.oneHourAgo = state.current || price
  }

  state.current = price
  state.lastUpdate = now

  // Check for significant move (from 5 min ago)
  if (state.fiveMinAgo > 0) {
    const move = (price - state.fiveMinAgo) / state.fiveMinAgo
    if (Math.abs(move) >= PRICE_MOVE_THRESHOLD) {
      const alert = {
        coin,
        price,
        fiveMinAgo: state.fiveMinAgo,
        move: move * 100, // percentage
        direction: move > 0 ? "UP" : "DOWN",
        timestamp: now,
      }
      console.log(`[PRICE-MONITOR] 🚨 ${coin} ${alert.direction} ${Math.abs(alert.move).toFixed(2)}% in 5min ($${price.toFixed(0)})`)
      if (onPriceAlert) onPriceAlert(alert)
      // Reset 5-min tracking after alert
      state.fiveMinAgo = price
    }
  }
}

// Polling fallback if WebSocket not available
let pollingStarted = false
function startPollingFallback() {
  if (pollingStarted) return
  pollingStarted = true
  import("axios").then(({ default: axios }) => {
    setInterval(async () => {
      try {
        const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price", {
          params: { symbols: '["BTCUSDT","ETHUSDT","SOLUSDT"]' },
          timeout: 5000,
        })
        for (const item of data) {
          handleTicker({ s: item.symbol, c: item.price })
        }
      } catch {}
    }, 10000) // Poll every 10 seconds
    console.log("[PRICE-MONITOR] Using polling fallback (10s interval)")
  }).catch(() => {})
}

/**
 * Get current prices and recent moves
 */
export function getPrices() {
  const result = {}
  for (const [coin, state] of Object.entries(prices)) {
    if (state.current === 0) continue
    result[coin] = {
      price: state.current,
      change5min: state.fiveMinAgo > 0 ? ((state.current - state.fiveMinAgo) / state.fiveMinAgo * 100) : 0,
      change1hour: state.oneHourAgo > 0 ? ((state.current - state.oneHourAgo) / state.oneHourAgo * 100) : 0,
      lastUpdate: state.lastUpdate,
    }
  }
  return result
}

/**
 * Check if a crypto market has a price-based edge
 * E.g., "Will BTC be above $70K?" — if BTC just dropped 2%, market hasn't repriced yet
 */
export function getCryptoEdge(marketQuestion) {
  const q = marketQuestion.toLowerCase()
  let coin = null
  if (q.includes("bitcoin") || q.includes("btc")) coin = "BTC"
  else if (q.includes("ethereum") || q.includes("eth")) coin = "ETH"
  else if (q.includes("solana") || q.includes("sol")) coin = "SOL"
  if (!coin || !prices[coin].current) return null

  const state = prices[coin]
  const change5min = state.fiveMinAgo > 0 ? (state.current - state.fiveMinAgo) / state.fiveMinAgo : 0
  const change1hr = state.oneHourAgo > 0 ? (state.current - state.oneHourAgo) / state.oneHourAgo : 0

  // Extract price threshold from question
  const priceMatch = q.match(/\$([0-9,]+)/)?.[1]?.replace(/,/g, "")
  const threshold = priceMatch ? parseFloat(priceMatch) : null

  if (!threshold) return null

  const isAboveQuestion = q.includes("above") || q.includes("higher")
  const isBelowQuestion = q.includes("below") || q.includes("dip") || q.includes("drop")
  const currentPrice = state.current

  return {
    coin,
    currentPrice,
    threshold,
    isAbove: currentPrice > threshold,
    margin: ((currentPrice - threshold) / threshold * 100).toFixed(2),
    change5min: (change5min * 100).toFixed(2),
    change1hr: (change1hr * 100).toFixed(2),
    edge: isAboveQuestion
      ? (currentPrice > threshold * 1.02 ? "YES_LIKELY" : currentPrice < threshold * 0.98 ? "NO_LIKELY" : "CLOSE")
      : (currentPrice < threshold * 0.98 ? "YES_LIKELY" : currentPrice > threshold * 1.02 ? "NO_LIKELY" : "CLOSE"),
  }
}

/**
 * Set callback for price alerts
 */
export function setAlertCallback(callback) {
  onPriceAlert = callback
}

export function disconnect() {
  if (ws) {
    ws.close()
    ws = null
    isConnected = false
  }
}

export default { connect, disconnect, getPrices, getCryptoEdge, setAlertCallback }
