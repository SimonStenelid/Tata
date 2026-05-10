import fs from "node:fs"
import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy"
import type Anthropic from "@anthropic-ai/sdk"
import { runTata, type RunTataHooks } from "../agents/tata.js"
import { config } from "../config.js"
import { memory } from "../memory/conversation.js"
import { listCategories } from "../db/categories.js"
import { clearMemoryFor, upsertMemoryFile } from "../memory/store.js"
import { uploadSessions } from "./upload-session.js"
import { consume, register } from "./pending.js"

// Track who currently has a confirm keyboard open. If they send a new text
// message mid-flight, we resolve the pending confirm as cancelled and process
// the new text as a fresh turn.
const activeConfirmKeyByUser = new Map<number, string>()

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function shortToken(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function krSekShort(n: number): string {
  return new Intl.NumberFormat("sv-SE", {
    style: "currency",
    currency: "SEK",
    maximumFractionDigits: 0,
  }).format(n)
}

export function createBot(): Bot {
  const bot = new Bot(config.telegramBotToken)

  bot.use(async (ctx, next) => {
    console.log(
      `[update] id=${ctx.update.update_id} keys=${Object.keys(ctx.update).filter((k) => k !== "update_id").join(",")} from=${ctx.from?.id ?? "?"}`,
    )
    if (ctx.update.callback_query) {
      console.log(`[update:cbq] data=${ctx.update.callback_query.data} msg_id=${ctx.update.callback_query.message?.message_id}`)
    }
    await next()
  })

  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id
    if (!uid || !config.allowedUserIds.has(uid)) {
      console.log(`[reject] user=${uid ?? "?"} name=${ctx.from?.username ?? "?"}`)
      return
    }
    await next()
  })

  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "Hi! I'm Tata. 🐾 Your personal finance cat — paws on the spreadsheet, eyes on the prize.",
        "",
        "Just talk to me:",
        "• How much did I spend on groceries last month?",
        "• Top 5 expense categories this month",
        "• What's my AAPL position worth?",
        "• Add a Revolut card",
        "• Delete the duplicate Amazon transaction from yesterday",
        "",
        "📥 Want to import statements? Send the PDF(s) and tell me which card they're for.",
        "",
        "🧹 Housekeeping:",
        "• /stance — switch the financial worldview I apply",
        "• /onboard — redo setup",
        "• /reset — clear our chat transcript",
        "• /forget — wipe what I remember about you",
      ].join("\n"),
    ),
  )

  bot.command("reset", (ctx) => {
    if (ctx.from) memory.reset(ctx.from.id)
    return ctx.reply(
      "Transcript cleared! 🧹 I still remember the important stuff about you — /forget if you'd like that gone too.",
    )
  })

  bot.command("onboard", (ctx) => {
    if (!ctx.from) return
    const today = new Date().toISOString().slice(0, 10)
    upsertMemoryFile(
      ctx.from.id,
      "/memories/onboarding-requested.md",
      `User asked to redo onboarding on ${today}.\n`,
    )
    return ctx.reply(
      "Paws up — let's go through your setup again. Send any message to start. 🐾",
    )
  })

  bot.command("stance", (ctx) => {
    if (!ctx.from) return
    const today = new Date().toISOString().slice(0, 10)
    upsertMemoryFile(
      ctx.from.id,
      "/memories/stance-change-requested.md",
      `User asked to switch financial stance on ${today}.\n`,
    )
    return ctx.reply(
      "Tail-flick — let's reset the lens I wear. Send any message and I'll list the options. 🐾",
    )
  })

  bot.command("forget", (ctx) => {
    if (!ctx.from) return
    const removed = clearMemoryFor(ctx.from.id)
    return ctx.reply(
      `Memory wiped — ${removed} file${removed === 1 ? "" : "s"} swept away. 🐾 Fresh start!`,
    )
  })

  bot.on("message:document", async (ctx) => {
    const uid = ctx.from.id
    const doc = ctx.message.document
    if (doc.mime_type !== "application/pdf") {
      return ctx.reply(
        `Skipped "${doc.file_name}" — only PDF statements are supported.`,
      )
    }
    try {
      uploadSessions.start(uid)
      const size = doc.file_size ?? 0
      const { path } = uploadSessions.addFile(
        uid,
        doc.file_name ?? "statement.pdf",
        size,
      )
      const file = await ctx.getFile()
      const downloadUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`
      const resp = await fetch(downloadUrl)
      if (!resp.ok) {
        throw new Error(`download failed: ${resp.status} ${resp.statusText}`)
      }
      const buf = Buffer.from(await resp.arrayBuffer())
      fs.writeFileSync(path, buf)
      const stat = fs.statSync(path)
      uploadSessions.recordFile(uid, path, doc.file_name ?? "statement.pdf", stat.size)
      const s = uploadSessions.get(uid)!
      await ctx.reply(
        `📎 Got <b>${escapeHtml(doc.file_name ?? "statement.pdf")}</b> (${s.files.length}/${uploadSessions.MAX_FILES}). What should I do with it?`,
        { parse_mode: "HTML" },
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ctx.reply(`Upload failed: ${msg}`)
    }
  })

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data
    const uid = ctx.from.id
    console.log(`[callback] user=${uid} data=${data}`)

    const confirmMatch = data.match(/^confirm:(apply|cancel):(.+)$/)
    if (confirmMatch) {
      const [, action, token] = confirmMatch
      const slot = consume<boolean>(uid, token)
      if (!slot) {
        await ctx.answerCallbackQuery({ text: "This prompt has expired." })
        return
      }
      const key = `${uid}:${token}`
      if (activeConfirmKeyByUser.get(uid) === key) {
        activeConfirmKeyByUser.delete(uid)
      }
      slot.resolve(action === "apply")
      await ctx.answerCallbackQuery({
        text: action === "apply" ? "Applying…" : "Cancelled.",
      })
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined })
      } catch {
        // Non-fatal.
      }
      return
    }

    const catMatch = data.match(/^cat:([^:]+):(.+)$/)
    if (catMatch) {
      const [, token, choice] = catMatch
      const slot = consume<{ categoryName: string } | null>(uid, token)
      if (!slot) {
        await ctx.answerCallbackQuery({ text: "This prompt has expired." })
        return
      }
      const index = slot.meta as string[] | undefined

      let pick: { categoryName: string } | null = null
      let label = "Skipped."
      if (choice !== "skip" && index) {
        const idx = Number(choice)
        const name = Number.isInteger(idx) ? index[idx] : undefined
        if (name) {
          pick = { categoryName: name }
          label = `→ ${name}`
        }
      }
      slot.resolve(pick)
      await ctx.answerCallbackQuery({ text: label })
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined })
      } catch {
        // Non-fatal.
      }
      return
    }

    await ctx.answerCallbackQuery()
  })

  bot.on("message:text", async (ctx) => {
    const uid = ctx.from.id
    const text = ctx.message.text
    if (text.startsWith("/")) return

    // If a confirm keyboard is currently open for this user, treat the new
    // text as an implicit cancel and run the new turn fresh.
    const activeKey = activeConfirmKeyByUser.get(uid)
    if (activeKey) {
      const [, token] = activeKey.split(":")
      const slot = consume<boolean>(uid, token)
      activeConfirmKeyByUser.delete(uid)
      if (slot) {
        slot.resolve(false)
        await ctx.reply("(Pending confirm cancelled — handling your new message.)")
      }
    }

    // Build content for runTata: text + any buffered PDFs from upload-session.
    const session = uploadSessions.get(uid)
    let content: Parameters<typeof runTata>[1]
    if (session && session.files.length > 0) {
      const docBlocks = session.files.map((f) => {
        const data = fs.readFileSync(f.path).toString("base64")
        return {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data,
          },
        } satisfies Anthropic.Beta.Messages.BetaContentBlockParam
      })
      content = [{ type: "text" as const, text }, ...docBlocks]
    } else {
      content = text
    }

    const hooks: RunTataHooks = {
      onConfirm: async (summary, acceptLabel) => {
        const token = shortToken()
        const key = `${uid}:${token}`
        const keyboard = new InlineKeyboard()
          .text(`✅ ${acceptLabel}`, `confirm:apply:${token}`)
          .text("❌ Cancel", `confirm:cancel:${token}`)

        // Register the resolver BEFORE posting the keyboard, so a fast tap
        // can't race past `register` and find nothing in the pending map.
        return new Promise<boolean>((resolve) => {
          register<boolean>({
            uid,
            token,
            resolve: (v) => resolve(v ?? false),
          })
          activeConfirmKeyByUser.set(uid, key)
          ctx
            .reply(summary, { reply_markup: keyboard, parse_mode: "HTML" })
            .catch((err) => {
              console.error(`[onConfirm] reply failed user=${uid}`, err)
              const slot = consume<boolean>(uid, token)
              if (slot) slot.resolve(false)
              activeConfirmKeyByUser.delete(uid)
            })
        })
      },
      onAskCategory: async (merchant, kind, sample) => {
        const cats = listCategories(kind)
        if (cats.length === 0) return null
        const token = shortToken()

        const keyboard = new InlineKeyboard()
        cats.forEach((c, i) => {
          keyboard.text(c.name, `cat:${token}:${i}`)
          if ((i + 1) % 2 === 0) keyboard.row()
        })
        keyboard.row().text("⏭ Skip", `cat:${token}:skip`)

        const sign = kind === "EXPENSE" ? "-" : "+"
        return new Promise<{ categoryName: string } | null>((resolve) => {
          register<{ categoryName: string } | null>({
            uid,
            token,
            resolve: (v) => resolve(v ?? null),
            meta: cats.map((c) => c.name),
          })
          ctx
            .reply(
              `❓ Category for: <b>${escapeHtml(merchant)}</b>\n` +
                `${sign}${krSekShort(sample.amount)} on ${sample.date}`,
              { reply_markup: keyboard, parse_mode: "HTML" },
            )
            .catch((err) => {
              console.error(`[onAskCategory] reply failed user=${uid}`, err)
              const slot = consume<{ categoryName: string } | null>(uid, token)
              if (slot) slot.resolve(null)
            })
        })
      },
    }

    try {
      await ctx.replyWithChatAction("typing")
      const answer = await runTata(uid, content, hooks)
      // Drain the upload session AFTER the agent has consumed the PDFs.
      // The agent may have committed apply_changes; either way the
      // PDFs have served their purpose for this turn.
      if (session && session.files.length > 0) {
        uploadSessions.clear(uid)
      }
      await ctx.reply(answer, { parse_mode: "HTML" })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[error] user=${uid} err=${msg}`)
      await ctx.reply("Something went wrong. Try again, or /reset.")
    }
  })

  bot.catch((err) => {
    if (err.error instanceof GrammyError) {
      console.error(`[telegram] ${err.error.description}`)
    } else if (err.error instanceof HttpError) {
      console.error(`[telegram:http] ${err.error.message}`)
    } else {
      console.error("[telegram:unknown]", err.error)
    }
  })

  return bot
}
