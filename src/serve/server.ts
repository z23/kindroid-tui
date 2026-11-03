import { KindroidClient } from "../api/client"
import { describeError } from "../api/errors"
import type { DailyBudget, RateLimiter } from "../api/rateLimiter"
import { convKey, type ConversationKind, type ConversationRef } from "../api/types"
import { addConversation, type Config } from "../config"
import { normalizeId } from "../ids"
import type { HistoryCache } from "../store/cache"
import {
  Conversation,
  suggestName,
  type ConversationState,
  type Draft,
  type UndoPreview,
  type ViewMessage,
} from "../store/conversation"
import { formatMessage, type Segment } from "../ui/format"
import { VERSION } from "../version"

/**
 * Headless front end for the Omarchy plugin: newline-delimited JSON on stdin/stdout.
 *
 * Requests:  {"id": 1, "method": "send", "params": {"key": "kin:…", "text": "hi"}}
 * Responses: {"id": 1, "ok": true, "result": …} or {"id": 1, "ok": false, "error": "…"}
 * Events:    {"event": "ready" | "config" | "limits" | "conversation", …}
 *
 * Long actions (send, regenerate, sync, continue) answer at once and report progress through
 * `conversation` events; the rest answer when they finish. Bump PROTOCOL on any breaking change: the
 * plugin refuses a helper that speaks a different version.
 *
 * Like the terminal UI, this only talks to Kindroid when asked to. Nothing here polls or runs on a timer.
 */
export const PROTOCOL = 1

export interface WireMessage {
  key: string
  id?: string
  role: "user" | "ai"
  speakerId: string
  name: string
  text: string
  segments: Segment[]
  /** Milliseconds since epoch. */
  ts: number
  images: string[]
  notes: string[]
  local: boolean
  failed?: string
  notSent?: boolean
}

export interface WireDraft {
  speakerId: string
  name: string
  text: string
  segments: Segment[]
}

export interface WireEntry {
  key: string
  kind: ConversationKind
  id: string
  name: string
}

export interface WireUndoPreview {
  unit: UndoPreview["unit"]
  steps: number
  maxSteps: number
  messages: WireMessage[]
  problem?: string
}

type WireState = Omit<ConversationState, "messages" | "draft"> & { messages: WireMessage[]; draft: WireDraft | null }

export interface ServerDeps {
  loadConfig: () => Config
  cache: HistoryCache
  limiter: RateLimiter
  budget: DailyBudget
  /** Receives one JSON line (no trailing newline). */
  write: (line: string) => void
  /** Build an API client for a config with a key. Tests point it at the mock server. */
  makeClient?: (config: Config, limiter: RateLimiter, budget: DailyBudget) => KindroidClient
  /** How long to gather state changes (a streaming reply fires one per chunk) before sending them. */
  flushMs?: number
  /** Messages kept on screen per conversation. */
  windowSize?: number
}

interface Live {
  conv: Conversation
  title: string
  unsubscribe: () => void
  sent: ConversationState | null
  timer: ReturnType<typeof setTimeout> | null
}

type Params = Record<string, unknown>

const MAX_LINE = 1_000_000

const defaultClient = (config: Config, limiter: RateLimiter, budget: DailyBudget) =>
  new KindroidClient({ apiKey: config.apiKey!, baseUrl: config.baseUrl, limiter, budget })

export class Server {
  private config: Config
  private client: KindroidClient | null = null
  private clientSig = ""
  private live = new Map<string, Live>()
  private wire = new WeakMap<ViewMessage, WireMessage>()
  private limitsTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribers: Array<() => void> = []
  private closed = false
  private readonly flushMs: number
  private readonly windowSize: number

  constructor(private readonly deps: ServerDeps) {
    this.flushMs = deps.flushMs ?? 33
    this.windowSize = deps.windowSize ?? 120
    this.config = deps.loadConfig()
    this.rebuildClient()
  }

  start(): void {
    this.emit({ event: "ready", protocol: PROTOCOL, version: VERSION })
    this.emitConfig()
    this.emitLimits()
    this.unsubscribers.push(
      this.deps.limiter.onChange(() => this.scheduleLimits()),
      this.deps.budget.onChange(() => this.scheduleLimits()),
    )
  }

  /** Stop every reply in flight and drop all listeners. The caller closes the cache. */
  shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const live of this.live.values()) this.dispose(live)
    this.live.clear()
    for (const u of this.unsubscribers) u()
    if (this.limitsTimer) clearTimeout(this.limitsTimer)
  }

  /** Handle one request line. Never throws; failures become error responses. */
  async handle(line: string): Promise<void> {
    if (line.length > MAX_LINE) {
      this.emit({ id: null, ok: false, error: "request too large" })
      return
    }
    let req: { id?: unknown; method?: unknown; params?: unknown }
    try {
      req = JSON.parse(line)
    } catch {
      this.emit({ id: null, ok: false, error: "invalid JSON" })
      return
    }
    const id = typeof req.id === "number" || typeof req.id === "string" ? req.id : null
    const method = typeof req.method === "string" ? req.method : ""
    const params = (req.params && typeof req.params === "object" ? req.params : {}) as Params
    let response: Record<string, unknown>
    try {
      const result = await this.dispatch(method, params)
      response = { id, ok: true, result: result ?? null }
    } catch (err) {
      response = { id, ok: false, error: describeError(err) }
    }
    // State changes a request caused always arrive before its response.
    for (const live of this.live.values()) if (live.timer) this.flush(live, false)
    this.emit(response)
  }

  private async dispatch(method: string, p: Params): Promise<unknown> {
    switch (method) {
      case "hello":
        return { protocol: PROTOCOL, version: VERSION }
      case "reload":
        this.reload()
        return null
      case "setActive": {
        const entry = this.entry(str(p, "key"))
        this.deps.cache.setMeta("active", entry.key)
        return null
      }
      case "open": {
        const live = this.conversation(str(p, "key"))
        // open() loads the cache synchronously before it syncs; push that at once so the panel draws
        // before the network answers.
        const job = live.conv.open()
        this.flush(live, true)
        background(job)
        return null
      }
      case "send": {
        const text = str(p, "text").trim()
        if (!text) throw new Error("message is empty")
        background(this.conversation(str(p, "key")).conv.send(text))
        return null
      }
      case "stop":
        this.conversation(str(p, "key")).conv.stop()
        return null
      case "continue":
        background(this.conversation(str(p, "key")).conv.continueGroup())
        return null
      case "regenerate":
        background(this.conversation(str(p, "key")).conv.regenerate())
        return null
      case "sync":
        background(this.conversation(str(p, "key")).conv.sync({ manual: true }))
        return null
      case "dismiss":
        this.conversation(str(p, "key")).conv.dismissError()
        return null
      case "loadOlder":
        return { added: this.conversation(str(p, "key")).conv.loadOlder(num(p, "count", 100)) }
      case "undoPreview": {
        const preview = this.conversation(str(p, "key")).conv.undoPreview(num(p, "steps", 1))
        return this.wirePreview(preview)
      }
      case "undo": {
        const restored = await this.conversation(str(p, "key")).conv.undo(num(p, "steps", 1))
        return { restored }
      }
      case "scene":
        return { ok: await this.conversation(str(p, "key")).conv.setScene(str(p, "text")) }
      case "chatBreak": {
        const greeting = str(p, "greeting").trim()
        if (!greeting) throw new Error("a chat break needs a greeting")
        await this.conversation(str(p, "key")).conv.chatBreak(greeting, p.wipe === true)
        return null
      }
      case "lookup": {
        const kind = kindOf(p)
        const id = normalizeId(str(p, "id"))
        if (!id) throw new Error("paste an ID first")
        const res = await this.requireClient().getChatMessages({ kind, id }, { limit: 20 })
        return { id, name: suggestName(kind, res.messages) ?? null }
      }
      case "add": {
        const kind = kindOf(p)
        const id = normalizeId(str(p, "id"))
        const name = str(p, "name").trim() || id
        if (!id) throw new Error("paste an ID first")
        const key = convKey({ kind, id })
        const existing = this.entries().find((e) => e.key === key)
        if (existing) throw new Error(`Already in your list as “${existing.name}”`)
        addConversation(this.config.path, { kind, id, name })
        this.reload()
        return { key }
      }
      default:
        throw new Error(`unknown method ${JSON.stringify(method)}`)
    }
  }

  // --- config and client ----------------------------------------------------------------------

  private reload(): void {
    this.config = this.deps.loadConfig()
    const keyChanged = this.rebuildClient()
    const entries = new Map(this.entries().map((e) => [e.key, e]))
    for (const [key, live] of this.live) {
      const entry = entries.get(key)
      // A new key means a new client, which a Conversation can't swap; a renamed entry needs a new title.
      if (keyChanged || !entry || (entry.name !== live.title && !live.conv.busy)) {
        this.dispose(live)
        this.live.delete(key)
      }
    }
    this.emitConfig()
  }

  /** Returns true when the client changed. */
  private rebuildClient(): boolean {
    const sig = this.config.apiKey ? `${this.config.apiKey}\n${this.config.baseUrl ?? ""}` : ""
    if (sig === this.clientSig) return false
    this.clientSig = sig
    this.client = this.config.apiKey
      ? (this.deps.makeClient ?? defaultClient)(this.config, this.deps.limiter, this.deps.budget)
      : null
    return true
  }

  private requireClient(): KindroidClient {
    if (!this.client) throw new Error(`No API key: add api_key to ${this.config.path} or set KINDROID_API_KEY`)
    return this.client
  }

  private entries(): WireEntry[] {
    return [
      ...this.config.kins.map((k) => ({ key: convKey({ kind: "kin", id: k.ai_id }), kind: "kin" as const, id: k.ai_id, name: k.name })),
      ...this.config.groups.map((g) => ({
        key: convKey({ kind: "group", id: g.group_id }),
        kind: "group" as const,
        id: g.group_id,
        name: g.name,
      })),
    ]
  }

  private entry(key: string): WireEntry {
    const entry = this.entries().find((e) => e.key === key)
    if (!entry) throw new Error("Unknown conversation; it may have been removed from config.toml")
    return entry
  }

  private conversation(key: string): Live {
    const existing = this.live.get(key)
    if (existing) return existing
    const entry = this.entry(key)
    const client = this.requireClient()
    const ref: ConversationRef = { kind: entry.kind, id: entry.id }
    const conv = new Conversation({
      client,
      cache: this.deps.cache,
      ref,
      title: entry.name,
      nameFor: (aiId) => this.config.kins.find((k) => k.ai_id === aiId)?.name,
      userName: this.config.ui.userName,
      maxGroupTurns: this.config.ui.maxGroupTurns,
      windowSize: this.windowSize,
    })
    const live: Live = { conv, title: entry.name, unsubscribe: () => {}, sent: null, timer: null }
    live.unsubscribe = conv.subscribe(() => this.schedule(live))
    this.live.set(key, live)
    return live
  }

  private dispose(live: Live): void {
    live.unsubscribe()
    live.conv.stop()
    if (live.timer) clearTimeout(live.timer)
    live.timer = null
  }

  // --- events ---------------------------------------------------------------------------------

  private emit(obj: unknown): void {
    if (this.closed && !(obj && typeof obj === "object" && "id" in obj)) return
    this.deps.write(JSON.stringify(obj))
  }

  private emitConfig(): void {
    const active = this.deps.cache.getMeta("active")
    this.emit({
      event: "config",
      path: this.config.path,
      hasKey: !!this.config.apiKey,
      keySource: this.config.apiKeySource,
      warnings: this.config.warnings,
      userName: this.config.ui.userName ?? null,
      maxGroupTurns: this.config.ui.maxGroupTurns,
      active,
      conversations: this.entries(),
    })
  }

  private scheduleLimits(): void {
    if (this.limitsTimer || this.closed) return
    this.limitsTimer = setTimeout(() => {
      this.limitsTimer = null
      this.emitLimits()
    }, 200)
  }

  private emitLimits(): void {
    const { limiter, budget } = this.deps
    this.emit({
      event: "limits",
      at: Date.now(),
      queued: limiter.queued,
      waitMs: limiter.waitMs(),
      available: limiter.available(),
      limit: limiter.limit,
      budgetRemaining: budget.remaining(),
      budgetLimit: budget.limit,
    })
  }

  private schedule(live: Live): void {
    if (live.timer || this.closed) return
    live.timer = setTimeout(() => {
      live.timer = null
      this.flush(live, false)
    }, this.flushMs)
  }

  /** Send the fields that changed since the last event for this conversation (all of them when `full`). */
  private flush(live: Live, full: boolean): void {
    if (live.timer) {
      clearTimeout(live.timer)
      live.timer = null
    }
    const state = live.conv.state
    const prev = full ? null : live.sent
    const patch: Partial<WireState> = {}
    let changed = false
    for (const field of Object.keys(state) as Array<keyof ConversationState>) {
      if (prev && prev[field] === state[field]) continue
      changed = true
      if (field === "messages") patch.messages = state.messages.map((m) => this.wireMessage(m))
      else if (field === "draft") patch.draft = wireDraft(state.draft)
      else (patch as Record<string, unknown>)[field] = state[field]
    }
    live.sent = state
    if (changed) this.emit({ event: "conversation", key: live.conv.key, full, state: patch })
  }

  private wireMessage(m: ViewMessage): WireMessage {
    const hit = this.wire.get(m)
    if (hit) return hit
    const w: WireMessage = {
      key: m.key,
      ...(m.id ? { id: m.id } : {}),
      role: m.role,
      speakerId: m.speakerId,
      name: m.name,
      text: m.text,
      segments: formatMessage(m.text),
      ts: m.timestamp,
      images: m.images,
      notes: m.notes,
      local: m.local,
      ...(m.failed ? { failed: m.failed } : {}),
      ...(m.notSent ? { notSent: true } : {}),
    }
    this.wire.set(m, w)
    return w
  }

  private wirePreview(p: UndoPreview): WireUndoPreview {
    return {
      unit: p.unit,
      steps: p.steps,
      maxSteps: p.maxSteps,
      messages: p.messages.map((m) => this.wireMessage(m)),
      ...(p.problem ? { problem: p.problem } : {}),
    }
  }
}

function wireDraft(d: Draft | null): WireDraft | null {
  return d ? { speakerId: d.speakerId, name: d.name, text: d.text, segments: formatMessage(d.text) } : null
}

/** Long actions report through conversation events; their errors land in the state, not here. */
function background(job: Promise<unknown>): void {
  job.catch(() => {})
}

function str(p: Params, name: string): string {
  const v = p[name]
  if (typeof v !== "string") throw new Error(`missing ${name}`)
  return v
}

function num(p: Params, name: string, fallback: number): number {
  const v = p[name]
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function kindOf(p: Params): ConversationKind {
  const k = p.kind
  if (k !== "kin" && k !== "group") throw new Error('kind must be "kin" or "group"')
  return k
}
