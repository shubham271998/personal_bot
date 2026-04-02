/**
 * Web Researcher — Multi-source intelligence for Polymarket decisions
 *
 * Data sources (all free, no API keys needed unless noted):
 *   1. DuckDuckGo HTML search — web search for any market topic
 *   2. Twitter/X oEmbed — read tweets from key Polymarket accounts
 *   3. Polymarket price history — momentum + trend detection
 *   4. ESPN API — real sports scores and schedules (free, no auth)
 *   5. CoinGecko — crypto market context (free tier)
 *   6. Crypto Fear & Greed — market sentiment
 *   7. The Odds API — real sportsbook odds (500 free/month, needs key)
 *
 * Philosophy: Don't guess. RESEARCH first, then decide.
 */
import axios from "axios"
import api from "./api-client.mjs"

// ── Config ─────────────────────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY || ""
const RESEARCH_TIMEOUT = 8000

// ── 1. Web Search (DuckDuckGo HTML scrape) ─────────────────

/**
 * Search the web for context on a topic
 * Returns: [{ title, snippet, url }]
 */
export async function webSearch(query, limit = 5) {
  // Try multiple search sources in order of reliability
  const results = await _searchDDGLite(query, limit) ||
    await _searchSearX(query, limit) ||
    await _searchDDGInstant(query, limit) ||
    await _searchGoogleNews(query, limit) ||
    []

  return results
}

// DuckDuckGo Instant Answers API (JSON, always works, limited results)
async function _searchDDGInstant(query, limit) {
  try {
    const { data } = await axios.get("https://api.duckduckgo.com/", {
      params: { q: query, format: "json", no_html: 1, skip_disambig: 1 },
      timeout: RESEARCH_TIMEOUT,
    })

    const results = []
    // Abstract (main answer)
    if (data.Abstract) {
      results.push({ title: data.Heading || query, snippet: data.Abstract.slice(0, 200), url: data.AbstractURL || "" })
    }
    // Related topics
    for (const topic of (data.RelatedTopics || []).slice(0, limit - results.length)) {
      if (topic.Text) {
        results.push({ title: topic.Text.slice(0, 80), snippet: topic.Text.slice(0, 200), url: topic.FirstURL || "" })
      }
    }

    if (results.length > 0) return results
    return null
  } catch { return null }
}

// Google News RSS as last resort (already used by news-analyzer)
async function _searchGoogleNews(query, limit) {
  try {
    const { data } = await axios.get(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
      {
        timeout: RESEARCH_TIMEOUT,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
      },
    )

    const results = []
    const items = data.matchAll(/<item>([\s\S]*?)<\/item>/g)
    for (const match of items) {
      const xml = match[1]
      const title = xml.match(/<title>(.*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, "$1") || ""
      if (title) results.push({ title, snippet: title, url: "" })
      if (results.length >= limit) break
    }

    if (results.length > 0) return results
    return null
  } catch { return null }
}

// DuckDuckGo Lite (simpler HTML, less likely to block)
async function _searchDDGLite(query, limit) {
  try {
    const { data } = await axios.post("https://lite.duckduckgo.com/lite/", `q=${encodeURIComponent(query)}`, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      },
      timeout: RESEARCH_TIMEOUT,
    })

    const results = []
    // DuckDuckGo Lite returns a table with results
    const rows = data.match(/<a[^>]+class="result-link"[^>]*>([\s\S]*?)<\/a>/g) ||
      data.match(/<a[^>]+rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g) || []

    // Extract titles and snippets from table rows
    const snippetBlocks = data.match(/<td class="result-snippet">([\s\S]*?)<\/td>/g) || []

    for (let i = 0; i < rows.length && results.length < limit; i++) {
      const titleMatch = rows[i].match(/>([^<]+)<\/a>/)
      const urlMatch = rows[i].match(/href="([^"]+)"/)
      const snippetMatch = snippetBlocks[i]?.match(/>([^<]+)</)

      if (titleMatch?.[1]) {
        results.push({
          title: titleMatch[1].trim(),
          snippet: snippetMatch?.[1]?.trim()?.slice(0, 200) || "",
          url: urlMatch?.[1] || "",
        })
      }
    }

    if (results.length > 0) return results
    return null // Try next source
  } catch {
    return null
  }
}

// SearXNG public instances as fallback
async function _searchSearX(query, limit) {
  const instances = [
    "https://searx.be",
    "https://search.sapti.me",
    "https://searx.tiekoetter.com",
  ]

  for (const instance of instances) {
    try {
      const { data } = await axios.get(`${instance}/search`, {
        params: { q: query, format: "json", categories: "general", language: "en" },
        timeout: RESEARCH_TIMEOUT,
        headers: { "User-Agent": "Mozilla/5.0" },
      })

      if (data?.results?.length > 0) {
        return data.results.slice(0, limit).map(r => ({
          title: r.title || "",
          snippet: (r.content || "").slice(0, 200),
          url: r.url || "",
        }))
      }
    } catch {
      continue // Try next instance
    }
  }
  return null
}

// ── 2. Twitter/X Sentiment (oEmbed + search) ───────────────

// Key Polymarket/prediction market accounts to monitor
const PM_TWITTER_ACCOUNTS = [
  "Polymarket", "polyaboretus", "DustinMoskovitz",
  "NateSilver538", "Kalshi", "elikibaek",
]

/**
 * Search Twitter/X for market sentiment
 */
export async function searchTwitter(query, limit = 5) {
  try {
    const results = await webSearch(`site:x.com OR site:twitter.com ${query} polymarket`, limit)
    return results.map(r => ({
      text: r.snippet || r.title,
      url: r.url,
      source: "twitter_search",
    }))
  } catch {
    return []
  }
}

/**
 * Search Reddit for community sentiment and discussion
 * Uses Reddit's JSON API (free, no auth needed)
 */
export async function searchReddit(query, limit = 5) {
  try {
    const { data } = await axios.get(`https://www.reddit.com/search.json`, {
      params: { q: `${query} polymarket OR prediction`, sort: "relevance", t: "week", limit },
      headers: { "User-Agent": "Mozilla/5.0 (research-bot)" },
      timeout: RESEARCH_TIMEOUT,
    })

    return (data?.data?.children || []).map(c => ({
      title: c.data?.title || "",
      subreddit: c.data?.subreddit || "",
      score: c.data?.score || 0,
      comments: c.data?.num_comments || 0,
      text: (c.data?.selftext || "").slice(0, 200),
      url: c.data?.url || "",
      source: "reddit",
    }))
  } catch {
    return []
  }
}

/**
 * Analyze social sentiment for a market from Twitter results
 */
export async function getSocialSentiment(marketQuestion) {
  const shortQuery = marketQuestion.slice(0, 40)
  const tweets = await searchTwitter(shortQuery, 8)

  if (tweets.length === 0) return { sentiment: "unknown", strength: 0, tweets: 0 }

  let bullish = 0, bearish = 0
  const positiveWords = /\b(yes|likely|confirmed|will|pass|win|agree|surge|rise|bullish|moon|pump)\b/i
  const negativeWords = /\b(no|unlikely|fail|won't|lose|reject|drop|crash|bearish|dump|dead)\b/i
  const negationWords = /\b(not|n't|never|won't|can't)\b/i

  for (const t of tweets) {
    const text = t.text.toLowerCase()
    const hasNegation = negationWords.test(text)
    const posHits = (text.match(positiveWords) || []).length
    const negHits = (text.match(negativeWords) || []).length

    let score = posHits - negHits
    if (hasNegation) score = -score // Flip on negation

    if (score > 0) bullish++
    else if (score < 0) bearish++
  }

  const total = tweets.length
  const sentiment = bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "neutral"
  const strength = Math.abs(bullish - bearish) / total

  return { sentiment, strength, bullish, bearish, total, tweets: tweets.slice(0, 3) }
}

// ── 3. Polymarket Price History & Momentum ─────────────────

/**
 * Get price history for trend analysis
 */
export async function getPriceHistory(tokenId, interval = "1w") {
  try {
    const { data } = await api.get(`https://clob.polymarket.com/prices-history`, {
      params: { market: tokenId, interval, fidelity: 50 },
      timeout: RESEARCH_TIMEOUT,
    })

    if (!data?.history?.length) return null

    const prices = data.history.map(p => ({ time: p.t, price: parseFloat(p.p) }))
    const recent = prices.slice(-10)
    const oldest = recent[0]?.price || 0
    const latest = recent[recent.length - 1]?.price || 0

    // Momentum: how much has price moved recently
    const momentum = oldest > 0 ? (latest - oldest) / oldest : 0
    // Volatility: standard deviation of recent prices
    const mean = recent.reduce((s, p) => s + p.price, 0) / recent.length
    const variance = recent.reduce((s, p) => s + (p.price - mean) ** 2, 0) / recent.length
    const volatility = Math.sqrt(variance)

    // Trend: linear regression slope
    const n = recent.length
    const xMean = (n - 1) / 2
    const slope = recent.reduce((s, p, i) => s + (i - xMean) * (p.price - mean), 0) /
      recent.reduce((s, _, i) => s + (i - xMean) ** 2, 0)

    return {
      prices,
      latest,
      oldest,
      momentum, // +0.1 = price up 10% recently
      volatility,
      trend: slope > 0.002 ? "up" : slope < -0.002 ? "down" : "flat",
      trendStrength: Math.abs(slope),
      dataPoints: prices.length,
    }
  } catch (err) {
    console.error(`[RESEARCHER] Price history failed: ${err.message}`)
    return null
  }
}

/**
 * Get recent trade activity (whale detection + volume analysis)
 */
export async function getRecentTrades(tokenId, limit = 20) {
  try {
    const { data } = await api.get(`https://clob.polymarket.com/trades`, {
      params: { asset_id: tokenId, limit },
      timeout: RESEARCH_TIMEOUT,
    })

    if (!Array.isArray(data) || data.length === 0) return null

    const trades = data.map(t => ({
      price: parseFloat(t.price),
      size: parseFloat(t.size),
      side: t.side,
      timestamp: t.match_time || t.timestamp,
    }))

    const totalVolume = trades.reduce((s, t) => s + t.size, 0)
    const buyVolume = trades.filter(t => t.side === "BUY").reduce((s, t) => s + t.size, 0)
    const avgSize = totalVolume / trades.length
    const largeTrades = trades.filter(t => t.size > avgSize * 3) // 3x average = notable

    return {
      tradeCount: trades.length,
      totalVolume,
      buyPressure: totalVolume > 0 ? buyVolume / totalVolume : 0.5,
      avgSize,
      largeTrades: largeTrades.length,
      largeTradeVolume: largeTrades.reduce((s, t) => s + t.size, 0),
      recentDirection: buyVolume > totalVolume * 0.6 ? "buying" : buyVolume < totalVolume * 0.4 ? "selling" : "balanced",
    }
  } catch {
    return null
  }
}

// ── 4. Sports Intelligence (ESPN + Odds API) ───────────────

const ESPN_SPORTS = {
  nhl: "hockey/nhl",
  nfl: "football/nfl",
  nba: "basketball/nba",
  mlb: "baseball/mlb",
  soccer: "soccer/eng.1", // Premier League
  mma: "mma/ufc",
}

/**
 * Get sports scores and schedule from ESPN (free, no auth)
 */
export async function getSportsContext(sportKey) {
  try {
    const espnPath = ESPN_SPORTS[sportKey]
    if (!espnPath) return null

    const { data } = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard`,
      { timeout: RESEARCH_TIMEOUT },
    )

    const events = (data.events || []).map(e => ({
      name: e.name,
      shortName: e.shortName,
      status: e.status?.type?.description,
      startDate: e.date,
      competitors: (e.competitions?.[0]?.competitors || []).map(c => ({
        team: c.team?.displayName,
        abbreviation: c.team?.abbreviation,
        score: c.score,
        homeAway: c.homeAway,
        winner: c.winner,
        record: c.records?.[0]?.summary,
      })),
    }))

    return { sport: sportKey, events }
  } catch {
    return null
  }
}

/**
 * Compare Polymarket odds vs real sportsbook odds
 * Returns edge if Polymarket is mispriced vs sharp books
 */
export async function getSportsOdds(sportKey, teamName) {
  if (!ODDS_API_KEY) return null

  try {
    // Map common names to odds-api sport keys
    const oddsApiSport = {
      nhl: "icehockey_nhl",
      nfl: "americanfootball_nfl",
      nba: "basketball_nba",
      mlb: "baseball_mlb",
      soccer: "soccer_epl",
    }[sportKey]

    if (!oddsApiSport) return null

    const { data } = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/odds/`,
      {
        params: { apiKey: ODDS_API_KEY, regions: "us", markets: "h2h", oddsFormat: "decimal" },
        timeout: RESEARCH_TIMEOUT,
      },
    )

    // Find the game matching our team
    for (const game of data) {
      const matchesTeam = game.home_team?.toLowerCase().includes(teamName.toLowerCase()) ||
        game.away_team?.toLowerCase().includes(teamName.toLowerCase())

      if (!matchesTeam) continue

      // Get Pinnacle odds (sharpest book)
      const pinnacle = game.bookmakers?.find(b => b.key === "pinnacle")
      const consensus = game.bookmakers?.[0] // First available
      const book = pinnacle || consensus

      if (!book) continue

      const outcomes = book.markets?.[0]?.outcomes || []
      const teamOdds = outcomes.find(o => o.name.toLowerCase().includes(teamName.toLowerCase()))

      if (teamOdds) {
        const impliedProb = 1 / teamOdds.price // Decimal odds → probability
        return {
          team: teamOdds.name,
          decimalOdds: teamOdds.price,
          impliedProbability: impliedProb,
          bookmaker: book.title,
          game: `${game.home_team} vs ${game.away_team}`,
          allOutcomes: outcomes.map(o => ({ name: o.name, odds: o.price, prob: (1 / o.price).toFixed(3) })),
        }
      }
    }

    return null
  } catch (err) {
    console.error(`[RESEARCHER] Odds API failed: ${err.message}`)
    return null
  }
}

// ── 5. Crypto Intelligence ─────────────────────────────────

/**
 * Get crypto market context for crypto-related markets
 */
export async function getCryptoContext(coinId = "bitcoin") {
  try {
    const [priceResp, fngResp] = await Promise.allSettled([
      axios.get(`https://api.coingecko.com/api/v3/simple/price`, {
        params: { ids: coinId, vs_currencies: "usd", include_24hr_change: true, include_24hr_vol: true },
        timeout: RESEARCH_TIMEOUT,
      }),
      axios.get("https://api.alternative.me/fng/?limit=1", { timeout: 5000 }),
    ])

    const price = priceResp.status === "fulfilled" ? priceResp.value.data[coinId] : null
    const fng = fngResp.status === "fulfilled" ? fngResp.value.data.data?.[0] : null

    return {
      coin: coinId,
      price: price?.usd,
      change24h: price?.usd_24h_change,
      volume24h: price?.usd_24h_vol,
      fearGreed: fng ? { value: parseInt(fng.value), label: fng.value_classification } : null,
    }
  } catch {
    return null
  }
}

// ── 6. Unified Research Function ───────────────────────────

/**
 * Research a market from ALL available sources
 * Returns a unified research report that Smart Brain can use
 */
export async function researchMarket(market, category = "other") {
  const question = market.question || ""
  const tokenId = market.outcomes?.[0]?.tokenId
  const report = {
    category,
    sources: [],
    signals: [],
    estimatedEdge: 0,
    confidence: 0,
    researchedAt: new Date().toISOString(),
  }

  // Run all research in parallel (with timeouts)
  const tasks = []

  // Always: web search for context
  tasks.push(
    webSearch(question.slice(0, 50) + " latest", 5)
      .then(results => {
        if (results.length > 0) {
          report.sources.push({ type: "web", count: results.length })
          report.webResults = results.slice(0, 3)
        }
      })
      .catch(() => {}),
  )

  // Always: social sentiment (Twitter + Reddit)
  tasks.push(
    getSocialSentiment(question)
      .then(sentiment => {
        if (sentiment.total > 0) {
          report.sources.push({ type: "social", count: sentiment.total })
          report.socialSentiment = sentiment
          if (sentiment.strength >= 0.3) {
            report.signals.push({
              source: "social",
              direction: sentiment.sentiment,
              strength: sentiment.strength,
              detail: `Social: ${sentiment.bullish}B/${sentiment.bearish}R (${sentiment.total} posts)`,
            })
          }
        }
      })
      .catch(() => {}),
  )

  // Reddit discussion
  tasks.push(
    searchReddit(question.slice(0, 40), 5)
      .then(posts => {
        if (posts.length > 0) {
          report.sources.push({ type: "reddit", count: posts.length })
          report.redditPosts = posts.slice(0, 3)
          // High-engagement Reddit = market attention = potential for quick moves
          const totalEngagement = posts.reduce((s, p) => s + p.score + p.comments, 0)
          if (totalEngagement > 50) {
            report.signals.push({
              source: "reddit",
              direction: "neutral", // Reddit engagement doesn't give direction directly
              strength: Math.min(1, totalEngagement / 200),
              detail: `Reddit: ${posts.length} posts, ${totalEngagement} engagement (${posts[0]?.subreddit})`,
            })
          }
        }
      })
      .catch(() => {}),
  )

  // If has token: price history + trade activity
  if (tokenId) {
    tasks.push(
      getPriceHistory(tokenId)
        .then(history => {
          if (history) {
            report.sources.push({ type: "price_history", dataPoints: history.dataPoints })
            report.priceHistory = history
            if (Math.abs(history.momentum) > 0.05) {
              report.signals.push({
                source: "momentum",
                direction: history.momentum > 0 ? "bullish" : "bearish",
                strength: Math.min(1, Math.abs(history.momentum) * 5),
                detail: `Price ${history.trend} ${(history.momentum * 100).toFixed(1)}% recently`,
              })
            }
          }
        })
        .catch(() => {}),
    )

    tasks.push(
      getRecentTrades(tokenId)
        .then(trades => {
          if (trades) {
            report.sources.push({ type: "trades", count: trades.tradeCount })
            report.recentTrades = trades
            if (Math.abs(trades.buyPressure - 0.5) > 0.15) {
              report.signals.push({
                source: "trade_flow",
                direction: trades.recentDirection === "buying" ? "bullish" : "bearish",
                strength: Math.abs(trades.buyPressure - 0.5) * 2,
                detail: `${(trades.buyPressure * 100).toFixed(0)}% buy pressure, ${trades.largeTrades} large trades`,
              })
            }
          }
        })
        .catch(() => {}),
    )
  }

  // Category-specific research
  if (category === "sports") {
    // Detect sport type from question
    const sportKey = detectSport(question)
    const teamName = extractTeamName(question)

    if (sportKey) {
      tasks.push(
        getSportsContext(sportKey)
          .then(ctx => {
            if (ctx?.events?.length > 0) {
              report.sources.push({ type: "espn", events: ctx.events.length })
              report.sportsContext = ctx
            }
          })
          .catch(() => {}),
      )

      if (teamName && ODDS_API_KEY) {
        tasks.push(
          getSportsOdds(sportKey, teamName)
            .then(odds => {
              if (odds) {
                report.sources.push({ type: "sportsbook_odds", bookmaker: odds.bookmaker })
                report.sportsbookOdds = odds

                // Compare sportsbook implied prob vs Polymarket price
                const pmPrice = market.outcomes?.[0]?.price || 0.5
                const edge = odds.impliedProbability - pmPrice
                if (Math.abs(edge) > 0.05) {
                  report.signals.push({
                    source: "odds_comparison",
                    direction: edge > 0 ? "bullish" : "bearish",
                    strength: Math.min(1, Math.abs(edge) * 5),
                    detail: `Sportsbook: ${(odds.impliedProbability * 100).toFixed(0)}% vs PM: ${(pmPrice * 100).toFixed(0)}% (${(edge * 100).toFixed(1)}% edge)`,
                  })
                }
              }
            })
            .catch(() => {}),
        )
      }
    }
  }

  if (category === "crypto") {
    const coin = question.toLowerCase().includes("bitcoin") ? "bitcoin" :
      question.toLowerCase().includes("ethereum") ? "ethereum" :
        question.toLowerCase().includes("solana") ? "solana" : "bitcoin"

    tasks.push(
      getCryptoContext(coin)
        .then(ctx => {
          if (ctx) {
            report.sources.push({ type: "crypto", coin })
            report.cryptoContext = ctx
            // Strong move context
            if (ctx.change24h && Math.abs(ctx.change24h) > 5) {
              report.signals.push({
                source: "crypto_price",
                direction: ctx.change24h > 0 ? "bullish" : "bearish",
                strength: Math.min(1, Math.abs(ctx.change24h) / 20),
                detail: `${coin} ${ctx.change24h > 0 ? "+" : ""}${ctx.change24h.toFixed(1)}% 24h | F&G: ${ctx.fearGreed?.value || "?"} (${ctx.fearGreed?.label || "?"})`,
              })
            }
          }
        })
        .catch(() => {}),
    )
  }

  // Wait for all research to complete
  await Promise.allSettled(tasks)

  // Calculate overall signal
  const bullishSignals = report.signals.filter(s => s.direction === "bullish")
  const bearishSignals = report.signals.filter(s => s.direction === "bearish")
  const bullishStrength = bullishSignals.reduce((s, sig) => s + sig.strength, 0)
  const bearishStrength = bearishSignals.reduce((s, sig) => s + sig.strength, 0)

  report.overallDirection = bullishStrength > bearishStrength ? "bullish" : bearishStrength > bullishStrength ? "bearish" : "neutral"
  report.confidence = Math.min(1, (bullishStrength + bearishStrength) / report.signals.length || 0)
  report.estimatedEdge = (bullishStrength - bearishStrength) / Math.max(report.signals.length, 1) * 0.1

  return report
}

// ── Helpers ────────────────────────────────────────────────

function detectSport(question) {
  const q = question.toLowerCase()
  if (/\bnhl\b|hockey|stanley\s+cup/.test(q)) return "nhl"
  if (/\bnfl\b|football|super\s+bowl/.test(q)) return "nfl"
  if (/\bnba\b|basketball/.test(q)) return "nba"
  if (/\bmlb\b|baseball|world\s+series/.test(q)) return "mlb"
  if (/premier\s+league|la\s+liga|bundesliga|serie\s+a|champions\s+league|soccer|football.*vs/.test(q)) return "soccer"
  if (/\bufc\b|mma|boxing/.test(q)) return "mma"
  // Generic "X vs Y" — try NHL first (most common on Polymarket)
  if (/\bvs\.?\b/.test(q)) return "nhl"
  return null
}

function extractTeamName(question) {
  // "Devils vs. Hurricanes" → "Devils"
  const match = question.match(/^([A-Z][a-zA-Z\s]+?)\s+vs\.?\s+/i)
  return match?.[1]?.trim() || null
}

export default {
  webSearch,
  searchTwitter,
  getSocialSentiment,
  getPriceHistory,
  getRecentTrades,
  getSportsContext,
  getSportsOdds,
  getCryptoContext,
  researchMarket,
}
