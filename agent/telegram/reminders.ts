import cron from "node-cron"
import type { Bot } from "grammy"
import { config } from "../config.js"

const MESSAGE = [
  "📅 New month — time to upload last month's bank statements.",
  "",
  "• /add debit — upload a debit card PDF",
  "• /add debit amex — upload both",
  "• /go — parse & preview after upload",
].join("\n")

const SCHEDULE = "0 9 1 * *"
const TIMEZONE = "Europe/Stockholm"

export function startReminders(bot: Bot) {
  const task = cron.schedule(
    SCHEDULE,
    async () => {
      for (const uid of config.allowedUserIds) {
        try {
          await bot.api.sendMessage(uid, MESSAGE)
          console.log(`[reminder] sent to user=${uid}`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[reminder:error] user=${uid} err=${msg}`)
        }
      }
    },
    { timezone: TIMEZONE },
  )

  console.log(`[reminder] scheduled "${SCHEDULE}" (${TIMEZONE})`)
  return task
}
