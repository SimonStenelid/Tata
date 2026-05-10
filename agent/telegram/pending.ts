// Generic resolver map for Telegram inline-keyboard prompts. Replaces the
// ad-hoc pendingConfirms / pendingCategoryPicks / pendingCategoryIndex maps
// in bot.ts. Each pending entry is keyed by `${uid}:${token}` and carries a
// resolver plus optional metadata (used by category picks to remember the
// option list across rounds).

type AnyPending = {
  resolve: (value: unknown) => void
  meta?: unknown
  expiresAt: number
  timer: NodeJS.Timeout
}

const pending = new Map<string, AnyPending>()

function key(uid: number, token: string): string {
  return `${uid}:${token}`
}

export type RegisterArgs<T> = {
  uid: number
  token: string
  resolve: (v: T) => void
  meta?: unknown
  ttlMs?: number
}

const DEFAULT_TTL_MS = 5 * 60 * 1000

export function register<T>({
  uid,
  token,
  resolve,
  meta,
  ttlMs = DEFAULT_TTL_MS,
}: RegisterArgs<T>): void {
  const k = key(uid, token)
  // If the same key is reused, clear the old timer first.
  const existing = pending.get(k)
  if (existing) {
    clearTimeout(existing.timer)
    pending.delete(k)
  }
  const timer = setTimeout(() => {
    const entry = pending.get(k)
    if (!entry) return
    pending.delete(k)
    entry.resolve(undefined)
  }, ttlMs)
  pending.set(k, {
    resolve: resolve as (v: unknown) => void,
    meta,
    expiresAt: Date.now() + ttlMs,
    timer,
  })
}

export type Consumed<T> = { resolve: (v: T) => void; meta?: unknown }

export function consume<T>(
  uid: number,
  token: string,
): Consumed<T> | null {
  const k = key(uid, token)
  const entry = pending.get(k)
  if (!entry) return null
  pending.delete(k)
  clearTimeout(entry.timer)
  return { resolve: entry.resolve as (v: T) => void, meta: entry.meta }
}

export function has(uid: number, token: string): boolean {
  return pending.has(key(uid, token))
}

export function size(): number {
  return pending.size
}
