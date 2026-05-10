import Database from "better-sqlite3"
import { randomBytes, createHash } from "node:crypto"
import { config } from "../config.js"

const writeDb = new Database(config.dbPath, { fileMustExist: true })
writeDb.pragma("journal_mode = WAL")

export type InsertableRow = {
  date: string // YYYY-MM-DD
  amount: number
  type: "INCOME" | "EXPENSE"
  description: string
  source: string
  categoryId: string | null
}

function newId(): string {
  return "tg" + Date.now().toString(36) + randomBytes(3).toString("hex")
}

function importHashFor(r: InsertableRow): string {
  const key = `${r.date}|${r.amount.toFixed(2)}|${r.description.trim().toLowerCase()}|${r.source.trim().toLowerCase()}`
  return createHash("sha1").update(key).digest("hex")
}

const insertStmt = writeDb.prepare(`
  INSERT INTO "Transaction" (id, date, amount, type, description, source, categoryId, importHash, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`)

export function insertTransactions(rows: InsertableRow[]): {
  inserted: number
  firstId: string | null
  lastId: string | null
} {
  if (rows.length === 0) return { inserted: 0, firstId: null, lastId: null }

  let firstId: string | null = null
  let lastId: string | null = null

  const run = writeDb.transaction((batch: InsertableRow[]) => {
    for (const r of batch) {
      const id = newId()
      if (!firstId) firstId = id
      lastId = id
      insertStmt.run(
        id,
        new Date(r.date + "T00:00:00.000Z").toISOString(),
        r.amount,
        r.type,
        r.description,
        r.source,
        r.categoryId,
        importHashFor(r),
      )
    }
  })

  run(rows)
  return { inserted: rows.length, firstId, lastId }
}

const existsByHashStmt = writeDb.prepare(
  `SELECT 1 FROM "Transaction" WHERE importHash = ? LIMIT 1`,
)

/** Idempotency check via the importHash unique index. */
export function existsTransaction(row: InsertableRow): boolean {
  return existsByHashStmt.get(importHashFor(row)) !== undefined
}

const findCategoryStmt = writeDb.prepare(
  `SELECT id FROM Category WHERE lower(name) = lower(?)`,
)

export function getCategoryIdByName(name: string): string | null {
  const row = findCategoryStmt.get(name) as { id: string } | undefined
  return row?.id ?? null
}

// ─── Typed entity writes (used by apply_changes) ───────────────────────────

export type CardKind = "DEBIT" | "CREDIT"
export type CategoryKind = "INCOME" | "EXPENSE"
export type AssetType =
  | "STOCK"
  | "FUND"
  | "CRYPTO"
  | "REAL_ESTATE"
  | "VEHICLE"
  | "COLLECTIBLE"
  | "OTHER"
export type LoanType =
  | "MORTGAGE"
  | "CAR"
  | "STUDENT"
  | "PERSONAL"
  | "CREDIT_LINE"
  | "OTHER"

const upsertCardStmt = writeDb.prepare(`
  INSERT INTO Card (keyword, label, kind, createdAt)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(keyword) DO UPDATE SET label = excluded.label, kind = excluded.kind
`)

export function upsertCard(args: {
  keyword: string
  label: string
  kind: CardKind
}): { keyword: string } {
  upsertCardStmt.run(args.keyword, args.label, args.kind)
  return { keyword: args.keyword }
}

const findCategoryByExactNameStmt = writeDb.prepare(
  `SELECT id, kind, color FROM Category WHERE name = ?`,
)
const insertCategoryStmt = writeDb.prepare(`
  INSERT INTO Category (id, name, kind, color) VALUES (?, ?, ?, ?)
`)
const updateCategoryStmt = writeDb.prepare(`
  UPDATE Category SET kind = ?, color = ? WHERE id = ?
`)

export function upsertCategory(args: {
  name: string
  kind: CategoryKind
  color?: string | null
}): { id: string; created: boolean } {
  const existing = findCategoryByExactNameStmt.get(args.name) as
    | { id: string; kind: string; color: string | null }
    | undefined
  if (existing) {
    updateCategoryStmt.run(args.kind, args.color ?? null, existing.id)
    return { id: existing.id, created: false }
  }
  const id = newId()
  insertCategoryStmt.run(id, args.name, args.kind, args.color ?? null)
  return { id, created: true }
}

const insertAssetStmt = writeDb.prepare(`
  INSERT INTO Asset (id, name, type, currency, ticker, quantity, avgBuyPrice, manualValue, manualValueAsOf, notes, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`)
const updateAssetStmt = writeDb.prepare(`
  UPDATE Asset SET
    name = ?,
    type = ?,
    currency = ?,
    ticker = ?,
    quantity = ?,
    avgBuyPrice = ?,
    manualValue = ?,
    manualValueAsOf = ?,
    notes = ?,
    updatedAt = datetime('now')
  WHERE id = ?
`)

export type UpsertAssetInput = {
  id?: string | null
  name: string
  type: AssetType
  currency?: string
  ticker?: string | null
  quantity?: number | null
  avgBuyPrice?: number | null
  manualValue?: number | null
  manualValueAsOf?: string | null
  notes?: string | null
}

export function upsertAsset(args: UpsertAssetInput): {
  id: string
  created: boolean
} {
  const currency = args.currency ?? "SEK"
  if (args.id) {
    updateAssetStmt.run(
      args.name,
      args.type,
      currency,
      args.ticker ?? null,
      args.quantity ?? null,
      args.avgBuyPrice ?? null,
      args.manualValue ?? null,
      args.manualValueAsOf
        ? new Date(args.manualValueAsOf).toISOString()
        : null,
      args.notes ?? null,
      args.id,
    )
    return { id: args.id, created: false }
  }
  const id = newId()
  insertAssetStmt.run(
    id,
    args.name,
    args.type,
    currency,
    args.ticker ?? null,
    args.quantity ?? null,
    args.avgBuyPrice ?? null,
    args.manualValue ?? null,
    args.manualValueAsOf ? new Date(args.manualValueAsOf).toISOString() : null,
    args.notes ?? null,
  )
  return { id, created: true }
}

const insertLoanStmt = writeDb.prepare(`
  INSERT INTO Loan (id, name, type, originalAmount, currentBalance, interestRate, currency, startDate, endDate, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`)
const updateLoanStmt = writeDb.prepare(`
  UPDATE Loan SET
    name = ?,
    type = ?,
    originalAmount = ?,
    currentBalance = ?,
    interestRate = ?,
    currency = ?,
    startDate = ?,
    endDate = ?,
    updatedAt = datetime('now')
  WHERE id = ?
`)

export type UpsertLoanInput = {
  id?: string | null
  name: string
  type: LoanType
  originalAmount: number
  currentBalance: number
  interestRate?: number
  currency?: string
  startDate?: string | null
  endDate?: string | null
}

export function upsertLoan(args: UpsertLoanInput): {
  id: string
  created: boolean
} {
  const interestRate = args.interestRate ?? 0
  const currency = args.currency ?? "SEK"
  const startDate = args.startDate ? new Date(args.startDate).toISOString() : null
  const endDate = args.endDate ? new Date(args.endDate).toISOString() : null
  if (args.id) {
    updateLoanStmt.run(
      args.name,
      args.type,
      args.originalAmount,
      args.currentBalance,
      interestRate,
      currency,
      startDate,
      endDate,
      args.id,
    )
    return { id: args.id, created: false }
  }
  const id = newId()
  insertLoanStmt.run(
    id,
    args.name,
    args.type,
    args.originalAmount,
    args.currentBalance,
    interestRate,
    currency,
    startDate,
    endDate,
  )
  return { id, created: true }
}

const findTxStmt = writeDb.prepare(`SELECT id FROM "Transaction" WHERE id = ?`)
const updateTxStmt = writeDb.prepare(`
  UPDATE "Transaction" SET
    date        = COALESCE(?, date),
    amount      = COALESCE(?, amount),
    type        = COALESCE(?, type),
    description = COALESCE(?, description),
    notes       = COALESCE(?, notes),
    source      = COALESCE(?, source),
    categoryId  = COALESCE(?, categoryId),
    updatedAt   = datetime('now')
  WHERE id = ?
`)
const deleteTxStmt = writeDb.prepare(`DELETE FROM "Transaction" WHERE id = ?`)

export type UpdateTransactionInput = {
  date?: string
  amount?: number
  type?: "INCOME" | "EXPENSE"
  description?: string | null
  notes?: string | null
  source?: string | null
  categoryId?: string | null
}

export function transactionExists(id: string): boolean {
  return findTxStmt.get(id) !== undefined
}

export function updateTransaction(
  id: string,
  set: UpdateTransactionInput,
): { ok: boolean } {
  if (!transactionExists(id)) return { ok: false }
  updateTxStmt.run(
    set.date ? new Date(set.date + "T00:00:00.000Z").toISOString() : null,
    set.amount ?? null,
    set.type ?? null,
    set.description === undefined ? null : set.description,
    set.notes === undefined ? null : set.notes,
    set.source === undefined ? null : set.source,
    set.categoryId === undefined ? null : set.categoryId,
    id,
  )
  return { ok: true }
}

export function deleteTransactionById(id: string): { ok: boolean } {
  if (!transactionExists(id)) return { ok: false }
  deleteTxStmt.run(id)
  return { ok: true }
}

// Atomic transaction wrapper: pass a function that performs sequential writes;
// throws on rollback. apply_changes uses this so partial commits never escape.
export function runInTransaction<T>(fn: () => T): T {
  return writeDb.transaction(fn)()
}

// Raw SQL escape hatch for apply_changes. Caller is responsible for sieve.
// Returns the number of changes (rows affected). Single statement only.
export function execRaw(sql: string): { changes: number } {
  const info = writeDb.prepare(sql).run()
  return { changes: info.changes ?? 0 }
}
