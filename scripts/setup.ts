#!/usr/bin/env tsx
import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

import * as p from "@clack/prompts"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const ENV_PATH = path.join(ROOT, ".env")
const ENV_EXAMPLE_PATH = path.join(ROOT, ".env.example")

type EnvMap = Record<string, string>

function parseEnv(text: string): EnvMap {
  const out: EnvMap = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function serializeEnv(env: EnvMap): string {
  const lines = [
    `DATABASE_URL="${env.DATABASE_URL ?? "file:./dev.db"}"`,
    ``,
    `# Anthropic API key — https://console.anthropic.com/`,
    `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY ?? ""}`,
    ``,
    `# Telegram bot token from @BotFather`,
    `TELEGRAM_BOT_TOKEN=${env.TELEGRAM_BOT_TOKEN ?? ""}`,
    ``,
    `# Comma-separated Telegram numeric user ids that may talk to the bot.`,
    `TELEGRAM_ALLOWED_USER_IDS=${env.TELEGRAM_ALLOWED_USER_IDS ?? ""}`,
    ``,
  ]
  if (env.AGENT_DB_PATH) {
    lines.push(`AGENT_DB_PATH=${env.AGENT_DB_PATH}`, ``)
  } else {
    lines.push(`# Optional: override the SQLite path the agent reads/writes.`)
    lines.push(`# AGENT_DB_PATH=./dev.db`, ``)
  }
  if (env.SOURCE_DEBIT_LABEL) lines.push(`SOURCE_DEBIT_LABEL=${env.SOURCE_DEBIT_LABEL}`)
  if (env.SOURCE_AMEX_LABEL) lines.push(`SOURCE_AMEX_LABEL=${env.SOURCE_AMEX_LABEL}`)
  return lines.join("\n")
}

function mask(value: string): string {
  if (!value) return ""
  if (value.length <= 8) return "•".repeat(value.length)
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

function isCancel<T>(v: T | symbol): v is symbol {
  return p.isCancel(v)
}

async function promptValue(opts: {
  label: string
  hint?: string
  current?: string
  secret?: boolean
  validate: (v: string) => string | undefined
}): Promise<string> {
  const { label, hint, current, secret, validate } = opts

  if (current) {
    const keep = await p.select({
      message: `${label} — already set (${secret ? mask(current) : current}).`,
      options: [
        { value: "keep", label: "Keep existing" },
        { value: "replace", label: "Replace with new value" },
      ],
    })
    if (isCancel(keep)) cancel()
    if (keep === "keep") return current
  }

  while (true) {
    const result = secret
      ? await p.password({ message: label, mask: "•" })
      : await p.text({ message: label, placeholder: hint })
    if (isCancel(result)) cancel()
    const value = String(result ?? "").trim()
    const err = validate(value)
    if (err) {
      p.log.warn(err)
      continue
    }
    return value
  }
}

function cancel(): never {
  p.cancel("Setup cancelled. You can run it again any time with ./setup.sh or pnpm setup.")
  process.exit(0)
}

function validateAnthropicKey(v: string): string | undefined {
  if (!v) return "Required."
  if (!v.startsWith("sk-ant-")) return "Anthropic keys start with sk-ant-. Double-check what you pasted."
  if (v.length < 20) return "That looks too short — paste the full key."
  return undefined
}

function validateBotToken(v: string): string | undefined {
  if (!v) return "Required."
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(v)) {
    return "Bot tokens look like 1234567890:ABC… (numbers, colon, ~35 chars). Try again."
  }
  return undefined
}

function validateUserIds(v: string): string | undefined {
  if (!v) return "Required — at least one numeric user id."
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return "Required — at least one numeric user id."
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return `"${part}" isn't a number. User ids look like 123456789.`
  }
  return undefined
}

async function runCommand(label: string, command: string, args: string[]): Promise<boolean> {
  const s = p.spinner()
  s.start(label)
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "pipe" })
    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (err) => {
      s.stop(`${label} — failed`)
      p.log.error(err.message)
      resolve(false)
    })
    child.on("exit", (code) => {
      if (code === 0) {
        s.stop(`${label} — done`)
        resolve(true)
      } else {
        s.stop(`${label} — failed (exit ${code})`)
        if (stderr.trim()) p.log.error(stderr.trim().split("\n").slice(-10).join("\n"))
        resolve(false)
      }
    })
  })
}

async function maybeRun(message: string, command: string, args: string[]): Promise<void> {
  const yes = await p.confirm({ message, initialValue: true })
  if (isCancel(yes)) cancel()
  if (!yes) {
    p.log.info(`Skipped. You can run it later: ${command} ${args.join(" ")}`)
    return
  }
  const ok = await runCommand(`Running: ${command} ${args.join(" ")}`, command, args)
  if (!ok) {
    p.log.warn("That step failed. You can retry by running the command yourself once you've fixed the cause.")
  }
}

async function main() {
  console.clear()
  p.intro("🐱  Tata setup")

  p.note(
    [
      "This will walk you through everything Tata needs to run:",
      "  1. Anthropic API key (for Claude)",
      "  2. Telegram bot token (from @BotFather)",
      "  3. Your Telegram user id (so only you can talk to the bot)",
      "",
      "You'll paste each value when asked. Press Ctrl+C any time to cancel.",
    ].join("\n"),
    "What's about to happen",
  )

  // Load existing env (preserve unknown keys)
  let env: EnvMap = {}
  if (existsSync(ENV_PATH)) {
    env = parseEnv(readFileSync(ENV_PATH, "utf-8"))
    p.log.info("Found an existing .env — you can keep or replace each value.")
  } else if (existsSync(ENV_EXAMPLE_PATH)) {
    env = parseEnv(readFileSync(ENV_EXAMPLE_PATH, "utf-8"))
    // Wipe placeholder empties so prompts treat them as missing
    for (const key of ["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"]) {
      if (env[key] === "") delete env[key]
    }
  }
  if (!env.DATABASE_URL) env.DATABASE_URL = "file:./dev.db"

  // --- Anthropic key ---
  p.note(
    [
      "1) Open https://console.anthropic.com/ and sign in.",
      "2) Go to Settings → API Keys → Create Key.",
      "3) Copy the key (starts with sk-ant-…). You won't see it again, so copy it now.",
      "4) Paste it below.",
    ].join("\n"),
    "Anthropic API key",
  )
  env.ANTHROPIC_API_KEY = await promptValue({
    label: "Paste your Anthropic API key",
    hint: "sk-ant-…",
    current: env.ANTHROPIC_API_KEY,
    secret: true,
    validate: validateAnthropicKey,
  })

  // --- Telegram bot token ---
  p.note(
    [
      "1) Open Telegram and message @BotFather.",
      "2) Send /newbot, then follow the prompts:",
      "     • Pick a name (e.g. \"My Tata\")",
      "     • Pick a username ending in \"bot\" (e.g. my_tata_bot)",
      "3) BotFather replies with a token like 1234567890:ABCdef…",
      "4) Copy that token and paste it below.",
    ].join("\n"),
    "Telegram bot token",
  )
  env.TELEGRAM_BOT_TOKEN = await promptValue({
    label: "Paste your Telegram bot token",
    hint: "1234567890:ABCdef…",
    current: env.TELEGRAM_BOT_TOKEN,
    secret: true,
    validate: validateBotToken,
  })

  // --- Telegram allowed user ids ---
  p.note(
    [
      "Tata only replies to user ids on this list — everyone else is silently ignored.",
      "",
      "How to find your id:",
      "1) Open Telegram and message @userinfobot.",
      "2) It replies with your numeric id (e.g. 123456789).",
      "",
      "Paste your id below. To allow multiple people, separate ids with commas.",
    ].join("\n"),
    "Your Telegram user id",
  )
  env.TELEGRAM_ALLOWED_USER_IDS = await promptValue({
    label: "Paste your Telegram numeric user id(s)",
    hint: "123456789 or 123456789,987654321",
    current: env.TELEGRAM_ALLOWED_USER_IDS,
    validate: validateUserIds,
  })

  // Write .env
  writeFileSync(ENV_PATH, serializeEnv(env), "utf-8")
  p.log.success(`Saved ${path.relative(ROOT, ENV_PATH)}`)

  // --- DB / install steps ---
  p.note(
    "Next, Tata needs to create the local database and seed the default categories and cards.",
    "Database setup",
  )

  const needsInstall = !existsSync(path.join(ROOT, "node_modules"))
  if (needsInstall) {
    await maybeRun("Install Node dependencies now? (pnpm install)", "pnpm", ["install"])
  }
  await maybeRun("Create the SQLite database? (pnpm db:migrate)", "pnpm", ["db:migrate"])
  await maybeRun("Seed default categories and cards? (pnpm db:seed)", "pnpm", ["db:seed"])

  // --- Done ---
  p.note(
    [
      "Start the bot:",
      "  pnpm agent:dev      (auto-restarts on code changes)",
      "  pnpm agent          (plain run)",
      "",
      "Then open Telegram, find your bot, and send /start.",
      "The first message kicks off onboarding (identity → stance → financial profile).",
    ].join("\n"),
    "You're set 🎉",
  )
  p.outro("Have fun with Tata.")
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
