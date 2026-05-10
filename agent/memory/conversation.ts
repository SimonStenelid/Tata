import type Anthropic from "@anthropic-ai/sdk"
import Database from "better-sqlite3"
import { randomBytes } from "node:crypto"
import { config } from "../config.js"
import { upsertMemoryFile } from "./store.js"
import { summarizePriorSession } from "./summarize.js"

// SQLite-backed transcript keyed by Telegram user id (mapped 1:1 onto
// Conversation.chatId). Each turn's content blocks are stored verbatim as JSON
// in Message.contentJson so tool_use / tool_result blocks survive restarts.

// A single Tata turn can append many messages (user → [assistant tool_use →
// user tool_result] × N → assistant text). With MAX_TOOL_ITERATIONS = 20 in
// runTata, one turn alone can be 40+ messages. Keep the cap well above that
// so trimming never slices through the middle of a tool cycle. Trim is also
// turn-group aware (see trimToTurnBoundary) so even in pathological cases we
// never delete a tool_result while keeping its tool_use (or vice versa).
const MAX_MESSAGES = 200

type Msg = Anthropic.MessageParam

const db = new Database(config.dbPath, { fileMustExist: true })
db.pragma("journal_mode = WAL")

function newId(prefix: string): string {
  return prefix + Date.now().toString(36) + randomBytes(4).toString("hex")
}

const findConversationStmt = db.prepare(
  `SELECT id FROM Conversation WHERE chatId = ?`,
)
const insertConversationStmt = db.prepare(
  `INSERT INTO Conversation (id, chatId, lastActiveAt, createdAt)
   VALUES (?, ?, datetime('now'), datetime('now'))`,
)
const touchConversationStmt = db.prepare(
  `UPDATE Conversation SET lastActiveAt = datetime('now') WHERE id = ?`,
)
const deleteMessagesStmt = db.prepare(
  `DELETE FROM Message WHERE conversationId = ?`,
)
const deleteConversationStmt = db.prepare(
  `DELETE FROM Conversation WHERE id = ?`,
)
const insertMessageStmt = db.prepare(
  `INSERT INTO Message (id, conversationId, role, contentJson, textPreview, createdAt)
   VALUES (?, ?, ?, ?, ?, datetime('now'))`,
)
// Use SQLite's implicit `rowid` for ordering. createdAt has 1-second
// resolution, so rows inserted in the same second can sort out of order on
// id (CUID-like, not monotonic). rowid is strictly monotonic for inserts.
const selectAllMessagesStmt = db.prepare(
  `SELECT role, contentJson FROM Message
   WHERE conversationId = ?
   ORDER BY rowid ASC`,
)
const trimMessagesByRowidStmt = db.prepare(
  `DELETE FROM Message
   WHERE conversationId = ? AND rowid < ?`,
)
const selectRowidsAscStmt = db.prepare(
  `SELECT rowid AS rid, role, contentJson FROM Message
   WHERE conversationId = ?
   ORDER BY rowid ASC`,
)
const selectConversationActivityStmt = db.prepare(
  `SELECT id,
          (julianday('now') - julianday(lastActiveAt)) * 24 AS idleHours,
          (SELECT COUNT(*) FROM Message WHERE conversationId = Conversation.id) AS msgCount
   FROM Conversation WHERE chatId = ?`,
)

function ensureConversation(userId: number): string {
  const chatId = String(userId)
  const existing = findConversationStmt.get(chatId) as { id: string } | undefined
  if (existing) return existing.id
  const id = newId("cv")
  insertConversationStmt.run(id, chatId)
  return id
}

function previewOf(content: Msg["content"]): string | null {
  if (typeof content === "string") return content.slice(0, 200)
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text.slice(0, 200)
    }
  }
  return null
}

// PDFs sent as base64 document blocks balloon Message.contentJson into the
// multi-MB range and would dominate the 20-message transcript. Replace them
// with a tiny text stub before persisting; PDFs only matter inside the turn
// they were uploaded.
function stripDocumentsForPersist(content: Msg["content"]): Msg["content"] {
  if (typeof content === "string") return content
  return content.map((block) => {
    if (block.type !== "document") return block
    const src = (block as { source?: { data?: string } }).source
    const kb = src?.data ? Math.round((src.data.length * 3) / 4 / 1024) : 0
    const sizeNote = kb > 0 ? `, ${kb}kb` : ""
    return {
      type: "text" as const,
      text: `[pdf${sizeNote} — no longer in context]`,
    }
  })
}

// Skill loads can return multi-kilobyte markdown bodies. They're authored as
// "agent code" (versioned with the repo) and the live skill content is always
// reachable via load_skill in any future turn — there's no value in keeping
// the full body in the persisted transcript. Track which tool_use_ids came
// from load_skill calls (seen on assistant turns) and replace their matching
// tool_result blocks with a tiny stub when the next user turn lands.
const pendingSkillToolIdsByUser = new Map<number, Set<string>>()

function noteAssistantToolUses(userId: number, content: Msg["content"]): void {
  if (typeof content === "string") return
  for (const block of content) {
    const b = block as {
      type?: string
      name?: string
      id?: string
    }
    if (b.type === "tool_use" && b.name === "load_skill" && typeof b.id === "string") {
      let set = pendingSkillToolIdsByUser.get(userId)
      if (!set) {
        set = new Set<string>()
        pendingSkillToolIdsByUser.set(userId, set)
      }
      set.add(b.id)
    }
  }
}

function stripSkillResultsForPersist(
  userId: number,
  content: Msg["content"],
): Msg["content"] {
  if (typeof content === "string") return content
  const set = pendingSkillToolIdsByUser.get(userId)
  if (!set || set.size === 0) return content
  return content.map((block) => {
    const b = block as {
      type?: string
      tool_use_id?: string
    }
    if (b.type === "tool_result" && typeof b.tool_use_id === "string" && set.has(b.tool_use_id)) {
      set.delete(b.tool_use_id)
      return {
        type: "tool_result" as const,
        tool_use_id: b.tool_use_id,
        content: "[skill content — reload via load_skill if needed]",
      }
    }
    return block
  })
}

// Public — used by both loadHistory AND runTata's pre-flight sanitiser.
//
// Anthropic's hard rule: every assistant `tool_use` block must be followed by
// a user message containing a `tool_result` block with the matching id, in
// the very next message. If history is sliced mid-tool-cycle (e.g. by a row
// trim or a crash), we have to repair it before sending or the API 400s.
//
// Strategy: alternate two passes until stable.
//   Pass A (forward): drop user turns whose tool_result references a
//     tool_use_id we haven't seen in a prior assistant turn.
//   Pass B (pair check): for every assistant turn that emits tool_use blocks,
//     the *immediately next* message MUST be a user turn whose tool_result
//     blocks cover ALL of those ids. If not, drop the assistant turn.
//
// Dropping turns in either pass can orphan a turn elsewhere, so we loop until
// neither pass changes anything. Then trim leading non-user turns. Idempotent,
// returns a new array.
export function sanitiseHistory<M extends { role: string; content: unknown }>(
  msgs: M[],
): M[] {
  let arr = [...msgs]
  // Cap iterations: each pass strictly shrinks the array on a real change,
  // so worst case is O(n) loops. The cap is a paranoia bound.
  for (let i = 0; i < arr.length + 2; i++) {
    const afterA = dropOrphanToolResults(arr)
    const afterB = dropUnpairedToolUseTurns(afterA)
    if (afterB.length === arr.length) {
      arr = afterB
      break
    }
    arr = afterB
  }

  // Drop leading non-user turns (API requires the first message to be `user`).
  while (arr.length > 0 && arr[0].role !== "user") arr.shift()
  return arr
}

function dropOrphanToolResults<M extends { role: string; content: unknown }>(
  msgs: M[],
): M[] {
  const knownToolUseIds = new Set<string>()
  const out: M[] = []
  for (const m of msgs) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content) {
        const b = block as { type?: string; id?: string }
        if (b.type === "tool_use" && typeof b.id === "string") {
          knownToolUseIds.add(b.id)
        }
      }
      out.push(m)
      continue
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      let hasOrphan = false
      for (const block of m.content) {
        const b = block as { type?: string; tool_use_id?: string }
        if (
          b.type === "tool_result" &&
          typeof b.tool_use_id === "string" &&
          !knownToolUseIds.has(b.tool_use_id)
        ) {
          hasOrphan = true
          break
        }
      }
      if (hasOrphan) continue
    }
    out.push(m)
  }
  return out
}

function dropUnpairedToolUseTurns<
  M extends { role: string; content: unknown },
>(msgs: M[]): M[] {
  const keep = new Array<boolean>(msgs.length).fill(true)
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue

    const toolUseIds: string[] = []
    for (const block of m.content) {
      const b = block as { type?: string; id?: string }
      if (b.type === "tool_use" && typeof b.id === "string") {
        toolUseIds.push(b.id)
      }
    }
    if (toolUseIds.length === 0) continue // text-only assistant turn — fine

    const next = msgs[i + 1]
    if (!next || next.role !== "user" || !Array.isArray(next.content)) {
      keep[i] = false
      continue
    }
    const matchedIds = new Set<string>()
    for (const block of next.content) {
      const b = block as { type?: string; tool_use_id?: string }
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        matchedIds.add(b.tool_use_id)
      }
    }
    for (const id of toolUseIds) {
      if (!matchedIds.has(id)) {
        keep[i] = false
        break
      }
    }
  }
  const out: M[] = []
  for (let i = 0; i < msgs.length; i++) if (keep[i]) out.push(msgs[i])
  return out
}

function loadHistory(conversationId: string): Msg[] {
  const rows = selectAllMessagesStmt.all(conversationId) as {
    role: string
    contentJson: string
  }[]
  const msgs: Msg[] = rows.map((r) => ({
    role: r.role === "USER" ? "user" : "assistant",
    content: JSON.parse(r.contentJson),
  }))
  return sanitiseHistory(msgs)
}

// Find a "turn boundary": a user message that contains NO tool_result blocks.
// These are the only safe trim points — slicing here can never split a
// tool_use/tool_result pair. Returns the rowid of the oldest row to keep, or
// null if no trimming is needed (transcript is below budget).
function findTrimRowid(conversationId: string): number | null {
  const rows = selectRowidsAscStmt.all(conversationId) as {
    rid: number
    role: string
    contentJson: string
  }[]
  if (rows.length <= MAX_MESSAGES) return null

  // Walk newest → oldest, count messages, and remember the most recent row
  // that crosses the budget AND sits on a turn boundary (a plain user turn
  // with no tool_result blocks). Keep everything from that row onward.
  let count = 0
  let trimAt: number | null = null
  for (let i = rows.length - 1; i >= 0; i--) {
    count++
    const r = rows[i]
    if (count < MAX_MESSAGES) continue
    if (r.role !== "USER") continue
    let isBoundary = true
    try {
      const content = JSON.parse(r.contentJson)
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string }
          if (b.type === "tool_result") {
            isBoundary = false
            break
          }
        }
      }
    } catch {
      isBoundary = false
    }
    if (isBoundary) {
      trimAt = r.rid
      break
    }
  }
  return trimAt
}

export const memory = {
  getHistory(userId: number): Msg[] {
    const cid = ensureConversation(userId)
    return loadHistory(cid)
  },
  append(userId: number, msg: Msg) {
    const cid = ensureConversation(userId)
    const role = msg.role === "user" ? "USER" : "ASSISTANT"
    let persisted = stripDocumentsForPersist(msg.content)
    if (role === "ASSISTANT") {
      noteAssistantToolUses(userId, persisted)
    } else {
      persisted = stripSkillResultsForPersist(userId, persisted)
    }
    const contentJson = JSON.stringify(persisted)
    const preview = previewOf(persisted)
    insertMessageStmt.run(newId("ms"), cid, role, contentJson, preview)
    touchConversationStmt.run(cid)
    const trimRowid = findTrimRowid(cid)
    if (trimRowid !== null) trimMessagesByRowidStmt.run(cid, trimRowid)
  },
  reset(userId: number) {
    pendingSkillToolIdsByUser.delete(userId)
    const chatId = String(userId)
    const existing = findConversationStmt.get(chatId) as { id: string } | undefined
    if (!existing) return
    deleteMessagesStmt.run(existing.id)
    deleteConversationStmt.run(existing.id)
  },
  size(userId: number): number {
    const cid = ensureConversation(userId)
    return loadHistory(cid).length
  },
}

export function getIdleHours(
  userId: number,
): { idleHours: number; msgCount: number } | null {
  const row = selectConversationActivityStmt.get(String(userId)) as
    | { id: string; idleHours: number; msgCount: number }
    | undefined
  if (!row) return null
  return { idleHours: row.idleHours, msgCount: row.msgCount }
}

function renderTranscriptForSummary(msgs: Msg[]): string {
  const lines: string[] = []
  for (const m of msgs) {
    const role = m.role === "user" ? "User" : "Tata"
    let text = ""
    if (typeof m.content === "string") {
      text = m.content
    } else {
      const parts: string[] = []
      for (const block of m.content) {
        const b = block as { type?: string; text?: string }
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
      }
      text = parts.join("\n")
    }
    if (text.trim()) lines.push(`${role}: ${text.trim()}`)
  }
  return lines.join("\n\n")
}

export async function summarizeAndRollover(userId: number): Promise<void> {
  const past = memory.getHistory(userId)
  if (past.length === 0) return
  const transcript = renderTranscriptForSummary(past)
  let summary = ""
  try {
    summary = await summarizePriorSession(transcript)
  } catch (err) {
    console.error(`[rollover] user=${userId} summarize failed:`, err)
  }
  if (summary.trim().length > 0) {
    try {
      upsertMemoryFile(userId, "/memories/last-session.md", summary.trim() + "\n")
    } catch (err) {
      console.error(`[rollover] user=${userId} memory write failed:`, err)
    }
  }
  memory.reset(userId)
}
