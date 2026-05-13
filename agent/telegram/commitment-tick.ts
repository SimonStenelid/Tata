import cron from "node-cron"
import type { Bot } from "grammy"
import { runTata } from "../agents/tata.js"
import {
  computeNextRunAt,
  dueCommitments,
  markFired,
} from "../db/commitments.js"

// Scans every minute for ACTIVE commitments whose nextRunAt has passed, then
// runs Tata with the saved prompt as a synthetic user turn and pushes the
// reply to the user via the bot API. Mirrors agent/telegram/reminders.ts in
// shape and logging style.

const SCHEDULE = "* * * * *"

// No-op hooks: a scheduled fire has no live user in front of it, so
// apply_changes will reject (which is the desired safety — scheduled fires
// can read+report but cannot mutate the DB unprompted).
const SCHEDULED_HOOKS = {
  onConfirm: async () => false,
  onAskCategory: async () => null,
}

export function startCommitmentTick(bot: Bot) {
  const task = cron.schedule(
    SCHEDULE,
    async () => {
      const now = new Date()
      const due = dueCommitments(now)
      if (due.length === 0) return

      for (const c of due) {
        // Advance nextRunAt BEFORE running so an exception or a slow run
        // doesn't double-fire on the next tick.
        const newNext = computeNextRunAt(c.cron, c.timezone, now)
        markFired(c.id, newNext, null)
        console.log(
          `[commitment:fire] user=${c.userId} id=${c.id} title="${c.title}" next=${newNext.toISOString()}`,
        )

        try {
          const answer = await runTata(
            c.userId,
            `[Scheduled commitment "${c.title}"] ${c.prompt}`,
            SCHEDULED_HOOKS,
          )
          await bot.api.sendMessage(c.userId, answer, { parse_mode: "HTML" })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(
            `[commitment:fire:error] user=${c.userId} id=${c.id} err=${msg}`,
          )
          markFired(c.id, newNext, msg)
          try {
            await bot.api.sendMessage(
              c.userId,
              `⚠️ Scheduled check "${c.title}" failed: ${msg}`,
            )
          } catch {
            // Telegram down — drop, will retry next cadence.
          }
        }
      }
    },
    { timezone: "UTC" },
  )

  console.log(`[commitment] tick scheduled "${SCHEDULE}" (UTC)`)
  return task
}
