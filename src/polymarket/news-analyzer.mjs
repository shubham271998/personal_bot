/**
 * News Analyzer for Polymarket Edge Detection
 *
 * Fetches real-time news and compares sentiment with market odds
 * to find mispricings before the market catches up.
 */
import axios from "axios"

const NEWS_SOURCES = [
  { name: "Google News", url: "https://news.google.com/rss/search?q=" },
]

/**
 * Search news for a topic and extract key signals
 * Uses Google News RSS as a free source
 */
export async function searchNews(query, limit = 5) {
  try {
    const encoded = encodeURIComponent(query)
    const { data } = await axios.get(
      `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`,
      { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } },
    )

    // Parse RSS XML simply
    const items = []
    const matches = data.matchAll(/<item>([\s\S]*?)<\/item>/g)
    for (const match of matches) {
      const xml = match[1]
      const title = xml.match(/<title>(.*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, "$1") || ""
      const link = xml.match(/<link>(.*?)<\/link>/)?.[1] || xml.match(/<link\/>(.*?)(?=<)/)?.[1] || ""
      const pubDate = xml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || ""
      const source = xml.match(/<source.*?>(.*?)<\/source>/)?.[1] || ""

      if (title) {
        items.push({ title, link, pubDate, source })
      }
      if (items.length >= limit) break
    }

    return items
  } catch (err) {
    console.error(`News search failed: ${err.message}`)
    return []
  }
}

/**
 * Analyze sentiment of headlines for a market question
 * Returns: { bullish, bearish, neutral, headlines }
 */
export function analyzeSentiment(headlines, yesOutcome) {
  const positiveWords = ["wins", "leads", "ahead", "likely", "confirms", "passes", "approved", "agrees",
    "victory", "succeeds", "gains", "rises", "surges", "breaks", "deal", "signed", "yes",
    "will", "expected", "certain", "announces", "launches", "accepts"]
  const negativeWords = ["loses", "fails", "behind", "unlikely", "rejects", "blocked", "denied",
    "defeat", "drops", "falls", "crashes", "no", "won't", "cancels", "delays", "stalls",
    "opposes", "refuses", "collapses", "impossible"]

  let bullish = 0
  let bearish = 0
  let neutral = 0

  for (const h of headlines) {
    const lower = h.title.toLowerCase()
    const posHits = positiveWords.filter((w) => lower.includes(w)).length
    const negHits = negativeWords.filter((w) => lower.includes(w)).length

    if (posHits > negHits) bullish++
    else if (negHits > posHits) bearish++
    else neutral++
  }

  const total = headlines.length || 1
  return {
    bullish,
    bearish,
    neutral,
    bullishPct: bullish / total,
    bearishPct: bearish / total,
    sentiment: bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "neutral",
    headlines: headlines.slice(0, 5),
  }
}

/**
 * Compare news sentiment with market price to find edges
 */
export function findNewsEdge(market, sentiment) {
  const yesPrice = market.outcomes[0]?.price || 0.5

  // If news is bullish but market says low probability → potential buy
  if (sentiment.sentiment === "bullish" && yesPrice < 0.4) {
    return {
      direction: "BUY_YES",
      confidence: Math.min(0.9, sentiment.bullishPct * 1.5),
      reason: `News is bullish (${sentiment.bullish}/${sentiment.bullish + sentiment.bearish + sentiment.neutral} positive headlines) but market only at ${(yesPrice * 100).toFixed(0)}%`,
    }
  }

  // If news is bearish but market says high probability → potential buy NO
  if (sentiment.sentiment === "bearish" && yesPrice > 0.6) {
    return {
      direction: "BUY_NO",
      confidence: Math.min(0.9, sentiment.bearishPct * 1.5),
      reason: `News is bearish (${sentiment.bearish} negative headlines) but market at ${(yesPrice * 100).toFixed(0)}%`,
    }
  }

  return null
}

export default { searchNews, analyzeSentiment, findNewsEdge }
