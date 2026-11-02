/** What the composer's text means: a chat message, or one of the app's slash commands. */
export type ComposerInput =
  | { kind: "message"; text: string }
  | { kind: "scene"; text?: string }
  | { kind: "undo"; steps: number }
  | { kind: "help" }
  | { kind: "unknown"; name: string }
  | { kind: "invalid"; reason: string }

export const COMMAND_HINT = "Commands: /scene [text], /undo [n], /help. Start with // to send a message beginning with /"

/**
 * Parse composer text. `/name args` is a command when `name` is a word; `//text` sends "/text" as a
 * message; anything else (including "/ " or "/123") is an ordinary message.
 */
export function parseComposerInput(raw: string): ComposerInput {
  const text = raw.trim()
  if (text.startsWith("//")) return { kind: "message", text: text.slice(1) }
  const m = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(text)
  if (!m) return { kind: "message", text }
  const name = m[1]!.toLowerCase()
  const rest = (m[2] ?? "").trim()
  switch (name) {
    case "scene":
      return rest ? { kind: "scene", text: rest } : { kind: "scene" }
    case "undo": {
      if (!rest) return { kind: "undo", steps: 1 }
      if (!/^\d+$/.test(rest) || Number(rest) < 1) return { kind: "invalid", reason: "Use /undo or /undo <number>, e.g. /undo 3" }
      return { kind: "undo", steps: Number(rest) }
    }
    case "help":
    case "keys":
      return { kind: "help" }
    default:
      return { kind: "unknown", name }
  }
}
