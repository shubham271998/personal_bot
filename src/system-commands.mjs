/**
 * System Commands Module
 * Executes system-level operations via the pocket-system.sh helper script.
 * No sudo password required (uses osascript or passwordless sudo).
 */
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"
import logger from "./logger.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SYSTEM_SCRIPT = path.join(__dirname, "..", "scripts", "pocket-system.sh")

/**
 * Run a system command via pocket-system.sh
 * @param {string} command - The system command (sleep, shutdown, volume, etc.)
 * @param {string[]} args - Additional arguments
 * @param {number} timeout - Timeout in ms (default 15s)
 * @returns {Promise<string>} Output
 */
export function runSystemCommand(command, args = [], timeout = 15000) {
  return new Promise((resolve, reject) => {
    const fullArgs = [command, ...args]
    logger.info("SYSTEM", `Executing: pocket-system ${fullArgs.join(" ")}`)

    const proc = spawn("bash", [SYSTEM_SCRIPT, ...fullArgs], {
      env: { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    })

    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", (d) => (stdout += d.toString()))
    proc.stderr.on("data", (d) => (stderr += d.toString()))

    proc.on("close", (code) => {
      const output = (stdout + stderr).trim()
      if (code === 0) {
        logger.info("SYSTEM", `Success: ${output}`)
        resolve(output)
      } else {
        logger.error("SYSTEM", `Failed (exit ${code}): ${output}`)
        reject(new Error(output || `Command failed with exit code ${code}`))
      }
    })

    proc.on("error", (err) => {
      logger.error("SYSTEM", `Process error: ${err.message}`)
      reject(err)
    })
  })
}

/** Quick aliases */
export const systemSleep = () => runSystemCommand("sleep")
export const systemShutdown = () => runSystemCommand("shutdown")
export const systemRestart = () => runSystemCommand("restart")
export const systemLock = () => runSystemCommand("lock")
export const setVolume = (level) => runSystemCommand("volume", [String(level)])
export const mute = () => runSystemCommand("mute")
export const unmute = () => runSystemCommand("unmute")
export const getVolume = () => runSystemCommand("volume-get")
export const setBrightness = (level) => runSystemCommand("brightness", [String(level)])
export const getBattery = () => runSystemCommand("battery")
export const getUptime = () => runSystemCommand("uptime")
export const getDiskInfo = () => runSystemCommand("disk")
export const getMemoryInfo = () => runSystemCommand("memory")
export const openApp = (name) => runSystemCommand("open-app", [name])
export const quitApp = (name) => runSystemCommand("quit-app", [name])
export const runningApps = () => runSystemCommand("running-apps")
export const darkModeOn = () => runSystemCommand("dark-mode-on")
export const darkModeOff = () => runSystemCommand("dark-mode-off")
export const darkModeToggle = () => runSystemCommand("dark-mode-toggle")
export const notify = (title, msg) => runSystemCommand("notify", [title, msg])
export const sayText = (text) => runSystemCommand("say", [text])
export const wifiOn = () => runSystemCommand("wifi-on")
export const wifiOff = () => runSystemCommand("wifi-off")
export const wifiInfo = () => runSystemCommand("wifi")
export const dndOn = () => runSystemCommand("dnd-on")
export const dndOff = () => runSystemCommand("dnd-off")
export const emptyTrash = () => runSystemCommand("empty-trash")
export const screenshot = (dest) => runSystemCommand("screenshot", dest ? [dest] : [])
export const caffeinate = (secs) => runSystemCommand("caffeinate", secs ? [String(secs)] : [])
export const decaffeinate = () => runSystemCommand("decaffeinate")

/**
 * System command metadata for Claude's awareness
 */
export const SYSTEM_COMMANDS_DESCRIPTION = `
You have access to a system command helper at: ${SYSTEM_SCRIPT}
Run it with: bash ${SYSTEM_SCRIPT} <command> [args]

Available system commands (NO sudo needed):
  Power:     sleep, shutdown, restart, lock, screen-off
  Display:   brightness <0-100>
  Volume:    volume <0-100>, mute, unmute, volume-get
  Apps:      open-app <name>, quit-app <name>, force-quit-app <name>, running-apps
  System:    battery, uptime, disk, memory, wifi, wifi-on, wifi-off
  Bluetooth: bluetooth-on, bluetooth-off
  DND:       dnd-on, dnd-off
  Clipboard: clipboard-get, clipboard-set <text>
  Notify:    notify <title> <msg>, say <text>
  Screen:    screenshot [path]
  Sleep:     caffeinate [secs], decaffeinate
  Finder:    empty-trash, eject-all
  Theme:     dark-mode-on, dark-mode-off, dark-mode-toggle
  Process:   kill <name|pid>

IMPORTANT: Always use "bash ${SYSTEM_SCRIPT} <command>" for ANY system-level operation.
Do NOT use sudo directly. Do NOT use pmset or shutdown directly.
The helper script handles permissions automatically.
`.trim()
