import Database from "better-sqlite3"
import { randomBytes } from "node:crypto"
import { CronExpressionParser } from "cron-parser"
import { config } from "../config.js"

const db = new Database(config.dbPath, { fileMustExist: true })
db.pragma("journal_mode = WAL")

export type CommitmentStatus = "ACTIVE" | "PAUSED" | "CANCELLED"

export type Commitment = {
  id: string
  userId: number
  title: string
  prompt: string
  cron: string
  timezone: string
  status: CommitmentStatus
  nextRunAt: Date
  lastRunAt: Date | null
  lastError: string | null
}

type Row = {
  id: string
  userId: number
  title: string
  prompt: string
  cron: string
  timezone: string
  status: CommitmentStatus
  nextRunAt: string
  lastRunAt: string | null
  lastError: string | null
}

function rowToCommitment(r: Row): Commitment {
  return {
    id: r.id,
    userId: r.userId,
    title: r.title,
    prompt: r.prompt,
    cron: r.cron,
    timezone: r.timezone,
    status: r.status,
    nextRunAt: new Date(r.nextRunAt),
    lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
    lastError: r.lastError,
  }
}

function newId(): string {
  return "cm" + Date.now().toString(36) + randomBytes(3).toString("hex")
}

export function computeNextRunAt(
  cron: string,
  timezone: string,
  from: Date = new Date(),
): Date {
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: from })
    .next()
    .toDate()
}

export function validateCron(cron: string, timezone: string): { ok: true } | { ok: false; error: string } {
  try {
    CronExpressionParser.parse(cron, { tz: timezone })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const insertStmt = db.prepare(`
  INSERT INTO Commitment (id, userId, title, prompt, cron, timezone, status, nextRunAt, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, datetime('now'), datetime('now'))
`)

export function createCommitment(args: {
  userId: number
  title: string
  prompt: string
  cron: string
  timezone: string
}): Commitment {
  const id = newId()
  const nextRunAt = computeNextRunAt(args.cron, args.timezone)
  insertStmt.run(
    id,
    args.userId,
    args.title,
    args.prompt,
    args.cron,
    args.timezone,
    nextRunAt.toISOString(),
  )
  return {
    id,
    userId: args.userId,
    title: args.title,
    prompt: args.prompt,
    cron: args.cron,
    timezone: args.timezone,
    status: "ACTIVE",
    nextRunAt,
    lastRunAt: null,
    lastError: null,
  }
}

const listActiveStmt = db.prepare(`
  SELECT id, userId, title, prompt, cron, timezone, status, nextRunAt, lastRunAt, lastError
  FROM Commitment
  WHERE userId = ? AND status = 'ACTIVE'
  ORDER BY nextRunAt ASC
`)

export function listActiveCommitments(userId: number): Commitment[] {
  return (listActiveStmt.all(userId) as Row[]).map(rowToCommitment)
}

const cancelStmt = db.prepare(`
  UPDATE Commitment
  SET status = 'CANCELLED', updatedAt = datetime('now')
  WHERE id = ? AND userId = ? AND status = 'ACTIVE'
`)

export function cancelCommitment(userId: number, id: string): boolean {
  const r = cancelStmt.run(id, userId)
  return r.changes > 0
}

const dueStmt = db.prepare(`
  SELECT id, userId, title, prompt, cron, timezone, status, nextRunAt, lastRunAt, lastError
  FROM Commitment
  WHERE status = 'ACTIVE' AND nextRunAt <= ?
  ORDER BY nextRunAt ASC
`)

export function dueCommitments(now: Date): Commitment[] {
  return (dueStmt.all(now.toISOString()) as Row[]).map(rowToCommitment)
}

const markFiredStmt = db.prepare(`
  UPDATE Commitment
  SET lastRunAt = ?, nextRunAt = ?, lastError = ?, updatedAt = datetime('now')
  WHERE id = ?
`)

export function markFired(id: string, nextRunAt: Date, error: string | null = null): void {
  markFiredStmt.run(new Date().toISOString(), nextRunAt.toISOString(), error, id)
}
