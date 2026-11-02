import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parse, stringify } from "smol-toml"
import type { ConversationKind } from "./api/types"
import { appPaths } from "./paths"

export type ImageMode = "auto" | "kitty" | "sixel" | "blocks" | "off"
const IMAGE_MODES: readonly ImageMode[] = ["auto", "kitty", "sixel", "blocks", "off"]

export interface KinEntry {
  name: string
  ai_id: string
}

export interface GroupEntry {
  name: string
  group_id: string
}

export interface UiConfig {
  images: ImageMode
  /** Upper bound on AI replies per user message in a group chat. */
  maxGroupTurns: number
  /** How your own messages are labelled. Unset: your name as Kindroid reports it, else "You". */
  userName?: string
}

export interface Config {
  path: string
  apiKey?: string
  apiKeySource: "env" | "file" | null
  baseUrl?: string
  kins: KinEntry[]
  groups: GroupEntry[]
  ui: UiConfig
  warnings: string[]
}

export const CONFIG_TEMPLATE = `# kindroid-tui configuration
#
# API key: Kindroid app -> Profile -> Preferences -> API & Integrations.
# KINDROID_API_KEY in the environment takes precedence over this value.
# api_key = "kn_..."

# Add one [[kin]] per Kindroid. The ai_id is at the bottom of the Kin's settings menu.
# [[kin]]
# name = "Ava"
# ai_id = "..."

# Group chats need a Kindroid subscription. The group_id is the last part of
# the web URL /v2/chat/group/<group_id>.
# [[group]]
# name = "Friends"
# group_id = "..."

[ui]
images = "auto"        # auto | kitty | sixel | blocks | off
max_group_turns = 4    # most AI replies per message in a group chat
# user_name = "Sam"    # label for your messages (default: your name from Kindroid)
`

export function loadConfig(opts: { env?: Record<string, string | undefined>; path?: string } = {}): Config {
  const env = opts.env ?? process.env
  const path = opts.path ?? appPaths(env).configFile
  const warnings: string[] = []
  let raw: Record<string, unknown> = {}

  if (existsSync(path)) {
    try {
      raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>
    } catch (err) {
      warnings.push(`Could not parse ${path}: ${(err as Error).message}`)
    }
    try {
      const mode = statSync(path).mode
      if (mode & 0o077 && typeof raw.api_key === "string") {
        warnings.push(`${path} is readable by other users and holds your API key; run chmod 600 on it`)
      }
    } catch {
      // ignore
    }
  }

  const envKey = env.KINDROID_API_KEY?.trim()
  const fileKey = typeof raw.api_key === "string" ? raw.api_key.trim() : undefined
  const apiKey = envKey || fileKey || undefined
  const apiKeySource = envKey ? "env" : fileKey ? "file" : null
  if (apiKey && !apiKey.startsWith("kn_")) warnings.push("API key does not start with kn_; is it the right value?")

  const kins: KinEntry[] = entries(raw.kin, "ai_id", warnings).map(({ name, id }) => ({ name, ai_id: id }))
  const groups: GroupEntry[] = entries(raw.group, "group_id", warnings).map(({ name, id }) => ({ name, group_id: id }))

  const ui = (raw.ui ?? {}) as Record<string, unknown>
  let images = (typeof ui.images === "string" ? ui.images : "auto") as ImageMode
  if (!IMAGE_MODES.includes(images)) {
    warnings.push(`ui.images must be one of ${IMAGE_MODES.join(", ")}`)
    images = "auto"
  }
  const turns = Number(ui.max_group_turns ?? 4)

  return {
    path,
    apiKey,
    apiKeySource,
    baseUrl: env.KINDROID_API_BASE || (typeof raw.base_url === "string" ? raw.base_url : undefined),
    kins,
    groups,
    ui: {
      images,
      maxGroupTurns: Number.isFinite(turns) ? Math.min(20, Math.max(1, Math.floor(turns))) : 4,
      userName: typeof ui.user_name === "string" && ui.user_name.trim() ? ui.user_name.trim() : undefined,
    },
    warnings,
  }
}

function entries(value: unknown, idKey: "ai_id" | "group_id", warnings: string[]): Array<{ name: string; id: string }> {
  if (value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  const seen = new Set<string>()
  const out: Array<{ name: string; id: string }> = []
  for (const item of list) {
    const rec = (item ?? {}) as Record<string, unknown>
    const id = typeof rec[idKey] === "string" ? (rec[idKey] as string).trim() : ""
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id
    if (!id) {
      warnings.push(`Skipping a ${idKey === "ai_id" ? "[[kin]]" : "[[group]]"} entry without ${idKey}`)
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ name, id })
  }
  return out
}

/** Create the config file from the template (0600, directory 0700) if it doesn't exist. */
export function ensureConfigFile(path: string): void {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, CONFIG_TEMPLATE, { mode: 0o600 })
}

/** Append a [[kin]] or [[group]] table, preserving the rest of the file (comments included). */
export function addConversation(path: string, entry: { kind: ConversationKind; name: string; id: string }): void {
  ensureConfigFile(path)
  const table = entry.kind === "kin" ? { name: entry.name, ai_id: entry.id } : { name: entry.name, group_id: entry.id }
  const header = entry.kind === "kin" ? "[[kin]]" : "[[group]]"
  const existing = readFileSync(path, "utf8")
  // TOML array-of-tables must come before [ui] or they'd nest under it; inserting before the first
  // plain [table] header keeps them at the top level.
  const block = `${header}\n${stringify(table)}\n`
  const firstTable = existing.search(/^\[(?!\[)[^\]]+\]\s*$/m)
  if (firstTable === -1) {
    appendFileSync(path, (existing.endsWith("\n") ? "\n" : "\n\n") + block)
  } else {
    writeFileSync(path, existing.slice(0, firstTable) + block + "\n" + existing.slice(firstTable))
  }
  try {
    chmodSync(path, 0o600)
  } catch {
    // best effort
  }
}


