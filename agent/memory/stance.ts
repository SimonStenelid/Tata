import Database from "better-sqlite3"
import { config } from "../config.js"

// The user's chosen financial stance — one of STANCE_KEYS — stored as a
// single Markdown file in the per-user MemoryFile virtual filesystem at
// /memories/stance.md. The first non-empty, non-comment line is the stance
// key (e.g. "fire"); anything below is human-readable context the model may
// add (date picked, why, etc.). Tata always loads the matching stance skill
// into the system prompt for the user — see agent/prompts/system.ts.

const STANCE_PATH = "/memories/stance.md"

// Keep in sync with agent/skills/stances/*.md filenames.
export const STANCE_KEYS = [
  "fire",
  "fatfire",
  "simple-path",
  "rich-dad",
  "ramsey",
  "boglehead",
] as const

export type StanceKey = (typeof STANCE_KEYS)[number]

export function isStanceKey(s: string): s is StanceKey {
  return (STANCE_KEYS as readonly string[]).includes(s)
}

const db = new Database(config.dbPath, { fileMustExist: true })

const selectStmt = db.prepare(
  `SELECT content FROM MemoryFile WHERE userId = ? AND path = ?`,
)
const upsertStmt = db.prepare(
  `INSERT INTO MemoryFile (userId, path, content)
   VALUES (?, ?, ?)
   ON CONFLICT(userId, path) DO UPDATE SET content = excluded.content, updatedAt = datetime('now')`,
)

function parseKey(content: string): StanceKey | null {
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    return isStanceKey(line) ? line : null
  }
  return null
}

export function readStance(userId: number): StanceKey | null {
  const row = selectStmt.get(userId, STANCE_PATH) as
    | { content: string }
    | undefined
  if (!row) return null
  return parseKey(row.content)
}

export function setStance(userId: number, key: StanceKey): void {
  const today = new Date().toISOString().slice(0, 10)
  const body = `${key}\n\n# Picked: ${today}\n`
  upsertStmt.run(userId, STANCE_PATH, body)
}
