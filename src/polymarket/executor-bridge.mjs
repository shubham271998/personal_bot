/**
 * Bridge to Python trade executor
 * Calls trade-executor.py for real Polymarket orders (EIP-712 signed)
 */
import { spawn } from "child_process"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXECUTOR_PATH = path.join(__dirname, "trade-executor.py")

function runPython(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [EXECUTOR_PATH, ...args], {
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    })

    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => (stdout += d.toString()))
    proc.stderr.on("data", (d) => (stderr += d.toString()))

    proc.on("close", (code) => {
      try {
        const result = JSON.parse(stdout)
        if (result.error) reject(new Error(result.error))
        else resolve(result)
      } catch {
        reject(new Error(stderr || stdout || `Python exited with code ${code}`))
      }
    })
    proc.on("error", reject)
  })
}

/**
 * Place a limit order (GTC)
 */
export async function placeLimitOrder(tokenId, price, size, side, privateKey) {
  return runPython([side, tokenId, String(price), String(size), privateKey])
}

/**
 * Place a market order (FOK)
 */
export async function placeMarketOrder(tokenId, amountUsd, privateKey) {
  return runPython(["market_buy", tokenId, String(amountUsd), privateKey])
}

/**
 * Cancel an order
 */
export async function cancelOrder(orderId, privateKey) {
  return runPython(["cancel", orderId, privateKey])
}

/**
 * Cancel all orders
 */
export async function cancelAllOrders(privateKey) {
  return runPython(["cancel_all", privateKey])
}

/**
 * Get wallet balance (USDC + MATIC)
 */
export async function getBalance(privateKey) {
  return runPython(["balance", privateKey])
}

/**
 * Get open positions/orders
 */
export async function getPositions(privateKey) {
  return runPython(["positions", privateKey])
}

/**
 * Approve USDC for trading (one-time)
 */
export async function approveTrading(privateKey) {
  return runPython(["approve", privateKey])
}

/**
 * Check if py-clob-client is installed
 */
export async function checkDependencies() {
  try {
    await runPython(["--help"])
    return true
  } catch (err) {
    return err.message.includes("not installed") ? false : true
  }
}

export default {
  placeLimitOrder,
  placeMarketOrder,
  cancelOrder,
  cancelAllOrders,
  getBalance,
  getPositions,
  approveTrading,
  checkDependencies,
}
