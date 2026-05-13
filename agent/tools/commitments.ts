import { z } from "zod"
import { randomBytes } from "node:crypto"
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod"
import {
  cancelCommitment,
  computeNextRunAt,
  createCommitment,
  listActiveCommitments,
  validateCron,
} from "../db/commitments.js"
import { upsertMemoryFile } from "../memory/store.js"
import Database from "better-sqlite3"
import { config } from "../config.js"

// Single-slot pending-proposal file. Mirrors the onboarding-requested.md /
// stance-change-requested.md pattern: writing here means the next turn's
// bootstrap will surface the proposal so Tata can react to the user's
// yes/no reply.
const PENDING_PATH = "/memories/pending-commitment.md"

const memDb = new Database(config.dbPath, { fileMustExist: true })
memDb.pragma("journal_mode = WAL")
const readPendingStmt = memDb.prepare(
  `SELECT content FROM MemoryFile WHERE userId = ? AND path = ?`,
)
const deletePendingStmt = memDb.prepare(
  `DELETE FROM MemoryFile WHERE userId = ? AND path = ?`,
)

type Pending = {
  proposal_id: string
  title: string
  prompt: string
  cron: string
  timezone: string
  next_run_at_iso: string
  created_at: string
}

function readPending(userId: number): Pending | null {
  const row = readPendingStmt.get(userId, PENDING_PATH) as
    | { content: string }
    | undefined
  if (!row) return null
  // The memory tool may have re-edited the file; we only consider it valid if
  // we can pull our JSON fence back out.
  const m = row.content.match(/```json\s*([\s\S]*?)\s*```/)
  if (!m) return null
  try {
    return JSON.parse(m[1]) as Pending
  } catch {
    return null
  }
}

function clearPending(userId: number): void {
  deletePendingStmt.run(userId, PENDING_PATH)
}

function humanCadence(cron: string, timezone: string): string {
  // Tata gets to phrase the cadence in the chat reply; for the file we just
  // round-trip the cron + next run so the model can re-render naturally.
  const next = computeNextRunAt(cron, timezone)
  return `cron \`${cron}\` (${timezone}) — next: ${next.toISOString()}`
}

function shortId(): string {
  return "p" + Date.now().toString(36) + randomBytes(2).toString("hex")
}

export function buildCommitmentTools(userId: number) {
  const proposeTool = betaZodTool({
    name: "propose_commitment",
    description:
      "Draft a scheduled commitment for the user to confirm. DOES NOT persist. " +
      "Call this when the user describes something recurring (e.g. 'remind me every " +
      "Friday how much I spent on groceries'). After this returns, READ THE PROPOSAL " +
      "BACK to the user in plain English and ask 'want me to set this up?'. On the " +
      "next turn check /memories/pending-commitment.md and the user's reply, then call " +
      "confirm_commitment or cancel_pending_commitment accordingly. Overwrites any " +
      "previous pending proposal (single slot).",
    inputSchema: z.object({
      title: z
        .string()
        .describe("Short label, e.g. 'Weekly grocery check'. Shown in list_commitments."),
      prompt: z
        .string()
        .describe(
          "The text injected as a synthetic user turn into Tata when the commitment " +
            "fires. Write it as if the user just asked you the question. " +
            "Example: 'How much did I spend on groceries this past week?'",
        ),
      cron: z
        .string()
        .describe(
          "5-field cron: minute hour day-of-month month day-of-week. " +
            "Examples: '0 9 * * 5' (Fri 09:00), '0 9 1 * *' (1st 09:00), " +
            "'0 8 * * 1-5' (weekdays 08:00). Use the user's timezone via the timezone arg.",
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone. Default: 'Europe/Stockholm'. Use the user's timezone if " +
            "/memories/profile.md states one.",
        ),
    }),
    run: async ({ title, prompt, cron, timezone }) => {
      const tz = timezone ?? "Europe/Stockholm"
      const v = validateCron(cron, tz)
      if (!v.ok) {
        return JSON.stringify({ status: "error", error: `invalid cron: ${v.error}` })
      }
      const proposalId = shortId()
      const nextRunAt = computeNextRunAt(cron, tz)
      const pending: Pending = {
        proposal_id: proposalId,
        title,
        prompt,
        cron,
        timezone: tz,
        next_run_at_iso: nextRunAt.toISOString(),
        created_at: new Date().toISOString(),
      }
      // Write as a fenced JSON blob inside markdown so the file is both
      // human-readable in /memories and machine-parseable by confirm_commitment.
      const fileBody = [
        "# Pending commitment (awaiting user confirmation)",
        "",
        `Title: ${title}`,
        `Cadence: ${humanCadence(cron, tz)}`,
        `Prompt: ${prompt}`,
        "",
        "```json",
        JSON.stringify(pending, null, 2),
        "```",
        "",
        "On the next turn: if the user said yes (or similar), call",
        "confirm_commitment with this proposal_id. If they said no, call",
        "cancel_pending_commitment.",
      ].join("\n")
      upsertMemoryFile(userId, PENDING_PATH, fileBody)
      console.log(
        `[commitment] user=${userId} op=propose id=${proposalId} cron="${cron}" tz=${tz}`,
      )
      return JSON.stringify({
        status: "proposed",
        proposal_id: proposalId,
        title,
        prompt,
        cron,
        timezone: tz,
        next_run_at_iso: nextRunAt.toISOString(),
      })
    },
  })

  const confirmTool = betaZodTool({
    name: "confirm_commitment",
    description:
      "Persist the pending commitment from /memories/pending-commitment.md. " +
      "Call this after the user agrees to the proposal you read back. " +
      "Pass the proposal_id from the pending file to guard against stale confirms.",
    inputSchema: z.object({
      proposal_id: z
        .string()
        .describe("The proposal_id from /memories/pending-commitment.md."),
    }),
    run: async ({ proposal_id }) => {
      const pending = readPending(userId)
      if (!pending) {
        return JSON.stringify({
          status: "error",
          error: "no pending commitment found — call propose_commitment first",
        })
      }
      if (pending.proposal_id !== proposal_id) {
        return JSON.stringify({
          status: "error",
          error: `proposal_id mismatch (pending=${pending.proposal_id}, got=${proposal_id})`,
        })
      }
      const created = createCommitment({
        userId,
        title: pending.title,
        prompt: pending.prompt,
        cron: pending.cron,
        timezone: pending.timezone,
      })
      clearPending(userId)
      console.log(
        `[commitment] user=${userId} op=confirm id=${created.id} title="${created.title}"`,
      )
      return JSON.stringify({
        status: "confirmed",
        id: created.id,
        title: created.title,
        cron: created.cron,
        timezone: created.timezone,
        next_run_at_iso: created.nextRunAt.toISOString(),
      })
    },
  })

  const cancelPendingTool = betaZodTool({
    name: "cancel_pending_commitment",
    description:
      "Discard the pending commitment in /memories/pending-commitment.md. " +
      "Call this when the user rejects the proposal (says no, nevermind, " +
      "changes their mind, etc.). Safe to call even if no pending exists.",
    inputSchema: z.object({}),
    run: async () => {
      const pending = readPending(userId)
      clearPending(userId)
      console.log(
        `[commitment] user=${userId} op=cancel_pending had=${pending !== null}`,
      )
      return JSON.stringify({ status: "cleared", had_pending: pending !== null })
    },
  })

  const listTool = betaZodTool({
    name: "list_commitments",
    description:
      "Return all of the user's ACTIVE scheduled commitments. Use this when " +
      "the user asks 'what reminders/commitments do I have?' or before " +
      "calling cancel_commitment (to resolve a fuzzy reference like 'the " +
      "grocery one' to an id).",
    inputSchema: z.object({}),
    run: async () => {
      const items = listActiveCommitments(userId)
      console.log(`[commitment] user=${userId} op=list count=${items.length}`)
      return JSON.stringify({
        status: "ok",
        commitments: items.map((c) => ({
          id: c.id,
          title: c.title,
          prompt: c.prompt,
          cron: c.cron,
          timezone: c.timezone,
          next_run_at_iso: c.nextRunAt.toISOString(),
          last_run_at_iso: c.lastRunAt ? c.lastRunAt.toISOString() : null,
        })),
      })
    },
  })

  const cancelTool = betaZodTool({
    name: "cancel_commitment",
    description:
      "Cancel an active commitment by id. The user references commitments " +
      "loosely ('the grocery one'); call list_commitments first to resolve " +
      "the id, then call this. Sets status to CANCELLED (the tick loop will " +
      "skip it). Returns ok=false if the id does not exist or is not active.",
    inputSchema: z.object({
      id: z.string().describe("Commitment id from list_commitments."),
    }),
    run: async ({ id }) => {
      const ok = cancelCommitment(userId, id)
      console.log(`[commitment] user=${userId} op=cancel id=${id} ok=${ok}`)
      return JSON.stringify({ status: ok ? "cancelled" : "not_found", id })
    },
  })

  return [proposeTool, confirmTool, cancelPendingTool, listTool, cancelTool]
}
