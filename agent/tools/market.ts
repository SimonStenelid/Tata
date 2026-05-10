import YahooFinance from "yahoo-finance2"
import type { Quote } from "yahoo-finance2/modules/quote"

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] })

const QUOTE_TTL_MS = 60_000
const FX_TTL_MS = 5 * 60_000
const HISTORICAL_TTL_MS = 10 * 60_000
const SUMMARY_TTL_MS = 10 * 60_000
const SEARCH_TTL_MS = 10 * 60_000

const MAX_QUOTE_SYMBOLS = 25
const MAX_HISTORICAL_POINTS = 400

type CacheEntry<T> = { value: T; expiresAt: number }
const cache = new Map<string, CacheEntry<unknown>>()

function getCached<T>(key: string): T | undefined {
  const e = cache.get(key)
  if (!e) return undefined
  if (Date.now() > e.expiresAt) {
    cache.delete(key)
    return undefined
  }
  return e.value as T
}

function setCached<T>(key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })
}

async function getFxToSek(currency: string): Promise<number> {
  const ccy = currency.toUpperCase()
  if (ccy === "SEK") return 1
  const key = `fx:${ccy}`
  const cached = getCached<number>(key)
  if (cached !== undefined) return cached

  const symbol = `${ccy}SEK=X`
  const q = await yf.quote(symbol)
  const rate = q?.regularMarketPrice
  if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) {
    throw new Error(`Could not resolve FX rate ${ccy}→SEK (symbol ${symbol})`)
  }
  setCached(key, rate, FX_TTL_MS)
  return rate
}

export type QuoteResult = {
  symbol: string
  name: string | null
  priceSek: number
  priceOriginal: number
  currencyOriginal: string
  fxToSek: number
  marketState: string | null
  asOf: string | null
}

export type ToolError = { symbol?: string; error: string }

async function opQuote(symbols: string[]): Promise<{ quotes: QuoteResult[]; errors: ToolError[] }> {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error("symbols must be a non-empty array")
  }
  if (symbols.length > MAX_QUOTE_SYMBOLS) {
    throw new Error(`max ${MAX_QUOTE_SYMBOLS} symbols per quote call`)
  }

  const quotes: QuoteResult[] = []
  const errors: ToolError[] = []
  const toFetch: string[] = []

  for (const s of symbols) {
    const cached = getCached<QuoteResult>(`quote:${s}`)
    if (cached) quotes.push(cached)
    else toFetch.push(s)
  }

  if (toFetch.length === 0) return { quotes, errors }

  let arr: Quote[]
  try {
    arr = await yf.quote(toFetch)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { quotes, errors: [...errors, { error: `quote batch failed: ${msg}` }] }
  }

  const returnedSymbols = new Set(arr.map((q) => q.symbol))
  for (const s of toFetch) {
    if (!returnedSymbols.has(s)) {
      errors.push({ symbol: s, error: "no data returned (unknown symbol?)" })
    }
  }

  for (const q of arr) {
    try {
      const price = q.regularMarketPrice
      const ccy = (q.currency ?? "USD").toUpperCase()
      if (typeof price !== "number" || !isFinite(price)) {
        errors.push({ symbol: q.symbol, error: "no regularMarketPrice" })
        continue
      }
      const fx = await getFxToSek(ccy)
      const result: QuoteResult = {
        symbol: q.symbol,
        name:
          ("shortName" in q && typeof q.shortName === "string" && q.shortName) ||
          ("longName" in q && typeof q.longName === "string" && q.longName) ||
          null,
        priceSek: price * fx,
        priceOriginal: price,
        currencyOriginal: ccy,
        fxToSek: fx,
        marketState: q.marketState ?? null,
        asOf: q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : null,
      }
      setCached(`quote:${q.symbol}`, result, QUOTE_TTL_MS)
      quotes.push(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push({ symbol: q.symbol, error: msg })
    }
  }

  return { quotes, errors }
}

export type HistoricalPoint = {
  date: string
  closeSek: number
  closeOriginal: number
}

async function opHistorical(args: {
  symbol: string
  from: string
  to?: string
  interval?: "1d" | "1wk" | "1mo"
}): Promise<{
  symbol: string
  currencyOriginal: string
  fxToSek: number
  interval: string
  points: HistoricalPoint[]
  truncated: boolean
}> {
  const { symbol, from, to, interval = "1d" } = args
  if (!symbol || typeof symbol !== "string") throw new Error("symbol required")
  if (!from || typeof from !== "string") throw new Error("from (YYYY-MM-DD) required")

  const key = `hist:${symbol}:${from}:${to ?? "now"}:${interval}`
  const cached = getCached<{
    symbol: string
    currencyOriginal: string
    fxToSek: number
    interval: string
    points: HistoricalPoint[]
    truncated: boolean
  }>(key)
  if (cached) return cached

  const period1 = new Date(from)
  const period2 = to ? new Date(to) : new Date()
  if (isNaN(period1.getTime())) throw new Error(`invalid 'from' date: ${from}`)
  if (isNaN(period2.getTime())) throw new Error(`invalid 'to' date: ${to}`)

  const meta = await yf.quote(symbol)
  const ccy = (meta?.currency ?? "USD").toUpperCase()
  const fx = await getFxToSek(ccy)

  const rows = await yf.historical(symbol, {
    period1,
    period2,
    interval,
  })

  const points: HistoricalPoint[] = rows
    .filter((r) => typeof r.close === "number" && isFinite(r.close))
    .map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      closeSek: (r.close as number) * fx,
      closeOriginal: r.close as number,
    }))

  const truncated = points.length > MAX_HISTORICAL_POINTS
  const stride = truncated ? Math.ceil(points.length / MAX_HISTORICAL_POINTS) : 1
  const capped = truncated ? points.filter((_, i) => i % stride === 0) : points

  const result = {
    symbol,
    currencyOriginal: ccy,
    fxToSek: fx,
    interval,
    points: capped,
    truncated,
  }
  setCached(key, result, HISTORICAL_TTL_MS)
  return result
}

async function opSearch(query: string): Promise<{
  query: string
  results: Array<{
    symbol: string
    name: string | null
    exchange: string | null
    quoteType: string | null
  }>
}> {
  if (!query || typeof query !== "string") throw new Error("query required")
  const key = `search:${query.toLowerCase()}`
  const cached = getCached<{
    query: string
    results: Array<{
      symbol: string
      name: string | null
      exchange: string | null
      quoteType: string | null
    }>
  }>(key)
  if (cached) return cached

  const r = await yf.search(query, { quotesCount: 8, newsCount: 0 })
  const results = (r.quotes ?? [])
    .filter(
      (q): q is typeof q & { symbol: string } =>
        "symbol" in q && typeof (q as { symbol?: unknown }).symbol === "string",
    )
    .map((q) => {
      const obj = q as Record<string, unknown>
      const name =
        (typeof obj.shortname === "string" && obj.shortname) ||
        (typeof obj.longname === "string" && obj.longname) ||
        null
      const exchange = typeof obj.exchange === "string" ? obj.exchange : null
      const quoteType = typeof obj.quoteType === "string" ? obj.quoteType : null
      return { symbol: q.symbol, name, exchange, quoteType }
    })

  const out = { query, results }
  setCached(key, out, SEARCH_TTL_MS)
  return out
}

async function opSummary(symbol: string, modules?: string[]): Promise<unknown> {
  if (!symbol || typeof symbol !== "string") throw new Error("symbol required")
  const mods =
    modules && modules.length > 0
      ? modules
      : ["price", "summaryDetail", "defaultKeyStatistics"]
  const key = `summary:${symbol}:${[...mods].sort().join(",")}`
  const cached = getCached<unknown>(key)
  if (cached) return cached

  // Cast: the agent picks modules at runtime; we don't constrain to the literal union.
  const data = await yf.quoteSummary(symbol, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modules: mods as any,
  })
  setCached(key, data, SUMMARY_TTL_MS)
  return data
}

export type MarketDataInput =
  | { op: "quote"; symbols: string[] }
  | { op: "historical"; symbol: string; from: string; to?: string; interval?: "1d" | "1wk" | "1mo" }
  | { op: "search"; query: string }
  | { op: "summary"; symbol: string; modules?: string[] }

export async function marketData(input: MarketDataInput): Promise<unknown> {
  switch (input.op) {
    case "quote":
      return opQuote(input.symbols)
    case "historical":
      return opHistorical(input)
    case "search":
      return opSearch(input.query)
    case "summary":
      return opSummary(input.symbol, input.modules)
    default: {
      const _exhaustive: never = input
      throw new Error(`unknown op: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

