#!/usr/bin/env node

/**
 * Setup script for Security Guard
 * Captures reference face photo and screen screenshot
 */
import { execSync } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import readline from "readline"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, "../data")
const REFERENCE_FACE = path.join(DATA_DIR, "reference-face.png")
const REFERENCE_SCREEN = path.join(DATA_DIR, "reference-screen.png")

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((resolve) => rl.question(q, resolve))

async function main() {
  console.log("🛡️  Security Guard Setup\n")

  // Check for imagesnap
  try {
    execSync("which imagesnap", { encoding: "utf-8" })
    console.log("✅ imagesnap found")
  } catch {
    console.log("❌ imagesnap not found. Installing...")
    try {
      execSync("brew install imagesnap", { stdio: "inherit" })
      console.log("✅ imagesnap installed")
    } catch {
      console.error("Failed to install imagesnap. Please run: brew install imagesnap")
      process.exit(1)
    }
  }

  // Capture reference face
  console.log("\n📸 Step 1: Capture your reference face photo")
  console.log("   Sit in front of your webcam in your normal position.")
  await ask("   Press Enter when ready...")

  console.log("   Capturing in 3 seconds...")
  await new Promise((r) => setTimeout(r, 3000))

  try {
    execSync(`imagesnap -w 1 "${REFERENCE_FACE}"`, { stdio: "pipe" })
    console.log(`   ✅ Face photo saved: ${REFERENCE_FACE}`)
  } catch (err) {
    console.error("   ❌ Failed to capture:", err.message)
  }

  // Capture reference screenshot
  console.log("\n📸 Step 2: Capture reference screenshot (optional)")
  const doScreen = await ask("   Capture reference screenshot? (y/n): ")

  if (doScreen.toLowerCase() === "y") {
    console.log("   Capturing screen in 2 seconds...")
    await new Promise((r) => setTimeout(r, 2000))

    try {
      execSync(`screencapture -x -C "${REFERENCE_SCREEN}"`, { stdio: "pipe" })
      console.log(`   ✅ Screenshot saved: ${REFERENCE_SCREEN}`)
    } catch (err) {
      console.error("   ❌ Failed to capture:", err.message)
    }
  }

  // Summary
  console.log("\n✅ Setup complete!")
  console.log(`   Face reference: ${fs.existsSync(REFERENCE_FACE) ? "✅" : "❌"}`)
  console.log(`   Screen reference: ${fs.existsSync(REFERENCE_SCREEN) ? "✅" : "❌"}`)
  console.log("\n   Start monitoring with: npm run guard")
  console.log("   Or control via Telegram: /guard-start")

  rl.close()
}

main()
