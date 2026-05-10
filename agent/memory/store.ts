import Database from "better-sqlite3"
import type {
  BetaMemoryTool20250818CreateCommand,
  BetaMemoryTool20250818DeleteCommand,
  BetaMemoryTool20250818InsertCommand,
  BetaMemoryTool20250818RenameCommand,
  BetaMemoryTool20250818StrReplaceCommand,
  BetaMemoryTool20250818ViewCommand,
} from "@anthropic-ai/sdk/resources/beta.js"
import type { MemoryToolHandlers } from "@anthropic-ai/sdk/helpers/beta/memory"
import { config } from "../config.js"

// Per-user virtual filesystem rooted at /memories. Each file is a single
// SQLite row; directories are implicit (any path with children).
//
// The Prisma schema includes MemoryFile, but to avoid forcing a fresh
// `pnpm db:migrate` we create the table on demand here too.

const db = new Database(config.dbPath, { fileMustExist: true })
db.pragma("journal_mode = WAL")

db.exec(`
  CREATE TABLE IF NOT EXISTS MemoryFile (
    userId    INTEGER NOT NULL,
    path      TEXT    NOT NULL,
    content   TEXT    NOT NULL,
    createdAt TEXT    NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (userId, path)
  );
`)

const ROOT = "/memories"

function normalizePath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("path must be a non-empty string")
  }
  if (!raw.startsWith(ROOT)) {
    throw new Error(`path must start with ${ROOT}`)
  }
  // Reject .. segments and double slashes — keep this dumb on purpose.
  const parts = raw.split("/")
  for (const p of parts) {
    if (p === "..") throw new Error("'..' is not allowed in memory paths")
  }
  // Strip trailing slash unless it's the root itself.
  if (raw.length > ROOT.length && raw.endsWith("/")) raw = raw.slice(0, -1)
  return raw
}

function isDirectoryPath(userId: number, path: string): boolean {
  if (path === ROOT) return true
  // A directory exists if any file's path begins with `${path}/`.
  const row = db
    .prepare(
      `SELECT 1 FROM MemoryFile WHERE userId = ? AND path LIKE ? || '/%' LIMIT 1`,
    )
    .get(userId, path)
  return row !== undefined
}

function getFile(userId: number, path: string): { content: string } | null {
  const row = db
    .prepare(`SELECT content FROM MemoryFile WHERE userId = ? AND path = ?`)
    .get(userId, path) as { content: string } | undefined
  return row ?? null
}

function upsertFile(userId: number, path: string, content: string): void {
  db.prepare(
    `INSERT INTO MemoryFile (userId, path, content)
     VALUES (?, ?, ?)
     ON CONFLICT(userId, path) DO UPDATE SET content = excluded.content, updatedAt = datetime('now')`,
  ).run(userId, path, content)
}

function listChildren(userId: number, dir: string): string[] {
  const prefix = dir === ROOT ? `${ROOT}/` : `${dir}/`
  const rows = db
    .prepare(
      `SELECT path FROM MemoryFile WHERE userId = ? AND path LIKE ? || '%' ORDER BY path`,
    )
    .all(userId, prefix) as { path: string }[]

  const seen = new Set<string>()
  for (const r of rows) {
    const rest = r.path.slice(prefix.length)
    const head = rest.split("/")[0]
    if (!head) continue
    // A child is either a file (no further slash in `rest`) or a directory
    // (further slash). We mark directories with a trailing slash.
    seen.add(rest.includes("/") ? `${head}/` : head)
  }
  return [...seen].sort()
}

function viewCmd(userId: number, cmd: BetaMemoryTool20250818ViewCommand): string {
  const path = normalizePath(cmd.path)

  // Directory listing.
  const file = getFile(userId, path)
  if (!file) {
    if (path === ROOT || isDirectoryPath(userId, path)) {
      const entries = listChildren(userId, path)
      if (entries.length === 0) return `Directory ${path} is empty.`
      return `Directory ${path}:\n${entries.map((e) => `  ${e}`).join("\n")}`
    }
    throw new Error(`File not found: ${path}`)
  }

  // File view (optionally a line range).
  const lines = file.content.split("\n")
  if (cmd.view_range && cmd.view_range.length === 2) {
    const [from, to] = cmd.view_range
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1) {
      throw new Error("view_range must be [from, to] with 1-based integers")
    }
    const end = to === -1 ? lines.length : Math.min(to, lines.length)
    const slice = lines.slice(from - 1, end)
    return slice.map((l, i) => `${from + i}: ${l}`).join("\n")
  }
  return lines.map((l, i) => `${i + 1}: ${l}`).join("\n")
}

function createCmd(userId: number, cmd: BetaMemoryTool20250818CreateCommand): string {
  const path = normalizePath(cmd.path)
  if (path === ROOT) throw new Error(`cannot create at root ${ROOT}`)
  if (isDirectoryPath(userId, path)) {
    throw new Error(`${path} is a directory, refusing to overwrite`)
  }
  upsertFile(userId, path, cmd.file_text ?? "")
  return `Wrote ${path} (${(cmd.file_text ?? "").length} chars).`
}

function strReplaceCmd(
  userId: number,
  cmd: BetaMemoryTool20250818StrReplaceCommand,
): string {
  const path = normalizePath(cmd.path)
  const file = getFile(userId, path)
  if (!file) throw new Error(`File not found: ${path}`)
  const { old_str, new_str } = cmd
  if (typeof old_str !== "string" || old_str === "") {
    throw new Error("old_str must be a non-empty string")
  }
  const idx = file.content.indexOf(old_str)
  if (idx === -1) {
    throw new Error(`old_str not found in ${path}`)
  }
  if (file.content.indexOf(old_str, idx + 1) !== -1) {
    throw new Error(
      `old_str matches multiple times in ${path} — supply a more specific snippet`,
    )
  }
  const updated = file.content.slice(0, idx) + (new_str ?? "") + file.content.slice(idx + old_str.length)
  upsertFile(userId, path, updated)
  return `Replaced 1 occurrence in ${path}.`
}

function insertCmd(
  userId: number,
  cmd: BetaMemoryTool20250818InsertCommand,
): string {
  const path = normalizePath(cmd.path)
  const file = getFile(userId, path)
  if (!file) throw new Error(`File not found: ${path}`)
  const { insert_line, insert_text } = cmd
  if (!Number.isInteger(insert_line) || insert_line < 0) {
    throw new Error("insert_line must be a non-negative integer (0 = before line 1)")
  }
  const lines = file.content.split("\n")
  if (insert_line > lines.length) {
    throw new Error(`insert_line ${insert_line} exceeds file length ${lines.length}`)
  }
  const newLines = [
    ...lines.slice(0, insert_line),
    insert_text ?? "",
    ...lines.slice(insert_line),
  ]
  upsertFile(userId, path, newLines.join("\n"))
  return `Inserted at line ${insert_line} in ${path}.`
}

function deleteCmd(
  userId: number,
  cmd: BetaMemoryTool20250818DeleteCommand,
): string {
  const path = normalizePath(cmd.path)
  if (path === ROOT) throw new Error(`refusing to delete root ${ROOT}`)
  const file = getFile(userId, path)
  if (file) {
    db.prepare(`DELETE FROM MemoryFile WHERE userId = ? AND path = ?`).run(userId, path)
    return `Deleted ${path}.`
  }
  if (isDirectoryPath(userId, path)) {
    const r = db
      .prepare(`DELETE FROM MemoryFile WHERE userId = ? AND path LIKE ? || '/%'`)
      .run(userId, path)
    return `Deleted directory ${path} (${r.changes} files).`
  }
  throw new Error(`Nothing to delete at ${path}`)
}

function renameCmd(
  userId: number,
  cmd: BetaMemoryTool20250818RenameCommand,
): string {
  const oldPath = normalizePath(cmd.old_path)
  const newPath = normalizePath(cmd.new_path)
  if (oldPath === newPath) return `No-op rename for ${oldPath}.`

  const file = getFile(userId, oldPath)
  if (file) {
    if (getFile(userId, newPath) || isDirectoryPath(userId, newPath)) {
      throw new Error(`destination ${newPath} already exists`)
    }
    db.prepare(
      `UPDATE MemoryFile SET path = ?, updatedAt = datetime('now') WHERE userId = ? AND path = ?`,
    ).run(newPath, userId, oldPath)
    return `Renamed ${oldPath} → ${newPath}.`
  }
  if (isDirectoryPath(userId, oldPath)) {
    const rows = db
      .prepare(`SELECT path FROM MemoryFile WHERE userId = ? AND path LIKE ? || '/%'`)
      .all(userId, oldPath) as { path: string }[]
    const update = db.prepare(
      `UPDATE MemoryFile SET path = ?, updatedAt = datetime('now') WHERE userId = ? AND path = ?`,
    )
    const tx = db.transaction(() => {
      for (const r of rows) {
        const moved = newPath + r.path.slice(oldPath.length)
        update.run(moved, userId, r.path)
      }
    })
    tx()
    return `Renamed directory ${oldPath} → ${newPath} (${rows.length} files).`
  }
  throw new Error(`Nothing to rename at ${oldPath}`)
}

export function memoryHandlersFor(userId: number): MemoryToolHandlers {
  return {
    view: (c) => viewCmd(userId, c),
    create: (c) => createCmd(userId, c),
    str_replace: (c) => strReplaceCmd(userId, c),
    insert: (c) => insertCmd(userId, c),
    delete: (c) => deleteCmd(userId, c),
    rename: (c) => renameCmd(userId, c),
  }
}

export function upsertMemoryFile(
  userId: number,
  path: string,
  content: string,
): void {
  upsertFile(userId, normalizePath(path), content)
}

export function clearMemoryFor(userId: number): number {
  const r = db.prepare(`DELETE FROM MemoryFile WHERE userId = ?`).run(userId)
  return r.changes
}

export function hasAnyMemory(userId: number): boolean {
  const row = db
    .prepare(`SELECT 1 FROM MemoryFile WHERE userId = ? LIMIT 1`)
    .get(userId)
  return row !== undefined
}

export function hasOnboardingRequest(userId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM MemoryFile WHERE userId = ? AND path = '/memories/onboarding-requested.md' LIMIT 1`,
    )
    .get(userId)
  return row !== undefined
}
