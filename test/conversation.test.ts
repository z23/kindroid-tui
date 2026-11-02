import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { startMockKindroid, type MockKindroid } from "../scripts/mock-kindroid"
import { KindroidClient } from "../src/api/client"
import { DailyBudget, RateLimiter } from "../src/api/rateLimiter"
import type { ChatMessage, ConversationRef } from "../src/api/types"
import { HistoryCache, syncHistory } from "../src/store/cache"
import { Conversation, roleOf, toMs } from "../src/store/conversation"

let mock: MockKindroid
let cache: HistoryCache

beforeAll(() => {
  mock = startMockKindroid({ wordDelayMs: 0, rateLimit: false })
})
afterAll(() => mock.stop())
afterEach(() => cache?.close())

function setup(ref: ConversationRef, opts: { maxGroupTurns?: number; wordDelayMs?: number } = {}) {
  cache = new HistoryCache(":memory:")
  const client = new KindroidClient({
    apiKey: "kn_test",
    baseUrl: `${mock.url}/v1`,
    limiter: new RateLimiter({ limit: 1000 }),
    budget: new DailyBudget(cache.budgetStore()),
  })
  const names: Record<string, string> = { kin_ava: "Ava", kin_rex: "Rex", kin_mira: "Mira" }
  const conv = new Conversation({
    client,
    cache,
    ref,
    title: ref.kind === "kin" ? names[ref.id] ?? ref.id : "Friends",
    nameFor: (id) => names[id],
    userName: "Me",
    maxGroupTurns: opts.maxGroupTurns ?? 4,
  })
  return { client, conv }
}

describe("HistoryCache", () => {
  const ref = { kind: "kin" as const, id: "k" }
  const m = (id: string, ts: number): ChatMessage => ({ id, sender: "k", sender_type: "ai", timestamp: ts, message: id })

  test("upserts, dedupes, orders and windows", () => {
    cache = new HistoryCache(":memory:")
    cache.upsert(ref, [m("b", 2), m("a", 1), m("c", 3)])
    cache.upsert(ref, [{ ...m("b", 2), message: "edited" }])
    expect(cache.load(ref).map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(cache.load(ref)[1]!.message).toBe("edited")
    expect(cache.load(ref, 2).map((x) => x.id)).toEqual(["b", "c"])
    expect(cache.loadBefore(ref, 3, 5).map((x) => x.id)).toEqual(["a", "b"])
    expect(cache.newestTimestamp(ref)).toBe(3)
    cache.remove(ref, ["c"])
    expect(cache.count(ref)).toBe(2)
    cache.clear(ref)
    expect(cache.count(ref)).toBe(0)
  })

  test("syncHistory pages forward and stops at the page cap", async () => {
    cache = new HistoryCache(":memory:")
    const client = new KindroidClient({ apiKey: "kn_t", baseUrl: `${mock.url}/v1`, limiter: new RateLimiter({ limit: 1000 }) })
    const ava = { kind: "kin" as const, id: "kin_ava" }
    const first = await syncHistory(client, cache, ava, { pageSize: 10, maxPages: 2 })
    expect(first).toEqual({ added: 20, pages: 2, truncated: true })
    const rest = await syncHistory(client, cache, ava, { pageSize: 100 })
    expect(rest.truncated).toBe(false)
    expect(cache.count(ava)).toBe(mock.kins.get("kin_ava")!.messages.length)
  })
})

describe("roleOf / toMs", () => {
  test("classifies senders", () => {
    expect(roleOf({ sender: "x", sender_type: "user" })).toBe("user")
    expect(roleOf({ sender: "x", sender_type: "AI" })).toBe("ai")
    expect(roleOf({ sender: "user", sender_type: "" })).toBe("user")
  })
  test("normalises seconds to ms", () => {
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000)
  })
})

describe("Conversation (1:1)", () => {
  test("open shows history; send streams, then reconciles to server ids", async () => {
    const { conv } = setup({ kind: "kin", id: "kin_rex" })
    const drafts: string[] = []
    conv.subscribe((s) => s.draft && drafts.push(s.draft.text))
    await conv.open()
    const before = conv.state.messages.length
    expect(before).toBeGreaterThan(0)
    await conv.send("tell me something")
    expect(drafts.length).toBeGreaterThan(1)
    const msgs = conv.state.messages
    expect(msgs.length).toBe(before + 2)
    expect(msgs.every((m) => !m.local)).toBe(true)
    expect(msgs.at(-2)!.role).toBe("user")
    expect(msgs.at(-1)!.role).toBe("ai")
    expect(msgs.at(-1)!.name).toBe("Rex")
    expect(conv.state.activity.kind).toBe("idle")
    expect(conv.state.draft).toBeNull()
  })

  test("a selfie shows up after the reconcile sync", async () => {
    const { conv } = setup({ kind: "kin", id: "kin_rex" })
    await conv.open()
    await conv.send("send me a selfie")
    const last = conv.state.messages.at(-1)!
    expect(last.images.length).toBe(1)
    expect(last.notes[0]).toContain("image:")
  })

  test("<<ERROR>> leaves a failed AI bubble with regenerate hint", async () => {
    const { conv } = setup({ kind: "kin", id: "kin_rex" })
    await conv.open()
    await conv.send("/error")
    const last = conv.state.messages.at(-1)!
    expect(last.role).toBe("ai")
    expect(last.failed).toContain("regenerate")
  })

  test("undo removes the last exchange and returns the user's text", async () => {
    const { conv } = setup({ kind: "kin", id: "kin_mira" })
    await conv.open()
    const before = conv.state.messages.length
    await conv.send("undo me")
    const restored = await conv.undo()
    expect(restored).toBe("undo me")
    expect(conv.state.messages.length).toBe(before)
    expect(conv.state.error).toBeNull()
  })

  test("regenerate replaces the last reply", async () => {
    const { conv } = setup({ kind: "kin", id: "kin_mira" })
    await conv.open()
    await conv.send("again please")
    const count = conv.state.messages.length
    const oldId = conv.state.messages.at(-1)!.id
    await conv.regenerate()
    expect(conv.state.messages.length).toBe(count)
    expect(conv.state.messages.at(-1)!.id).not.toBe(oldId)
    expect(conv.state.messages.at(-2)!.text).toBe("again please")
  })

  test("stop aborts a slow reply and keeps the partial text", async () => {
    const slowMock = startMockKindroid({ wordDelayMs: 40, rateLimit: false })
    cache = new HistoryCache(":memory:")
    const client = new KindroidClient({ apiKey: "kn_t", baseUrl: `${slowMock.url}/v1`, limiter: new RateLimiter({ limit: 1000 }) })
    const conv = new Conversation({
      client,
      cache,
      ref: { kind: "kin", id: "kin_rex" },
      title: "Rex",
      nameFor: () => "Rex",
      userName: "Me",
      maxGroupTurns: 4,
    })
    await conv.open()
    const sending = conv.send("/long")
    await new Promise<void>((resolve) => {
      const off = conv.subscribe((s) => {
        if ((s.draft?.text.length ?? 0) > 20) {
          off()
          resolve()
        }
      })
    })
    conv.stop()
    await sending
    expect(conv.state.activity.kind).toBe("idle")
    expect(conv.state.notice).toContain("Stopped")
    const stopped = conv.state.messages.find((m) => m.failed === "stopped")
    expect(stopped?.text.length).toBeGreaterThan(20)
    slowMock.stop()
  })

  test("chat break resets to the greeting", async () => {
    const { conv } = setup({ kind: "kin", id: "kin_ava" })
    await conv.open()
    await conv.chatBreak("*stretches* Fresh start!", false)
    expect(conv.state.messages.map((m) => m.text)).toEqual(["*stretches* Fresh start!"])
  })

  test("actions started during a sync wait for it instead of being dropped", async () => {
    const { conv } = setup({ kind: "kin", id: "kin_mira" })
    const opening = conv.open()
    expect(conv.state.activity.kind).toBe("syncing")
    expect(conv.canAct()).toBe(true)
    await conv.chatBreak("*waves* Hi again", false)
    await opening
    expect(conv.state.messages.map((m) => m.text)).toEqual(["*waves* Hi again"])
  })

  test("a rejected send keeps the text as a not-sent message", async () => {
    const { conv } = setup({ kind: "kin", id: "does_not_exist" })
    await conv.send("hello?")
    const last = conv.state.messages.at(-1)!
    expect(last.notSent).toBe(true)
    expect(conv.state.error).toContain("Unknown")
  })
})

describe("Conversation (group)", () => {
  test("runs the turn loop until it's the user's turn", async () => {
    const { conv } = setup({ kind: "group", id: "grp_friends" })
    await conv.open()
    const before = conv.state.messages.length
    const speakers = new Set<string>()
    conv.subscribe((s) => s.activity.kind === "streaming" && speakers.add(s.activity.name))
    await conv.send("pizza or tacos?")
    const added = conv.state.messages.length - before
    expect(added).toBeGreaterThanOrEqual(2)
    expect(speakers.size).toBeGreaterThan(0)
    for (const n of speakers) expect(["Ava", "Rex", "Mira"]).toContain(n)
  })

  test("respects the turn cap and continueGroup forces another turn", async () => {
    const { conv } = setup({ kind: "group", id: "grp_friends" }, { maxGroupTurns: 1 })
    await conv.open()
    const before = conv.state.messages.length
    await conv.send("abc")
    expect(conv.state.messages.length).toBe(before + 2)
    await conv.continueGroup()
    expect(conv.state.messages.length).toBe(before + 3)
  })

  test("group undo removes one message", async () => {
    const { conv } = setup({ kind: "group", id: "grp_friends" })
    await conv.open()
    const before = conv.state.messages.length
    await conv.undo()
    expect(conv.state.messages.length).toBe(before - 1)
  })
})

describe("suggestName", () => {
  const { suggestName } = require("../src/store/conversation") as typeof import("../src/store/conversation")
  const m = (sender_type: string, display_name?: string): ChatMessage => ({
    id: Math.random().toString(36),
    sender: "x",
    sender_type,
    display_name,
    timestamp: 1,
    message: "",
  })

  test("a kin's name comes from its own messages, not the user's", () => {
    expect(suggestName("kin", [m("user", "Sam"), m("ai", "Mira")])).toBe("Mira")
    expect(suggestName("kin", [m("user", "Sam")])).toBeUndefined()
    expect(suggestName("kin", [])).toBeUndefined()
  })

  test("a group's name lists who talks in it", () => {
    expect(suggestName("group", [m("ai", "Rex"), m("ai", "Ava"), m("ai", "Rex"), m("user", "Me")])).toBe("Ava & Rex")
    expect(suggestName("group", [m("ai", "Rex")])).toBe("Rex")
    expect(suggestName("group", ["A", "B", "C", "D", "E"].map((n) => m("ai", n)))).toBe("C, D, E +2")
  })
})
