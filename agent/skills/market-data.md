# market-data

Fetch live and historical market data. Prices are converted to the user's
currency (originals always included, plus the FX rate used).

## The user's currency

Read it from `/memories/profile.md` (the `Currency:` line) and pass it as
`targetCurrency` on `quote` and `historical`. If profile.md has no
`Currency:` line, derive it from the `Country:` line (Sweden→SEK, US→USD,
UK→GBP, Germany/France/etc.→EUR, …) and write it back to profile.md in
the same turn. If neither exists, default to SEK and ask the user.

## Operations

- `quote` — current price for up to 25 symbols.
  Args: `{ op: "quote", symbols: string[], targetCurrency?: string }`.

- `historical` — OHLC time series for one symbol.
  Args: `{ op: "historical", symbol, from: "YYYY-MM-DD", to?, interval?: "1d"|"1wk"|"1mo", targetCurrency? }`.
  Capped at 400 points; downsampled if the range is wider.

- `search` — resolve a name to a ticker symbol.
  Args: `{ op: "search", query: string }`.

- `summary` — fundamentals (PE, dividend yield, market cap, …) for one symbol.
  Args: `{ op: "summary", symbol, modules?: string[] }`. Default modules:
  `price`, `summaryDetail`, `defaultKeyStatistics`.

## Result fields

`quote` and `historical` return both:
- `priceUser` / `closeUser` + `currencyUser` + `fxToUser` — converted into
  the user's currency.
- `priceOriginal` / `closeOriginal` + `currencyOriginal` — native currency
  of the instrument.

## Symbol conventions (Yahoo Finance)

- US equity: `AAPL`, `MSFT`, `TSLA`
- Stockholm: `INVE-B.ST`, `SEB-A.ST` (note `-A`/`-B` and `.ST` suffix)
- Xetra: `VWCE.DE`
- Crypto: `BTC-USD`, `ETH-USD`
- FX: `USDSEK=X`, `EURSEK=X`, `USDEUR=X`

If you don't know the ticker, use `op: "search"` first.

## Asset valuation

For a `Transaction`-table Asset row with a non-null `ticker`:
- **current value** = `quantity * priceUser` (from `quote` with
  `targetCurrency` set to the user's currency).
- **cost basis (user currency):** if `Asset.currency` matches the user's
  currency → `quantity * avgBuyPrice`; otherwise →
  `quantity * avgBuyPrice * fx`, where `fx` is the rate from
  `Asset.currency` to the user's currency (use any `quote` result on the
  same currency, or a direct FX symbol like `USDEUR=X`).
- **unrealized P/L** = current value − cost basis (same currency on both sides).

Never use `manualValue` for ticker'd assets — it's only for real estate /
vehicles / collectibles.

## Caching (good news, you don't have to think about it)

- Quotes: 60s
- FX: 5min
- Historical/summary/search: 10min
