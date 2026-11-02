import type { KindroidClient } from "../api/client"
import { KindroidError, describeError } from "../api/errors"
import type { ChatMessage, ConversationRef } from "../api/types"
import { convKey } from "../api/types"
import { type HistoryCache, syncHistory } from "./cache"

export type Role = "user" | "ai"

export interface ViewMessage {
  /** Stable key for rendering. */
  key: string
  /** Server id once known. */
  id?: string
  /** Optimistic message not yet confirmed by a sync. */
  local: boolean
  role: Role
  speakerId: string
  name: string
  text: string
  /** Milliseconds since epoch. */
  timestamp: number
  /** The server's timestamp in its own units, for cache queries. */
  rawTs?: number
  images: string[]
  notes: string[]
  /** Set when this message failed; the text explains why. */
  failed?: string
  /** A user message the server never accepted. Survives syncs so the text isn't lost. */
  notSent?: boolean
}

export type Activity =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "sending" }
  | { kind: "turn" }
  | { kind: "streaming"; speakerId: string; name: string }
  | { kind: "rewinding" }
  | { kind: "breaking" }

export interface Draft {
  speakerId: string
  name: string
  text: string
}

export interface ConversationState {
  messages: ViewMessage[]
  draft: Draft | null
  activity: Activity
  error: string | null
  notice: string | null
  /** More (older) messages exist in the local cache. */
  canLoadOlder: boolean
  lastSyncedAt: number | null
}

export type ConversationClient = Pick<
  KindroidClient,
  "sendMessage" | "getChatMessages" | "rewind" | "chatBreak" | "groupUserMessage" | "groupGetTurn" | "groupAiResponse" | "budget"
>

export interface ConversationDeps {
  client: ConversationClient
  cache: HistoryCache
  ref: ConversationRef
  title: string
  /** Display name for an ai_id, from config. */
  nameFor: (aiId: string) => string | undefined
  /** Label for the user's messages; falls back to the name Kindroid reports, then "You". */
  userName?: string
  maxGroupTurns: number
  /** Messages shown when a conversation opens. */
  windowSize?: number
  /** Background syncs are skipped when the daily history budget is at or below this. */
  historyReserve?: number
  /** Minimum gap between automatic syncs of the same conversation. */
  autoSyncIntervalMs?: number
  now?: () => number
}

const USER_TYPES = new Set(["user", "human", "you", "self"])

/** Decide whether a history message came from the user. Tuned by the API probe (docs/api-notes.md). */
export function roleOf(m: Pick<ChatMessage, "sender" | "sender_type">): Role {
  const t = m.sender_type?.toLowerCase().trim()
  if (t && USER_TYPES.has(t)) return "user"
  if (t) return "ai"
  return m.sender?.toLowerCase() === "user" ? "user" : "ai"
}

/** Kindroid timestamps may be seconds or milliseconds; normalise to ms. */
export const toMs = (ts: number) => (ts > 0 && ts < 1e12 ? ts * 1000 : ts)

/**
 * Suggest a display name from a little chat history, since the API can't read a Kindroid's profile:
 * a Kindroid's own display_name, or for a group (whose name the API doesn't expose) the names of the
 * Kindroids talking in it, e.g. "Ava, Rex & Mira".
 */
export function suggestName(kind: ConversationRef["kind"], messages: ChatMessage[]): string | undefined {
  const names: string[] = []
  for (const m of [...messages].reverse()) {
    const name = m.display_name?.trim()
    if (roleOf(m) === "ai" && name && !names.includes(name)) names.push(name)
  }
  if (names.length === 0) return undefined
  if (kind === "kin") return names[0]
  const shown = names.slice(0, 3).sort((a, b) => a.localeCompare(b))
  const more = names.length - shown.length
  if (more > 0) return `${shown.join(", ")} +${more}`
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} & ${shown.at(-1)}`
}

/** Which optimistic messages survive a sync: unsent user text and failed replies (so the error stays visible). */
const keepAcrossSync = (m: ViewMessage) => m.notSent || (m.role === "ai" && !!m.failed && m.failed !== "stopped")

let localSeq = 0
const localKey = () => `local:${Date.now().toString(36)}:${++localSeq}`

export class Conversation {
  readonly ref: ConversationRef
  readonly title: string
  state: ConversationState = {
    messages: [],
    draft: null,
    activity: { kind: "idle" },
    error: null,
    notice: null,
    canLoadOlder: false,
    lastSyncedAt: null,
  }

  private readonly deps: Required<Omit<ConversationDeps, "now" | "userName">> & { now: () => number; userName?: string }
  /** The user's name as Kindroid labels it, learned from history. */
  private serverUserName: string | undefined
  private listeners = new Set<(s: ConversationState) => void>()
  private views = new Map<string, { raw: string; view: ViewMessage }>()
  private serverMessages: ViewMessage[] = []
  private locals: ViewMessage[] = []
  private windowSize: number
  private controller: AbortController | null = null
  private running: Promise<void> | null = null
  private stopRequested = false
  private opened = false

  constructor(deps: ConversationDeps) {
    this.deps = {
      windowSize: 200,
      historyReserve: 50,
      autoSyncIntervalMs: 120_000,
      now: () => Date.now(),
      ...deps,
    }
    this.ref = deps.ref
    this.title = deps.title
    this.windowSize = this.deps.windowSize
  }

  get key() {
    return convKey(this.ref)
  }

  get busy() {
    return this.state.activity.kind !== "idle"
  }

  subscribe(fn: (s: ConversationState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Show cached history immediately, then sync in the background. */
  async open(): Promise<void> {
    if (!this.opened) {
      this.opened = true
      this.reloadFromCache()
    }
    await this.sync({ manual: false })
  }

  /** Pull new messages from Kindroid. Background syncs respect the budget reserve and a minimum interval. */
  async sync(opts: { manual: boolean } = { manual: true }): Promise<void> {
    if (this.busy) return
    const budget = this.deps.client.budget
    if (!opts.manual) {
      const last = this.state.lastSyncedAt ?? Number(this.deps.cache.getMeta(`synced:${this.key}`) ?? 0)
      if (last && this.deps.now() - last < this.deps.autoSyncIntervalMs && this.deps.cache.count(this.ref) > 0) return
      if (!budget.canSpend(this.deps.historyReserve)) {
        this.set({ notice: `Auto-sync paused: ${budget.remaining()} history calls left today (ctrl+l to force)` })
        return
      }
    } else if (!budget.canSpend(0)) {
      this.set({ error: "Daily history limit reached (600 per 24 h); try again later" })
      return
    }
    await this.run({ kind: "syncing" }, async (signal) => {
      await this.syncNow(signal)
    })
  }

  /**
   * Whether an action (send, undo, regenerate, chat break, more group replies) would be accepted now.
   * A sync in progress doesn't block anything: the action waits for it to finish.
   */
  canAct(): boolean {
    return !this.busy || this.state.activity.kind === "syncing"
  }

  /** Wait out a sync in progress. False when something else (a reply, a rewind) is still running. */
  private async settle(): Promise<boolean> {
    while (this.state.activity.kind === "syncing" && this.running) await this.running.catch(() => {})
    if (!this.busy) return true
    this.set({ notice: "Still working on the last message (esc to stop)" })
    return false
  }

  /** Send a user message. 1:1 chats stream one reply; group chats run the turn loop. */
  async send(text: string): Promise<void> {
    const body = text.trim()
    if (!body) return
    if (!(await this.settle())) return
    // Earlier failures have been seen by now; clear them so they don't trail newer messages.
    this.locals = this.locals.filter((m) => !m.failed)
    const userMsg = this.addLocal({ role: "user", speakerId: "user", name: this.userLabel(), text: body })
    if (this.ref.kind === "kin") {
      await this.run({ kind: "sending" }, async (signal) => {
        try {
          const stream = await this.deps.client.sendMessage(this.ref.id, body, signal)
          await this.consume(stream, this.ref.id, this.title, signal)
        } catch (err) {
          this.handleSendError(err, userMsg)
        }
        await this.reconcile(signal)
      })
    } else {
      await this.run({ kind: "sending" }, async (signal) => {
        try {
          await this.deps.client.groupUserMessage(this.ref.id, body, signal)
        } catch (err) {
          this.handleSendError(err, userMsg)
          return
        }
        await this.groupTurns(signal, true)
        await this.reconcile(signal)
      })
    }
  }

  /** Group chats: ask for another AI turn without giving the user the floor. */
  async continueGroup(): Promise<void> {
    if (this.ref.kind !== "group" || !(await this.settle())) return
    await this.run({ kind: "turn" }, async (signal) => {
      await this.groupTurns(signal, false)
      await this.reconcile(signal)
    })
  }

  /** Stop streaming and stop the group loop. The server may still save the interrupted reply. */
  stop(): void {
    this.stopRequested = true
    this.controller?.abort()
  }

  /**
   * Remove the last exchange (1:1: user message + reply) or the last message (group) on the server.
   * Returns the removed user text so the UI can offer it for editing.
   */
  async undo(): Promise<string | null> {
    if (!(await this.settle())) return null
    let restored: string | null = null
    await this.run({ kind: "rewinding" }, async (signal) => {
      if (this.locals.some((m) => !m.notSent)) await this.syncNow(signal)
      const count = this.ref.kind === "kin" ? 2 : 1
      const tail = this.serverMessages.slice(-count)
      if (this.ref.kind === "kin" && tail.at(-1)?.role === "user") {
        throw new KindroidError("conflict", {
          detail: "the last reply is missing and Kindroid only rewinds whole exchanges; send another message instead",
        })
      }
      if (this.ref.kind === "kin" && (tail.length < 2 || tail[0]!.role !== "user")) {
        throw new KindroidError("conflict", { detail: "the last two messages aren't a message and its reply" })
      }
      const res = await this.deps.client.rewind(this.ref, count, signal)
      const ids = res.deleted_message_ids?.length ? res.deleted_message_ids : tail.map((m) => m.id!).filter(Boolean)
      this.deps.cache.remove(this.ref, ids)
      restored = tail.find((m) => m.role === "user")?.text ?? null
      this.locals = []
      this.reloadFromCache()
      this.set({ notice: this.ref.kind === "kin" ? "Undid the last exchange" : "Removed the last message" })
    })
    return restored
  }

  /** 1:1 only: rewind the last exchange and send the same user message again. */
  async regenerate(): Promise<void> {
    if (this.ref.kind !== "kin") return
    const text = await this.undo()
    if (text && !this.state.error) await this.send(text)
  }

  /** End the chat (short-term memory reset). `wipe` also clears long-term (cascaded) memory. */
  async chatBreak(greeting: string, wipe: boolean): Promise<void> {
    if (!(await this.settle())) return
    await this.run({ kind: "breaking" }, async (signal) => {
      await this.deps.client.chatBreak(this.ref, greeting, wipe, signal)
      this.deps.cache.clear(this.ref)
      this.locals = []
      this.views.clear()
      this.reloadFromCache()
      this.set({ notice: wipe ? "Chat break done; long-term memory wiped" : "Chat break done" })
      await this.syncNow(signal)
    })
  }

  /** Show more history from the local cache. */
  loadOlder(count = 100): number {
    const oldest = this.serverMessages[0]
    if (!oldest) return 0
    const older = this.deps.cache.loadBefore(this.ref, oldest.rawTs ?? oldest.timestamp, count)
    if (older.length === 0) {
      this.set({ canLoadOlder: false })
      return 0
    }
    this.windowSize += older.length
    this.reloadFromCache()
    return older.length
  }

  dismissError(): void {
    if (this.state.error || this.state.notice) this.set({ error: null, notice: null })
  }

  // --- internals -------------------------------------------------------------------------------

  private run(activity: Activity, fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    this.stopRequested = false
    this.set({ activity, error: null, notice: null })
    const job = (async () => {
      try {
        await fn(controller.signal)
      } catch (err) {
        if (!(err instanceof KindroidError && err.kind === "aborted")) this.set({ error: describeError(err) })
      } finally {
        if (this.controller === controller) this.controller = null
        this.set({ activity: { kind: "idle" }, draft: null })
      }
    })()
    this.running = job
    return job.finally(() => {
      if (this.running === job) this.running = null
    })
  }

  private async groupTurns(signal: AbortSignal, allowUserFirst: boolean): Promise<void> {
    let allowUser = allowUserFirst
    let turns = 0
    while (!this.stopRequested && turns < this.deps.maxGroupTurns) {
      this.set({ activity: { kind: "turn" } })
      const aiId = await this.deps.client.groupGetTurn(this.ref.id, allowUser, signal)
      if (!aiId) return
      allowUser = true
      turns++
      const name = this.nameOf(aiId)
      try {
        const stream = await this.deps.client.groupAiResponse(this.ref.id, aiId, signal)
        await this.consume(stream, aiId, name, signal)
      } catch (err) {
        this.handleReplyError(err, aiId, name)
        return
      }
    }
    if (!this.stopRequested && turns >= this.deps.maxGroupTurns) {
      this.set({ notice: `Paused after ${turns} replies (ctrl+n lets them keep talking)` })
    }
  }

  /** Stream a reply into the draft, then commit it as a local message. */
  private async consume(stream: AsyncIterable<string>, speakerId: string, name: string, signal: AbortSignal) {
    this.set({ activity: { kind: "streaming", speakerId, name }, draft: { speakerId, name, text: "" } })
    let text = ""
    try {
      for await (const chunk of stream) {
        if (signal.aborted) throw new KindroidError("aborted", { partial: text })
        text += chunk
        this.set({ draft: { speakerId, name, text } })
      }
    } catch (err) {
      this.set({ draft: null })
      throw err instanceof KindroidError && err.partial === undefined ? new KindroidError(err.kind, { detail: err.detail, partial: text }) : err
    }
    this.set({ draft: null })
    this.addLocal({ role: "ai", speakerId, name, text: text.trimEnd() || "(empty reply)" })
  }

  private handleSendError(err: unknown, userMsg: ViewMessage): void {
    if (err instanceof KindroidError && ["generation", "stream", "aborted"].includes(err.kind)) {
      // The server accepted the user message; the reply is what failed.
      this.handleReplyError(err, this.ref.id, this.title)
      return
    }
    // The request itself was rejected (auth, subscription, rate limit, network): nothing was sent.
    this.patchLocal(userMsg.key, { failed: describeError(err), notSent: true })
    this.set({ error: describeError(err) })
  }

  private handleReplyError(err: unknown, speakerId: string, name: string): void {
    if (!(err instanceof KindroidError)) throw err
    const partial = err.partial?.trimEnd()
    if (err.kind === "aborted") {
      if (partial) this.addLocal({ role: "ai", speakerId, name, text: partial, failed: "stopped" })
      this.set({ notice: "Stopped. Kindroid may still save the full reply; it will appear after the next sync." })
      return
    }
    if (err.kind === "generation" || err.kind === "stream") {
      this.addLocal({
        role: "ai",
        speakerId,
        name,
        text: partial || "",
        failed: `${err.message}${this.ref.kind === "kin" ? " (ctrl+r to regenerate)" : ""}`,
      })
      return
    }
    throw err
  }

  /** One sync after a reply so optimistic messages get real ids and any selfie image_urls. */
  private async reconcile(signal: AbortSignal): Promise<void> {
    if (!this.deps.client.budget.canSpend(this.deps.historyReserve)) return
    try {
      await this.syncNow(signal)
    } catch (err) {
      if (!(err instanceof KindroidError && err.kind === "aborted")) {
        this.set({ notice: `Couldn't sync: ${describeError(err)}` })
      }
    }
  }

  private async syncNow(signal: AbortSignal): Promise<void> {
    this.set({ activity: { kind: "syncing" } })
    const res = await syncHistory(this.deps.client, this.deps.cache, this.ref, { signal })
    const now = this.deps.now()
    this.deps.cache.setMeta(`synced:${this.key}`, String(now))
    this.locals = this.locals.filter(keepAcrossSync)
    this.reloadFromCache()
    this.set({
      lastSyncedAt: now,
      ...(res.truncated ? { notice: "Synced part of a long history; more arrives on later syncs" } : {}),
    })
  }

  private reloadFromCache(): void {
    const raw = this.deps.cache.load(this.ref, this.windowSize)
    this.serverMessages = raw.map((m) => this.viewOf(m))
    this.set({ canLoadOlder: this.deps.cache.count(this.ref) > raw.length })
    this.publishMessages()
  }

  private viewOf(m: ChatMessage): ViewMessage {
    const rawKey = JSON.stringify(m)
    const hit = this.views.get(m.id)
    if (hit && hit.raw === rawKey) return hit.view
    const role = roleOf(m)
    const notes: string[] = []
    if (m.image_description) notes.push(`image: ${m.image_description}`)
    if (m.video_description) notes.push(`video: ${m.video_description}`)
    if (m.link_url) notes.push(`link: ${m.link_description ? `${m.link_description} ` : ""}${m.link_url}`)
    if (m.internet_response) notes.push(`searched: ${m.internet_response}`)
    const view: ViewMessage = {
      key: m.id,
      id: m.id,
      local: false,
      role,
      speakerId: role === "user" ? "user" : m.sender,
      name: role === "user" ? this.userLabel(m.display_name) : this.nameOf(m.sender, m.display_name),
      text: m.message,
      timestamp: toMs(m.timestamp),
      rawTs: m.timestamp,
      images: (m.image_urls ?? []).filter((u) => typeof u === "string" && /^https?:\/\//.test(u)),
      notes,
    }
    this.views.set(m.id, { raw: rawKey, view })
    return view
  }

  private userLabel(fromServer?: string): string {
    if (fromServer) this.serverUserName = fromServer
    return this.deps.userName ?? fromServer ?? this.serverUserName ?? "You"
  }

  private nameOf(aiId: string, displayName?: string): string {
    if (this.ref.kind === "kin" && (aiId === this.ref.id || !aiId)) return this.deps.nameFor(this.ref.id) ?? this.title
    return this.deps.nameFor(aiId) ?? displayName ?? (aiId ? aiId.slice(0, 8) : "AI")
  }

  private addLocal(m: Omit<ViewMessage, "key" | "local" | "timestamp" | "images" | "notes"> & Partial<ViewMessage>): ViewMessage {
    const view: ViewMessage = { key: localKey(), local: true, timestamp: this.deps.now(), images: [], notes: [], ...m }
    this.locals = [...this.locals, view]
    this.publishMessages()
    return view
  }

  private patchLocal(key: string, patch: Partial<ViewMessage>): void {
    this.locals = this.locals.map((m) => (m.key === key ? { ...m, ...patch } : m))
    this.publishMessages()
  }

  private publishMessages(): void {
    this.set({ messages: this.locals.length ? [...this.serverMessages, ...this.locals] : this.serverMessages })
  }

  private set(patch: Partial<ConversationState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l(this.state)
  }
}
