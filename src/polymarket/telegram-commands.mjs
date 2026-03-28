/**
 * Polymarket Telegram Commands
 *
 * Registers all /pm* commands on the bot instance.
 * Call registerPolymarketCommands(bot, isAdmin) from bot.mjs
 */
import scanner from "./market-scanner.mjs"
import newsAnalyzer from "./news-analyzer.mjs"
import trader from "./trader.mjs"

export function registerPolymarketCommands(bot, isAdminFn) {
  // ── /pm — Overview ────────────────────────────────────────
  bot.onText(/\/pm$/, (msg) => {
    const name = msg.from.first_name || "there"
    bot.sendMessage(
      msg.chat.id,
      `Hey ${name}! Here's what I can do on Polymarket 📈\n\n` +
        `*Markets:*\n` +
        `/pmtop — Trending markets right now\n` +
        `/pmsearch <query> — Find specific markets\n` +
        `/pmopps — Markets with potential edge\n\n` +
        `*Trading:*\n` +
        `/pmbuy <market> <outcome> <$amount> — Place a bet\n` +
        `/pmportfolio — Your current positions\n` +
        `/pmhistory — Trade history\n` +
        `/pmpnl — Your profit & loss\n\n` +
        `*Analysis:*\n` +
        `/pmnews <topic> — News analysis for a market\n` +
        `/pmanalyze <market> — Deep analysis with edge detection\n\n` +
        `*Settings:*\n` +
        `/pmsettings — View/change trading settings\n\n` +
        `_Currently in paper trading mode — no real money at risk!_`,
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
}
