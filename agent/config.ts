import "dotenv/config"
import path from "node:path"

function required(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

const allowedRaw = required("TELEGRAM_ALLOWED_USER_IDS")
const allowedUserIds = new Set(
  allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s)
      if (!Number.isInteger(n)) {
        throw new Error(`TELEGRAM_ALLOWED_USER_IDS contains non-integer: ${s}`)
      }
      return n
    }),
)

if (allowedUserIds.size === 0) {
  throw new Error("TELEGRAM_ALLOWED_USER_IDS must list at least one user id")
}

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUserIds,
  dbPath: path.resolve(process.env.AGENT_DB_PATH ?? "./dev.db"),
  model: "claude-sonnet-4-6" as const,
  sessionIdleHours: 6,
}
