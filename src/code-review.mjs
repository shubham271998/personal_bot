/**
 * Code Review Engine
 * Git diff analysis, PR review, code quality checks via Claude
 */
import { runClaude, runShell } from "./claude-runner.mjs"
import logger from "./logger.mjs"

/**
 * Get git status summary for a project
 */
export async function getGitStatus(projectDir) {
  try {
    const [status, branch, log] = await Promise.all([
      runShell("git status --short", projectDir),
      runShell("git branch --show-current", projectDir),
      runShell("git log --oneline -10", projectDir),
    ])
    return {
      branch: branch.trim(),
      status: status.trim() || "(clean)",
      recentCommits: log.trim(),
    }
  } catch (err) {
    logger.error("REVIEW", `Git status failed: ${err.message}`)
    return null
  }
}

/**
 * Get the diff for review
 */
export async function getDiff(projectDir, target = "HEAD") {
  try {
    // Staged + unstaged changes
    const diff = await runShell(`git diff ${target}`, projectDir)
    const stagedDiff = await runShell("git diff --cached", projectDir)
    return (diff + "\n" + stagedDiff).trim()
  } catch (err) {
    logger.error("REVIEW", `Git diff failed: ${err.message}`)
    return null
  }
}

/**
 * Get diff between two branches
 */
export async function getBranchDiff(projectDir, baseBranch = "main") {
  try {
    const currentBranch = (await runShell("git branch --show-current", projectDir)).trim()
    const diff = await runShell(`git diff ${baseBranch}...${currentBranch}`, projectDir)
    return { currentBranch, baseBranch, diff: diff.trim() }
  } catch (err) {
    logger.error("REVIEW", `Branch diff failed: ${err.message}`)
    return null
  }
}

/**
 * Full code review via Claude
 */
export async function reviewCode({ chatId, projectDir, projectName, onTyping, scope = "changes" }) {
  let diffContent = ""
  let context = ""

  if (scope === "changes") {
    diffContent = await getDiff(projectDir)
    context = "Review the following uncommitted changes"
  } else if (scope === "branch") {
    const branchDiff = await getBranchDiff(projectDir)
    if (branchDiff) {
      diffContent = branchDiff.diff
      context = `Review the changes on branch "${branchDiff.currentBranch}" compared to "${branchDiff.baseBranch}"`
    }
  } else if (scope === "last-commit") {
    diffContent = await runShell("git diff HEAD~1", projectDir).catch(() => "")
    context = "Review the last commit's changes"
  }

  if (!diffContent) {
    return "No changes to review."
  }

  // Truncate very large diffs
  const maxDiffLen = 15000
  const truncated = diffContent.length > maxDiffLen
  const truncatedDiff = truncated ? diffContent.slice(0, maxDiffLen) + "\n...(truncated)" : diffContent

  const prompt = `${context}. Provide a thorough code review covering:

1. **Summary** — What do these changes do?
2. **Issues** — Bugs, security risks, logic errors
3. **Improvements** — Suggestions for better code quality
4. **Style** — Naming, formatting, convention violations
5. **Rating** — Overall quality (1-10) with brief justification

Be concise but thorough. Here's the diff:

\`\`\`diff
${truncatedDiff}
\`\`\``

  logger.info("REVIEW", `Starting code review (${scope}) for ${projectName}`, {
    diffSize: diffContent.length,
    truncated,
  })

  return runClaude({
    chatId,
    prompt,
    projectDir,
    projectName,
    onTyping,
  })
}

/**
 * Quick lint/check via Claude
 */
export async function quickCheck({ chatId, projectDir, projectName, filePath, onTyping }) {
  const prompt = filePath
    ? `Review the file "${filePath}" for bugs, security issues, and improvements. Be concise.`
    : `Look at the current git diff and quickly flag any obvious bugs or issues. Just list problems, no explanations needed unless critical.`

  return runClaude({
    chatId,
    prompt,
    projectDir,
    projectName,
    onTyping,
  })
}

/**
 * Generate commit message from diff
 */
export async function generateCommitMessage({ chatId, projectDir, projectName, onTyping }) {
  const diff = await getDiff(projectDir)
  if (!diff) return "No changes to commit."

  const maxLen = 10000
  const truncatedDiff = diff.length > maxLen ? diff.slice(0, maxLen) + "\n...(truncated)" : diff

  const prompt = `Based on this git diff, generate a concise conventional commit message (type(scope): description). Just the commit message, nothing else.

\`\`\`diff
${truncatedDiff}
\`\`\``

  return runClaude({
    chatId,
    prompt,
    projectDir,
    projectName,
    onTyping,
  })
}

/**
 * Explain a file or piece of code
 */
export async function explainCode({ chatId, projectDir, projectName, target, onTyping }) {
  const prompt = `Explain what "${target}" does in this codebase. Include its purpose, key functions, dependencies, and how it fits into the architecture. Be concise.`

  return runClaude({
    chatId,
    prompt,
    projectDir,
    projectName,
    onTyping,
  })
}
