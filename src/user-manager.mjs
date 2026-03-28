/**
 * User Manager — Multi-tenant user management backed by SQLite
 *
 * Auth methods:
 *   1. "api_key" — User provides their Anthropic API key
 *   2. "claude_login" — User logs in via Anthropic email (validated via SDK)
 *
 * All API keys encrypted at rest. Admin is ONLY ALLOWED_TELEGRAM_IDS.
 */
import crypto from "crypto"
import db from "./database.mjs"
import { encryptSecure, decryptSecure, isValidApiKeyFormat } from "./security.mjs"

const MASTER_KEY = process.env.USER_ENCRYPT_KEY || crypto.randomBytes(32).toString("hex")
if (!process.env.USER_ENCRYPT_KEY) {
  console.warn("[USER-MGR] ⚠️  USER_ENCRYPT_KEY not set — using random key (API keys won't persist across restarts!)")
}

const ADMIN_IDS = (process.env.ALLOWED_TELEGRAM_IDS || "")
  .split(",").map(Number).filter(Boolean)

class UserManager {
  /**
   * Register or update a user
   */
  register(telegramId, { username, firstName } = {}) {
    db.upsertUser(telegramId, username, firstName)
    return db.getUser(telegramId)
  }

  /**
   * Check if user exists
   */
  exists(telegramId) {
    return !!db.getUser(telegramId)
  }

  /**
   * Get user record
   */
  get(telegramId) {
    return db.getUser(telegramId)
  }

  /**
   * Check if user has API key set
   */
  hasApiKey(telegramId) {
    return db.hasApiKey(telegramId)
  }

  /**
   * Get decrypted API key
   */
  getApiKey(telegramId) {
    const encrypted = db.getApiKey(telegramId)
    if (!encrypted) return null
    db.touchApiKey(telegramId)
    return decryptSecure(encrypted, MASTER_KEY)
  }

  /**
   * Set API key (encrypts before storing)
   */
  setApiKey(telegramId, apiKey) {
    const encrypted = encryptSecure(apiKey, MASTER_KEY)
    db.setApiKey(telegramId, encrypted)
    db.setAuthMethod(telegramId, "api_key")
    return true
  }

  /**
   * Set API key from Claude login flow (same storage, different auth_method)
   */
  setApiKeyFromLogin(telegramId, apiKey) {
    const encrypted = encryptSecure(apiKey, MASTER_KEY)
    db.setApiKey(telegramId, encrypted)
    db.setAuthMethod(telegramId, "claude_login")
    return true
  }

  /**
   * Remove API key
   */
  removeApiKey(telegramId) {
    db.deleteApiKey(telegramId)
    db.setAuthMethod(telegramId, "none")
    return true
  }

  /**
   * Approve a user
   */
  approve(telegramId) {
    return db.approveUser(telegramId)
  }

  /**
   * Block a user
   */
  block(telegramId) {
    return db.blockUser(telegramId)
  }

  /**
   * Check if user is admin (ONLY from ALLOWED_TELEGRAM_IDS — nobody else, ever)
   */
  isAdmin(telegramId) {
    return ADMIN_IDS.includes(telegramId)
  }

  /**
   * Record session usage
   */
  recordUsage(telegramId, meta) {
    if (!meta) return
    db.recordSession(telegramId, {
      project: meta.projectName || "default",
      prompt: meta.prompt || "",
      responseLen: meta.responseLen || 0,
      durationMs: meta.durationMs || 0,
      costUsd: meta.costUsd || 0,
      inputTokens: meta.usage?.inputTokens || 0,
      outputTokens: meta.usage?.outputTokens || 0,
      cacheTokens: (meta.usage?.cacheReadTokens || 0) + (meta.usage?.cacheCreationTokens || 0),
      model: meta.model || "unknown",
      status: meta.status || "success",
      error: meta.error || null,
    })
    db.touchUser(telegramId)
  }

  /**
   * Get usage summary for a user
   */
  getUsageSummary(telegramId) {
    return db.getUserUsageSummary(telegramId)
  }

  /**
   * Get daily breakdown
   */
  getDailyBreakdown(telegramId, days = 7) {
    return db.getUserDailyBreakdown(telegramId, days)
  }

  /**
   * Get recent sessions
   */
  getRecentSessions(telegramId, limit = 10) {
    return db.getUserSessions(telegramId, limit)
  }

  /**
   * List all users (admin view)
   */
  listAll() {
    return db.listUsers()
  }

  /**
   * Global stats (admin)
   */
  globalStats() {
    return db.globalStats()
  }
}

const userManager = new UserManager()
export default userManager
