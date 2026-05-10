# write-changes

ALL writes go through `apply_changes`. The tool drives a Telegram inline-keyboard
confirmation internally — you issue ONE call and read the result. Never ask the
user to confirm in chat first; that's the tool's job.

## Tool surface

```
apply_changes({
  summary: string,            // one-line headline shown to the user
  dry_run?: boolean,          // true → preview only, no confirm keyboard
  changes?: Change[],
  raw_sql?: { sql: string, expected_rows?: number }   // escape hatch
})
```

Returns `{ status, ... }` where status is one of:
- `applied` — the user tapped ✅; rows committed in a single SQLite transaction.
- `cancelled` — user tapped ❌, sent a new message, or no resolution arrived.
- `timeout` — 5-minute keyboard timeout.
- `error` — validation failure, FK miss, sieve rejection, expected_rows mismatch, etc. The `error` field tells you what went wrong; the user has not been bothered.
- `empty` — nothing left to commit (all rows skipped by rule or already in DB).
- `preview` — dry_run only.

If `error` comes back, fix and retry — don't surface raw error text to the
user unless they need it. If `cancelled`, acknowledge briefly and wait.

## Change kinds (typed — preferred)

### `insert_transactions`
```
{ kind: "insert_transactions", rows: ParsedRow[] }
```
Goes through skip-rule filter, importHash dedup, and per-merchant category
prompts automatically. See the `ingest-statements` skill.

### `update_transaction`
```
{
  kind: "update_transaction",
  id: "<Transaction.id>",
  set: {
    date?, amount?, type?,
    description?, notes?,
    source?, categoryId?,
    categoryName?  // convenience: server resolves to categoryId
  }
}
```
Only fields you set get changed. `amount` must be ≥ 0.

### `delete_transaction`
```
{ kind: "delete_transaction", id: "<Transaction.id>" }
```
Idempotent — fails clearly if the id doesn't exist.

### `upsert_card`
```
{ kind: "upsert_card", keyword: "revolut", label: "Revolut", cardKind: "DEBIT" | "CREDIT" }
```
`keyword` is the stable id (also `Transaction.source`). Don't rename it; it's
referenced by every transaction row that came in via that card.

### `upsert_category`
```
{ kind: "upsert_category", name: "Travel", categoryKind: "EXPENSE", color?: string }
```
Updates by exact name match (case-sensitive).

### `upsert_asset`
```
{
  kind: "upsert_asset",
  id?,                        // omit to create
  name, assetType,            // STOCK | FUND | CRYPTO | REAL_ESTATE | VEHICLE | COLLECTIBLE | OTHER
  currency?,                  // default "SEK"
  ticker?,                    // Yahoo symbol; null for non-ticker assets
  quantity?, avgBuyPrice?,
  manualValue?, manualValueAsOf?,   // ONLY for non-ticker assets
  notes?
}
```
Setting both `ticker` AND `manualValue` is rejected. Pick one.

### `upsert_loan`
```
{
  kind: "upsert_loan",
  id?,
  name, loanType,             // MORTGAGE | CAR | STUDENT | PERSONAL | CREDIT_LINE | OTHER
  originalAmount, currentBalance,
  interestRate?,              // default 0
  currency?,                  // default "SEK"
  startDate?, endDate?
}
```

## raw_sql escape hatch

Use only when no typed Change kind fits (e.g. bulk recategorisation, merging
two categories' transactions). Prefer typed changes whenever possible.

The sieve will REJECT:
- Multiple statements (any `;` other than trailing).
- DDL: `DROP | ALTER | CREATE | ATTACH | DETACH | REINDEX | PRAGMA | VACUUM | REPLACE | TRUNCATE`.
- Anything that doesn't start with `INSERT`, `UPDATE`, or `DELETE`.
- `UPDATE` or `DELETE` without `WHERE`.
- `UPDATE` or `DELETE` without `expected_rows` set.

`expected_rows` is checked after the statement runs — if the rowcount differs,
the entire transaction (including any typed changes in the same call) rolls
back. Always set it conservatively; don't guess.

Confirmation message highlights `raw_sql` so the user sees it. Be ready for
them to cancel.

## dry_run

Set `dry_run: true` to get a preview WITHOUT showing the user a confirm
keyboard. Useful only for ingest where you want to inspect totals before
committing. For non-ingest writes (cards, categories, assets, loans, edits,
deletes), skip dry_run — the confirm keyboard is sufficient.

## Examples

**Add a card:**
```
apply_changes({
  summary: "Add Revolut as a debit card",
  changes: [{ kind: "upsert_card", keyword: "revolut", label: "Revolut", cardKind: "DEBIT" }]
})
```

**Delete a transaction:**
```
apply_changes({
  summary: "Delete duplicate Amazon row from 2026-04-12",
  changes: [{ kind: "delete_transaction", id: "tg…" }]
})
```

**Recategorise all uncategorised Spotify rows to Subscriptions:**
```
apply_changes({
  summary: "Recategorise 8 Spotify rows → Subscriptions",
  raw_sql: {
    sql: "UPDATE Transaction SET categoryId = (SELECT id FROM Category WHERE name = 'Subscriptions') WHERE description LIKE '%Spotify%' AND categoryId IS NULL",
    expected_rows: 8
  }
})
```
