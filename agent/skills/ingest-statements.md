# ingest-statements

The user uploaded one or more PDF statements. Load this skill (and
`write-changes`) when you see `document` blocks in the user content.

## Workflow

1. **Identify which `Card.keyword` each PDF belongs to.**
   - If you don't already know which cards exist, run
     `SELECT keyword, label, kind FROM Card`.
   - Match the PDF (issuer name, header, card number format) to one of those keywords.
   - If the user didn't specify a card and you can't infer it confidently,
     **ASK in chat** before parsing — do not guess.
   - If the user names a card that doesn't exist yet (e.g. "Revolut"), propose
     an `upsert_card` change first via `apply_changes`. Once that's confirmed
     and applied, do the ingest in a follow-up `apply_changes` call.

2. **For every transaction line in every PDF**, build a row:
   ```
   {
     date: "YYYY-MM-DD",
     amount: <positive number>,
     type: "EXPENSE" | "INCOME",
     description: "<merchant text>",
     account: "<Card.keyword>",
     category: "<canonical name>" | null
   }
   ```

3. **Apply category heuristics** (below). If unsure, set `category: null` —
   `apply_changes` will ask the user per merchant via inline keyboard
   (up to 5 unique merchants; more than that falls back to "apply with
   uncategorised" so the user isn't tap-spammed).

4. **Call `apply_changes`** with the FULL combined list:
   ```
   apply_changes({
     summary: "Import 47 transactions from 2 statements",
     changes: [{ kind: "insert_transactions", rows: [...] }]
   })
   ```
   The tool stages the rows (skip-rule filter + importHash dedup), runs the
   per-merchant prompts internally, then shows the user a preview keyboard.
   On ✅ it commits; the result tells you the inserted count.

   **Optional `dry_run: true`** if you want to inspect totals without
   committing. The keyboard is skipped; you get back `{status: "preview", preview, insertCount, uncategorisedCount}`.

5. **After `apply_changes` returns**, reply briefly:
   - `applied` → "Imported <N> transactions. 🐾"
   - `cancelled` / `timeout` → say so kindly.
   - `empty` → "Nothing new — all rows were either duplicates or skipped by your rules."
   - `error` → diagnose; usually the issue is an unknown `account` keyword
     (propose an `upsert_card` first) or an empty rows array.

## Conventions

- `amount` is **ALWAYS POSITIVE**. Purchase = `EXPENSE`. Salary/refund = `INCOME`.
- Skip non-transaction lines: balance summaries, interest accruals, headers, page footers.
- Skip transfers between the user's own accounts entirely.
- Dates: convert "2026-03-15" / "15/03 2026" / "15 Mar 2026" all to "2026-03-15".
- Amex statements may include foreign-currency rows with a SEK conversion line —
  use the SEK amount.

## Category heuristics (Swedish context, case-insensitive substring)

- **Groceries:** ICA, Coop, Lidl, Willys, Hemköp, City Gross, Pressbyrån, Tempo, Mathem
- **Transport:** SL, Västtrafik, SJ, MTR, Uber, Bolt, Taxi, Q-park, Circle K, OKQ8, Preem, Shell
- **Dining & Bars:** restaurants, cafés, bars, Foodora, Wolt, UberEats, Starbucks, Espresso House
- **Entertainment:** cinemas (Filmstaden), event tickets, streaming one-offs
- **Subscriptions:** Netflix, Spotify, HBO, Disney+, Apple, Google, iCloud, Adobe, GitHub, gym memberships
- **Shopping:** clothing, electronics, H&M, Zara, Elgiganten, Webhallen, Amazon, IKEA, Åhléns
- **Health:** pharmacy (Apoteket, Kronans), doctor, dental, fitness-only gym
- **Housing:** rent (Hyra), electricity, Telia/Telenor/Tre, insurance (Folksam, IF, Länsförsäkringar)

If unsure, set `category: null`. Don't force a fit.

## Output discipline during ingest

- Don't dump the row list in chat — it goes in the `apply_changes` call.
- Before the `apply_changes` call, say ONE short sentence: "Parsing 47
  transactions — confirm below."
- The bot may silently drop rows that match the user's
  `/memories/ingest-skip.md` patterns. Always pass the FULL list; the tool
  filters before staging.
