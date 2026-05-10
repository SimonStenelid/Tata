import Database from "better-sqlite3"
import { config } from "../config.js"

const db = new Database(config.dbPath, { fileMustExist: true })
db.pragma("journal_mode = WAL")

export type CategoryKind = "EXPENSE" | "INCOME"

/** Lowercase, drop digits/punctuation, collapse whitespace. Useful for fuzzy match. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\d]+/g, " ")
    .replace(/[^a-zåäöéèüñç\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const listStmt = db.prepare(
  `SELECT id, name FROM Category WHERE kind = ? ORDER BY name ASC`,
)

export function listCategories(
  kind: CategoryKind,
): { id: string; name: string }[] {
  return listStmt.all(kind) as { id: string; name: string }[]
}

const findByIdStmt = db.prepare(
  `SELECT id, name, kind FROM Category WHERE id = ?`,
)

export function getCategoryById(
  id: string,
): { id: string; name: string; kind: CategoryKind } | null {
  const row = findByIdStmt.get(id) as
    | { id: string; name: string; kind: CategoryKind }
    | undefined
  return row ?? null
}
