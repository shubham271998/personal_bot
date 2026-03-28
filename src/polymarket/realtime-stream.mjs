/**
 * Polymarket Real-Time WebSocket Stream
 *
 * Two streams:
 *   1. CLOB WebSocket — Order book changes, price updates
 *   2. Live Data WebSocket — Trade activity, crypto prices
 *
 * Emits events to callbacks for the monitor to act on.
 */
import WebSocket from "ws"

const CLOB_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
const LIVE_WS = "wss://ws-live-data.polymarket.com"

class RealtimeStream {
  constructor() {
    this.clobWs = null
    this.liveWs = null
    this.subscribedTokens = new Set()
    this.subscribedSlugs = new Set()
    this.onPriceChange = null     // callback(tokenId, price, change)
    this.onTrade = null           // callback(tradeData)
    this.onBookUpdate = null      // callback(tokenId, bookData)
    this._reconnectTimer = null
    this._pingTimer = null
    this._isConnected = false
  }

  /**
   * Connect to CLOB WebSocket for order book updates
   */
  connectCLOB(tokenIds = []) {
    if (this.clobWs) this.clobWs.close()

    this.clobWs = new WebSocket(CLOB_WS)

    this.clobWs.on("open", () => {
      console.log("[WS-CLOB] Connected")
      this._isConnected = true

      // Subscribe to tokens
      if (tokenIds.length > 0) {
        this.clobWs.send(JSON.stringify({
          assets_ids: tokenIds,
          type: "market",
        }))
        tokenIds.forEach((id) => this.subscribedTokens.add(id))
        console.log(`[WS-CLOB] Subscribed to ${tokenIds.length} tokens`)
      }
    })

    this.clobWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString())
        this._handleCLOBMessage(msg)
      } catch {}
    })

    this.clobWs.on("close", () => {
      console.log("[WS-CLOB] Disconnected, reconnecting in 5s...")
      this._isConnected = false
      this._reconnectTimer = setTimeout(() => {
        this.connectCLOB([...this.subscribedTokens])
      }, 5000)
    })

    this.clobWs.on("error", (err) => {
      console.error("[WS-CLOB] Error:", err.message)
    })
  }

  /**
   * Connect to Live Data WebSocket for trade activity
   */
  connectLive(eventSlugs = []) {
    if (this.liveWs) this.liveWs.close()

    this.liveWs = new WebSocket(LIVE_WS)

    this.liveWs.on("open", () => {
      console.log("[WS-LIVE] Connected")

      // Ping every 5 seconds to keep alive
      this._pingTimer = setInterval(() => {
        if (this.liveWs?.readyState === WebSocket.OPEN) {
          this.liveWs.send("ping")
        }
      }, 5000)

      // Subscribe to trade activity for events
      for (const slug of eventSlugs) {
        this.liveWs.send(JSON.stringify({
          action: "subscribe",
          subscriptions: [{
            topic: "activity",
            type: "trades",
            filters: JSON.stringify({ event_slug: slug }),
          }],
        }))
        this.subscribedSlugs.add(slug)
      }

      if (eventSlugs.length > 0) {
        console.log(`[WS-LIVE] Subscribed to ${eventSlugs.length} events`)
      }
    })

    this.liveWs.on("message", (data) => {
      const msg = data.toString()
      if (msg === "pong") return

      try {
        const parsed = JSON.parse(msg)
        this._handleLiveMessage(parsed)
      } catch {}
    })

    this.liveWs.on("close", () => {
      console.log("[WS-LIVE] Disconnected, reconnecting in 5s...")
      if (this._pingTimer) clearInterval(this._pingTimer)
      setTimeout(() => {
        this.connectLive([...this.subscribedSlugs])
      }, 5000)
    })

    this.liveWs.on("error", (err) => {
      console.error("[WS-LIVE] Error:", err.message)
    })
  }

  /**
   * Subscribe to a new token's order book updates
   */
  subscribeToken(tokenId) {
    if (this.subscribedTokens.has(tokenId)) return
    this.subscribedTokens.add(tokenId)

    if (this.clobWs?.readyState === WebSocket.OPEN) {
      this.clobWs.send(JSON.stringify({
        assets_ids: [tokenId],
        type: "market",
      }))
    }
  }

  /**
   * Subscribe to trade activity for an event
   */
  subscribeEvent(slug) {
    if (this.subscribedSlugs.has(slug)) return
    this.subscribedSlugs.add(slug)

    if (this.liveWs?.readyState === WebSocket.OPEN) {
      this.liveWs.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [{
          topic: "activity",
          type: "trades",
          filters: JSON.stringify({ event_slug: slug }),
        }],
      }))
    }
  }

  /**
   * Process CLOB WebSocket messages (order book updates)
   */
  _handleCLOBMessage(msg) {
    // Price change events
    if (msg.asset_id && msg.price) {
      if (this.onPriceChange) {
        this.onPriceChange(msg.asset_id, parseFloat(msg.price), msg)
      }
    }

    // Book update events
    if (msg.asset_id && (msg.bids || msg.asks)) {
      if (this.onBookUpdate) {
        this.onBookUpdate(msg.asset_id, msg)
      }
    }
  }

  /**
   * Process Live Data WebSocket messages (trades, activity)
   */
  _handleLiveMessage(msg) {
    if (msg.topic === "activity" && msg.type === "trades") {
      if (this.onTrade) {
        this.onTrade(msg.payload)
      }
    }
  }

  /**
   * Disconnect everything
   */
  disconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    if (this._pingTimer) clearInterval(this._pingTimer)
    if (this.clobWs) this.clobWs.close()
    if (this.liveWs) this.liveWs.close()
    this.clobWs = null
    this.liveWs = null
    this._isConnected = false
    this.subscribedTokens.clear()
    this.subscribedSlugs.clear()
    console.log("[WS] All streams disconnected")
  }

  get connected() {
    return this._isConnected
  }
}

const stream = new RealtimeStream()
export default stream
