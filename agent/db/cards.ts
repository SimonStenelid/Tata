import Database from "better-sqlite3"
import { config } from "../config.js"

export type CardKind = "DEBIT" | "CREDIT"

export type Card = {
  keyword: string
  label: string
  kind: CardKind
}

const db = new Database(config.dbPath, { readonly: true, fileMustExist: true })

const selectAllStmt = db.prepare(
  `SELECT keyword, label, kind FROM Card ORDER BY keyword ASC`,
)

// Cards rarely change and the list is small. Loaded once at startup; if a
// /cards command is added later it should call refreshCards() after writing.
let cache: Card[] = selectAllStmt.all() as Card[]
let byKeyword: Map<string, Card> = new Map(cache.map((c) => [c.keyword, c]))

export function refreshCards(): void {
  cache = selectAllStmt.all() as Card[]
  byKeyword = new Map(cache.map((c) => [c.keyword, c]))
}

export function listCards(): Card[] {
  return cache
}

export function getCard(keyword: string): Card | undefined {
  return byKeyword.get(keyword)
}

export function cardExists(keyword: string): boolean {
  return byKeyword.has(keyword)
}

export function cardKeywords(): string[] {
  return cache.map((c) => c.keyword)
}
