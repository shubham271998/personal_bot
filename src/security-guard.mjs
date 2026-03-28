#!/usr/bin/env node

/**
 * Security Guard — Webcam & Screenshot Monitoring
 *
 * Uses InsightFace ONNX (SCRFD + ArcFace) for face-only comparison.
 * Pipeline: Detect face → Align to 112×112 → 512-dim ArcFace embedding → Cosine similarity
 *
 * Monitors keyboard/mouse activity. On activity:
 * 1. Captures webcam photo
 * 2. Detects & compares face with authorized user
 * 3. Sends alert with action buttons if mismatch
 *
 * Requirements (macOS):
 *   brew install imagesnap
 *   Reference photo: data/reference-face.png
 *   Models: models/insightface/ (run scripts/download-face-models.sh)
 */
import "dotenv/config"
import { execSync, spawn } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import faceEngine from "./face-engine.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, "../data")
const REFERENCE_PHOTO = path.join(DATA_DIR, "reference-face.png")
const CAPTURE_PHOTO = path.join(DATA_DIR, "capture-temp.png")
const REFERENCE_SCREEN = path.join(DATA_DIR, "reference-screen.png")
const CAPTURE_SCREEN = path.join(DATA_DIR, "capture-screen-temp.png")

// Config — ArcFace cosine similarity thresholds
// > 0.4 = same person, < 0.3 = definitely different
const SIMILARITY_THRESHOLD = 0.38 // ArcFace cosine threshold (0.4 is strict, 0.35 is lenient)
const CHECK_INTERVAL_MS = 15000   // Check every 15 seconds
const IDLE_THRESHOLD_SEC = 300    // 5 min idle = no checks
const COOLDOWN_AFTER_FAIL_MS = 5000

let lastActivityTime = Date.now()
let isMonitoring = false
let guardInterval = null
let failCount = 0
const MAX_FAILS_BEFORE_SLEEP = 2 // Allow 2 failed checks before sleeping

// Bot instance and chat ID — injected from bot.mjs
let _bot = null
let _chatId = null

/**
 * Set the Telegram bot instance and chat ID for sending alerts
 */
function setBot(bot, chatId) {
  _bot = bot
  _chatId = chatId
  console.log(`Security guard linked to Telegram chat: ${chatId}`)
}

/**
 * Send Telegram text alert
 */
async function sendAlert(message, options = {}) {
  if (!_bot || !_chatId) {
    console.log(`[GUARD] No bot/chatId — skipping alert: ${message}`)
    return
  }
  try {
    return await _bot.sendMessage(_chatId, message, options)
  } catch (err) {
    console.error(`[GUARD] sendAlert failed: ${err.message}`)
  }
}

/**
 * Send security alert with action buttons
 */
async function sendAlertWithActions(photoPath, similarity) {
  if (!_bot || !_chatId) return

  const simPct = typeof similarity === "number"
    ? (similarity * 100).toFixed(1)
    : (similarity.displayPct || 0).toFixed(1)
  const timestamp = new Date().toLocaleTimeString()

  try {
    // Send the intruder photo first
    if (photoPath && fs.existsSync(photoPath)) {
      await _bot.sendPhoto(_chatId, photoPath, {
        caption: `🚨 *INTRUDER DETECTED*\nSimilarity: ${simPct}%\nTime: ${timestamp}\nFail count: ${failCount}/${MAX_FAILS_BEFORE_SLEEP}`,
        parse_mode: "Markdown",
      })
    }

    // Send action buttons
    await _bot.sendMessage(
      _chatId,
      `⚠️ *Unauthorized access detected!*\nWhat do you want to do?`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔴 Shutdown", callback_data: "guard_shutdown" },
              { text: "😴 Sleep", callback_data: "guard_sleep" },
            ],
            [
              { text: "🔒 Lock Screen", callback_data: "guard_lock" },
              { text: "📢 Sound Alarm", callback_data: "guard_alarm" },
            ],
            [
              { text: "✅ It's Me (Dismiss)", callback_data: "guard_dismiss" },
            ],
          ],
        },
      },
    )
  } catch (err) {
    console.error(`[GUARD] sendAlertWithActions failed: ${err.message}`)
  }
}

/**
 * Send photo alert via Telegram
 */
async function sendPhotoAlert(photoPath, caption) {
  if (!_bot || !_chatId) {
    console.log(`[GUARD] No bot/chatId — skipping photo alert`)
    return
  }
  if (!fs.existsSync(photoPath)) {
    console.log(`[GUARD] Photo not found: ${photoPath}`)
    return
  }
  try {
    await _bot.sendPhoto(_chatId, photoPath, { caption })
  } catch (err) {
    console.error(`[GUARD] sendPhoto failed: ${err.message}`)
  }
}

/**
 * Check if user is active (keyboard/mouse activity)
 * Uses macOS ioreg to check HID idle time
 */
function getIdleTimeSec() {
  try {
    const output = execSync(
      'ioreg -c IOHIDSystem | awk \'/HIDIdleTime/ {print int($NF/1000000000); exit}\'',
      { encoding: "utf-8", timeout: 5000 },
    )
    return parseInt(output.trim()) || 0
  } catch {
    return 0 // Assume active on error
  }
}

/**
 * Capture webcam photo using ffmpeg (works from launchd, no TCC issues)
 * Falls back to imagesnap if ffmpeg unavailable.
 */
function captureWebcam(outputPath) {
  return new Promise((resolve, reject) => {
    // ffmpeg: capture 1 frame from the default camera
    // -t 2: record max 2 seconds to prevent hang
    // -update 1: overwrite single file (no sequence pattern needed)
    const proc = spawn("ffmpeg", [
      "-f", "avfoundation",
      "-framerate", "30",
      "-video_size", "1280x720",
      "-t", "2",
      "-i", "0",
      "-frames:v", "1",
      "-update", "1",
      "-y",
      outputPath,
    ], {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    })

    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath)
      } else {
        // Fallback to imagesnap
        console.log("  ffmpeg capture failed, trying imagesnap...")
        const fallback = spawn("imagesnap", ["-w", "1", outputPath], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10000,
        })
        fallback.on("close", (code2) => {
          if (code2 === 0 && fs.existsSync(outputPath)) {
            resolve(outputPath)
          } else {
            reject(new Error(`Webcam capture failed (ffmpeg code ${code}, imagesnap code ${code2})`))
          }
        })
        fallback.on("error", () => reject(new Error("Neither ffmpeg nor imagesnap available")))
      }
    })

    proc.on("error", (err) => {
      reject(new Error(`ffmpeg not found: ${err.message}\nInstall: brew install ffmpeg`))
    })
  })
}

/**
 * Capture screenshot using macOS screencapture
 */
function captureScreen(outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("screencapture", ["-x", "-C", outputPath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    })

    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath)
      } else {
        reject(new Error(`screencapture failed with code ${code}`))
      }
    })

    proc.on("error", reject)
  })
}

// ── Face Recognition Engine (InsightFace ONNX) ─────────────
let engineReady = false

async function initFaceEngine() {
  if (engineReady) return true
  try {
    console.log("🧠 Loading InsightFace ONNX models (SCRFD + ArcFace)...")
    const ok = await faceEngine.init()
    if (!ok) return false

    // Pre-cache reference face embedding for fast comparisons
    if (fs.existsSync(REFERENCE_PHOTO)) {
      await faceEngine.cacheReferenceEmbedding(REFERENCE_PHOTO)
    }

    engineReady = true
    return true
  } catch (err) {
    console.error("❌ Failed to init face engine:", err.message)
    return false
  }
}

/**
 * Compare two face images using InsightFace ArcFace (512-dim embeddings)
 *
 * Returns: { similarity, displayPct, isSamePerson } or number (-1 = error, 0 = no face)
 *
 * ArcFace cosine similarity thresholds:
 *   > 0.5  = definitely same person
 *   0.3-0.5 = likely same person
 *   < 0.3  = different person
 */
async function compareImages(img1Path, img2Path) {
  try {
    if (!engineReady) {
      const ok = await initFaceEngine()
      if (!ok) return -1
    }
    return await faceEngine.compareFaces(img1Path, img2Path)
  } catch (err) {
    console.error("Face comparison failed:", err.message)
    return -1
  }
}

/**
 * Clear cached reference embedding (call when reference photo changes)
 */
function clearReferenceCache() {
  faceEngine.clearCache()
  engineReady = false // Force re-init to re-cache reference
}

/**
 * Sleep the laptop (macOS)
 */
function sleepLaptop() {
  console.log("😴 SLEEPING LAPTOP — unauthorized user detected!")
  try {
    execSync('osascript -e \'tell application "System Events" to sleep\'')
  } catch (err) {
    console.error("Failed to sleep:", err.message)
    try {
      execSync("pmset sleepnow")
    } catch {}
  }
}

/**
 * Shutdown the laptop (macOS)
 */
function shutdownLaptop() {
  console.log("🔴 SHUTTING DOWN LAPTOP — owner command!")
  try {
    execSync('osascript -e \'tell application "System Events" to shut down\'')
  } catch (err) {
    console.error("Failed to shutdown:", err.message)
    try {
      execSync("sudo shutdown -h now")
    } catch {}
  }
}

/**
 * Lock the screen (macOS)
 */
function lockScreen() {
  console.log("🔒 LOCKING SCREEN")
  try {
    execSync('osascript -e \'tell application "System Events" to keystroke "q" using {control down, command down}\'')
  } catch (err) {
    console.error("Failed to lock:", err.message)
  }
}

/**
 * Sound alarm via speakers
 */
function soundAlarm() {
  console.log("📢 SOUNDING ALARM")
  try {
    // Max volume + say warning + system alert sound
    execSync('osascript -e "set volume output volume 100"')
    spawn("say", ["-v", "Samantha", "-r", "200", "WARNING. UNAUTHORIZED ACCESS DETECTED. THIS DEVICE IS BEING MONITORED."], { stdio: "ignore" })
    // Also play system alert sounds
    spawn("afplay", ["/System/Library/Sounds/Sosumi.aiff"], { stdio: "ignore" })
  } catch (err) {
    console.error("Failed to sound alarm:", err.message)
  }
}

/**
 * Main security check cycle
 */
async function performSecurityCheck() {
  const idleTime = getIdleTimeSec()

  // Skip if user has been idle (no one at keyboard)
  if (idleTime > IDLE_THRESHOLD_SEC) {
    failCount = 0 // Reset on idle
    return
  }

  // Only check when there's recent activity (within last 15 seconds)
  if (idleTime > 15) return

  console.log(`[${new Date().toISOString()}] Activity detected (idle: ${idleTime}s), checking...`)

  try {
    // MODE 1: Webcam face comparison (InsightFace ArcFace)
    if (fs.existsSync(REFERENCE_PHOTO)) {
      const captureFile = path.join(DATA_DIR, `capture-${Date.now()}.png`)

      await captureWebcam(captureFile)
      const result = await compareImages(REFERENCE_PHOTO, captureFile)

      // Handle error cases
      if (result === -1) {
        console.log("  ⚠ Face engine error — skipping check")
        try { if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile) } catch {}
        return
      }
      if (result === 0) {
        console.log("  ⚠ No face detected in capture")
        await sendPhotoAlert(captureFile, `👻 No face detected\nIdle: ${idleTime}s`)
        try { if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile) } catch {}
        return
      }

      const { similarity, displayPct, isSamePerson } = result
      console.log(`  ArcFace result: cosine=${similarity.toFixed(4)}, display=${displayPct.toFixed(1)}%, match=${isSamePerson}`)

      // Send the captured image to Telegram
      const statusEmoji = isSamePerson ? "✅" : "🚨"
      await sendPhotoAlert(
        captureFile,
        `${statusEmoji} Face check — ${displayPct.toFixed(1)}% match (cosine: ${similarity.toFixed(3)})\nIdle: ${idleTime}s | Fails: ${failCount}/${MAX_FAILS_BEFORE_SLEEP}`,
      )

      if (!isSamePerson) {
        failCount++
        console.log(`  🚨 MISMATCH — fail ${failCount}/${MAX_FAILS_BEFORE_SLEEP}`)

        // Send alert with action buttons (Shutdown/Sleep/Lock/Alarm/Dismiss)
        await sendAlertWithActions(captureFile, similarity)

        // Auto-lock after repeated fails as safety net
        if (failCount >= MAX_FAILS_BEFORE_SLEEP) {
          await sendAlert("🔒 AUTO-LOCKING — too many failed face checks! Use buttons above to shutdown if needed.")
          lockScreen()
          failCount = 0
        }

        try { if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile) } catch {}
        return
      }

      // Match — reset fail count
      failCount = 0
      console.log("  ✅ Authorized user confirmed (ArcFace)")

      try { if (fs.existsSync(captureFile)) fs.unlinkSync(captureFile) } catch {}
    }

    // MODE 2: Screenshot comparison (if reference screen exists)
    if (fs.existsSync(REFERENCE_SCREEN)) {
      await captureScreen(CAPTURE_SCREEN)
      const screenSim = await compareImages(REFERENCE_SCREEN, CAPTURE_SCREEN)

      console.log(`  Screen similarity: ${(screenSim * 100).toFixed(1)}%`)

      // Screen comparison is supplementary — log but don't sleep based on it alone
      if (screenSim >= 0 && screenSim < 0.5) {
        await sendAlert(
          `📸 Screen changed significantly.\nSimilarity: ${(screenSim * 100).toFixed(1)}%`,
        )
      }

      if (fs.existsSync(CAPTURE_SCREEN)) fs.unlinkSync(CAPTURE_SCREEN)
    }
  } catch (err) {
    console.error("  Security check error:", err.message)
  }
}

/**
 * Start the security monitoring loop
 */
async function startMonitoring() {
  if (!fs.existsSync(REFERENCE_PHOTO) && !fs.existsSync(REFERENCE_SCREEN)) {
    console.error("❌ No reference photo found!")
    console.error(`   Run: npm run setup-guard`)
    console.error(`   Or place your photo at: ${REFERENCE_PHOTO}`)
    process.exit(1)
  }

  console.log("🛡️  Security Guard started (InsightFace ArcFace)")
  console.log(`   Reference face: ${fs.existsSync(REFERENCE_PHOTO) ? "✅" : "❌"}`)
  console.log(`   Reference screen: ${fs.existsSync(REFERENCE_SCREEN) ? "✅" : "❌"}`)
  console.log(`   ArcFace cosine threshold: ${SIMILARITY_THRESHOLD}`)
  console.log(`   Check interval: ${CHECK_INTERVAL_MS / 1000}s`)
  console.log(`   Max fails before lock: ${MAX_FAILS_BEFORE_SLEEP}`)
  console.log(`   Telegram alerts: ${_bot && _chatId ? "✅" : "❌"}`)
  console.log("")

  // Pre-load face engine and cache reference embedding
  await initFaceEngine()

  isMonitoring = true

  // Clear any existing interval
  if (guardInterval) clearInterval(guardInterval)

  // Run checks on interval
  guardInterval = setInterval(performSecurityCheck, CHECK_INTERVAL_MS)

  // First check immediately
  performSecurityCheck()
}

/**
 * Stop the security monitoring
 */
function stopMonitoring() {
  if (!isMonitoring) return false
  isMonitoring = false
  if (guardInterval) {
    clearInterval(guardInterval)
    guardInterval = null
  }
  failCount = 0
  console.log("🛡️  Security Guard stopped")
  return true
}

function isGuardRunning() {
  return isMonitoring
}

// Standalone execution
if (process.argv[1] && process.argv[1].includes("security-guard")) {
  startMonitoring()
}

// Export for bot integration
export {
  setBot,
  startMonitoring,
  stopMonitoring,
  isGuardRunning,
  initFaceEngine,
  clearReferenceCache,
  performSecurityCheck,
  captureWebcam,
  captureScreen,
  compareImages,
  sleepLaptop,
  shutdownLaptop,
  lockScreen,
  soundAlarm,
  REFERENCE_PHOTO,
  REFERENCE_SCREEN,
  SIMILARITY_THRESHOLD,
}
