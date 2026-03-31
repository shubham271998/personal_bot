/**
 * Polymarket API Client — Resilient connectivity layer
 *
 * Problem: Polymarket domains are DNS-blocked by some providers (Google DNS in India).
 * Solution: Use Cloudflare DNS resolver + custom axios instance with dns.resolve4 fallback.
 *
 * All Polymarket API calls should go through this module.
 */
import axios from "axios"
import dns from "dns"

// ── Polymarket domains ─────────────────────────────────────
const POLYMARKET_DOMAINS = [
  "gamma-api.polymarket.com",
  "clob.polymarket.com",
  "ws-subscriptions-clob.polymarket.com",
  "ws-live-data.polymarket.com",
]

// ── Cloudflare DNS resolver (bypasses blocked system DNS) ──
const cfResolver = new dns.Resolver()
cfResolver.setServers(["1.1.1.1", "1.0.0.1"])

// ── DNS cache ──────────────────────────────────────────────
const dnsCache = new Map() // domain → { ips, expiry }
const DNS_TTL_MS = 5 * 60 * 1000

async function resolveHost(hostname) {
  const cached = dnsCache.get(hostname)
  if (cached && cached.expiry > Date.now()) return cached.ips[0]

  return new Promise((resolve, reject) => {
    cfResolver.resolve4(hostname, (err, addresses) => {
      if (err || !addresses?.length) return reject(err || new Error("No addresses"))
      dnsCache.set(hostname, { ips: addresses, expiry: Date.now() + DNS_TTL_MS })
      resolve(addresses[0])
    })
  })
}

// ── Core request function with DNS fallback ────────────────

async function polyRequest(config) {
  // First: try direct connection (works if DNS isn't blocked)
  try {
    const resp = await axios({ ...config, timeout: config.timeout || 10000 })
    return resp
  } catch (err) {
    const isDNSError = err.code === "ENOTFOUND" || err.code === "EAI_AGAIN" ||
      err.message?.includes("ENOTFOUND") || err.message?.includes("getaddrinfo")

    if (!isDNSError) throw err // Not a DNS issue, rethrow

    // Second: resolve via Cloudflare DNS, rewrite URL to use IP + Host header
    let url
    try {
      url = new URL(typeof config.url === "string" ? config.url : "")
    } catch {
      throw err
    }
    const hostname = url.hostname
    if (!POLYMARKET_DOMAINS.includes(hostname)) throw err

    try {
      const ip = await resolveHost(hostname)
      // Replace hostname with IP in the URL
      url.hostname = ip
      const resp = await axios({
        ...config,
        url: url.toString(),
        timeout: config.timeout || 15000,
        headers: {
          ...config.headers,
          Host: hostname,
        },
        // Cloudflare accepts IP+Host header requests with proper SNI
      })
      return resp
    } catch (fallbackErr) {
      // Only log unexpected errors (not 401/404 which are expected for some CLOB endpoints via IP)
      const status = fallbackErr.response?.status
      if (!status || (status !== 401 && status !== 404)) {
        console.error(`[API-CLIENT] Fallback failed for ${hostname}: ${fallbackErr.message?.slice(0, 80)}`)
      }
      throw fallbackErr
    }
  }
}

// ── Public API ─────────────────────────────────────────────

export function get(url, config = {}) {
  return polyRequest({ method: "GET", url, ...config })
}

export function post(url, data, config = {}) {
  return polyRequest({ method: "POST", url, data, ...config })
}

export function del(url, config = {}) {
  return polyRequest({ method: "DELETE", url, ...config })
}

/**
 * Pre-warm DNS cache for all Polymarket domains
 */
export async function warmup() {
  console.log("[API-CLIENT] Warming up DNS cache via Cloudflare...")
  let resolved = 0
  for (const domain of POLYMARKET_DOMAINS) {
    try {
      const ip = await resolveHost(domain)
      console.log(`[API-CLIENT] ${domain} → ${ip}`)
      resolved++
    } catch (e) {
      console.error(`[API-CLIENT] Failed to resolve ${domain}: ${e.message}`)
    }
  }
  console.log(`[API-CLIENT] Resolved ${resolved}/${POLYMARKET_DOMAINS.length} domains`)
  return resolved
}

export async function healthCheck() {
  try {
    const resp = await get("https://gamma-api.polymarket.com/markets?limit=1", { timeout: 10000 })
    return { ok: true, status: resp.status }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

export function getCacheStats() {
  const stats = {}
  for (const [domain, { ips, expiry }] of dnsCache) {
    stats[domain] = { ip: ips[0], ttlSeconds: Math.max(0, Math.round((expiry - Date.now()) / 1000)) }
  }
  return stats
}

export default { get, post, del, warmup, healthCheck, getCacheStats }
