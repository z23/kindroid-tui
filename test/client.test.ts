import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { startMockKindroid, type MockKindroid } from "../scripts/mock-kindroid"
import { KindroidClient, normalizeHistory, parseTurn } from "../src/api/client"
import { KindroidError } from "../src/api/errors"
import { RateLimiter } from "../src/api/rateLimiter"
import { collectStream } from "../src/api/stream"

const KIN = { kind: "kin" as const, id: "kin_ava" }
const GROUP = { kind: "group" as const, id: "grp_friends" }

async function expectError(p: Promise<unknown>, kind: KindroidError["kind"]): Promise<KindroidError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(KindroidError)
    expect((err as KindroidError).kind).toBe(kind)
    return err as KindroidError
  }
  throw new Error(`expected a ${kind} error`)
}

describe("against the mock API", () => {
  let mock: MockKindroid
  let client: KindroidClient

  beforeAll(() => {
    mock = startMockKindroid({ wordDelayMs: 0, rateLimit: false })
    client = new KindroidClient({ apiKey: "kn_test_key", baseUrl: `${mock.url}/v1`, limiter: new RateLimiter({ limit: 1000 }) })
  })
  afterAll(() => mock.stop())

  test("streams a reply and records both messages", async () => {
    const before = mock.kins.get("kin_rex")!.messages.length
    const text = await collectStream(await client.sendMessage("kin_rex", "hello there"))
    expect(text.length).toBeGreaterThan(10)
    expect(text.startsWith(" ")).toBe(false)
    expect(mock.kins.get("kin_rex")!.messages.length).toBe(before + 2)
  })

  test("<<ERROR>> surfaces as a generation error", async () => {
    await expectError(collectStream(await client.sendMessage("kin_rex", "/error")), "generation")
  })

  test("mid-stream <<HTTP_ERROR>> keeps partial text", async () => {
    const err = await expectError(collectStream(await client.sendMessage("kin_rex", "/break please")), "stream")
    expect(err.partial!.length).toBeGreaterThan(0)
  })

  test("pages history forward with start_after_timestamp", async () => {
    const first = await client.getChatMessages(KIN, { limit: 20 })
    expect(first.messages.length).toBe(20)
    expect(first.pagination.hasMore).toBe(true)
    const second = await client.getChatMessages(KIN, { limit: 20, startAfter: first.pagination.lastTimestamp })
    expect(second.messages[0]!.timestamp).toBeGreaterThan(first.messages.at(-1)!.timestamp)
  })

  test("history calls spend the daily budget", async () => {
    const before = client.budget.remaining()
    await client.getChatMessages(KIN, { limit: 1 })
    expect(client.budget.remaining()).toBe(before - 1)
  })

  test("rewind validates parity locally for 1:1 chats", async () => {
    await expectError(client.rewind(KIN, 1), "bad_request")
    await expectError(client.rewind(KIN, 12), "bad_request")
    const res = await client.rewind(KIN, 2)
    expect(res.deleted_message_ids?.length).toBe(2)
  })

  test("unknown id maps to not_found", async () => {
    await expectError(client.sendMessage("nope", "hi"), "not_found")
  })

  test("bad key maps to unauthorized and is redacted", async () => {
    const bad = new KindroidClient({ apiKey: "bogus", baseUrl: `${mock.url}/v1` })
    const err = await expectError(bad.getChatMessages(KIN), "unauthorized")
    expect(err.message).not.toContain("bogus")
  })

  test("group loop endpoints", async () => {
    await client.groupUserMessage(GROUP.id, "what movie?")
    const speakers: string[] = []
    for (let i = 0; i < 10; i++) {
      const ai = await client.groupGetTurn(GROUP.id, true)
      if (!ai) break
      speakers.push(ai)
      const text = await collectStream(await client.groupAiResponse(GROUP.id, ai))
      expect(text.length).toBeGreaterThan(0)
    }
    expect(speakers.length).toBeGreaterThan(0)
    expect(speakers.length).toBeLessThan(10)
    const forced = await client.groupGetTurn(GROUP.id, false)
    expect(forced).toBeTruthy()
  })

  test("setScene sends only current_scene, to the right endpoint", async () => {
    await client.setScene({ kind: "kin", id: "kin_rex" }, "  A rainy rooftop at dusk ")
    expect(mock.kins.get("kin_rex")!.info).toEqual({ current_scene: "A rainy rooftop at dusk" })
    await client.setScene(GROUP, "The diner after the show")
    expect(mock.groups.get("grp_friends")!.info).toEqual({ current_scene: "The diner after the show" })
    const sent = mock.requests.filter((r) => r.path === "/update-info" || r.path === "/groupchats-update")
    expect(sent.map((r) => Object.keys(r.body as object).sort())).toEqual([
      ["ai_id", "current_scene"],
      ["current_scene", "group_id"],
    ])
    await expectError(client.setScene(GROUP, "   "), "bad_request")
  })

  test("chat break resets to the greeting", async () => {
    await client.chatBreak({ kind: "kin", id: "kin_mira" }, "*yawns* Morning!")
    const hist = await client.getChatMessages({ kind: "kin", id: "kin_mira" })
    expect(hist.messages.map((m) => m.message)).toEqual(["*yawns* Morning!"])
  })
})

describe("retry policy", () => {
  function fakeFetch(statuses: number[]) {
    const calls: string[] = []
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(input)}`)
      const status = statuses.shift() ?? 200
      return new Response(status === 200 ? JSON.stringify({ messages: [], pagination: { hasMore: false } }) : "nope", { status })
    }) as typeof fetch
    return { impl, calls }
  }

  const mk = (impl: typeof fetch, limiter = new RateLimiter({ limit: 1000 })) =>
    new KindroidClient({ apiKey: "kn_x", baseUrl: "http://x.invalid/v1", fetch: impl, limiter })

  test("GET retries once on 5xx", async () => {
    const f = fakeFetch([500, 200])
    await mk(f.impl).getChatMessages(KIN)
    expect(f.calls.length).toBe(2)
  })

  test("GET gives up after the second 5xx", async () => {
    const f = fakeFetch([502, 503])
    await expectError(mk(f.impl).getChatMessages(KIN), "server")
    expect(f.calls.length).toBe(2)
  })

  test("POST is never retried on 5xx", async () => {
    const f = fakeFetch([500])
    await expectError(mk(f.impl).sendMessage("a", "hi"), "server")
    expect(f.calls.length).toBe(1)
  })

  test("429 penalizes the limiter and retries", async () => {
    const f = fakeFetch([429, 200])
    const limiter = new RateLimiter({ limit: 1000, windowMs: 5 })
    await mk(f.impl, limiter).getChatMessages(KIN)
    expect(f.calls.length).toBe(2)
  })

  test("sends the bearer token and JSON body", async () => {
    let seen: RequestInit | undefined
    const impl = (async (_: unknown, init?: RequestInit) => {
      seen = init
      return new Response("")
    }) as typeof fetch
    await mk(impl).groupUserMessage("g1", "hi")
    expect((seen!.headers as Record<string, string>).Authorization).toBe("Bearer kn_x")
    expect(JSON.parse(String(seen!.body))).toEqual({ group_id: "g1", message: "hi" })
  })
})

describe("parsers", () => {
  test("parseTurn handles empty, plain and JSON bodies", () => {
    expect(parseTurn("")).toBeNull()
    expect(parseTurn("  \n")).toBeNull()
    expect(parseTurn("abc123")).toBe("abc123")
    expect(parseTurn('"abc123"')).toBe("abc123")
    expect(parseTurn('{"ai_id":"abc"}')).toBe("abc")
    expect(parseTurn("null")).toBeNull()
  })

  test("normalizeHistory fills defaults and rejects garbage", () => {
    const r = normalizeHistory({ messages: [{ id: "1", message: "hi", timestamp: 5 }, { nope: true }] })
    expect(r.messages.length).toBe(1)
    expect(r.pagination.lastTimestamp).toBe(5)
    expect(() => normalizeHistory({})).toThrow()
  })
})
