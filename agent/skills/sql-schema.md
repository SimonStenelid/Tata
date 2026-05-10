# sql-schema

Read the personal-finance SQLite database. Load this skill before composing any
non-trivial `run_sql` query.

All tables have CUID string primary keys. Default currency is SEK.

## Tables

### Transaction — every money movement
```
id          TEXT PRIMARY KEY
date        DATETIME           -- indexed
amount      REAL               -- ALWAYS POSITIVE; sign implied by 'type'
type        TEXT               -- 'INCOME' | 'EXPENSE'
description TEXT NULL
notes       TEXT NULL
source      TEXT NULL          -- card keyword, FK-by-convention → Card.keyword
                               -- (e.g. 'debit', 'amex'). JOIN Card to get the
                               -- human label. Match case-sensitively.
categoryId  TEXT NULL          -- FK → Category.id
importHash  TEXT UNIQUE NULL
createdAt   DATETIME
updatedAt   DATETIME
```

### Card — cards / rails the user can ingest from
```
keyword   TEXT PRIMARY KEY     -- stable id, also Transaction.source
label     TEXT                 -- human-readable name, e.g. 'Handelsbanken'
kind      TEXT                 -- 'DEBIT' | 'CREDIT'
createdAt DATETIME
```

### Category — labels for transactions
```
id    TEXT PRIMARY KEY
name  TEXT UNIQUE
kind  TEXT               -- 'INCOME' | 'EXPENSE'
color TEXT NULL
```

### Asset — non-account holdings
```
id              TEXT PRIMARY KEY
name            TEXT
type            TEXT  -- 'STOCK'|'FUND'|'CRYPTO'|'REAL_ESTATE'|'VEHICLE'|'COLLECTIBLE'|'OTHER'
currency        TEXT  -- the currency 'avgBuyPrice' is in (e.g. 'USD' for AAPL)
ticker          TEXT NULL  -- Yahoo Finance symbol
quantity        REAL NULL
avgBuyPrice     REAL NULL  -- per-unit cost basis, in 'currency'
manualValue     REAL NULL  -- ONLY for non-ticker assets; ticker'd ones go via market_data
manualValueAsOf DATETIME NULL
notes           TEXT NULL
```

### Loan — debts
```
id             TEXT PRIMARY KEY
name           TEXT
type           TEXT
originalAmount REAL
currentBalance REAL
interestRate   REAL
currency       TEXT
startDate      DATETIME NULL
endDate        DATETIME NULL
```

## Semantic rules

- "Spending" / "expenses" → `Transaction.type = 'EXPENSE'`.
- "Income" / "earned" → `Transaction.type = 'INCOME'`.
- "On Amex" / "on my debit card" → `JOIN Card ON Transaction.source = Card.keyword`
  and filter by `Card.label LIKE …` or `Card.kind`. The user thinks in labels
  ("Handelsbanken", "Amex"), the DB stores keywords ("debit", "amex").
- Net for a period = SUM(income) − SUM(expenses).
- Categories can be null (uncategorised); mention if material.
- Use `strftime('%Y-%m', date) = 'YYYY-MM'` for month filtering.
- For ticker'd assets, current value comes from `market_data` (priceSek), NEVER
  from `manualValue`. `manualValue` is only for real estate / vehicles / etc.
- Cost basis for an asset:
    if `currency = 'SEK'` → `quantity * avgBuyPrice`
    else                → `quantity * avgBuyPrice * fxToSek` (from market_data)

## Query hygiene

- `run_sql` only accepts a single SELECT (or WITH … SELECT). No INSERT/UPDATE/DELETE/DDL.
- Results are capped at 200 rows. If `truncated: true`, refine with WHERE / LIMIT.
- Quote string comparisons with `lower(...)` when matching user-typed labels.
