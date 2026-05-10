# cards-and-categories

Add, rename, or delete cards and categories. Everything goes through
`apply_changes`. Load `write-changes` for the full Change taxonomy.

## Cards (`Card` table)

Columns: `keyword` (PK, e.g. `'debit'`), `label` (display name), `kind` (`DEBIT` | `CREDIT`).

User intents:

- **"Add a Revolut card"** →
  ```
  apply_changes({
    summary: "Add Revolut as a debit card",
    changes: [{ kind: "upsert_card", keyword: "revolut", label: "Revolut", cardKind: "DEBIT" }]
  })
  ```
  Always confirm the `keyword` slug with the user before calling — it gets baked into every imported row.

- **"Rename the Amex label to Platinum"** → same shape, same keyword:
  ```
  { kind: "upsert_card", keyword: "amex", label: "Platinum", cardKind: "CREDIT" }
  ```
  Don't change the keyword; existing transactions reference it.

- **"Delete a card"** → not a typed Change. Use raw_sql with `expected_rows: 1`,
  but warn the user this orphans any existing transactions that reference its
  keyword. Usually better to leave the card row alone and just stop using it.

## Categories (`Category` table)

Columns: `id` (PK CUID), `name` (UNIQUE), `kind` (`INCOME` | `EXPENSE`), `color` (nullable).

User intents:

- **"Add a Travel category"** →
  ```
  apply_changes({
    summary: "Add Travel category (EXPENSE)",
    changes: [{ kind: "upsert_category", name: "Travel", categoryKind: "EXPENSE" }]
  })
  ```

- **"Rename Dining & Bars to Restaurants"** → not a typed Change (rename
  changes the unique key). Use raw_sql with `expected_rows: 1`:
  ```
  apply_changes({
    summary: "Rename category Dining & Bars → Restaurants",
    raw_sql: {
      sql: "UPDATE Category SET name = 'Restaurants' WHERE name = 'Dining & Bars'",
      expected_rows: 1
    }
  })
  ```

- **"Merge X into Y"** → typically two raw_sql changes in one call:
  ```
  apply_changes({
    summary: "Merge Health-old into Health, then drop the old one",
    raw_sql: {
      sql: "UPDATE Transaction SET categoryId = (SELECT id FROM Category WHERE name = 'Health') WHERE categoryId = (SELECT id FROM Category WHERE name = 'Health-old')",
      expected_rows: <count from a prior run_sql>
    }
  })
  ```
  Then a second `apply_changes` to delete the old category row.

When adding, pick a sensible default kind from the user's wording — purchases →
EXPENSE, salary/refunds → INCOME. Confirm if ambiguous.
