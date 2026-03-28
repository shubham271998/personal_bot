/**
 * User Manager — Multi-tenant user management
 *
 * Each user connects their own Claude (Anthropic API key).
 * Tracks per-user usage, sessions, and spending.
 * Persists to data/users.json
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import crypto from "crypto"
import { encryptSecure, decryptSecure } from "./security.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const USERS_FILE = path.resolve(__dirname, "../data/users.json")

// Encryption master key — MUST be set via env in production
const MASTER_KEY = process.env.USER_ENCRYPT_KEY || crypto.randomBytes(32).toString("hex")
if (!process.env.USER_ENCRYPT_KEY) {
  console.warn("[USER-MGR] ⚠️  USER_ENCRYPT_KEY not set — using random key (API keys won't persist across restarts!)")
}

function encrypt(text) {
  return encryptSecure(text, MASTER_KEY)
}

function decrypt(text) {
  return decryptSecure(text, MASTER_KEY)
}

/**
 * User record:
 * {
 *   telegramId: number,
 *   username: string,
 *   firstName: string,
 *   apiKey: string (encrypted),
 *   registeredAt: string (ISO),
 *   lastActiveAt: string (ISO),
 *   isApproved: boolean,
 *   isAdmin: boolean,
 *   usage: {
 *     totalSessions: number,
 *     totalCostUsd: number,
 *     totalInputTokens: number,
 *     totalOutputTokens: number,
 *     totalCacheTokens: number,
 *     dailyCostUsd: { [date]: number },
 *     lastSessionAt: string,
 *   }
 * }
 */

class UserManager {
  constructor() {
    this.users = new Map()
    this._load()
  }

  _load() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"))
        for (const user of data) {
          this.users.set(user.telegramId, user)
        }
      }
    } catch {
      console.error("[USER-MGR] Failed to load users file")
    }
  }

  _save() {
    try {
      const dir = path.dirname(USERS_FILE)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(USERS_FILE, JSON.stringify([...this.users.values()], null, 2))
    } catch (err) {
      console.error("[USER-MGR] Failed to save:", err.message)
    }
  }

  /**
   * Check if a user exists
   */
  exists(telegramId) {
    return this.users.has(telegramId)
  }

  /**
   * Get user record
   */
  get(telegramId) {
    return this.users.get(telegramId) || null
  }

  /**
   * Check if user has set up their API key
   */
  hasApiKey(telegramId) {
    const user = this.users.get(telegramId)
    return user?.apiKey ? true : false
  }

  /**
   * Get decrypted API key for a user
   */
  getApiKey(telegramId) {
    const user = this.users.get(telegramId)
    if (!user?.apiKey) return null
    return decrypt(user.apiKey)
  }

  /**
   * Register a new user (or update existing)
   */
  register(telegramId, { username, firstName }) {
    let user = this.users.get(telegramId)
    if (user) {
      user.username = username || user.username
      user.firstName = firstName || user.firstName
      user.lastActiveAt = new Date().toISOString()
    } else {
      user = {
        telegramId,
        username: username || "",
        firstName: firstName || "",
        apiKey: null,
        registeredAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        isApproved: false,
        isAdmin: false,
        usage: {
          totalSessions: 0,
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheTokens: 0,
          dailyCostUsd: {},
          lastSessionAt: null,
        },
      }
      this.users.set(telegramId, user)
    }
    this._save()
    return user
  }

  /**
   * Set API key for a user
   */
  setApiKey(telegramId, apiKey) {
    const user = this.users.get(telegramId)
    if (!user) return false
    user.apiKey = encrypt(apiKey)
    this._save()
    return true
  }

  /**
   * Remove API key
   */
  removeApiKey(telegramId) {
    const user = this.users.get(telegramId)
    if (!user) return false
    user.apiKey = null
    this._save()
    return true
  }

  /**
   * Approve a user (admin action)
   */
  approve(telegramId) {
    const user = this.users.get(telegramId)
    if (!user) return false
    user.isApproved = true
    this._save()
    return true
  }

  /**
   * Block a user (admin action)
   */
  block(telegramId) {
    const user = this.users.get(telegramId)
    if (!user) return false
    user.isApproved = false
    this._save()
    return true
  }

  /**
   * Set admin flag — ONLY callable internally, never from user commands.
   * Admin is locked to ALLOWED_TELEGRAM_IDS in .env
   */
  setAdmin(telegramId, isAdmin = true) {
    const user = this.users.get(telegramId)
    if (!user) return false
    user.isAdmin = isAdmin
    this._save()
    return true
  }

  /**
   * Check if user is admin (admins are ONLY from ALLOWED_TELEGRAM_IDS)
   */
  isAdmin(telegramId) {
    const allowedIds = (process.env.ALLOWED_TELEGRAM_IDS || "")
      .split(",").map(Number).filter(Boolean)
    return allowedIds.includes(telegramId)
  }

  /**
   * Record usage from a Claude session
   */
  recordUsage(telegramId, meta) {
    const user = this.users.get(telegramId)
    if (!user || !meta) return

    const today = new Date().toISOString().split("T")[0]

    user.usage.totalSessions++
    user.usage.totalCostUsd += meta.costUsd || 0
    user.usage.totalInputTokens += meta.usage?.inputTokens || 0
    user.usage.totalOutputTokens += meta.usage?.outputTokens || 0
    user.usage.totalCacheTokens += (meta.usage?.cacheReadTokens || 0) + (meta.usage?.cacheCreationTokens || 0)
    user.usage.lastSessionAt = new Date().toISOString()

    if (!user.usage.dailyCostUsd[today]) user.usage.dailyCostUsd[today] = 0
    user.usage.dailyCostUsd[today] += meta.costUsd || 0

    user.lastActiveAt = new Date().toISOString()

    // Keep only last 30 days of daily cost
    const keys = Object.keys(user.usage.dailyCostUsd).sort()
    if (keys.length > 30) {
      for (const key of keys.slice(0, keys.length - 30)) {
        delete user.usage.dailyCostUsd[key]
      }
    }

    this._save()
  }

  /**
   * Get usage summary for a user
   */
  getUsageSummary(telegramId) {
    const user = this.users.get(telegramId)
    if (!user) return null

    const today = new Date().toISOString().split("T")[0]
    const u = user.usage

    return {
      totalSessions: u.totalSessions,
      totalCostUsd: u.totalCostUsd,
      todayCostUsd: u.dailyCostUsd[today] || 0,
      totalInputTokens: u.totalInputTokens,
      totalOutputTokens: u.totalOutputTokens,
      totalCacheTokens: u.totalCacheTokens,
      lastSessionAt: u.lastSessionAt,
      avgCostPerSession: u.totalSessions > 0 ? u.totalCostUsd / u.totalSessions : 0,
    }
  }

  /**
   * List all users (admin)
   */
  listAll() {
    return [...this.users.values()].map((u) => ({
      telegramId: u.telegramId,
      username: u.username,
      firstName: u.firstName,
      isApproved: u.isApproved,
      isAdmin: u.isAdmin,
      hasKey: !!u.apiKey,
      totalSessions: u.usage.totalSessions,
      totalCostUsd: u.usage.totalCostUsd,
      lastActiveAt: u.lastActiveAt,
    }))
  }
}

const userManager = new UserManager()
export default userManager
