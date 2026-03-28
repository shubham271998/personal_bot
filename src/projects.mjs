/**
 * Multi-Project Manager
 * Manages multiple project directories that Claude can work on
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import logger from "./logger.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, "../data")
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json")

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

class ProjectManager {
  constructor() {
    this.projects = new Map() // name -> { path, description, addedAt }
    this.activeProject = new Map() // chatId -> projectName
    this._load()
  }

  _load() {
    try {
      if (fs.existsSync(PROJECTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8"))
        for (const [name, info] of Object.entries(data.projects || {})) {
          this.projects.set(name, info)
        }
        // Restore active selections
        for (const [chatId, name] of Object.entries(data.active || {})) {
          this.activeProject.set(Number(chatId), name)
        }
        logger.info("PROJECTS", `Loaded ${this.projects.size} projects`)
      }
    } catch (err) {
      logger.error("PROJECTS", "Failed to load projects", { error: err.message })
    }
  }

  _save() {
    const data = {
      projects: Object.fromEntries(this.projects),
      active: Object.fromEntries(this.activeProject),
    }
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2))
  }

  add(name, projectPath, description = "") {
    const resolved = path.resolve(projectPath)
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: `Path does not exist: ${resolved}` }
    }
    this.projects.set(name, {
      path: resolved,
      description,
      addedAt: new Date().toISOString(),
    })
    this._save()
    logger.info("PROJECTS", `Added project: ${name} → ${resolved}`)
    return { ok: true }
  }

  remove(name) {
    if (!this.projects.has(name)) {
      return { ok: false, error: `Project "${name}" not found` }
    }
    this.projects.delete(name)
    // Remove active selections pointing to this project
    for (const [chatId, active] of this.activeProject) {
      if (active === name) this.activeProject.delete(chatId)
    }
    this._save()
    logger.info("PROJECTS", `Removed project: ${name}`)
    return { ok: true }
  }

  switchTo(chatId, name) {
    if (!this.projects.has(name)) {
      return { ok: false, error: `Project "${name}" not found` }
    }
    this.activeProject.set(chatId, name)
    this._save()
    const project = this.projects.get(name)
    logger.info("PROJECTS", `Chat ${chatId} switched to: ${name}`)
    return { ok: true, project }
  }

  getActive(chatId) {
    const name = this.activeProject.get(chatId)
    if (!name || !this.projects.has(name)) {
      // Return default (first project or fallback)
      const first = this.projects.entries().next().value
      if (first) return { name: first[0], ...first[1] }
      return null
    }
    return { name, ...this.projects.get(name) }
  }

  getActiveDir(chatId) {
    const project = this.getActive(chatId)
    return project?.path || null
  }

  list() {
    const result = []
    for (const [name, info] of this.projects) {
      result.push({ name, ...info })
    }
    return result
  }

  /**
   * Scan common directories for git repos
   */
  async scanForProjects(searchDirs = null) {
    const homeDir = process.env.HOME || (await import("os")).homedir()
    const dirs = searchDirs || [
      path.join(homeDir, "Downloads"),
      path.join(homeDir, "Documents"),
      path.join(homeDir, "Desktop"),
      path.join(homeDir, "Projects"),
      path.join(homeDir, "Developer"),
      path.join(homeDir, "Code"),
      path.join(homeDir, "repos"),
      path.join(homeDir, "workspace"),
      path.join(homeDir, "src"),
      path.join(homeDir, "dev"),
    ]

    const found = []

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue
          const fullPath = path.join(dir, entry.name)
          const gitPath = path.join(fullPath, ".git")
          if (fs.existsSync(gitPath)) {
            // Check if already registered
            const alreadyAdded = [...this.projects.values()].some((p) => p.path === fullPath)
            found.push({
              name: entry.name,
              path: fullPath,
              parentDir: dir,
              alreadyAdded,
            })
          }
        }
      } catch {}
    }

    return found
  }

  /**
   * Auto-add all found projects
   */
  async autoAddProjects() {
    const found = await this.scanForProjects()
    let added = 0
    for (const proj of found) {
      if (!proj.alreadyAdded) {
        // Generate unique name if collision
        let name = proj.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")
        if (this.projects.has(name)) {
          name = `${name}-${Date.now() % 10000}`
        }
        this.add(name, proj.path, `Auto-discovered from ${proj.parentDir}`)
        added++
      }
    }
    return { found: found.length, added }
  }
}

export const projectManager = new ProjectManager()
export default projectManager
