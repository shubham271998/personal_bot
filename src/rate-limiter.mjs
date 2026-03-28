/**
 * Per-user sliding window rate limiter
 */
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 10

const userWindows = new Map() // userId -> timestamp[]

export function checkRateLimit(userId) {
  const now = Date.now()
  const cutoff = now - WINDOW_MS

  if (!userWindows.has(userId)) userWindows.set(userId, [])
  const timestamps = userWindows.get(userId).filter((t) => t > cutoff)
  userWindows.set(userId, timestamps)

  if (timestamps.length >= MAX_REQUESTS) {
    const oldest = timestamps[0]
    const resetMs = oldest + WINDOW_MS - now
    return { allowed: false, remaining: 0, resetMs }
  }

  timestamps.push(now)
  return { allowed: true, remaining: MAX_REQUESTS - timestamps.length, resetMs: 0 }
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2
  for (const [userId, timestamps] of userWindows) {
    const filtered = timestamps.filter((t) => t > cutoff)
    if (filtered.length === 0) userWindows.delete(userId)
    else userWindows.set(userId, filtered)
  }
}, 300000)
