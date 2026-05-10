import { cardKeywords, getCard } from "../db/cards.js"
import { descriptionMatchesAnyRule } from "../memory/skip-rules.js"
import {
  existsTransaction,
  getCategoryIdByName,
  type InsertableRow,
} from "../db/write.js"

export type ParsedRow = {
  date: string // YYYY-MM-DD
  amount: number
  type: "INCOME" | "EXPENSE"
  description: string
  // Card keyword from the Card table. Written verbatim into Transaction.source.
  account: string
  category: string | null
}

// ─── Staging ───────────────────────────────────────────────────────────────

export type PerSourceTotals = {
  account: string // card keyword
  label: string
  count: number
  income: number
  expense: number
}

export type PerCategoryTotals = {
  name: string
  count: number
  sum: number
}

export type StagedBatch = {
  resolvedRows: InsertableRow[]
  parsedCount: number
  skippedCount: number
  skippedByRuleCount: number
  uncategorisedCount: number
  dateRange: { from: string; to: string } | null
  totals: { income: number; expense: number; net: number }
  perSource: PerSourceTotals[]
  perCategory: PerCategoryTotals[] // EXPENSE rows only, sorted desc by sum
}

export function stageBatch(
  rows: ParsedRow[],
  skipRulesLower: string[] = [],
): StagedBatch {
  if (rows.length === 0) {
    throw new Error("no rows parsed from statements")
  }

  const known = cardKeywords()
  for (const r of rows) {
    if (!getCard(r.account)) {
      throw new Error(
        `unknown card "${r.account}" — must be one of the existing Card.keyword values: ${known.join(", ") || "(none — add a card first)"}`,
      )
    }
  }

  const parsedCount = rows.length

  // Drop rows whose description matches a user skip rule before any further
  // processing. These never reach the staging or dedup layers.
  let skippedByRuleCount = 0
  if (skipRulesLower.length > 0) {
    const kept: ParsedRow[] = []
    for (const r of rows) {
      if (descriptionMatchesAnyRule(r.description, skipRulesLower)) {
        skippedByRuleCount++
      } else {
        kept.push(r)
      }
    }
    rows = kept
  }

  type Pair = { parsed: ParsedRow; resolved: InsertableRow }
  const allPairs: Pair[] = rows.map((r) => {
    const categoryId = r.category ? getCategoryIdByName(r.category) : null
    return {
      parsed: r,
      resolved: {
        date: r.date,
        amount: r.amount,
        type: r.type,
        description: r.description,
        source: r.account, // the card keyword IS the source
        categoryId,
      },
    }
  })

  // Dedup against existing DB rows via importHash.
  const toInsert: Pair[] = []
  const skipped: Pair[] = []
  for (const p of allPairs) {
    if (existsTransaction(p.resolved)) {
      skipped.push(p)
    } else {
      toInsert.push(p)
    }
  }

  const empty: StagedBatch = {
    resolvedRows: [],
    parsedCount,
    skippedCount: skipped.length,
    skippedByRuleCount,
    uncategorisedCount: 0,
    dateRange: null,
    totals: { income: 0, expense: 0, net: 0 },
    perSource: [],
    perCategory: [],
  }
  if (toInsert.length === 0) return empty

  const uncategorisedCount = toInsert.filter(
    (p) => !p.resolved.categoryId,
  ).length

  const perSourceMap = new Map<string, PerSourceTotals>()
  for (const { parsed } of toInsert) {
    const cur = perSourceMap.get(parsed.account) ?? {
      account: parsed.account,
      label: getCard(parsed.account)?.label ?? parsed.account,
      count: 0,
      income: 0,
      expense: 0,
    }
    cur.count++
    if (parsed.type === "EXPENSE") cur.expense += parsed.amount
    else if (parsed.type === "INCOME") cur.income += parsed.amount
    perSourceMap.set(parsed.account, cur)
  }

  const dates = toInsert.map((p) => p.parsed.date)
  const dateRange = {
    from: dates.reduce((a, b) => (a < b ? a : b)),
    to: dates.reduce((a, b) => (a > b ? a : b)),
  }

  let income = 0
  let expense = 0
  for (const { parsed } of toInsert) {
    if (parsed.type === "INCOME") income += parsed.amount
    else if (parsed.type === "EXPENSE") expense += parsed.amount
  }

  const byCat = new Map<string, PerCategoryTotals>()
  for (const { parsed } of toInsert) {
    if (parsed.type !== "EXPENSE") continue
    const name = parsed.category || "Uncategorised"
    const cur = byCat.get(name) ?? { name, count: 0, sum: 0 }
    cur.count++
    cur.sum += parsed.amount
    byCat.set(name, cur)
  }
  const perCategory = [...byCat.values()].sort((a, b) => b.sum - a.sum)

  return {
    resolvedRows: toInsert.map((p) => p.resolved),
    parsedCount,
    skippedCount: skipped.length,
    skippedByRuleCount,
    uncategorisedCount,
    dateRange,
    totals: { income, expense, net: income - expense },
    perSource: [...perSourceMap.values()],
    perCategory,
  }
}

