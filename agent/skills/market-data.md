# market-data

Fetch live and historical market data. All prices come back in SEK (originals
included for transparency, plus the FX rate used).

## Operations

- `quote` — current price for up to 25 symbols.
  Args: `{ op: "quote", symbols: string[] }`.

- `historical` — OHLC time series for one symbol.
  Args: `{ op: "historical", symbol, from: "YYYY-MM-DD", to?, interval?: "1d"|"1wk"|"1mo" }`.
  Capped at 400 points; downsampled if the range is wider.

- `search` — resolve a name to a ticker symbol.
  Args: `{ op: "search", query: string }`.

- `summary` — fundamentals (PE, dividend yield, market cap, …) for one symbol.
  Args: `{ op: "summary", symbol, modules?: string[] }`. Default modules:
  `price`, `summaryDetail`, `defaultKeyStatistics`.

## Symbol conventions (Yahoo Finance)

- US equity: `AAPL`, `MSFT`, `TSLA`
- Stockholm: `INVE-B.ST`, `SEB-A.ST` (note `-A`/`-B` and `.ST` suffix)
- Xetra: `VWCE.DE`
- Crypto: `BTC-USD`, `ETH-USD`
- FX: `USDSEK=X`, `EURSEK=X`

If you don't know the ticker, use `op: "search"` first.

## Asset valuation

For a `Transaction`-table Asset row with a non-null `ticker`:
- **current value** = `quantity * priceSek` (from `quote`)
- **cost basis (SEK):** if `Asset.currency = 'SEK'` → `quantity * avgBuyPrice`;
  otherwise → `quantity * avgBuyPrice * fxToSek` (FX from any `quote` result on
  the same currency, or from `USDSEK=X`-style FX).
- **unrealized P/L (SEK)** = current value − cost basis.

Never use `manualValue` for ticker'd assets — it's only for real estate /
vehicles / collectibles.

## Caching (good news, you don't have to think about it)

- Quotes: 60s
- FX: 5min
- Historical/summary/search: 10min
