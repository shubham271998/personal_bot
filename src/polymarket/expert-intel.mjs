/**
 * Expert Intelligence — Mine opinions from YouTube, podcasts, Twitter experts
 *
 * The edge: markets move on EXPERT OPINIONS before data arrives.
 * When Nate Silver tweets, when a YouTube analyst publishes, when a podcast
 * discusses a market — prices follow within minutes to hours.
 *
 * Sources:
 *   1. YouTube transcripts — free via innertube API (no key needed)
 *   2. Expert Twitter/X accounts — key Polymarket influencers
 *   3. Podcast RSS feeds — analysis shows, prediction market pods
 *   4. Polymarket comment activity — community consensus
 *
 * This feeds into the research daemon for Claude CLI to analyze.
 */
import axios from "axios"

const RESEARCH_TIMEOUT = 10000

// ── Key expert accounts whose opinions move markets ────────
const EXPERT_TWITTER_ACCOUNTS = [
  "NateSilver538",      // Polymarket advisor, superforecaster
  "Polymarket",         // Official account — announces resolutions
  "DustinMoskovitz",    // Major Polymarket investor
  "elikibaek",          // Polymarket founder
  "StarSpangledGambler",// Popular PM trader/analyst
  "MattGlassman312",    // Political analyst
  "Saborite",           // Polymarket whale
  "PredictIt",          // Competing platform — shows divergence
  "TheStalwart",        // Bloomberg/finance, covers PM
  "NateSilver",         // Personal account
]

// YouTube channels that regularly analyze prediction markets
const YOUTUBE_SEARCH_QUERIES = [
  "polymarket analysis today",
  "prediction market breakdown",
  "polymarket odds explained",
]

// Podcast RSS feeds covering prediction markets
const PODCAST_FEEDS = [
  { name: "Risky Business (Nate Silver)", url: "https://feeds.megaphone.fm/riskybusiness" },
  { name: "Odd Lots (Bloomberg)", url: "https://feeds.bloomberg.com/podcasts/etf-report" },
]

// ── 1. YouTube Transcript Mining ───────────────────────────

/**
 * Search YouTube for recent videos about a topic and get transcripts
 * Uses YouTube's innertube API (no key needed) for search
 * Uses timedtext API for transcripts (no key needed)
 */
export async function searchYouTubeVideos(query, limit = 3) {
  try {
    // YouTube search via innertube (same as browser uses)
    const { data } = await axios.post("https://www.youtube.com/youtubei/v1/search", {
      context: {
        client: { clientName: "WEB", clientVersion: "2.20240101", hl: "en", gl: "US" },
      },
      query: query,
    }, {
      headers: { "Content-Type": "application/json" },
      timeout: RESEARCH_TIMEOUT,
    })

    const results = []
    // Parse innertube response
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || []
    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents || []
      for (const item of items) {
        const video = item?.videoRenderer
        if (!video) continue
        results.push({
          videoId: video.videoId,
          title: video.title?.runs?.[0]?.text || "",
          channel: video.ownerText?.runs?.[0]?.text || "",
          views: video.viewCountText?.simpleText || "",
          published: video.publishedTimeText?.simpleText || "",
          lengthText: video.lengthText?.simpleText || "",
        })
        if (results.length >= limit) break
      }
      if (results.length >= limit) break
    }

    return results
  } catch (err) {
    console.error(`[EXPERT] YouTube search failed: ${err.message}`)
    return []
  }
}

/**
 * Get transcript for a YouTube video (no API key needed)
 * Uses YouTube's timedtext endpoint
 */
export async function getYouTubeTranscript(videoId) {
  try {
    // First get the video page to extract caption track URL
    const { data: pageHtml } = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      timeout: RESEARCH_TIMEOUT,
    })

    // Extract captions URL from page data
    const captionMatch = pageHtml.match(/"captionTracks":\[(.+?)\]/)
    if (!captionMatch) return null

    const captionData = JSON.parse(`[${captionMatch[1]}]`)
    const englishTrack = captionData.find(t => t.languageCode === "en") || captionData[0]
    if (!englishTrack?.baseUrl) return null

    // Fetch the transcript
    const { data: transcriptXml } = await axios.get(englishTrack.baseUrl, { timeout: RESEARCH_TIMEOUT })

    // Parse XML transcript
    const segments = []
    const matches = transcriptXml.matchAll(/<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)
    for (const match of matches) {
      segments.push({
        start: parseFloat(match[1]),
        text: match[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      })
    }

    // Combine into readable text (first 3000 chars — enough for analysis)
    const fullText = segments.map(s => s.text).join(" ").slice(0, 3000)
    return {
      videoId,
      transcript: fullText,
      segmentCount: segments.length,
      durationMinutes: segments.length > 0 ? Math.round(segments[segments.length - 1].start / 60) : 0,
    }
  } catch (err) {
    console.error(`[EXPERT] Transcript failed for ${videoId}: ${err.message}`)
    return null
  }
}

/**
 * Search YouTube for analysis on a specific market topic and extract key opinions
 */
export async function getYouTubeOpinions(marketQuestion, limit = 2) {
  const shortQuery = marketQuestion.slice(0, 40) + " analysis prediction"
  const videos = await searchYouTubeVideos(shortQuery, limit)
  const opinions = []

  for (const video of videos) {
    const transcript = await getYouTubeTranscript(video.videoId)
    if (transcript && transcript.transcript.length > 100) {
      opinions.push({
        source: `YouTube: ${video.channel}`,
        title: video.title,
        videoId: video.videoId,
        views: video.views,
        published: video.published,
        // First 2000 chars of transcript — enough for Claude to analyze
        transcript: transcript.transcript.slice(0, 2000),
        durationMinutes: transcript.durationMinutes,
      })
    }
    // Rate limit YouTube requests
    await new Promise(r => setTimeout(r, 1000))
  }

  return opinions
}

// ── 2. Expert Twitter Monitoring ───────────────────────────

/**
 * Get recent posts from key Polymarket experts via web search
 * (Can't access Twitter API directly without auth)
 */
export async function getExpertTweets(topic, limit = 5) {
  const experts = EXPERT_TWITTER_ACCOUNTS.slice(0, 5).join(" OR from:")
  try {
    // Search for expert tweets about this topic via web
    const { data } = await axios.get("https://news.google.com/rss/search", {
      params: {
        q: `${topic.slice(0, 30)} (${EXPERT_TWITTER_ACCOUNTS.slice(0, 3).join(" OR ")}) site:x.com OR site:twitter.com`,
        hl: "en-US", gl: "US", ceid: "US:en",
      },
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/rss+xml",
      },
      timeout: RESEARCH_TIMEOUT,
    })

    const tweets = []
    const items = data.matchAll(/<item>([\s\S]*?)<\/item>/g)
    for (const match of items) {
      const title = match[1].match(/<title>(.*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, "$1") || ""
      if (title) tweets.push({ text: title, source: "expert_twitter" })
      if (tweets.length >= limit) break
    }
    return tweets
  } catch {
    return []
  }
}

// ── 3. Polymarket Comment Activity ─────────────────────────

/**
 * Get market engagement metrics — high comments = information flow
 * Uses Gamma API market data which includes comment counts
 */
export async function getMarketEngagement(marketSlug) {
  try {
    const api = (await import("./api-client.mjs")).default
    const { data } = await api.get(`https://gamma-api.polymarket.com/markets?slug=${marketSlug}`, {
      timeout: RESEARCH_TIMEOUT,
    })

    const market = data?.[0]
    if (!market) return null

    return {
      commentCount: market.commentCount || 0,
      liquidity: market.liquidityNum || 0,
      volume: market.volumeNum || 0,
      // High engagement signals: lots of discussion = potential information edge
      engagementScore: Math.min(1, (market.commentCount || 0) / 100),
      isHotMarket: (market.commentCount || 0) > 50 || (market.volume24hr || 0) > 500000,
    }
  } catch {
    return null
  }
}

// ── 4. Unified Expert Intelligence ─────────────────────────

/**
 * Gather ALL expert intelligence for a market topic
 * Returns structured data for Claude CLI to analyze
 */
export async function gatherExpertIntel(marketQuestion, category = "other") {
  const intel = {
    youtube: [],
    expertTweets: [],
    engagement: null,
    sources: 0,
    summary: "",
  }

  const tasks = []

  // YouTube opinions (most valuable — full analysis with reasoning)
  tasks.push(
    getYouTubeOpinions(marketQuestion, 2)
      .then(opinions => {
        intel.youtube = opinions
        intel.sources += opinions.length
      })
      .catch(() => {}),
  )

  // Expert tweets
  tasks.push(
    getExpertTweets(marketQuestion, 5)
      .then(tweets => {
        intel.expertTweets = tweets
        intel.sources += tweets.length
      })
      .catch(() => {}),
  )

  await Promise.allSettled(tasks)

  // Build summary for Claude
  let summary = ""
  if (intel.youtube.length > 0) {
    summary += "\n\nYouTube expert analysis:\n"
    for (const yt of intel.youtube) {
      summary += `- ${yt.source} "${yt.title}" (${yt.views}, ${yt.published}):\n`
      summary += `  ${yt.transcript.slice(0, 500)}...\n`
    }
  }
  if (intel.expertTweets.length > 0) {
    summary += "\n\nExpert tweets:\n"
    for (const t of intel.expertTweets) {
      summary += `- ${t.text}\n`
    }
  }
  intel.summary = summary

  return intel
}

export default {
  searchYouTubeVideos,
  getYouTubeTranscript,
  getYouTubeOpinions,
  getExpertTweets,
  getMarketEngagement,
  gatherExpertIntel,
}
