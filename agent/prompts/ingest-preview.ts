import type { StagedBatch } from "../tools/ingest-tools.js"

const TOP_CATEGORIES = 5

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function krSek(n: number): string {
  return new Intl.NumberFormat("sv-SE", {
    style: "currency",
    currency: "SEK",
    maximumFractionDigits: 0,
  }).format(n)
}

function signed(n: number): string {
  if (n === 0) return krSek(0)
  const sign = n > 0 ? "+" : "−"
  return `${sign}${krSek(Math.abs(n))}`
}

function padEnd(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length)
}

function padStart(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s
}

export function renderPreview(staged: StagedBatch): string {
  const {
    resolvedRows,
    parsedCount,
    skippedCount,
    skippedByRuleCount,
    uncategorisedCount,
    dateRange,
    totals,
    perSource,
    perCategory,
  } = staged

  if (resolvedRows.length === 0) {
    const notes: string[] = []
    if (skippedByRuleCount > 0) notes.push(`${skippedByRuleCount} skipped by rule`)
    if (skippedCount > 0) notes.push(`${skippedCount} already in DB`)
    const tail = notes.length > 0 ? ` (${notes.join(", ")})` : ""
    return `📄 Parsed <b>${parsedCount}</b> transactions — nothing new to insert${tail}.`
  }

  const lines: string[] = []

  const range = dateRange ? ` · ${dateRange.from} → ${dateRange.to}` : ""
  lines.push(
    `📄 Parsed <b>${parsedCount}</b> transactions${range}`,
  )
  lines.push("")

  // By card — one line each, with tx count and in/out figures.
  lines.push("<b>By card</b>")
  for (const s of perSource) {
    const parts: string[] = [`${s.count} tx`]
    if (s.income > 0) parts.push(`in ${krSek(s.income)}`)
    if (s.expense > 0) parts.push(`out ${krSek(s.expense)}`)
    lines.push(`  ${escapeHtml(s.label)} — ${parts.join(" · ")}`)
  }
  lines.push("")

  // Money totals.
  lines.push("<b>Money</b>")
  lines.push(`  Income     ${signed(totals.income)}`)
  lines.push(`  Expenses   ${signed(-totals.expense)}`)
  lines.push(`  Net        <b>${signed(totals.net)}</b>`)

  // Top expense categories in a monospace block so columns line up.
  if (perCategory.length > 0) {
    const shown = perCategory.slice(0, TOP_CATEGORIES)
    const rest = perCategory.slice(TOP_CATEGORIES)
    const nameW = Math.max(
      ...shown.map((c) => c.name.length),
      rest.length > 0 ? `…${rest.length} more`.length : 0,
    )
    const countW = Math.max(...shown.map((c) => String(c.count).length), 2)

    const rows: string[] = []
    for (const c of shown) {
      rows.push(
        `${padEnd(escapeHtml(c.name), nameW)}  ${padStart(String(c.count), countW)}  ${padStart(krSek(c.sum), 10)}`,
      )
    }
    if (rest.length > 0) {
      const restCount = rest.reduce((a, b) => a + b.count, 0)
      const restSum = rest.reduce((a, b) => a + b.sum, 0)
      rows.push(
        `${padEnd(`…${rest.length} more`, nameW)}  ${padStart(String(restCount), countW)}  ${padStart(krSek(restSum), 10)}`,
      )
    }

    lines.push("")
    lines.push("<b>Top expense categories</b>")
    lines.push(`<pre>${rows.join("\n")}</pre>`)
  }

  // Footers.
  const footers: string[] = []
  if (skippedByRuleCount > 0) {
    footers.push(
      `🚫 ${skippedByRuleCount} row(s) skipped per your /skip rules`,
    )
  }
  if (skippedCount > 0) {
    footers.push(
      `🔁 ${skippedCount} duplicate row(s) skipped (already in DB)`,
    )
  }
  if (uncategorisedCount > 0) {
    footers.push(
      `⚠️ ${uncategorisedCount} row(s) will be saved as Uncategorised`,
    )
  }
  if (footers.length > 0) {
    lines.push("")
    lines.push(...footers)
  }

  return lines.join("\n")
}
