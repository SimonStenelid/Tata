import Anthropic from "@anthropic-ai/sdk"
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"
import { betaMemoryTool } from "@anthropic-ai/sdk/helpers/beta/memory"
import { z } from "zod"
import { config } from "../config.js"
import {
  memory,
  sanitiseHistory,
  getIdleHours,
  summarizeAndRollover,
} from "../memory/conversation.js"
import { buildSystemPrompt } from "../prompts/system.js"
import { runSql } from "../tools/run-sql.js"
import { marketData, type MarketDataInput } from "../tools/market.js"
import {
  memoryHandlersFor,
  hasAnyMemory,
  hasOnboardingRequest,
} from "../memory/store.js"
import { readStance } from "../memory/stance.js"
import type { CategoryKind } from "../db/categories.js"
import { getSkillContent, listSkillNames } from "../tools/load-skill.js"
import { buildApplyChangesTool } from "../tools/apply-changes.js"

const client = new Anthropic({ apiKey: config.anthropicApiKey })

const MAX_TOOL_ITERATIONS = 20
const MAX_TOKENS = 4096

const marketDataInputSchema = z
  .object({
    op: z.enum(["quote", "historical", "search", "summary"]),
    symbols: z.array(z.string()).optional(),
    symbol: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    interval: z.enum(["1d", "1wk", "1mo"]).optional(),
    query: z.string().optional(),
    modules: z.array(z.string()).optional(),
  })
  .describe(
    "Yahoo Finance lookup. Required fields by op: " +
      "quote → symbols (≤25); historical → symbol + from (YYYY-MM-DD), optional to/interval; " +
      "search → query; summary → symbol, optional modules.",
  )

export type AskCategoryHook = (
  merchant: string,
  kind: CategoryKind,
  sample: { amount: number; date: string },
) => Promise<{ categoryName: string } | null>

// Confirm is now generic — apply_changes calls it for inserts, updates,
// deletes, upserts, and raw_sql. The acceptLabel is what the ✅ button shows.
export type ConfirmHook = (
  summary: string,
  acceptLabel: string,
) => Promise<boolean>

export type RunTataHooks = {
  onAskCategory: AskCategoryHook
  onConfirm: ConfirmHook
}

export type RunTataInput =
  | string
  | Array<Anthropic.Beta.Messages.BetaContentBlockParam>

function buildTools(userId: number, hooks: RunTataHooks) {
  const runSqlTool = betaZodTool({
    name: "run_sql",
    description:
      "Execute a single read-only SELECT query against the personal finance SQLite database. " +
      "Use the schema in the system prompt. Results are capped at 200 rows; if `truncated` is true, refine the query.",
    inputSchema: z.object({
      sql: z
        .string()
        .describe(
          "A single SELECT (or WITH ... SELECT) statement. No INSERT/UPDATE/DELETE/DDL. No multiple statements.",
        ),
    }),
    run: async ({ sql }) => {
      const result = runSql(sql)
      console.log(
        `[sql] user=${userId} rows=${result.row_count} sql=${sql.replace(/\s+/g, " ").slice(0, 200)}`,
      )
      return JSON.stringify(result)
    },
  })

  const marketDataTool = betaZodTool({
    name: "market_data",
    description:
      "Fetch live and historical market data from Yahoo Finance. ALL prices are returned in SEK " +
      "(originals included for transparency, plus the FX rate used). Use after run_sql has " +
      "returned Asset rows with a non-null ticker — multiply quantity * priceSek for current " +
      "value, compare against quantity * avgBuyPrice for unrealized P/L. Operations:\n" +
      " - quote:      current price for up to 25 symbols\n" +
      " - historical: OHLC time series for one symbol (YYYY-MM-DD range, optional interval)\n" +
      " - search:     resolve a name to a ticker symbol\n" +
      " - summary:    fundamentals (PE, dividend yield, market cap, ...) for one symbol\n" +
      "Symbols follow Yahoo conventions: 'AAPL' (US), 'VWCE.DE' (Xetra), 'BTC-USD' (crypto), " +
      "'USDSEK=X' (FX). When you don't know the ticker, use op=search first.",
    inputSchema: marketDataInputSchema,
    run: async (input) => {
      const result = await marketData(input as MarketDataInput)
      console.log(`[market] user=${userId} op=${input.op}`)
      return JSON.stringify(result)
    },
  })

  const skillNames = listSkillNames()
  const loadSkillTool = betaZodTool({
    name: "load_skill",
    description:
      "Load specialised know-how on demand. Each skill is a markdown brief with " +
      "schemas, recipes, and conventions for one topic. Load the relevant skill " +
      "BEFORE doing the matching task (writing SQL, parsing PDFs, market lookups, " +
      "memory writes, etc.). Returns the skill content as a string. " +
      `Available skills: ${skillNames.join(", ")}.`,
    inputSchema: z.object({
      name: z.string().describe(`One of: ${skillNames.join(", ")}.`),
    }),
    run: async ({ name }) => {
      const content = getSkillContent(name)
      if (content === null) {
        return JSON.stringify({
          error: `unknown skill "${name}". Available: ${skillNames.join(", ")}`,
        })
      }
      console.log(`[skill] user=${userId} load=${name} chars=${content.length}`)
      return content
    },
  })

  const applyChangesTool = buildApplyChangesTool(userId, {
    onAskCategory: hooks.onAskCategory,
    onConfirm: hooks.onConfirm,
  })

  const memoryTool = betaMemoryTool(memoryHandlersFor(userId))

  return [
    runSqlTool,
    marketDataTool,
    applyChangesTool,
    loadSkillTool,
    memoryTool,
  ]
}

function extractFinalText(content: Anthropic.Beta.Messages.BetaContentBlock[]): string {
  return content
    .filter(
      (b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n")
    .trim()
}

export async function runTata(
  userId: number,
  input: RunTataInput,
  hooks: RunTataHooks,
): Promise<string> {
  const userTurn: Anthropic.MessageParam = {
    role: "user",
    content: input as Anthropic.MessageParam["content"],
  }

  // Session boundary: if the user has been idle past the threshold, summarise
  // the prior transcript into /memories/last-session.md (single rolling file)
  // and reset before this turn. The bootstrap rule (system prompt) makes the
  // model re-view /memories at the start, so it picks up the summary.
  const activity = getIdleHours(userId)
  if (
    activity &&
    activity.msgCount > 0 &&
    activity.idleHours >= config.sessionIdleHours
  ) {
    console.log(
      `[session] user=${userId} idle=${activity.idleHours.toFixed(1)}h — rolling over`,
    )
    await summarizeAndRollover(userId)
  }

  // Don't round-trip the live user turn through SQLite — persistence stubs
  // PDF document blocks (and load_skill tool_results) so future turns stay
  // small, but the runner needs the FULL content for THIS turn. Read prior
  // turns from disk, then append the live turn in-memory only.
  const past = memory.getHistory(userId) as Anthropic.Beta.Messages.BetaMessageParam[]
  // Pre-flight sanitiser on the full array (past + live) — catches any orphan
  // tool_result / dangling tool_use that slipped past loadHistory's repair.
  // The live user turn is text/document only, so it's always safe to keep.
  const history = sanitiseHistory<Anthropic.Beta.Messages.BetaMessageParam>([
    ...past,
    userTurn as Anthropic.Beta.Messages.BetaMessageParam,
  ])
  memory.append(userId, userTurn) // stubbed for future replays
  const startLen = history.length

  // First-time meeting OR explicit /onboard request → inject the onboarding
  // nudge into the system prompt. Steady-state users get the standard prompt
  // (and a stable cache key) from turn two onward.
  const isOnboarding = !hasAnyMemory(userId) || hasOnboardingRequest(userId)
  if (isOnboarding) console.log(`[onboarding] user=${userId} first-time=${!hasAnyMemory(userId)}`)
  const stanceKey = readStance(userId)
  const stanceContent = stanceKey ? getSkillContent(`stances/${stanceKey}`) : null
  if (stanceKey) console.log(`[stance] user=${userId} stance=${stanceKey}`)
  const systemPrompt = buildSystemPrompt({
    onboarding: isOnboarding,
    stanceContent,
  })

  const runner = client.beta.messages.toolRunner({
    model: config.model,
    max_tokens: MAX_TOKENS,
    max_iterations: MAX_TOOL_ITERATIONS,
    betas: ["context-management-2025-06-27"],
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: buildTools(userId, hooks),
    messages: history,
  })

  let final: Anthropic.Beta.Messages.BetaMessage | undefined
  let runError: unknown
  console.log(`[runTata] user=${userId} starting iterations=<=${MAX_TOOL_ITERATIONS}`)
  try {
    final = await runner.runUntilDone()
    console.log(
      `[runTata] user=${userId} done stop=${final?.stop_reason ?? "?"} msgs=${runner.params.messages.length - startLen}`,
    )
  } catch (err) {
    runError = err
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[agent:error] user=${userId} err=${msg}`)
  }

  // Persist whatever the runner produced — even on failure — so partial
  // progress isn't lost. We then trim trailing turns whose tool_use blocks
  // weren't followed by tool_results, otherwise the next API call will
  // 400 with "tool_use without tool_result". This makes the loop self-healing
  // across crashes, network blips, and tool exceptions.
  const finalMessages = runner.params.messages
  const newSlice = finalMessages.slice(startLen) as Anthropic.MessageParam[]
  const persisted = trimDanglingToolUse(newSlice)
  for (const m of persisted) memory.append(userId, m)

  if (runError) throw runError
  if (!final) throw new Error("runner returned no final message")

  const text = extractFinalText(final.content)
  if (text) return text
  if (final.stop_reason && final.stop_reason !== "end_turn") {
    return `(stopped: ${final.stop_reason})`
  }
  return "(no response)"
}

// If the last assistant turn emitted tool_use blocks that aren't all matched
// by tool_result blocks in the next message, drop that assistant turn (and
// any preceding orphans). Anthropic's API rejects unmatched tool_use on
// replay, so a partial failure mid-tool-call would otherwise wedge the
// transcript until /reset.
function trimDanglingToolUse(
  msgs: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const out = [...msgs]
  while (out.length > 0) {
    const last = out[out.length - 1]
    if (last.role !== "assistant" || !Array.isArray(last.content)) break

    const toolUseIds = new Set<string>()
    for (const block of last.content) {
      const b = block as { type?: string; id?: string }
      if (b.type === "tool_use" && typeof b.id === "string") toolUseIds.add(b.id)
    }
    if (toolUseIds.size === 0) break // assistant text only — fine to keep

    // Trailing assistant with tool_use(s) and no following user turn = dangling.
    out.pop()
  }
  return out
}

// Back-compat shim: a few callers still import askAgent. Forward to runTata
// with a no-op hooks object so plain text Q&A keeps working without a bot.
// New callers should pass real hooks.
export async function askAgent(userId: number, userText: string): Promise<string> {
  return runTata(userId, userText, {
    onAskCategory: async () => null,
    onConfirm: async () => false,
  })
}
