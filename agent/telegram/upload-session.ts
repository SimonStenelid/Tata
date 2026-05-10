import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes
const MAX_FILES = 4
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB

export type UploadedFile = {
  path: string
  originalName: string
  bytes: number
}

export type UploadSession = {
  userId: number
  dir: string
  files: UploadedFile[]
  startedAt: Date
  timer: NodeJS.Timeout
}

const sessions = new Map<number, UploadSession>()

function baseDir(userId: number): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  return path.join(os.tmpdir(), "tata-agent", String(userId), ts)
}

export const uploadSessions = {
  start(userId: number): UploadSession {
    const existing = sessions.get(userId)
    if (existing) return existing
    const dir = baseDir(userId)
    fs.mkdirSync(dir, { recursive: true })
    const session: UploadSession = {
      userId,
      dir,
      files: [],
      startedAt: new Date(),
      timer: setTimeout(() => uploadSessions.clear(userId), TIMEOUT_MS),
    }
    sessions.set(userId, session)
    return session
  },

  get(userId: number): UploadSession | undefined {
    return sessions.get(userId)
  },

  has(userId: number): boolean {
    return sessions.has(userId)
  },

  addFile(
    userId: number,
    originalName: string,
    bytes: number,
  ): { path: string } {
    const s = sessions.get(userId)
    if (!s) throw new Error("no active upload session — run /add first")
    if (s.files.length >= MAX_FILES) {
      throw new Error(`max ${MAX_FILES} files per session`)
    }
    if (bytes > MAX_BYTES) {
      throw new Error(`file too large (max ${MAX_BYTES / 1024 / 1024} MB)`)
    }
    const safe = originalName.replace(/[^\w.\-]/g, "_")
    const p = path.join(s.dir, `${s.files.length + 1}-${safe}`)
    return { path: p }
  },

  recordFile(userId: number, p: string, originalName: string, bytes: number) {
    const s = sessions.get(userId)
    if (!s) return
    s.files.push({ path: p, originalName, bytes })
  },

  clear(userId: number) {
    const s = sessions.get(userId)
    if (!s) return
    clearTimeout(s.timer)
    try {
      fs.rmSync(s.dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
    sessions.delete(userId)
  },

  MAX_FILES,
  MAX_BYTES,
  TIMEOUT_MS,
}
