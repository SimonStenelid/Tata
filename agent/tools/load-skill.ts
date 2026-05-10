import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { config } from "../config.js"

// Skills are versioned with code (not user data). They live as markdown files
// under agent/skills/ and are loaded once at startup into a Map. The model
// pulls one in via the `load_skill` tool when it needs the matching know-how.
// Persisted history strips load_skill tool_results so they don't bloat the
// transcript (see agent/memory/conversation.ts).

const here = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = path.resolve(here, "..", "skills")

type SkillEntry = {
  name: string
  staticContent: string
}

const skills = new Map<string, SkillEntry>()

function loadSkillsFromDisk(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.warn(`[skills] directory missing: ${SKILLS_DIR}`)
    return
  }
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Skill name is the path relative to SKILLS_DIR, sans .md, with
        // forward slashes. Files at the root keep their bare name (e.g.
        // "sql-schema"); nested files get a namespace ("stances/fire").
        const rel = path.relative(SKILLS_DIR, full).replace(/\\/g, "/")
        const name = rel.slice(0, -3)
        const staticContent = fs.readFileSync(full, "utf8")
        skills.set(name, { name, staticContent })
      }
    }
  }
  walk(SKILLS_DIR)
  console.log(`[skills] loaded ${skills.size}: ${[...skills.keys()].join(", ")}`)
}

loadSkillsFromDisk()

// Appended to sql-schema on every load — the canonical category list lives in
// the DB and is the only piece of dynamic state the schema skill needs.
function loadCategoryHints(): string {
  try {
    const db = new Database(config.dbPath, {
      readonly: true,
      fileMustExist: true,
    })
    const rows = db
      .prepare("SELECT name, kind FROM Category ORDER BY kind, name")
      .all() as { name: string; kind: string }[]
    db.close()
    if (rows.length === 0) return ""
    const income = rows.filter((r) => r.kind === "INCOME").map((r) => r.name)
    const expense = rows.filter((r) => r.kind === "EXPENSE").map((r) => r.name)
    return [
      "",
      "## Current categories (live from DB)",
      `EXPENSE: ${expense.join(", ") || "(none)"}`,
      `INCOME:  ${income.join(", ") || "(none)"}`,
    ].join("\n")
  } catch {
    return ""
  }
}

export function listSkillNames(): string[] {
  return [...skills.keys()].sort()
}

export function getSkillContent(name: string): string | null {
  const entry = skills.get(name)
  if (!entry) return null
  if (name === "sql-schema") {
    return entry.staticContent + loadCategoryHints()
  }
  return entry.staticContent
}
