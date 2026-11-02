export type SegmentKind = "plain" | "action" | "quote" | "bold"

export interface Segment {
  kind: SegmentKind
  text: string
}

/**
 * Split Kindroid roleplay text into styled segments:
 * `*action*` (asterisks dropped, shown italic), `**bold**`, and "dialogue" in straight or curly quotes.
 * An unclosed `*` runs to the end of the text, so a reply that is still streaming renders sensibly.
 */
export function formatMessage(text: string): Segment[] {
  const out: Segment[] = []
  let buf = ""
  // Typed loosely on purpose: `flush` reassigns it, which TypeScript control-flow narrowing cannot see.
  let mode = "plain" as SegmentKind

  const flush = (next: SegmentKind) => {
    if (buf) {
      const last = out.at(-1)
      if (last && last.kind === mode) last.text += buf
      else out.push({ kind: mode, text: buf })
    }
    buf = ""
    mode = next
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "*" && text[i + 1] === "*") {
      flush(mode === "bold" ? "plain" : mode === "plain" ? "bold" : mode)
      i++
      continue
    }
    if (ch === "*") {
      if (mode === "action") flush("plain")
      else if (mode === "plain" || mode === "quote") flush("action")
      continue
    }
    if (mode === "plain" && (ch === '"' || ch === "“")) {
      flush("quote")
      buf += ch
      continue
    }
    if (mode === "quote" && (ch === '"' || ch === "”")) {
      buf += ch
      flush("plain")
      continue
    }
    buf += ch
  }
  flush("plain")
  return out
}

export function formatTime(ms: number, now = Date.now()): string {
  if (!ms) return ""
  const d = new Date(ms)
  const today = new Date(now)
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (d.toDateString() === today.toDateString()) return time
  const yesterday = new Date(now - 86_400_000)
  if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`
  const sameYear = d.getFullYear() === today.getFullYear()
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })} ${time}`
}
