import { z } from "zod"
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"
import {
  cardKeywords,
  getCard,
  refreshCards,
} from "../db/cards.js"
import { normalize, type CategoryKind } from "../db/categories.js"
import {
  deleteTransactionById,
  execRaw,
  getCategoryIdByName,
  insertTransactions,
  runInTransaction,
  transactionExists,
  updateTransaction,
  upsertAsset,
  upsertCard,
  upsertCategory,
  upsertLoan,
} from "../db/write.js"
import { renderPreview } from "../prompts/ingest-preview.js"
import { loadSkipRules } from "../memory/skip-rules.js"
import { stageBatch, type ParsedRow, type StagedBatch } from "./ingest-tools.js"

// ─── Confirmation hook surface (driven by the bot) ─────────────────────────

export type AskCategoryHook = (
  merchant: string,
  kind: CategoryKind,
  sample: { amount: number; date: string },
) => Promise<{ categoryName: string } | null>

export type ConfirmHook = (
  summary: string,
  acceptLabel: string,
) => Promise<boolean>

export type ApplyChangesHooks = {
  onAskCategory: AskCategoryHook
  onConfirm: ConfirmHook
}

// At most one apply_changes confirm in flight per user — overlapping confirms
// would race the keyboard message and confuse the user.
const inflightConfirmByUser = new Set<number>()

// ─── Change schema ────────────────────────────────────────────────────────

const txTypeEnum = z.enum(["INCOME", "EXPENSE"])
const cardKindEnum = z.enum(["DEBIT", "CREDIT"])
const categoryKindEnum = z.enum(["INCOME", "EXPENSE"])
const assetTypeEnum = z.enum([
  "STOCK",
  "FUND",
  "CRYPTO",
  "REAL_ESTATE",
  "VEHICLE",
  "COLLECTIBLE",
  "OTHER",
])
const loanTypeEnum = z.enum([
  "MORTGAGE",
  "CAR",
  "STUDENT",
  "PERSONAL",
  "CREDIT_LINE",
  "OTHER",
])

const parsedRowSchema = z.object({
  date: z.string().describe("YYYY-MM-DD"),
  amount: z.number(),
  type: txTypeEnum,
  description: z.string(),
  account: z
    .string()
    .describe("A Card.keyword that exists in the Card table."),
  category: z.string().nullable(),
})

const insertTxnsChange = z.object({
  kind: z.literal("insert_transactions"),
  rows: z.array(parsedRowSchema),
})

const updateTxnChange = z.object({
  kind: z.literal("update_transaction"),
  id: z.string(),
  set: z.object({
    date: z.string().optional(),
    amount: z.number().optional(),
    type: txTypeEnum.optional(),
    description: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    categoryId: z.string().nullable().optional(),
    categoryName: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Convenience: if set, the server resolves the Category by name and overrides categoryId.",
      ),
  }),
})

const deleteTxnChange = z.object({
  kind: z.literal("delete_transaction"),
  id: z.string(),
})

const upsertCardChange = z.object({
  kind: z.literal("upsert_card"),
  keyword: z.string(),
  label: z.string(),
  cardKind: cardKindEnum,
})

const upsertCategoryChange = z.object({
  kind: z.literal("upsert_category"),
  name: z.string(),
  categoryKind: categoryKindEnum,
  color: z.string().nullable().optional(),
})

const upsertAssetChange = z.object({
  kind: z.literal("upsert_asset"),
  id: z.string().nullable().optional(),
  name: z.string(),
  assetType: assetTypeEnum,
  currency: z.string().optional(),
  ticker: z.string().nullable().optional(),
  quantity: z.number().nullable().optional(),
  avgBuyPrice: z.number().nullable().optional(),
  manualValue: z.number().nullable().optional(),
  manualValueAsOf: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
})

const upsertLoanChange = z.object({
  kind: z.literal("upsert_loan"),
  id: z.string().nullable().optional(),
  name: z.string(),
  loanType: loanTypeEnum,
  originalAmount: z.number(),
  currentBalance: z.number(),
  interestRate: z.number().optional(),
  currency: z.string().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
})

const changeSchema = z.discriminatedUnion("kind", [
  insertTxnsChange,
  updateTxnChange,
  deleteTxnChange,
  upsertCardChange,
  upsertCategoryChange,
  upsertAssetChange,
  upsertLoanChange,
])

const rawSqlSchema = z.object({
  sql: z.string(),
  expected_rows: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "REQUIRED for UPDATE / DELETE. Transaction rolls back if rowcount differs.",
    ),
})

export const applyChangesInputSchema = z.object({
  summary: z
    .string()
    .describe("One-line summary for the confirm message. Be specific."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "If true: stage and return a preview WITHOUT showing the user a confirm keyboard. Useful for ingest preview-then-commit.",
    ),
  changes: z.array(changeSchema).optional(),
  raw_sql: rawSqlSchema
    .optional()
    .describe(
      "Escape hatch for mutations the typed change kinds can't express. Single statement only; UPDATE/DELETE require WHERE + expected_rows. Prefer typed changes when possible.",
    ),
})

export type ApplyChangesInput = z.infer<typeof applyChangesInputSchema>
type Change = z.infer<typeof changeSchema>

// ─── raw_sql sieve ────────────────────────────────────────────────────────

const RAW_SQL_BLACKLIST =
  /\b(DROP|ALTER|CREATE|ATTACH|DETACH|REINDEX|PRAGMA|VACUUM|REPLACE|TRUNCATE)\b/i

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .trim()
}

type SieveResult =
  | { ok: true; verb: "INSERT" | "UPDATE" | "DELETE"; sql: string }
  | { ok: false; error: string }

function sieveRawSql(rawSql: string): SieveResult {
  const stripped = stripComments(rawSql)
  if (!stripped) return { ok: false, error: "raw_sql is empty" }

  const withoutTrailingSemi = stripped.replace(/;\s*$/, "")
  if (withoutTrailingSemi.includes(";")) {
    return { ok: false, error: "multiple statements not allowed in raw_sql" }
  }

  if (RAW_SQL_BLACKLIST.test(withoutTrailingSemi)) {
    return {
      ok: false,
      error:
        "raw_sql cannot contain DDL or system pragmas (DROP/ALTER/CREATE/PRAGMA/...)",
    }
  }

  const m = withoutTrailingSemi.match(/^\s*(INSERT|UPDATE|DELETE)\b/i)
  if (!m) {
    return {
      ok: false,
      error:
        "raw_sql must start with INSERT, UPDATE, or DELETE (use run_sql for SELECT)",
    }
  }
  const verb = m[1].toUpperCase() as "INSERT" | "UPDATE" | "DELETE"

  if (verb === "UPDATE" || verb === "DELETE") {
    if (!/\bWHERE\b/i.test(withoutTrailingSemi)) {
      return {
        ok: false,
        error: `raw_sql ${verb} requires a WHERE clause`,
      }
    }
  }
  return { ok: true, verb, sql: withoutTrailingSemi }
}

// ─── Per-merchant uncategorised resolution ────────────────────────────────

const BULK_CATEGORY_THRESHOLD = 5

async function resolveUncategorisedRows(
  rows: ParsedRow[],
  staged: StagedBatch,
  hooks: ApplyChangesHooks,
): Promise<{
  rows: ParsedRow[]
  picks: { merchant: string; kind: CategoryKind; categoryName: string }[]
  skipped: string[]
}> {
  if (staged.uncategorisedCount === 0) {
    return { rows, picks: [], skipped: [] }
  }

  type Group = {
    merchant: string
    kind: CategoryKind
    sample: { amount: number; date: string }
  }
  const groups = new Map<string, Group>()
  for (const row of staged.resolvedRows) {
    if (row.categoryId) continue
    const kind: CategoryKind = row.type === "INCOME" ? "INCOME" : "EXPENSE"
    const key = normalize(row.description) || row.description
    if (groups.has(key)) continue
    groups.set(key, {
      merchant: row.description,
      kind,
      sample: { amount: row.amount, date: row.date },
    })
  }

  // Bulk fallback: too many uncategorised merchants → don't ask per-merchant,
  // let the user confirm "as-is" via the main keyboard with rows still
  // uncategorised. They can backfill later.
  if (groups.size > BULK_CATEGORY_THRESHOLD) {
    return { rows, picks: [], skipped: [] }
  }

  const picks: {
    merchant: string
    kind: CategoryKind
    categoryName: string
  }[] = []
  const skipped: string[] = []
  for (const g of groups.values()) {
    const ans = await hooks.onAskCategory(g.merchant, g.kind, g.sample)
    if (ans) {
      picks.push({
        merchant: g.merchant,
        kind: g.kind,
        categoryName: ans.categoryName,
      })
    } else {
      skipped.push(g.merchant)
    }
  }

  if (picks.length === 0) return { rows, picks, skipped }

  const pickByKey = new Map<string, string>()
  for (const p of picks) {
    const k = normalize(p.merchant) || p.merchant
    pickByKey.set(k, p.categoryName)
  }
  const updated = rows.map((r) => {
    if (r.category) return r
    const k = normalize(r.description) || r.description
    const picked = pickByKey.get(k)
    return picked ? { ...r, category: picked } : r
  })
  return { rows: updated, picks, skipped }
}

// ─── Validation + preview rendering ───────────────────────────────────────

type ValidatedInsert = { kind: "insert_transactions"; staged: StagedBatch; rows: ParsedRow[] }
type ValidatedOther = Exclude<Change, { kind: "insert_transactions" }>
type ValidatedChange = ValidatedInsert | ValidatedOther

function describeChangeForPreview(c: ValidatedChange): string {
  switch (c.kind) {
    case "insert_transactions":
      return `Insert ${c.staged.resolvedRows.length} transaction(s)`
    case "update_transaction":
      return `Update transaction <code>${c.id}</code>`
    case "delete_transaction":
      return `Delete transaction <code>${c.id}</code>`
    case "upsert_card":
      return `Upsert card <code>${c.keyword}</code> (${c.cardKind}) — ${c.label}`
    case "upsert_category":
      return `Upsert category <b>${c.name}</b> (${c.categoryKind})`
    case "upsert_asset":
      return c.id
        ? `Update asset <code>${c.id}</code> — ${c.name}`
        : `Add asset <b>${c.name}</b> (${c.assetType}${c.ticker ? `, ${c.ticker}` : ""})`
    case "upsert_loan":
      return c.id
        ? `Update loan <code>${c.id}</code> — ${c.name}`
        : `Add loan <b>${c.name}</b> (${c.loanType})`
  }
}

function renderConfirmMessage(args: {
  summary: string
  validated: ValidatedChange[]
  rawSql?: { verb: string; sql: string; expected_rows?: number }
}): string {
  const lines: string[] = []
  lines.push(`<b>Confirm:</b> ${escapeHtml(args.summary)}`)
  lines.push("")
  for (const c of args.validated) {
    lines.push(`• ${describeChangeForPreview(c)}`)
    if (c.kind === "insert_transactions") {
      // Embed the existing ingest preview directly under the bullet.
      lines.push(renderPreview(c.staged))
    }
  }
  if (args.rawSql) {
    lines.push("")
    lines.push(`⚠️ <b>raw_sql</b> (${args.rawSql.verb})`)
    lines.push(`<pre>${escapeHtml(args.rawSql.sql)}</pre>`)
    if (args.rawSql.expected_rows !== undefined) {
      lines.push(`Expected rows: ${args.rawSql.expected_rows}`)
    }
  }
  return lines.join("\n")
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// ─── Validation ───────────────────────────────────────────────────────────

type ValidationResult =
  | { ok: true; validated: ValidatedChange[] }
  | { ok: false; error: string }

async function validateChanges(
  userId: number,
  changes: Change[],
  hooks: ApplyChangesHooks,
): Promise<ValidationResult> {
  const out: ValidatedChange[] = []
  for (const c of changes) {
    switch (c.kind) {
      case "insert_transactions": {
        if (c.rows.length === 0) {
          return { ok: false, error: "insert_transactions: rows is empty" }
        }
        const known = cardKeywords()
        for (const r of c.rows) {
          if (r.amount < 0) {
            return {
              ok: false,
              error: `insert_transactions: amount must be ≥ 0 (got ${r.amount} for "${r.description}")`,
            }
          }
          if (!getCard(r.account)) {
            return {
              ok: false,
              error: `insert_transactions: unknown card "${r.account}" — known: ${known.join(", ") || "(none)"}. Add the card first via upsert_card.`,
            }
          }
        }
        const skipRulesLower = loadSkipRules(userId)
        let staged: StagedBatch
        try {
          staged = stageBatch(c.rows, skipRulesLower)
        } catch (err) {
          return {
            ok: false,
            error: `insert_transactions: ${err instanceof Error ? err.message : String(err)}`,
          }
        }

        // Ask the user about uncategorised merchants (or fall back to bulk).
        const resolved = await resolveUncategorisedRows(c.rows, staged, hooks)
        if (resolved.picks.length > 0) {
          // Re-stage with picks applied so totals reflect the choices.
          try {
            staged = stageBatch(resolved.rows, skipRulesLower)
          } catch (err) {
            return {
              ok: false,
              error: `insert_transactions (after category picks): ${err instanceof Error ? err.message : String(err)}`,
            }
          }
        }

        out.push({ kind: "insert_transactions", staged, rows: resolved.rows })
        break
      }
      case "update_transaction": {
        if (!transactionExists(c.id)) {
          return {
            ok: false,
            error: `update_transaction: no transaction with id "${c.id}"`,
          }
        }
        if (c.set.amount !== undefined && c.set.amount < 0) {
          return {
            ok: false,
            error: `update_transaction: amount must be ≥ 0 (got ${c.set.amount})`,
          }
        }
        out.push(c)
        break
      }
      case "delete_transaction": {
        if (!transactionExists(c.id)) {
          return {
            ok: false,
            error: `delete_transaction: no transaction with id "${c.id}"`,
          }
        }
        out.push(c)
        break
      }
      case "upsert_card": {
        if (!c.keyword.trim()) {
          return { ok: false, error: "upsert_card: keyword cannot be empty" }
        }
        if (!c.label.trim()) {
          return { ok: false, error: "upsert_card: label cannot be empty" }
        }
        out.push(c)
        break
      }
      case "upsert_category": {
        if (!c.name.trim()) {
          return { ok: false, error: "upsert_category: name cannot be empty" }
        }
        out.push(c)
        break
      }
      case "upsert_asset": {
        if (!c.name.trim()) {
          return { ok: false, error: "upsert_asset: name cannot be empty" }
        }
        if (
          c.ticker &&
          c.manualValue !== null &&
          c.manualValue !== undefined
        ) {
          return {
            ok: false,
            error:
              "upsert_asset: manualValue is only for non-ticker assets. Drop manualValue or drop ticker.",
          }
        }
        out.push(c)
        break
      }
      case "upsert_loan": {
        if (!c.name.trim()) {
          return { ok: false, error: "upsert_loan: name cannot be empty" }
        }
        out.push(c)
        break
      }
    }
  }
  return { ok: true, validated: out }
}

// ─── Commit ───────────────────────────────────────────────────────────────

type ApplyOk = {
  status: "applied"
  applied: Record<string, unknown>[]
}

type ApplyErr = {
  status: "error"
  error: string
}

function commitValidated(
  validated: ValidatedChange[],
  rawSql?: { verb: string; sql: string; expected_rows?: number },
): ApplyOk | ApplyErr {
  let cardsTouched = false
  try {
    const applied = runInTransaction<Record<string, unknown>[]>(() => {
      const results: Record<string, unknown>[] = []
      for (const c of validated) {
        switch (c.kind) {
          case "insert_transactions": {
            const r = insertTransactions(c.staged.resolvedRows)
            results.push({
              kind: "insert_transactions",
              inserted: r.inserted,
              firstId: r.firstId,
              lastId: r.lastId,
            })
            break
          }
          case "update_transaction": {
            const set = c.set
            let categoryId = set.categoryId
            if (set.categoryName !== undefined) {
              if (set.categoryName === null) {
                categoryId = null
              } else {
                const id = getCategoryIdByName(set.categoryName)
                if (!id) {
                  throw new Error(
                    `update_transaction: category "${set.categoryName}" not found — add it first via upsert_category`,
                  )
                }
                categoryId = id
              }
            }
            const r = updateTransaction(c.id, {
              date: set.date,
              amount: set.amount,
              type: set.type,
              description:
                set.description === undefined ? undefined : set.description,
              notes: set.notes === undefined ? undefined : set.notes,
              source: set.source === undefined ? undefined : set.source,
              categoryId:
                categoryId === undefined ? undefined : categoryId,
            })
            results.push({ kind: "update_transaction", id: c.id, ok: r.ok })
            break
          }
          case "delete_transaction": {
            const r = deleteTransactionById(c.id)
            results.push({ kind: "delete_transaction", id: c.id, ok: r.ok })
            break
          }
          case "upsert_card": {
            const r = upsertCard({
              keyword: c.keyword,
              label: c.label,
              kind: c.cardKind,
            })
            cardsTouched = true
            results.push({ kind: "upsert_card", keyword: r.keyword })
            break
          }
          case "upsert_category": {
            const r = upsertCategory({
              name: c.name,
              kind: c.categoryKind,
              color: c.color ?? null,
            })
            results.push({
              kind: "upsert_category",
              id: r.id,
              created: r.created,
            })
            break
          }
          case "upsert_asset": {
            const r = upsertAsset({
              id: c.id ?? null,
              name: c.name,
              type: c.assetType,
              currency: c.currency,
              ticker: c.ticker ?? null,
              quantity: c.quantity ?? null,
              avgBuyPrice: c.avgBuyPrice ?? null,
              manualValue: c.manualValue ?? null,
              manualValueAsOf: c.manualValueAsOf ?? null,
              notes: c.notes ?? null,
            })
            results.push({
              kind: "upsert_asset",
              id: r.id,
              created: r.created,
            })
            break
          }
          case "upsert_loan": {
            const r = upsertLoan({
              id: c.id ?? null,
              name: c.name,
              type: c.loanType,
              originalAmount: c.originalAmount,
              currentBalance: c.currentBalance,
              interestRate: c.interestRate,
              currency: c.currency,
              startDate: c.startDate ?? null,
              endDate: c.endDate ?? null,
            })
            results.push({
              kind: "upsert_loan",
              id: r.id,
              created: r.created,
            })
            break
          }
        }
      }
      if (rawSql) {
        const info = execRaw(rawSql.sql)
        if (
          (rawSql.verb === "UPDATE" || rawSql.verb === "DELETE") &&
          rawSql.expected_rows !== undefined &&
          info.changes !== rawSql.expected_rows
        ) {
          throw new Error(
            `raw_sql: expected_rows ${rawSql.expected_rows} but ${info.changes} row(s) matched — rolling back`,
          )
        }
        results.push({
          kind: "raw_sql",
          verb: rawSql.verb,
          changes: info.changes,
        })
      }
      return results
    })
    if (cardsTouched) refreshCards()
    return { status: "applied", applied }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { status: "error", error: msg }
  }
}

// ─── Tool factory ─────────────────────────────────────────────────────────

const APPLY_CHANGES_DESCRIPTION =
  "Make changes to the user's finance database. ALL writes go through this tool. " +
  "Pass a typed `changes` array (preferred) and/or a `raw_sql` escape hatch. " +
  "The bot shows the user a preview + confirm keyboard internally; the tool only " +
  "commits on ✅. Returns {status: 'applied' | 'cancelled' | 'timeout' | 'error'}. " +
  "Don't ask the user to confirm in chat — this tool already does. " +
  "For PDF ingest: use kind='insert_transactions'; the rows go through skip rules + " +
  "importHash dedup + per-merchant category prompts automatically. Set dry_run=true " +
  "first if you want a preview without showing the user a confirm keyboard."

export function buildApplyChangesTool(userId: number, hooks: ApplyChangesHooks) {
  return betaZodTool({
    name: "apply_changes",
    description: APPLY_CHANGES_DESCRIPTION,
    inputSchema: applyChangesInputSchema,
    run: async (input: ApplyChangesInput) => {
      const changes = (input.changes ?? []) as Change[]
      const summary = input.summary ?? "(no summary)"
      const dryRun = input.dry_run === true

      if (changes.length === 0 && !input.raw_sql) {
        return JSON.stringify({
          status: "error",
          error: "apply_changes: provide at least one change or raw_sql",
        })
      }

      // raw_sql sieve
      let rawSql: { verb: "INSERT" | "UPDATE" | "DELETE"; sql: string; expected_rows?: number } | undefined
      if (input.raw_sql) {
        const sieve = sieveRawSql(input.raw_sql.sql)
        if (!sieve.ok) {
          return JSON.stringify({ status: "error", error: sieve.error })
        }
        if (
          (sieve.verb === "UPDATE" || sieve.verb === "DELETE") &&
          input.raw_sql.expected_rows === undefined
        ) {
          return JSON.stringify({
            status: "error",
            error: `raw_sql ${sieve.verb} requires expected_rows for safety`,
          })
        }
        rawSql = {
          verb: sieve.verb,
          sql: sieve.sql,
          expected_rows: input.raw_sql.expected_rows,
        }
      }

      // Validate typed changes (also runs per-merchant category prompts on
      // insert_transactions before we render the preview).
      const validation = await validateChanges(userId, changes, hooks)
      if (!validation.ok) {
        return JSON.stringify({ status: "error", error: validation.error })
      }
      const validated = validation.validated

      // Empty staged ingest?  Surface that clearly.
      const insertChange = validated.find(
        (c): c is ValidatedInsert => c.kind === "insert_transactions",
      )
      if (insertChange && insertChange.staged.resolvedRows.length === 0) {
        return JSON.stringify({
          status: "empty",
          summary: renderPreview(insertChange.staged),
          note:
            "Nothing new to insert (all rows skipped by rule or already in DB).",
        })
      }

      // dry_run: return the rendered preview, do NOT confirm or commit.
      if (dryRun) {
        return JSON.stringify({
          status: "preview",
          preview: renderConfirmMessage({ summary, validated, rawSql }),
          insertCount: insertChange?.staged.resolvedRows.length ?? 0,
          uncategorisedCount: insertChange?.staged.uncategorisedCount ?? 0,
        })
      }

      // One confirm in flight per user.
      if (inflightConfirmByUser.has(userId)) {
        return JSON.stringify({
          status: "error",
          error:
            "another change is awaiting confirmation — resolve it first (or it will time out)",
        })
      }
      inflightConfirmByUser.add(userId)
      console.log(
        `[apply_changes] user=${userId} confirm-requested changes=${validated.map((c) => c.kind).join(",")} rawSql=${rawSql ? rawSql.verb : "none"}`,
      )
      try {
        // Build accept-button label.
        let acceptLabel = "Apply"
        if (insertChange) {
          acceptLabel = `Insert ${insertChange.staged.resolvedRows.length}`
        } else if (validated.length === 1) {
          const c = validated[0]
          if (c.kind === "delete_transaction") acceptLabel = "Delete"
          else if (c.kind.startsWith("upsert_")) acceptLabel = "Save"
          else if (c.kind === "update_transaction") acceptLabel = "Update"
        }

        const confirmText = renderConfirmMessage({ summary, validated, rawSql })
        const confirmed = await hooks.onConfirm(confirmText, acceptLabel)
        console.log(
          `[apply_changes] user=${userId} confirm-resolved=${confirmed}`,
        )
        if (!confirmed) {
          return JSON.stringify({ status: "cancelled" })
        }

        const result = commitValidated(validated, rawSql)
        console.log(
          `[apply_changes] user=${userId} commit-result=${result.status}`,
        )
        return JSON.stringify(result)
      } finally {
        inflightConfirmByUser.delete(userId)
      }
    },
  })
}
