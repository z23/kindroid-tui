import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startMockKindroid, type MockKindroid } from "../scripts/mock-kindroid"
import { DailyBudget, RateLimiter } from "../src/api/rateLimiter"
import { loadConfig } from "../src/config"
import { PROTOCOL, Server, type WireMessage } from "../src/serve/server"
import { HistoryCache } from "../src/store/cache"

let mock: MockKindroid
let dir: string
let cache: HistoryCache
let server: Server | undefined

beforeAll(() => {
  mock = startMockKindroid({ wordDelayMs: 0, rateLimit: false })
})
afterAll(() => mock.stop())
afterEach(() => {
  server?.shutdown()
  server = undefined
  cache?.close()
  rmSync(dir, { recursive: true, force: true })
})

type Line = Record<string, any>

function setup(configText?: string, server_ = mock) {
  return setupWith(configText ?? DEFAULT_CONFIG, server_)
}

const DEFAULT_CONFIG = 'api_key = "kn_test"\n\n[[kin]]\nname = "Ava"\nai_id = "kin_ava"\n\n[[group]]\nname = "Friends"\ngroup_id = "grp_friends"\n'

function setupWith(configText: string, api: MockKindroid) {   dir = mkdtempSync(join(tmpdir(), "kindroid-serve-test-"))
  const path = join(dir, "config.toml")
  writeFileSync(path, configText, { mode: 0o600 })
  cache = new HistoryCache(":memory:")
  const lines: Line[] = []
  const waiters: Array<{ pred: (l: Line) => boolean; resolve: (l: Line) => void }> = []
  const env = { KINDROID_API_BASE: `${api.url}/v1` }
  server = new Server({
    loadConfig: () => loadConfig({ path, env }),
    cache,
    limiter: new RateLimiter({ limit: 1000 }),
    budget: new DailyBudget(cache.budgetStore()),
    flushMs: 1,
    write: (raw) => {
      const line = JSON.parse(raw) as Line
      lines.push(line)
      for (const w of [...waiters]) {
        if (w.pred(line)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(line)
        }
      }
    },
  })
  let nextId = 1
  /** Send a request and resolve with its response. */
  const call = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++
    const done = waitFor((l) => l.id === id)
    void server!.handle(JSON.stringify({ id, method, params }))
    return done
  }
  /** Resolve with the first line (already seen or future) matching `pred`. */
  const waitFor = (pred: (l: Line) => boolean, timeoutMs = 3000) => {
    const seen = lines.find(pred)
    if (seen) return Promise.resolve(seen)
    return new Promise<Line>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a line")), timeoutMs)
      waiters.push({ pred, resolve: (l) => (clearTimeout(timer), resolve(l)) })
    })
  }
  /** Apply conversation patches in order, like the plugin does. */
  const stateOf = (key: string) => {
    const state: Line = {}
    for (const l of lines) if (l.event === "conversation" && l.key === key) Object.assign(state, l.state)
    return state
  }
  /** Wait until the conversation has been busy and is idle again. */
  const settled = async (key: string, since: number) => {
    await waitFor((l) => lines.indexOf(l) >= since && l.event === "conversation" && l.key === key && l.state.activity?.kind !== undefined && l.state.activity.kind !== "idle")
    const busyAt = lines.length
    await waitFor((l) => lines.indexOf(l) >= busyAt - 1 && l.event === "conversation" && l.key === key && l.state.activity?.kind === "idle")
  }
  server.start()
  return { path, lines, call, waitFor, stateOf, settled }
}

describe("serve", () => {
  test("announces itself, the config and the limits on start", async () => {
    const { lines } = setup()
    expect(lines[0]).toMatchObject({ event: "ready", protocol: PROTOCOL })
    expect(lines[1]).toMatchObject({
      event: "config",
      hasKey: true,
      keySource: "file",
      conversations: [
        { key: "kin:kin_ava", kind: "kin", id: "kin_ava", name: "Ava" },
        { key: "group:grp_friends", kind: "group", id: "grp_friends", name: "Friends" },
      ],
    })
    expect(lines[2]).toMatchObject({ event: "limits", limit: 1000, budgetLimit: 600 })
    expect(JSON.stringify(lines[1])).not.toContain("kn_test")
  })

  test("bad requests get error responses, not crashes", async () => {
    const { call, lines } = setup()
    expect(await call("nope")).toMatchObject({ ok: false, error: expect.stringContaining("unknown method") })
    expect(await call("open", { key: "kin:missing" })).toMatchObject({ ok: false, error: expect.stringContaining("Unknown conversation") })
    expect(await call("send", { key: "kin:kin_ava", text: "   " })).toMatchObject({ ok: false, error: "message is empty" })
    await server!.handle("{not json")
    expect(lines.at(-1)).toMatchObject({ id: null, ok: false, error: "invalid JSON" })
  })

  test("open syncs history, send streams a reply as formatted segments", async () => {
    const { call, stateOf, settled, lines } = setup()
    const key = "kin:kin_ava"
    let mark = lines.length
    expect(await call("open", { key })).toMatchObject({ ok: true })
    await settled(key, mark)
    const opened = stateOf(key)
    expect(opened.messages.length).toBeGreaterThan(0)
    expect(opened.lastSyncedAt).toBeNumber()

    mark = lines.length
    expect(await call("send", { key, text: "hello there" })).toMatchObject({ ok: true })
    await settled(key, mark)
    const after = stateOf(key)
    const msgs = after.messages as WireMessage[]
    expect(msgs.at(-2)).toMatchObject({ role: "user", text: "hello there" })
    const reply = msgs.at(-1)!
    expect(reply.role).toBe("ai")
    expect(reply.name).toBe("Ava")
    expect(reply.segments.map((s) => s.text).join("")).toBe(reply.text.replace(/\*/g, ""))
    expect(after.draft).toBeNull()
    expect(after.error).toBeNull()
  })

  test("a slow reply streams out as a growing draft", async () => {
    const slow = startMockKindroid({ wordDelayMs: 15, rateLimit: false })
    try {
      const { call, settled, lines } = setup(undefined, slow)
      const key = "kin:kin_ava"
      let mark = lines.length
      await call("open", { key })
      await settled(key, mark)
      mark = lines.length
      await call("send", { key, text: "tell me something" })
      await settled(key, mark)
      const drafts = lines
        .filter((l) => l.event === "conversation" && l.key === key && l.state.draft?.text)
        .map((l) => l.state.draft.text as string)
      expect(drafts.length).toBeGreaterThan(1)
      expect(drafts.at(-1)!.length).toBeGreaterThan(drafts[0]!.length)
      expect(lines.find((l) => l.state?.draft?.text)!.state.draft.segments.length).toBeGreaterThan(0)
    } finally {
      slow.stop()
    }
  })

  test("only changed fields are resent", async () => {
    const { call, settled, lines } = setup()
    const key = "kin:kin_ava"
    const mark = lines.length
    await call("open", { key })
    await settled(key, mark)
    const patches = lines.filter((l) => l.event === "conversation" && !l.full)
    expect(patches.length).toBeGreaterThan(0)
    expect(patches.every((l) => Object.keys(l.state).length < 8)).toBe(true)
  })

  test("undo preview and undo rewind the last exchange", async () => {
    const { call, settled, stateOf, lines } = setup()
    const key = "kin:kin_ava"
    let mark = lines.length
    await call("open", { key })
    await settled(key, mark)
    mark = lines.length
    await call("send", { key, text: "undo me" })
    await settled(key, mark)
    const preview = await call("undoPreview", { key, steps: 1 })
    expect(preview.result).toMatchObject({ unit: "exchange", steps: 1 })
    expect(preview.result.messages[0]).toMatchObject({ role: "user", text: "undo me" })
    const undone = await call("undo", { key, steps: 1 })
    expect(undone).toMatchObject({ ok: true, result: { restored: "undo me" } })
    expect((stateOf(key).messages as WireMessage[]).some((m) => m.text === "undo me")).toBe(false)
  })

  test("group chats run the turn loop", async () => {
    const { call, settled, stateOf, lines } = setup()
    const key = "group:grp_friends"
    let mark = lines.length
    await call("open", { key })
    await settled(key, mark)
    mark = lines.length
    await call("send", { key, text: "hi all" })
    await settled(key, mark)
    const msgs = stateOf(key).messages as WireMessage[]
    const at = msgs.findLastIndex((m) => m.text === "hi all")
    expect(at).toBeGreaterThanOrEqual(0)
    expect(msgs.slice(at + 1).every((m) => m.role === "ai")).toBe(true)
    expect(msgs.length - at - 1).toBeGreaterThan(0)
  })

  test("setActive is shared with the terminal UI through the cache", async () => {
    const { call } = setup()
    await call("setActive", { key: "group:grp_friends" })
    expect(cache.getMeta("active")).toBe("group:grp_friends")
  })

  test("lookup suggests a name and add writes config.toml", async () => {
    const { call, path, waitFor, lines } = setup('api_key = "kn_test"\n\n[ui]\nmax_group_turns = 2\n')
    const looked = await call("lookup", { kind: "kin", id: "https://kindroid.ai/whatever/kin_rex" })
    expect(looked).toMatchObject({ ok: true, result: { id: "kin_rex", name: "Rex" } })
    const mark = lines.length
    expect(await call("add", { kind: "kin", id: "kin_rex", name: "Rex" })).toMatchObject({ ok: true, result: { key: "kin:kin_rex" } })
    const cfg = await waitFor((l) => lines.indexOf(l) >= mark && l.event === "config")
    expect(cfg.conversations).toEqual([{ key: "kin:kin_rex", kind: "kin", id: "kin_rex", name: "Rex" }])
    expect(readFileSync(path, "utf8")).toContain('ai_id = "kin_rex"')
    expect(await call("add", { kind: "kin", id: "kin_rex", name: "Again" })).toMatchObject({ ok: false, error: expect.stringContaining("Already") })
  })

  test("without a key, config says so and chat calls explain why they fail", async () => {
    const { call, lines } = setup('[[kin]]\nname = "Ava"\nai_id = "kin_ava"\n')
    expect(lines[1]).toMatchObject({ event: "config", hasKey: false })
    expect(await call("open", { key: "kin:kin_ava" })).toMatchObject({ ok: false, error: expect.stringContaining("No API key") })
  })
})
