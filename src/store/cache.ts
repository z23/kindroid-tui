import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { KindroidClient } from "../api/client"
import type { BudgetStore } from "../api/rateLimiter"
import { convKey, type ChatMessage, type ConversationRef } from "../api/types"

/**
 * Local history cache (bun:sqlite). Chat content is private, so the file is created 0600.
 * Rows are keyed by (conversation, message id); the server is the source of truth and every sync
 * upserts what it returns.
 */
export class HistoryCache {
  private db: Database

  constructor(file: string | ":memory:") {
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const isNew = !existsSync(file)
      this.db = new Database(file, { create: true })
      if (isNew) chmodSync(file, 0o600)
    } else {
      this.db = new Database(":memory:")
    }
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        conv TEXT NOT NULL,
        id   TEXT NOT NULL,
        ts   REAL NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (conv, id)
      );
      CREATE INDEX IF NOT EXISTS messages_conv_ts ON messages (conv, ts);
      CREATE TABLE IF NOT EXISTS budget (ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }

  /** Messages for a conversation in chronological order. `limit` keeps the newest N. */
  load(ref: ConversationRef, limit?: number): ChatMessage[] {
    const conv = convKey(ref)
    const rows = limit
      ? this.db
          .query<{ data: string }, [string, number]>(
            "SELECT data FROM (SELECT data, ts, id FROM messages WHERE conv = ? ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts, id",
          )
          .all(conv, limit)
      : this.db.query<{ data: string }, [string]>("SELECT data FROM messages WHERE conv = ? ORDER BY ts, id").all(conv)
    return rows.map((r) => JSON.parse(r.data) as ChatMessage)
  }

  /** Messages strictly older than `beforeTs`, newest `limit` of them, in chronological order. */
  loadBefore(ref: ConversationRef, beforeTs: number, limit: number): ChatMessage[] {
    return this.db
      .query<{ data: string }, [string, number, number]>(
        "SELECT data FROM (SELECT data, ts, id FROM messages WHERE conv = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts, id",
      )
      .all(convKey(ref), beforeTs, limit)
      .map((r) => JSON.parse(r.data) as ChatMessage)
  }

  count(ref: ConversationRef): number {
    return (
      this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE conv = ?").get(convKey(ref))?.n ?? 0
    )
  }

  upsert(ref: ConversationRef, messages: ChatMessage[]): void {
    if (messages.length === 0) return
    const conv = convKey(ref)
    const stmt = this.db.prepare("INSERT OR REPLACE INTO messages (conv, id, ts, data) VALUES (?, ?, ?, ?)")
    this.db.transaction(() => {
      for (const m of messages) stmt.run(conv, m.id, m.timestamp, JSON.stringify(m))
    })()
  }

  remove(ref: ConversationRef, ids: string[]): void {
    if (ids.length === 0) return
    const conv = convKey(ref)
    const stmt = this.db.prepare("DELETE FROM messages WHERE conv = ? AND id = ?")
    this.db.transaction(() => {
      for (const id of ids) stmt.run(conv, id)
    })()
  }

  clear(ref: ConversationRef): void {
    this.db.run("DELETE FROM messages WHERE conv = ?", [convKey(ref)])
  }

  newestTimestamp(ref: ConversationRef): number | null {
    return (
      this.db.query<{ ts: number | null }, [string]>("SELECT MAX(ts) AS ts FROM messages WHERE conv = ?").get(convKey(ref))
        ?.ts ?? null
    )
  }

  getMeta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value])
  }

  /** Persistent store for the daily /get-chat-messages budget. */
  budgetStore(): BudgetStore {
    return {
      load: (sinceMs) =>
        this.db
          .query<{ ts: number }, [number]>("SELECT ts FROM budget WHERE ts > ? ORDER BY ts")
          .all(sinceMs)
          .map((r) => r.ts),
      record: (ts) => {
        this.db.run("INSERT INTO budget (ts) VALUES (?)", [ts])
      },
      prune: (beforeMs) => {
        this.db.run("DELETE FROM budget WHERE ts <= ?", [beforeMs])
      },
    }
  }

  close(): void {
    this.db.close()
  }
}

export interface SyncResult {
  added: number
  pages: number
  /** True when the page cap stopped the sync before the server ran out of messages. */
  truncated: boolean
}

/**
 * Fetch everything newer than the cache's newest message (or the first pages for an empty cache)
 * and upsert it. `maxPages` protects the 600/day history budget.
 */
export async function syncHistory(
  client: Pick<KindroidClient, "getChatMessages">,
  cache: HistoryCache,
  ref: ConversationRef,
  opts: { maxPages?: number; pageSize?: number; signal?: AbortSignal } = {},
): Promise<SyncResult> {
  const maxPages = opts.maxPages ?? 10
  const limit = opts.pageSize ?? 100
  let cursor = cache.newestTimestamp(ref) ?? undefined
  let added = 0
  let pages = 0
  for (;;) {
    const res = await client.getChatMessages(ref, { limit, startAfter: cursor, signal: opts.signal })
    pages++
    cache.upsert(ref, res.messages)
    added += res.messages.length
    const next = res.pagination.lastTimestamp || res.messages.at(-1)?.timestamp
    if (!res.pagination.hasMore || res.messages.length === 0 || next === undefined || next === cursor) {
      return { added, pages, truncated: false }
    }
    if (pages >= maxPages) return { added, pages, truncated: true }
    cursor = next
  }
}
