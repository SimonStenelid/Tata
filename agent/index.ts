import { run } from "@grammyjs/runner"
import { config } from "./config.js"
import { startReminders } from "./telegram/reminders.js"
import { startCommitmentTick } from "./telegram/commitment-tick.js"
import { createBot } from "./telegram/bot.js"

async function main() {
  const bot = createBot()
  startReminders(bot)
  startCommitmentTick(bot)

  console.log(
    `[start] db=${config.dbPath} model=${config.model} allowed=${[...config.allowedUserIds].join(",")}`,
  )

  // Use @grammyjs/runner instead of bot.start() so updates are processed
  // concurrently. The built-in long-poller is strictly sequential, which
  // deadlocks any flow where a handler awaits a follow-up callback_query
  // (e.g. apply_changes confirm keyboards, per-merchant category prompts).
  const handle = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message", "callback_query", "edited_message"],
      },
    },
  })

  const me = await bot.api.getMe()
  console.log(`[start] bot online as @${me.username}`)

  const shutdown = async (signal: string) => {
    console.log(`[shutdown] received ${signal}, stopping bot...`)
    await handle.stop()
    process.exit(0)
  }
  process.once("SIGINT", () => void shutdown("SIGINT"))
  process.once("SIGTERM", () => void shutdown("SIGTERM"))

  await handle.task()
}

main().catch((err) => {
  console.error("[fatal]", err)
  process.exit(1)
})
