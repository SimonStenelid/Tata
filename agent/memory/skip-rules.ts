import Database from "better-sqlite3"
import { config } from "../config.js"

// User-defined ingest skip rules, stored as a single Markdown file in the
// per-user MemoryFile virtual filesystem at /memories/ingest-skip.md. One
// merchant substring per line; '#' starts a comment; matching is
// case-insensitive substring against Transaction.description.

const SKIP_PATH = "/memories/ingest-skip.md"

const db = new Database(config.dbPath, { fileMustExist: true })

const selectStmt = db.prepare(
  `SELECT content FROM MemoryFile WHERE userId = ? AND path = ?`,
)
const upsertStmt = db.prepare(
  `INSERT INTO MemoryFile (userId, path, content)
   VALUES (?, ?, ?)
   ON CONFLICT(userId, path) DO UPDATE SET content = excluded.content, updatedAt = datetime('now')`,
)

function readFile(userId: number): string | null {
  const row = selectStmt.get(userId, SKIP_PATH) as
    | { content: string }
    | undefined
  return row?.content ?? null
}

function parseRules(content: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const lower = line.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(line)
  }
  return out
}

export function loadSkipRules(userId: number): string[] {
  const content = readFile(userId)
  if (!content) return []
  // Lowercased for matching; the original case is only relevant for display
  // (see listSkipRules).
  return parseRules(content).map((r) => r.toLowerCase())
}

export function listSkipRules(userId: number): string[] {
  const content = readFile(userId)
  if (!content) return []
  return parseRules(content)
}

export function addSkipRule(userId: number, rule: string): {
  added: boolean
  rule: string
} {
  const trimmed = rule.trim()
  if (!trimmed) throw new Error("rule must not be empty")
  if (trimmed.startsWith("#")) throw new Error("rule must not start with '#'")

  const existing = readFile(userId)
  const current = existing ? parseRules(existing) : []
  const lower = trimmed.toLowerCase()
  if (current.some((r) => r.toLowerCase() === lower)) {
    return { added: false, rule: trimmed }
  }

  const header =
    "# Merchants to skip during PDF ingest. One per line; case-insensitive substring match.\n"
  const body = existing && existing.trim() !== "" ? existing : header
  const sep = body.endsWith("\n") ? "" : "\n"
  const next = `${body}${sep}${trimmed}\n`
  upsertStmt.run(userId, SKIP_PATH, next)
  return { added: true, rule: trimmed }
}

export function descriptionMatchesAnyRule(
  description: string,
  rulesLower: string[],
): boolean {
  if (rulesLower.length === 0) return false
  const d = description.toLowerCase()
  for (const r of rulesLower) {
    if (d.includes(r)) return true
  }
  return false
}
