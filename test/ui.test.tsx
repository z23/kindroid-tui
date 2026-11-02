import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/solid"
import { render } from "@opentui/solid"
import { startMockKindroid, type MockKindroid } from "../scripts/mock-kindroid"
import { KindroidClient } from "../src/api/client"
import { DailyBudget, RateLimiter } from "../src/api/rateLimiter"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, type Config } from "../src/config"
import { HistoryCache } from "../src/store/cache"
import { App } from "../src/ui/App"
import { normalizeId } from "../src/ui/dialogs/AddConversation"
import { formatMessage } from "../src/ui/format"
import { fuzzyScore } from "../src/ui/dialogs/Picker"

// UI tests wait on real sockets; give them more than bun's 5 s default (CI runners are slower).
setDefaultTimeout(30_000)

let mock: MockKindroid
let setup: TestRendererSetup | undefined
let cache: HistoryCache | undefined

beforeAll(() => {
  mock = startMockKindroid({ wordDelayMs: 0, rateLimit: false })
})
afterAll(() => mock.stop())
afterEach(async () => {
  await setup?.dispose()
  setup = undefined
  cache?.close()
})

const config = (): Config => ({
  path: "/nonexistent/config.toml",
  apiKey: "kn_test",
  apiKeySource: "env",
  kins: [
    { name: "Ava", ai_id: "kin_ava" },
    { name: "Rex", ai_id: "kin_rex" },
    { name: "Mira", ai_id: "kin_mira" },
  ],
  groups: [{ name: "Friends", group_id: "grp_friends" }],
  ui: { images: "blocks", maxGroupTurns: 3, userName: "Me" },
  warnings: [],
})

async function mount(width = 110, height = 32, opts: { config?: Config; reloadConfig?: () => Config } = {}) {
  setup = await createTestRenderer({ width, height })
  cache = new HistoryCache(":memory:")
  const client = new KindroidClient({
    apiKey: "kn_test",
    baseUrl: `${mock.url}/v1`,
    limiter: new RateLimiter({ limit: 1000 }),
    budget: new DailyBudget(cache.budgetStore()),
  })
  const keymap = createDefaultOpenTuiKeymap(setup.renderer)
  const cfg = opts.config ?? config()
  await render(
    () => (
      <KeymapProvider keymap={keymap}>
        <App config={cfg} client={client} cache={cache!} reloadConfig={opts.reloadConfig ?? (() => cfg)} onQuit={() => {}} />
      </KeymapProvider>
    ),
    setup.renderer,
  )
  return setup
}

/** Poll frames on real time: the mock server answers over real sockets, so render passes alone aren't enough. */
async function waitUntil(s: TestRendererSetup, pred: (frame: string) => boolean, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms
  let frame = ""
  while (Date.now() < deadline) {
    await s.flush()
    frame = s.captureCharFrame()
    if (pred(frame)) return frame
    await Bun.sleep(15)
  }
  throw new Error(`timed out; last frame:\n${frame}`)
}

const until = (s: TestRendererSetup, needle: string | RegExp) =>
  waitUntil(s, (f) => (typeof needle === "string" ? f.includes(needle) : needle.test(f)))
/** Screen position of `text`, optionally only where it starts at or right of column `minX`. */
function locate(frame: string, text: string, minX = 0, maxX = Infinity): { x: number; y: number } {
  const lines = frame.split("\n")
  for (let y = 0; y < lines.length; y++) {
    let x = lines[y]!.indexOf(text, minX)
    while (x >= 0 && x <= maxX) {
      return { x, y }
    }
  }
  throw new Error(`"${text}" not on screen`)
}

const gone = (s: TestRendererSetup, needle: string) => waitUntil(s, (f) => !f.includes(needle))
/** The first history sync has finished: at least one call spent from the daily budget and nothing in flight. */
const ready = (s: TestRendererSetup) =>
  waitUntil(s, (f) => {
    // Only look at the status bar: chat history may itself contain words like "syncing".
    const status = f.trimEnd().split("\n").at(-1) ?? ""
    const left = Number(/history (\d+)\/600/.exec(status)?.[1] ?? 600)
    return left < 600 && !/syncing|sending|typing/.test(status)
  })

describe("UI", () => {
  test("renders the chat list, history and status bar", async () => {
    const s = await mount()
    const frame = await until(s, "Old message number 30")
    expect(frame).toContain("Chats")
    expect(frame).toContain("▶ Ava")
    expect(frame).toContain("• Rex")
    expect(frame).toContain("# Friends")
    expect(frame).toContain("history")
    expect(frame).toContain("f1 help")
  })

  test("sending a message streams a reply into the view", async () => {
    const s = await mount()
    await ready(s)
    await s.mockInput.typeText("hello from the test")
    s.mockInput.pressEnter()
    await until(s, "hello from the test")
    const frame = await until(s, /Ava\s+\d/)
    expect(frame).toContain("Me")
    await gone(s, "typing")
  })

  test("ctrl+k opens the picker and esc closes it", async () => {
    const s = await mount()
    await until(s, "Ava")
    s.mockInput.pressKey("k", { ctrl: true })
    await until(s, "Jump to chat")
    s.mockInput.pressEscape()
    await gone(s, "Jump to chat")
  })

  test("picker filters and switches to a group", async () => {
    const s = await mount()
    await until(s, "Ava")
    s.mockInput.pressKey("k", { ctrl: true })
    await until(s, "Jump to chat")
    await s.mockInput.typeText("fri")
    s.mockInput.pressEnter()
    const frame = await until(s, "Friends · group")
    expect(frame).toContain("who's picking the movie")
  })

  test("f1 shows help", async () => {
    const s = await mount()
    await until(s, "Ava")
    s.mockInput.pressKey("F1")
    const frame = await until(s, "Keys")
    expect(frame).toContain("regenerate last reply")
  })

  test("ctrl+b opens the chat break dialog", async () => {
    const s = await mount()
    await until(s, "Ava")
    s.mockInput.pressKey("b", { ctrl: true })
    const frame = await until(s, "Chat break")
    expect(frame).toContain("wipe long-term memory")
    s.mockInput.pressEscape()
    await gone(s, "Chat break")
  })

  test("ctrl+z asks first, then undoes and restores the message to the composer", async () => {
    const s = await mount()
    await ready(s)
    await s.mockInput.typeText("please undo this")
    s.mockInput.pressEnter()
    await until(s, "please undo this")
    await gone(s, "typing")
    await waitUntil(s, (f) => !f.includes("syncing") && !f.includes("sending"))
    s.mockInput.pressKey("z", { ctrl: true })
    await until(s, "Undo the last 1 exchange")
    s.mockInput.pressKey("y")
    const frame = await waitUntil(s, (f) => f.includes("Undid the last exchange"))
    // the text is back in the composer, not in the history
    const lines = frame.split("\n")
    const composerLine = lines.findLast((l) => l.includes("please undo this"))
    expect(composerLine).toBeDefined()
    expect(lines.filter((l) => l.includes("please undo this")).length).toBe(1)
  })

  test("a selfie renders inline as an image", async () => {
    const s = await mount()
    await ready(s)
    await s.mockInput.typeText("send a selfie?")
    s.mockInput.pressEnter()
    const frame = await waitUntil(s, (f) => f.includes("image: Ava smiling"), 5000)
    // blocks mode draws with Unicode quadrant/half blocks
    expect(/[▀▄▌▐▖▗▘▙▚▛▜▝▞▟█]/.test(frame)).toBe(true)
  })

  test("ctrl+o hides images", async () => {
    const s = await mount()
    await ready(s)
    await s.mockInput.typeText("selfie again")
    s.mockInput.pressEnter()
    // the new reply's image note must come after our message (older selfies may be in history)
    await waitUntil(s, (f) => f.lastIndexOf("image: Ava smiling") > f.indexOf("selfie again") && f.includes("selfie again"), 5000)
    s.mockInput.pressKey("o", { ctrl: true })
    await until(s, "image hidden")
  })

  test("enter during the initial sync still sends the message", async () => {
    const s = await mount()
    await s.mockInput.typeText("sent while syncing")
    s.mockInput.pressEnter()
    const frame = await until(s, "sent while syncing")
    expect(frame).not.toContain("Still replying")
    await gone(s, "typing")
  })

  test("adding a Kindroid needs only the ID: the name is filled in from history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kindroid-tui-ui-"))
    try {
      const path = join(dir, "config.toml")
      const base: Config = { ...config(), path, kins: [{ name: "Ava", ai_id: "kin_ava" }], groups: [] }
      const s = await mount(110, 32, { config: base, reloadConfig: () => ({ ...loadConfig({ path, env: {} }), apiKey: "kn_test" }) })
      await ready(s)
      s.mockInput.pressKey("k", { ctrl: true })
      await until(s, "Jump to chat")
      await s.mockInput.typeText("add")
      s.mockInput.pressEnter()
      await until(s, "Add a chat")
      await s.mockInput.typeText("kin_mira")
      s.mockInput.pressEnter()
      const checked = await until(s, "✓ Found Mira")
      expect(checked).toContain("Mira")
      s.mockInput.pressEnter()
      const frame = await until(s, "Added Mira")
      expect(frame).toContain("▶ Mira")
      expect(readFileSync(path, "utf8")).toContain('ai_id = "kin_mira"')
      expect(loadConfig({ path, env: {} }).kins).toEqual([{ name: "Mira", ai_id: "kin_mira" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("adding an ID that's already listed is refused", async () => {
    const s = await mount()
    await ready(s)
    s.mockInput.pressKey("k", { ctrl: true })
    await until(s, "Jump to chat")
    await s.mockInput.typeText("add")
    s.mockInput.pressEnter()
    await until(s, "Add a chat")
    await s.mockInput.typeText("kin_rex")
    s.mockInput.pressEnter()
    await until(s, "✓ Found Rex")
    s.mockInput.pressEnter()
    await until(s, "Already in your list")
  })

  test("an unknown ID shows the error and keeps the dialog open", async () => {
    const s = await mount()
    await ready(s)
    s.mockInput.pressKey("k", { ctrl: true })
    await until(s, "Jump to chat")
    await s.mockInput.typeText("add")
    s.mockInput.pressEnter()
    await until(s, "Add a chat")
    await s.mockInput.typeText("nope_123")
    s.mockInput.pressEnter()
    const frame = await until(s, "Unknown Kindroid or group ID")
    expect(frame).toContain("Add a chat")
  })

  test("clicking a chat in the list opens it and focuses the composer", async () => {
    const s = await mount()
    const frame = await ready(s)
    const rex = locate(frame, "Rex", 0, 23)
    await s.mockMouse.click(rex.x, rex.y)
    const opened = await until(s, "Message Rex…")
    expect(opened).toContain("▶ Rex")
    expect(opened).toContain("╭─ Rex ")
    // the composer has focus, so typing goes into it
    await s.mockInput.typeText("hi rex")
    await until(s, "hi rex")
  })

  test("hovering and clicking in the jump-to-chat picker", async () => {
    const s = await mount()
    await ready(s)
    s.mockInput.pressKey("k", { ctrl: true })
    const frame = await until(s, "Jump to chat")
    const friends = locate(frame, "Friends", 30)
    await s.mockMouse.moveTo(friends.x, friends.y)
    await s.mockMouse.click(friends.x, friends.y)
    await until(s, "Friends · group")
    await gone(s, "Jump to chat")
  })

  test("clicking “+ add” opens the add dialog", async () => {
    const s = await mount()
    const frame = await ready(s)
    const add = locate(frame, "+ add", 0, 23)
    await s.mockMouse.click(add.x, add.y)
    await until(s, "Add a chat")
  })

  test("keyboard still works in the chat list", async () => {
    const s = await mount()
    await ready(s)
    s.mockInput.pressTab()
    s.mockInput.pressArrow("down")
    s.mockInput.pressKey("j")
    s.mockInput.pressEnter()
    await until(s, "Message Mira…")
  })

  test("/scene sets the scene, shows it, and ctrl+s reopens it for editing", async () => {
    const s = await mount()
    await ready(s)
    await s.mockInput.typeText("/scene A storm rolls in over the harbour")
    s.mockInput.pressEnter()
    await until(s, "scene (set here): A storm rolls in over the harbour")
    await until(s, "Scene updated")
    expect(mock.kins.get("kin_ava")!.info.current_scene).toBe("A storm rolls in over the harbour")
    // the command didn't go out as a chat message
    expect(mock.kins.get("kin_ava")!.messages.some((m) => m.message.includes("/scene"))).toBe(false)
    s.mockInput.pressKey("s", { ctrl: true })
    const dialog = await until(s, "Scene · Ava")
    expect(dialog.replace(/[│\s]+/g, " ")).toContain("this is the one you set here")
    // the editor is pre-filled with the scene set earlier (its line sits inside two nested borders)
    expect(dialog.split("\n").some((l) => /│\s+│ A storm rolls in over the harbour/.test(l))).toBe(true)
    s.mockInput.pressEscape()
    await gone(s, "Scene · Ava")
  })

  test("ctrl+z picks how many exchanges to undo and highlights them", async () => {
    const s = await mount()
    await ready(s)
    s.mockInput.pressKey("z", { ctrl: true })
    await until(s, "Undo the last 1 exchange")
    s.mockInput.pressArrow("up")
    const frame = await until(s, "Undo the last 2 exchanges")
    expect(frame).toContain("✗ will be removed")
    s.mockInput.pressKey("9")
    await until(s, "Undo the last 5 exchanges")
    s.mockInput.pressEscape()
    const after = await gone(s, "Undo the last")
    expect(after).not.toContain("will be removed")
  })

  test("/undo 2 rewinds two exchanges after confirming", async () => {
    const s = await mount()
    await ready(s)
    for (const text of ["undo test one", "undo test two"]) {
      await s.mockInput.typeText(text)
      s.mockInput.pressEnter()
      await until(s, text)
      await waitUntil(s, (f) => {
        const status = f.trimEnd().split("\n").at(-1) ?? ""
        return !/sending|typing|syncing/.test(status)
      })
    }
    const before = mock.kins.get("kin_ava")!.messages.length
    await s.mockInput.typeText("/undo 2")
    s.mockInput.pressEnter()
    await until(s, "Undo the last 2 exchanges")
    s.mockInput.pressKey("y")
    const frame = await until(s, "Undid the last 2 exchanges")
    expect(mock.kins.get("kin_ava")!.messages.length).toBe(before - 4)
    // the earlier message is back in the composer for editing
    expect(frame.split("\n").filter((l) => l.includes("undo test one")).length).toBe(1)
  })

  test("// sends a message that starts with a slash", async () => {
    const s = await mount()
    await ready(s)
    await s.mockInput.typeText("//waves hello")
    s.mockInput.pressEnter()
    await until(s, "/waves hello")
    await waitUntil(s, () => mock.kins.get("kin_ava")!.messages.some((m) => m.message === "/waves hello"))
  })

  test("an unknown command keeps the text and explains", async () => {
    const s = await mount()
    await ready(s)
    await s.mockInput.typeText("/selfie now")
    s.mockInput.pressEnter()
    const frame = await until(s, "Unknown command /selfie")
    expect(frame).toContain("/selfie now")
    expect(mock.kins.get("kin_ava")!.messages.some((m) => m.message.includes("/selfie"))).toBe(false)
  })

  test("narrow terminals hide the chat list", async () => {
    const s = await mount(60, 24)
    const frame = await until(s, "Ava")
    expect(frame).not.toContain("Chats")
  })
})

describe("formatMessage", () => {
  test("splits actions, quotes and bold", () => {
    expect(formatMessage('*smiles* "Hi!" **really**')).toEqual([
      { kind: "action", text: "smiles" },
      { kind: "plain", text: " " },
      { kind: "quote", text: '"Hi!"' },
      { kind: "plain", text: " " },
      { kind: "bold", text: "really" },
    ])
  })
  test("an unclosed action runs to the end while streaming", () => {
    expect(formatMessage("ok *walks to")).toEqual([
      { kind: "plain", text: "ok " },
      { kind: "action", text: "walks to" },
    ])
  })
})

describe("normalizeId", () => {
  test("accepts bare IDs and pasted URLs", () => {
    expect(normalizeId("  abc123 ")).toBe("abc123")
    expect(normalizeId("https://kindroid.ai/v2/chat/group/g_42")).toBe("g_42")
    expect(normalizeId("https://kindroid.ai/v2/chat/group/g_42/?tab=1#x")).toBe("g_42")
  })
})

describe("fuzzyScore", () => {
  test("prefers substring matches and rejects non-matches", () => {
    expect(fuzzyScore("av", "Ava")).toBe(0)
    expect(fuzzyScore("aa", "Ava")).toBeGreaterThan(99)
    expect(fuzzyScore("xyz", "Ava")).toBe(-1)
  })
})
