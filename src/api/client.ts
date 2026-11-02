import { KindroidError, isAbort, kindForStatus } from "./errors"
import { DailyBudget, MemoryBudgetStore, RateLimiter } from "./rateLimiter"
import { ERROR_MARKER, HTTP_ERROR_MARKER, parseKindroidStream } from "./stream"
import type { ChatMessage, ChatMessagesResponse, ConversationRef, RewindResult } from "./types"

export const DEFAULT_BASE_URL = "https://api.kindroid.ai/v1"
const USER_AGENT = "kindroid-tui/0.1"

export interface KindroidClientOptions {
  apiKey: string
  baseUrl?: string
  limiter?: RateLimiter
  budget?: DailyBudget
  fetch?: typeof fetch
  /** Timeout for calls that don't stream. Streams have no timeout; the user stops them. */
  timeoutMs?: number
}

interface RequestInit_ {
  method: "GET" | "POST"
  query?: Record<string, string | number | undefined>
  body?: unknown
  signal?: AbortSignal
  /** Counts against the 600/day /get-chat-messages budget. */
  history?: boolean
  /** Apply the non-stream timeout. */
  timeout?: boolean
}

const idField = (ref: ConversationRef) => (ref.kind === "kin" ? "ai_id" : "group_id")

export class KindroidClient {
  readonly baseUrl: string
  readonly limiter: RateLimiter
  readonly budget: DailyBudget
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: KindroidClientOptions) {
    if (!opts.apiKey) throw new KindroidError("unauthorized", { detail: "no API key configured" })
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.limiter = opts.limiter ?? new RateLimiter()
    this.budget = opts.budget ?? new DailyBudget(new MemoryBudgetStore())
    this.fetchImpl = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 120_000
  }

  /** POST /send-message, streamed. Resolves once headers arrive; iterate the result for text chunks. */
  async sendMessage(aiId: string, message: string, signal?: AbortSignal): Promise<AsyncGenerator<string>> {
    const res = await this.request("/send-message", {
      method: "POST",
      body: { ai_id: aiId, message, stream: true },
      signal,
    })
    return this.streamOf(res)
  }

  /** POST /send-message without streaming. Used by the probe script. */
  async sendMessageText(aiId: string, message: string, signal?: AbortSignal): Promise<string> {
    const res = await this.request("/send-message", {
      method: "POST",
      body: { ai_id: aiId, message, stream: false },
      signal,
      timeout: true,
    })
    return checkMarkers(await res.text())
  }

  /** POST /chat-break or /groupchats-chat-break. */
  async chatBreak(ref: ConversationRef, greeting: string, wipeCascaded = false, signal?: AbortSignal): Promise<void> {
    await this.request(ref.kind === "kin" ? "/chat-break" : "/groupchats-chat-break", {
      method: "POST",
      body: { [idField(ref)]: ref.id, greeting, wipe_cascaded: wipeCascaded },
      signal,
      timeout: true,
    })
  }

  /** GET /get-chat-messages. Oldest first. Costs one call from the daily history budget. */
  async getChatMessages(
    ref: ConversationRef,
    opts: { limit?: number; startAfter?: number; signal?: AbortSignal } = {},
  ): Promise<ChatMessagesResponse> {
    const res = await this.request("/get-chat-messages", {
      method: "GET",
      query: {
        [idField(ref)]: ref.id,
        limit: opts.limit,
        start_after_timestamp: opts.startAfter,
      },
      signal: opts.signal,
      history: true,
      timeout: true,
    })
    const raw = await res.text()
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      throw new KindroidError("server", { detail: `unexpected history response: ${raw.slice(0, 120)}` })
    }
    return normalizeHistory(data)
  }

  /** POST /rewind-messages. For 1:1 chats `count` must be even. */
  async rewind(ref: ConversationRef, count: number, signal?: AbortSignal): Promise<RewindResult> {
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new KindroidError("bad_request", { detail: "rewind count must be 1-10" })
    }
    if (ref.kind === "kin" && count % 2 !== 0) {
      throw new KindroidError("bad_request", { detail: "rewind count must be even for a 1:1 chat" })
    }
    const res = await this.request("/rewind-messages", {
      method: "POST",
      body: { [idField(ref)]: ref.id, count },
      signal,
      timeout: true,
    })
    const text = await res.text()
    try {
      return text.trim() ? (JSON.parse(text) as RewindResult) : {}
    } catch {
      return {}
    }
  }

  /**
   * Set the current scene: POST /update-info for a Kindroid, POST /groupchats-update for a group.
   * Deliberately sends only `current_scene`; the other settings those endpoints accept (backstory,
   * memory, group members…) are write-only and destructive, so this client never touches them.
   */
  async setScene(ref: ConversationRef, scene: string, signal?: AbortSignal): Promise<void> {
    const text = scene.trim()
    if (!text) throw new KindroidError("bad_request", { detail: "the scene can't be empty" })
    await this.request(ref.kind === "kin" ? "/update-info" : "/groupchats-update", {
      method: "POST",
      body: { [idField(ref)]: ref.id, current_scene: text },
      signal,
      timeout: true,
    })
  }

  /** POST /groupchats-user-message (text only). */
  async groupUserMessage(groupId: string, message: string, signal?: AbortSignal): Promise<void> {
    await this.request("/groupchats-user-message", {
      method: "POST",
      body: { group_id: groupId, message },
      signal,
      timeout: true,
    })
  }

  /** POST /groupchats-get-turn. Returns the next speaker's ai_id, or null when it's the user's turn. */
  async groupGetTurn(groupId: string, allowUser: boolean, signal?: AbortSignal): Promise<string | null> {
    const res = await this.request("/groupchats-get-turn", {
      method: "POST",
      body: { group_id: groupId, allow_user: allowUser },
      signal,
      timeout: true,
    })
    return parseTurn(await res.text())
  }

  /** POST /groupchats-ai-response, streamed. */
  async groupAiResponse(groupId: string, aiId: string, signal?: AbortSignal): Promise<AsyncGenerator<string>> {
    const res = await this.request("/groupchats-ai-response", {
      method: "POST",
      body: { group_id: groupId, ai_id: aiId, stream: true },
      signal,
    })
    return this.streamOf(res)
  }

  private streamOf(res: Response): AsyncGenerator<string> {
    if (!res.body) return (async function* () {})()
    return parseKindroidStream(res.body)
  }

  private async request(path: string, init: RequestInit_): Promise<Response> {
    const url = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
    const idempotent = init.method === "GET"
    let rateRetries = 0
    let serverRetries = 0

    for (;;) {
      await this.limiter.acquire(init.signal)
      if (init.history) this.budget.spend()

      const signal = init.timeout
        ? AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)].filter((s): s is AbortSignal => !!s))
        : init.signal

      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method: init.method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "User-Agent": USER_AGENT,
            ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal,
        })
      } catch (err) {
        if (init.signal?.aborted) throw new KindroidError("aborted")
        if (isAbort(err)) throw new KindroidError("network", { detail: "request timed out" })
        if (idempotent && serverRetries++ < 1) continue
        throw new KindroidError("network", { detail: (err as Error)?.message ?? String(err) })
      }

      if (res.ok) return res

      const detail = await res.text().catch(() => "")
      if (res.status === 429) {
        this.limiter.penalize()
        // A 429 means the request was rejected unprocessed, so retrying is safe even for POSTs.
        if (rateRetries++ < 2) continue
      } else if (res.status >= 500 && idempotent && serverRetries++ < 1) {
        continue
      }
      throw new KindroidError(kindForStatus(res.status), { status: res.status, detail })
    }
  }
}

function checkMarkers(text: string): string {
  const body = text.replace(/^\s+/, "")
  if (body.startsWith(ERROR_MARKER)) {
    throw new KindroidError("generation", { detail: body.slice(ERROR_MARKER.length).trim() || undefined })
  }
  const idx = body.indexOf(HTTP_ERROR_MARKER)
  if (idx >= 0) {
    throw new KindroidError("stream", {
      detail: body.slice(idx + HTTP_ERROR_MARKER.length).trim() || undefined,
      partial: body.slice(0, idx),
    })
  }
  return body
}

/** The turn endpoint's body is an ai_id or empty; tolerate JSON encodings of either. */
export function parseTurn(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  try {
    const v = JSON.parse(t) as unknown
    if (v === null || v === "") return null
    if (typeof v === "string") return v.trim() || null
    if (typeof v === "object" && v && "ai_id" in v) {
      const id = (v as { ai_id?: unknown }).ai_id
      return typeof id === "string" && id.trim() ? id.trim() : null
    }
  } catch {
    // plain text id
  }
  return t
}

export function normalizeHistory(data: unknown): ChatMessagesResponse {
  if (!data || typeof data !== "object" || !Array.isArray((data as { messages?: unknown }).messages)) {
    throw new KindroidError("server", { detail: "history response has no messages array" })
  }
  const d = data as { messages: Partial<ChatMessage>[]; pagination?: Partial<ChatMessagesResponse["pagination"]> }
  const messages: ChatMessage[] = d.messages
    .filter((m): m is Partial<ChatMessage> & { id: string } => !!m && typeof m.id === "string")
    .map((m) => ({
      ...m,
      id: m.id,
      sender: m.sender ?? "",
      sender_type: m.sender_type ?? "",
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Number(m.timestamp ?? 0),
      message: m.message ?? "",
    }))
  const last = messages.at(-1)
  return {
    messages,
    pagination: {
      hasMore: !!d.pagination?.hasMore,
      lastTimestamp: d.pagination?.lastTimestamp ?? last?.timestamp ?? 0,
      limit: d.pagination?.limit ?? messages.length,
    },
  }
}
