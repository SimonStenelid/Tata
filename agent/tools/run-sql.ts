import Database from "better-sqlite3"
import { config } from "../config.js"

const db = new Database(config.dbPath, { readonly: true, fileMustExist: true })
db.pragma("query_only = ON")

const MAX_ROWS = 200

export type RunSqlResult = {
  columns: string[]
  rows: unknown[][]
  row_count: number
  truncated: boolean
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .trim()
}

export function runSql(rawSql: string): RunSqlResult {
  if (typeof rawSql !== "string" || rawSql.trim() === "") {
    throw new Error("sql must be a non-empty string")
  }

  const stripped = stripComments(rawSql)
  if (!/^select\b/i.test(stripped) && !/^with\b/i.test(stripped)) {
    throw new Error(
      "Only a single SELECT (or WITH ... SELECT) statement is allowed.",
    )
  }

  const withoutTrailingSemi = stripped.replace(/;\s*$/, "")
  if (withoutTrailingSemi.includes(";")) {
    throw new Error("Multiple statements are not allowed.")
  }

  const stmt = db.prepare(withoutTrailingSemi)
  stmt.raw(true)
  const rows = stmt.all() as unknown[][]
  const columns = stmt.columns().map((c) => c.name)

  const truncated = rows.length > MAX_ROWS
  const capped = truncated ? rows.slice(0, MAX_ROWS) : rows

  return {
    columns,
    rows: capped,
    row_count: capped.length,
    truncated,
  }
}

