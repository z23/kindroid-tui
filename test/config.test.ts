import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "smol-toml"
import { addConversation, ensureConfigFile, loadConfig } from "../src/config"
import { redact } from "../src/api/errors"

let dir: string | undefined
const tmp = () => (dir = mkdtempSync(join(tmpdir(), "kindroid-tui-test-")))
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("config", () => {
  test("template is created 0600 and parses with no conversations", () => {
    const path = join(tmp(), "sub", "config.toml")
    ensureConfigFile(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const cfg = loadConfig({ path, env: {} })
    expect(cfg.kins).toEqual([])
    expect(cfg.apiKey).toBeUndefined()
    expect(cfg.ui.images).toBe("auto")
    expect(cfg.ui.userName).toBeUndefined()
    expect(cfg.warnings).toEqual([])
  })

  test("env key wins over file key", () => {
    const path = join(tmp(), "config.toml")
    writeFileSync(path, 'api_key = "kn_file"\n', { mode: 0o600 })
    expect(loadConfig({ path, env: {} })).toMatchObject({ apiKey: "kn_file", apiKeySource: "file" })
    expect(loadConfig({ path, env: { KINDROID_API_KEY: "kn_env" } })).toMatchObject({ apiKey: "kn_env", apiKeySource: "env" })
  })

  test("warns when a key file is readable by others", () => {
    const path = join(tmp(), "config.toml")
    writeFileSync(path, 'api_key = "kn_x"\n')
    chmodSync(path, 0o644)
    expect(loadConfig({ path, env: {} }).warnings.join(" ")).toContain("chmod 600")
  })

  test("skips entries without ids, dedupes, and validates ui values", () => {
    const path = join(tmp(), "config.toml")
    writeFileSync(
      path,
      `[[kin]]\nname = "A"\nai_id = "a1"\n[[kin]]\nname = "dup"\nai_id = "a1"\n[[kin]]\nname = "no id"\n[ui]\nimages = "nope"\nmax_group_turns = 99\n`,
    )
    const cfg = loadConfig({ path, env: {} })
    expect(cfg.kins).toEqual([{ name: "A", ai_id: "a1" }])
    expect(cfg.ui.images).toBe("auto")
    expect(cfg.ui.maxGroupTurns).toBe(20)
    expect(cfg.warnings.length).toBe(2)
  })

  test("addConversation keeps comments and puts tables before [ui]", () => {
    const path = join(tmp(), "config.toml")
    ensureConfigFile(path)
    addConversation(path, { kind: "kin", name: 'Ava "the bold"', id: "ai_1" })
    addConversation(path, { kind: "group", name: "Friends", id: "g_1" })
    const text = readFileSync(path, "utf8")
    expect(text).toContain("# API key: Kindroid app")
    expect(text.indexOf("[[kin]]")).toBeLessThan(text.indexOf("[ui]"))
    const parsed = parse(text) as Record<string, unknown>
    expect(parsed.kin).toEqual([{ name: 'Ava "the bold"', ai_id: "ai_1" }])
    expect(parsed.group).toEqual([{ name: "Friends", group_id: "g_1" }])
    expect((parsed.ui as Record<string, unknown>).max_group_turns).toBe(4)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("redact hides API keys", () => {
    expect(redact("bad key kn_abc123XYZ_-9 here")).toBe("bad key kn_… here")
  })
})
