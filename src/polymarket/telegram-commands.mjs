/**
 * Polymarket Telegram Commands
 *
 * Registers all /pm* commands on the bot instance.
 * Call registerPolymarketCommands(bot, isAdmin) from bot.mjs
 */
import scanner from "./market-scanner.mjs"
import newsAnalyzer from "./news-analyzer.mjs"
import trader from "./trader.mjs"
import strategyEngine from "./strategy-engine.mjs"
import marketMaker from "./market-maker.mjs"
import executor from "./executor-bridge.mjs"
import negRisk from "./negrisk-scanner.mjs"

export function registerPolymarketCommands(bot, isAdminFn) {
  // ── /pm — Overview ────────────────────────────────────────
  bot.onText(/\/pm$/, (msg) => {
    const name = msg.from.first_name || "there"
    bot.sendMessage(
      msg.chat.id,
      `Hey ${name}! Here's what I can do on Polymarket 📈\n\n` +
        `*🧠 Smart Scanning:*\n` +
        `/pmscan [bankroll] — Full 5-strategy scan (the big one)\n` +
        `/pmsnipes — Safe bets (95%+ resolution snipes)\n` +
        `/pmlongshots — High risk, 10x+ payoff bets\n\n` +
        `*📊 Markets:*\n` +
        `/pmtop — Trending markets\n` +
        `/pmsearch <query> — Find markets\n` +
        `/pmopps — Quick opportunity scan\n\n` +
        `*📰 Research:*\n` +
        `/pmnews <topic> — News sentiment analysis\n` +
        `/pmanalyze <market> — Deep market analysis\n\n` +
        `*💰 Trading:*\n` +
        `/pmbuy <id> <outcome> <$amount> — Place a bet\n` +
        `/pmportfolio — Your positions\n` +
        `/pmpnl — Profit & loss\n` +
        `/pmhistory — Trade log\n\n` +
        `*⚖️ Arbitrage:*\n` +
        `/pmnegrisk — NegRisk multi-outcome arbitrage (risk-free!)\n` +
        `/pmmaker — Market making opportunities\n\n` +
        `*💳 Wallet:*\n` +
        `/pmwallet — Check balance\n` +
        `/pmconnect <key> — Connect Polygon wallet\n\n` +
        `*⚙️ Settings:*\n` +
        `/pmsettings — Trading config\n\n` +
        `_Paper trading mode — no real money at risk!_`,
      { parse_mode: "Markdown" },
    )
  })

  // ── /pmtop — Top markets ──────────────────────────────────
  bot.onText(/\/pmtop/, async (msg) => {
    const chatId = msg.chat.id
    const loading = await bot.sendMessage(chatId, "📊 _Scanning top markets..._", { parse_mode: "Markdown" })

    try {
      const markets = await scanner.getTopMarkets(8)
      const lines = markets.map((m, i) => {
        const outcomes = m.outcomes.slice(0, 2).map((o) =>
          `  ${o.name}: *${(o.price * 100).toFixed(1)}%*`,
        ).join("\n")
        const vol = m.volume24hr >= 1000000
          ? `$${(m.volume24hr / 1000000).toFixed(1)}M`
          : `$${(m.volume24hr / 1000).toFixed(0)}K`
        return `${i + 1}. *${m.question.slice(0, 70)}*\n${outcomes}\n  📊 ${vol} vol/24h`
      })

      bot.editMessageText(
        `🔥 *Trending on Polymarket*\n\n${lines.join("\n\n")}`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Couldn't fetch markets: ${err.message}`, {
        chat_id: chatId, message_id: loading.message_id,
      })
    }
  })

  // ── /pmsearch — Search markets ────────────────────────────
  bot.onText(/\/pmsearch\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id
    const query = match[1].trim()

    try {
      const markets = await scanner.searchMarkets(query, 5)
      if (markets.length === 0) {
        bot.sendMessage(chatId, `No markets found for "${query}" 🤷`)
        return
      }

      const lines = markets.map((m) => {
        const outcomes = m.outcomes.slice(0, 2).map((o) =>
          `${o.name}: *${(o.price * 100).toFixed(1)}%*`,
        ).join(" | ")
        return `*${m.question.slice(0, 80)}*\n  ${outcomes}\n  ID: \`${m.id}\``
      })

      bot.sendMessage(chatId, `🔍 Markets matching "${query}":\n\n${lines.join("\n\n")}`, {
        parse_mode: "Markdown",
      })
    } catch (err) {
      bot.sendMessage(chatId, `Search failed: ${err.message}`)
    }
  })

  // ── /pmopps — Find opportunities ──────────────────────────
  bot.onText(/\/pmopps/, async (msg) => {
    const chatId = msg.chat.id
    const loading = await bot.sendMessage(chatId, "🔮 _Scanning for opportunities..._", { parse_mode: "Markdown" })

    try {
      const opps = await scanner.findOpportunities(50)

      if (opps.length === 0) {
        bot.editMessageText("No obvious opportunities right now. Markets look efficiently priced! ⚖️", {
          chat_id: chatId, message_id: loading.message_id,
        })
        return
      }

      const lines = opps.slice(0, 5).map((opp, i) => {
        const m = opp.market
        const reasons = opp.signals.reasons.slice(0, 2).join("\n  ")
        const outcomes = m.outcomes.slice(0, 2).map((o) =>
          `${o.name}: ${(o.price * 100).toFixed(1)}%`,
        ).join(" | ")
        return `${i + 1}. *${m.question.slice(0, 70)}*\n  ${outcomes}\n  🎯 Score: ${opp.signals.score.toFixed(1)}\n  ${reasons}`
      })

      bot.editMessageText(
        `🔮 *Opportunities Found*\n\n${lines.join("\n\n")}\n\n_Higher score = stronger signal_`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Scan failed: ${err.message}`, {
        chat_id: chatId, message_id: loading.message_id,
      })
    }
  })

  // ── /pmnews — News analysis ───────────────────────────────
  bot.onText(/\/pmnews\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id
    const topic = match[1].trim()
    const loading = await bot.sendMessage(chatId, `📰 _Checking news for "${topic}"..._`, { parse_mode: "Markdown" })

    try {
      const headlines = await newsAnalyzer.searchNews(topic, 8)
      const sentiment = newsAnalyzer.analyzeSentiment(headlines, topic)

      const emoji = sentiment.sentiment === "bullish" ? "🟢" : sentiment.sentiment === "bearish" ? "🔴" : "⚪"
      const headlineList = sentiment.headlines.slice(0, 5).map((h) =>
        `• ${h.title.slice(0, 80)}${h.source ? ` _(${h.source})_` : ""}`,
      ).join("\n")

      bot.editMessageText(
        `📰 *News Analysis: ${topic}*\n\n` +
          `${emoji} Sentiment: *${sentiment.sentiment.toUpperCase()}*\n` +
          `  🟢 Bullish: ${sentiment.bullish} | 🔴 Bearish: ${sentiment.bearish} | ⚪ Neutral: ${sentiment.neutral}\n\n` +
          `*Headlines:*\n${headlineList || "No recent headlines found"}`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`News fetch failed: ${err.message}`, {
        chat_id: chatId, message_id: loading.message_id,
      })
    }
  })

  // ── /pmanalyze — Deep analysis with news + market ─────────
  bot.onText(/\/pmanalyze\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id
    const query = match[1].trim()
    const loading = await bot.sendMessage(chatId, `🧠 _Analyzing "${query}"..._`, { parse_mode: "Markdown" })

    try {
      // Find the market
      const markets = await scanner.searchMarkets(query, 1)
      if (markets.length === 0) {
        bot.editMessageText(`Couldn't find a market matching "${query}"`, {
          chat_id: chatId, message_id: loading.message_id,
        })
        return
      }

      const market = markets[0]
      const headlines = await newsAnalyzer.searchNews(market.question, 8)
      const sentiment = newsAnalyzer.analyzeSentiment(headlines, market.outcomes[0]?.name)
      const edge = newsAnalyzer.findNewsEdge(market, sentiment)

      const outcomes = market.outcomes.map((o) =>
        `  ${o.name}: *${(o.price * 100).toFixed(1)}%*`,
      ).join("\n")

      const sentEmoji = sentiment.sentiment === "bullish" ? "🟢" : sentiment.sentiment === "bearish" ? "🔴" : "⚪"

      let edgeText = "_No clear edge detected — market seems fairly priced_"
      if (edge) {
        edgeText = `🎯 *EDGE DETECTED*\n` +
          `  Direction: *${edge.direction}*\n` +
          `  Confidence: ${(edge.confidence * 100).toFixed(0)}%\n` +
          `  ${edge.reason}`
      }

      const headlineList = sentiment.headlines.slice(0, 3).map((h) =>
        `• ${h.title.slice(0, 70)}`,
      ).join("\n")

      bot.editMessageText(
        `🧠 *Analysis: ${market.question.slice(0, 60)}*\n\n` +
          `*Current Odds:*\n${outcomes}\n\n` +
          `*News Sentiment:* ${sentEmoji} ${sentiment.sentiment}\n` +
          `${headlineList ? headlineList + "\n\n" : "\n"}` +
          `${edgeText}\n\n` +
          `_Vol: $${(market.volume24hr / 1000).toFixed(0)}K/24h_`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Analysis failed: ${err.message}`, {
        chat_id: chatId, message_id: loading.message_id,
      })
    }
  })

  // ── /pmbuy — Place a bet (paper by default) ───────────────
  bot.onText(/\/pmbuy\s+(\d+)\s+(.+?)\s+\$?(\d+(?:\.\d+)?)/, async (msg, match) => {
    const chatId = msg.chat.id
    const userId = msg.from.id
    const marketId = match[1]
    const outcomeName = match[2].trim()
    const amount = parseFloat(match[3])

    try {
      const market = await scanner.getMarket(marketId)
      if (!market) {
        bot.sendMessage(chatId, `Market ${marketId} not found`)
        return
      }

      const settings = trader.getSettings(userId)

      if (settings.paper_mode) {
        const result = trader.paperTrade(userId, market, outcomeName, amount)
        if (!result.ok) {
          bot.sendMessage(chatId, `❌ ${result.error}`)
          return
        }
        const t = result.trade
        bot.sendMessage(
          chatId,
          `📝 *Paper Trade Placed!*\n\n` +
            `*${market.question.slice(0, 60)}*\n` +
            `Bought: *${t.outcome}* at ${(t.price * 100).toFixed(1)}%\n` +
            `Amount: $${t.sizeUsdc}\n` +
            `Shares: ${t.shares}\n\n` +
            `_Paper trade — no real money used_`,
          { parse_mode: "Markdown" },
        )
      } else {
        bot.sendMessage(chatId, "Live trading coming soon! Use paper mode for now.")
      }
    } catch (err) {
      bot.sendMessage(chatId, `Trade failed: ${err.message}`)
    }
  })

  // ── /pmportfolio — View positions ─────────────────────────
  bot.onText(/\/pmportfolio/, (msg) => {
    const chatId = msg.chat.id
    const positions = trader.getPortfolio(msg.from.id)

    if (positions.length === 0) {
      bot.sendMessage(chatId, "You don't have any positions yet! Use /pmtop to find markets and /pmbuy to start trading 📈")
      return
    }

    const lines = positions.map((p) => {
      const value = (p.shares * p.avg_price).toFixed(2)
      return `*${p.market_id}* — ${p.outcome}\n` +
        `  ${p.shares.toFixed(2)} shares @ ${(p.avg_price * 100).toFixed(1)}%\n` +
        `  Value: ~$${value} ${p.paper ? "(paper)" : ""}`
    })

    bot.sendMessage(
      chatId,
      `📊 *Your Positions*\n\n${lines.join("\n\n")}`,
      { parse_mode: "Markdown" },
    )
  })

  // ── /pmhistory — Trade history ────────────────────────────
  bot.onText(/\/pmhistory/, (msg) => {
    const chatId = msg.chat.id
    const trades = trader.getTradeHistory(msg.from.id, 10)

    if (trades.length === 0) {
      bot.sendMessage(chatId, "No trades yet! Use /pmbuy to start.")
      return
    }

    const lines = trades.map((t) => {
      const time = t.created_at.split("T")[0]
      const icon = t.paper ? "📝" : "💰"
      return `${icon} ${time} | ${t.side} ${t.outcome.slice(0, 20)} @ ${(t.price * 100).toFixed(1)}% | $${t.size_usdc}`
    })

    bot.sendMessage(
      chatId,
      `📜 *Recent Trades*\n\n${lines.join("\n")}`,
      { parse_mode: "Markdown" },
    )
  })

  // ── /pmpnl — Profit & Loss ────────────────────────────────
  bot.onText(/\/pmpnl/, (msg) => {
    const chatId = msg.chat.id
    const pnl = trader.getPnLSummary(msg.from.id)

    bot.sendMessage(
      chatId,
      `💰 *Your P&L*\n\n` +
        `Today: $${pnl.dailyPnL.toFixed(2)}\n` +
        `Total: $${pnl.totalPnL.toFixed(2)}\n` +
        `Trades: ${pnl.totalTrades}\n` +
        `Win rate: ${pnl.winRate}%\n` +
        `Volume: $${pnl.totalVolume.toFixed(2)}`,
      { parse_mode: "Markdown" },
    )
  })

  // ── /pmsettings — Trading settings ────────────────────────
  bot.onText(/\/pmsettings/, (msg) => {
    const chatId = msg.chat.id
    const settings = trader.getSettings(msg.from.id)

    bot.sendMessage(
      chatId,
      `⚙️ *Trading Settings*\n\n` +
        `Mode: *${settings.paper_mode ? "📝 Paper Trading" : "💰 Live Trading"}*\n` +
        `Max bet: $${settings.max_bet}\n` +
        `Auto-trade: ${settings.auto_trade ? "ON" : "OFF"}\n\n` +
        `_Paper mode is on — all trades are simulated, no real money at risk._\n\n` +
        `To change, use:\n` +
        `/pmset paper on/off\n` +
        `/pmset maxbet <amount>`,
      { parse_mode: "Markdown" },
    )
  })

  bot.onText(/\/pmset\s+paper\s+(on|off)/, (msg, match) => {
    const userId = msg.from.id
    if (!isAdminFn(userId)) {
      bot.sendMessage(msg.chat.id, "Only admin can switch to live trading mode.")
      return
    }
    const paperMode = match[1] === "on" ? 1 : 0
    trader.updateSettings(userId, { paperMode })
    bot.sendMessage(msg.chat.id, paperMode ? "📝 Paper trading mode ON" : "💰 Live trading mode ON — be careful!")
  })

  bot.onText(/\/pmset\s+maxbet\s+(\d+)/, (msg, match) => {
    const maxBet = parseInt(match[1])
    trader.updateSettings(msg.from.id, { maxBet })
    bot.sendMessage(msg.chat.id, `Max bet set to $${maxBet}`)
  })

  // ── /pmnegrisk — NegRisk arbitrage scan ─────────────────────
  bot.onText(/\/pmnegrisk/, async (msg) => {
    const chatId = msg.chat.id
    const loading = await bot.sendMessage(chatId, "⚖️ _Scanning NegRisk events for arbitrage..._\n_This is the strategy that extracted $29M in one year_", { parse_mode: "Markdown" })

    try {
      const opps = await negRisk.findNegRiskArbitrage(0.5)

      if (opps.length === 0) {
        bot.editMessageText("No NegRisk arbitrage right now. Markets are efficiently priced — I'll keep watching!", {
          chat_id: chatId, message_id: loading.message_id,
        })
        return
      }

      const lines = opps.slice(0, 5).map((opp, i) => {
        const outcomeList = opp.event.outcomes.slice(0, 5).map((o) =>
          `   ${o.name}: ${(o.yesPrice * 100).toFixed(1)}%`,
        ).join("\n")
        return `${i + 1}. ⚖️ *${opp.event.title.slice(0, 55)}*\n` +
          `   YES prices sum: *${(opp.event.totalYesPrice * 100).toFixed(1)}%* (should be 100%)\n` +
          `   Spread: *${opp.spreadPct}%* → ${opp.direction}\n` +
          `   Profit: *${opp.tradeDetails.profitPct}%* guaranteed\n` +
          `${outcomeList}`
      })

      bot.editMessageText(
        `⚖️ *NegRisk Arbitrage Opportunities*\n` +
          `_Multi-outcome events where prices don't add up_\n\n${lines.join("\n\n")}`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Scan failed: ${err.message}`, { chat_id: chatId, message_id: loading.message_id })
    }
  })

  // ── /pmwallet — Check wallet balance ────────────────────────
  bot.onText(/\/pmwallet$/, async (msg) => {
    const chatId = msg.chat.id
    if (!isAdminFn(msg.from.id)) {
      bot.sendMessage(chatId, "Only admin can manage wallets.")
      return
    }

    if (!executor.hasWallet(msg.from.id)) {
      bot.sendMessage(
        chatId,
        `💳 *Connect Your Polygon Wallet*\n\n` +
          `To trade for real, I need your Polygon wallet private key.\n\n` +
          `*Setup steps:*\n` +
          `1. Create a wallet (MetaMask, Rabby, etc.)\n` +
          `2. Switch to Polygon network\n` +
          `3. Send some USDC + a tiny bit of MATIC for gas\n` +
          `4. Export private key and send: /pmconnect <key>\n\n` +
          `⚠️ _Key is deleted from chat instantly & encrypted._\n` +
          `_Use a dedicated wallet, not your main one!_`,
        { parse_mode: "Markdown" },
      )
      return
    }

    const loading = await bot.sendMessage(chatId, "💳 _Checking balance..._", { parse_mode: "Markdown" })
    try {
      const pk = executor.getWalletKey(msg.from.id)
      const balance = await executor.getBalance(pk)
      const settings = trader.getSettings(msg.from.id)

      bot.editMessageText(
        `💳 *Your Wallet*\n\n` +
          `Address: \`${balance.address}\`\n` +
          `USDC: *$${balance.usdc.toFixed(2)}*\n` +
          `MATIC: ${balance.matic.toFixed(4)} (for gas)\n\n` +
          `Mode: ${settings.paper_mode ? "📝 Paper" : "💰 Live"}\n\n` +
          `_/pmapprove to approve USDC for trading (one-time)_\n` +
          `_/pmset paper off to switch to live mode_`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Wallet check failed: ${err.message}`, {
        chat_id: chatId, message_id: loading.message_id,
      })
    }
  })

  // ── /pmconnect — Set private key ──────────────────────────
  bot.onText(/\/pmconnect\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id
    if (!isAdminFn(msg.from.id)) return

    // Delete the message with the key IMMEDIATELY
    bot.deleteMessage(chatId, msg.message_id).catch(() => {})

    const key = match[1].trim()
    if (!key.startsWith("0x") || key.length !== 66) {
      bot.sendMessage(chatId, "Invalid key format. Should be 0x + 64 hex characters.\nMake sure to export the *private key*, not the address.")
      return
    }

    const loading = await bot.sendMessage(chatId, "🔄 _Connecting wallet..._", { parse_mode: "Markdown" })

    try {
      const balance = await executor.getBalance(key)

      // Store encrypted key
      executor.storeWalletKey(msg.from.id, key)
      trader.updateSettings(msg.from.id, { privateKey: "stored_in_executor" })

      bot.editMessageText(
        `✅ *Wallet Connected!*\n\n` +
          `Address: \`${balance.address}\`\n` +
          `USDC: $${balance.usdc.toFixed(2)}\n` +
          `MATIC: ${balance.matic.toFixed(4)}\n\n` +
          `*Next steps:*\n` +
          `1. /pmapprove — Approve USDC for trading (one-time, costs ~0.01 MATIC)\n` +
          `2. /pmset paper off — Switch to live mode\n` +
          `3. Start trading!\n\n` +
          `_Key deleted from chat & encrypted in database._`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Couldn't connect: ${err.message}`, {
        chat_id: chatId, message_id: loading.message_id,
      })
    }
  })

  // ── /pmapprove — Approve USDC spending on Polymarket ──────
  bot.onText(/\/pmapprove/, async (msg) => {
    const chatId = msg.chat.id
    if (!isAdminFn(msg.from.id)) return

    const pk = executor.getWalletKey(msg.from.id)
    if (!pk) {
      bot.sendMessage(chatId, "Connect wallet first: /pmconnect <private_key>")
      return
    }

    const loading = await bot.sendMessage(
      chatId,
      "🔄 _Approving USDC for 3 Polymarket exchange contracts..._\n_This sends 3 on-chain transactions (costs ~0.03 MATIC)_",
      { parse_mode: "Markdown" },
    )

    try {
      const result = await executor.approveTrading(pk)

      bot.editMessageText(
        `✅ *USDC Approved for Trading!*\n\n` +
          `Approved ${result.exchanges} exchange contracts:\n` +
          `• CTF Exchange (binary markets)\n` +
          `• NegRisk Exchange (multi-outcome)\n` +
          `• NegRisk Adapter\n\n` +
          `You're ready to trade! Use /pmset paper off to go live.`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Approval failed: ${err.message}\n\nMake sure you have MATIC for gas fees.`, {
        chat_id: chatId, message_id: loading.message_id,
      })
    }
  })

  // ── /pmorders — View open orders on-chain ─────────────────
  bot.onText(/\/pmorders/, async (msg) => {
    const chatId = msg.chat.id
    if (!isAdminFn(msg.from.id)) return

    const pk = executor.getWalletKey(msg.from.id)
    if (!pk) { bot.sendMessage(chatId, "No wallet. /pmconnect first."); return }

    try {
      const result = await executor.getOpenOrders(pk)
      const orders = result.orders || []

      if (orders.length === 0) {
        bot.sendMessage(chatId, "No open orders on Polymarket right now.")
        return
      }

      const lines = orders.slice(0, 10).map((o, i) =>
        `${i + 1}. ${o.side} @ ${o.price} — ${o.size} shares\n   ID: \`${(o.id || "").slice(0, 12)}...\``,
      )

      bot.sendMessage(chatId, `📋 *Open Orders (${orders.length})*\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" })
    } catch (err) {
      bot.sendMessage(chatId, `Failed: ${err.message}`)
    }
  })

  // ── /pmcancelall — Cancel all open orders ─────────────────
  bot.onText(/\/pmcancelall/, async (msg) => {
    const chatId = msg.chat.id
    if (!isAdminFn(msg.from.id)) return

    const pk = executor.getWalletKey(msg.from.id)
    if (!pk) { bot.sendMessage(chatId, "No wallet."); return }

    try {
      await executor.cancelAll(pk)
      bot.sendMessage(chatId, "✅ All open orders cancelled.")
    } catch (err) {
      bot.sendMessage(chatId, `Cancel failed: ${err.message}`)
    }
  })

  // ── /pmmaker — Market making opportunities ────────────────
  bot.onText(/\/pmmaker/, async (msg) => {
    const chatId = msg.chat.id
    const loading = await bot.sendMessage(chatId, "📊 _Finding market making opportunities..._", { parse_mode: "Markdown" })

    try {
      const markets = await scanner.getTopMarkets(30)
      const opps = await marketMaker.findMMOpportunities(markets)

      if (opps.length === 0) {
        bot.editMessageText("No good market making opportunities right now.", {
          chat_id: chatId, message_id: loading.message_id,
        })
        return
      }

      const lines = opps.slice(0, 5).map((o, i) => {
        const sim = marketMaker.simulateMMSession(o.mid, parseFloat(o.optimalSpread) / 100, 100)
        return `${i + 1}. *${o.market.question.slice(0, 55)}*\n` +
          `   Spread: ${o.currentSpread}% → optimal ${o.optimalSpread}%\n` +
          `   Mid: ${(o.mid * 100).toFixed(1)}% | Depth: $${(o.bidDepth / 1000).toFixed(0)}K/$${(o.askDepth / 1000).toFixed(0)}K\n` +
          `   Est. daily: *~$${o.estDailyRevenue}* (0 fees + rebates)\n` +
          `   Sim: Buy@${sim.buyPrice} Sell@${sim.sellPrice} → $${sim.totalProfit}/round`
      })

      bot.editMessageText(
        `📊 *Market Making Opportunities*\n` +
          `_Makers pay 0% fees + earn rebates!_\n\n${lines.join("\n\n")}`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Failed: ${err.message}`, { chat_id: chatId, message_id: loading.message_id })
    }
  })

  // ── /pmscan — Full strategy scan (the big one) ────────────
  bot.onText(/\/pmscan\s*(\d*)/, async (msg, match) => {
    const chatId = msg.chat.id
    const bankroll = parseInt(match[1]) || 100
    const name = msg.from.first_name || "Boss"

    const loading = await bot.sendMessage(
      chatId,
      `🧠 _Running full market scan for you, ${name}..._\n\n` +
        `Checking 5 strategies across 200+ markets.\n` +
        `This takes 15-30 seconds.`,
      { parse_mode: "Markdown" },
    )

    try {
      const results = await strategyEngine.runFullScan(bankroll)

      // Build the report
      let report =
        `🎯 *Market Scan Complete*\n` +
        `💰 Bankroll: $${bankroll}\n` +
        `📊 Allocation: 60% safe / 25% medium / 15% risky\n\n`

      // Strategy summary
      const strats = results.strategies
      report +=
        `*Strategies Found:*\n` +
        `  🛡️ Resolution snipes: ${strats.resolutionSnipes || 0}\n` +
        `  ⚖️ Arbitrage: ${strats.arbitrage || 0}\n` +
        `  📰 News alpha: ${strats.newsAlpha || 0}\n` +
        `  📈 Momentum: ${strats.momentum || 0}\n` +
        `  🎰 Long shots: ${strats.longShots || 0}\n\n`

      // Top picks
      if (results.topPicks.length === 0) {
        report += `_No strong signals right now. Markets look efficiently priced. I'll keep watching!_`
      } else {
        report += `*🔥 Top Picks:*\n\n`

        for (let i = 0; i < Math.min(results.topPicks.length, 7); i++) {
          const pick = results.topPicks[i]
          const riskEmoji = pick.risk === "NONE" ? "⚖️" :
            pick.risk === "LOW" ? "🛡️" :
            pick.risk === "MEDIUM" ? "⚡" : "🎰"

          report +=
            `${i + 1}. ${riskEmoji} *${pick.strategy}*\n` +
            `   ${pick.market.question.slice(0, 60)}\n` +
            `   ${pick.reasoning.slice(0, 100)}\n` +
            `   💵 Suggested: $${(pick.betSize || 0).toFixed(2)}\n\n`
        }

        report += `_Use /pmbuy <market_id> <outcome> <$amount> to trade_`
      }

      bot.editMessageText(report, {
        chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown",
      })
    } catch (err) {
      bot.editMessageText(`Scan failed: ${err.message}`, {
        chat_id: chatId, message_id: loading.message_id,
      })
    }
  })

  // ── /pmsnipes — Resolution snipes only ────────────────────
  bot.onText(/\/pmsnipes/, async (msg) => {
    const chatId = msg.chat.id
    const loading = await bot.sendMessage(chatId, "🛡️ _Scanning for safe resolution snipes..._", { parse_mode: "Markdown" })

    try {
      const snipes = await strategyEngine.findResolutionSnipes(0.90, 0.99)

      if (snipes.length === 0) {
        bot.editMessageText("No good snipes right now. Check back later!", {
          chat_id: chatId, message_id: loading.message_id,
        })
        return
      }

      const lines = snipes.slice(0, 8).map((s, i) => {
        const hoursText = s.hoursLeft !== "N/A" ? ` | ⏰ ${s.hoursLeft}h left` : ""
        return `${i + 1}. *${s.market.question.slice(0, 55)}*\n` +
          `   ${s.outcome}: ${(s.price * 100).toFixed(1)}% → +${s.profit}% profit${hoursText}\n` +
          `   ID: \`${s.market.id}\``
      })

      bot.editMessageText(
        `🛡️ *Resolution Snipes*\n_Buy near-certain outcomes for small guaranteed profit_\n\n${lines.join("\n\n")}`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Failed: ${err.message}`, { chat_id: chatId, message_id: loading.message_id })
    }
  })

  // ── /pmlongshots — High risk, high reward ─────────────────
  bot.onText(/\/pmlongshots/, async (msg) => {
    const chatId = msg.chat.id
    const loading = await bot.sendMessage(chatId, "🎰 _Scanning for long shots..._", { parse_mode: "Markdown" })

    try {
      const shots = await strategyEngine.findLongShots(0.15)

      if (shots.length === 0) {
        bot.editMessageText("No interesting long shots right now.", {
          chat_id: chatId, message_id: loading.message_id,
        })
        return
      }

      const lines = shots.slice(0, 8).map((s, i) =>
        `${i + 1}. *${s.market.question.slice(0, 55)}*\n` +
          `   ${s.outcome}: ${(s.price * 100).toFixed(1)}% → *${s.payoff} return*\n` +
          `   ID: \`${s.market.id}\``,
      )

      bot.editMessageText(
        `🎰 *Long Shots*\n_Small bets, massive payoffs if they hit_\n\n${lines.join("\n\n")}\n\n` +
          `_Only bet what you can afford to lose!_`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: "Markdown" },
      )
    } catch (err) {
      bot.editMessageText(`Failed: ${err.message}`, { chat_id: chatId, message_id: loading.message_id })
    }
  })
}
