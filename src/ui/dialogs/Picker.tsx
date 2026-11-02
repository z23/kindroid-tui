import { useBindings } from "@opentui/keymap/solid"
import { createMemo, createSignal } from "solid-js"
import { ListView, type ListItem } from "../ListView"
import type { ConvEntry } from "../Sidebar"
import { theme } from "../theme"
import { Dialog } from "./Dialog"

const ADD = "__add__"

/** Score a fuzzy subsequence match; lower is better, -1 means no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim()
  const t = text.toLowerCase()
  if (!q) return 0
  const idx = t.indexOf(q)
  if (idx >= 0) return idx
  let ti = 0
  let gaps = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return -1
    gaps += found - ti
    ti = found + 1
  }
  return 100 + gaps
}

export function PickerDialog(props: {
  entries: ConvEntry[]
  activeKey?: string
  onPick: (entry: ConvEntry) => void
  onAdd: () => void
  onCancel: () => void
}) {
  const [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  const matches = createMemo(() =>
    props.entries
      .map((e) => ({ e, score: fuzzyScore(query(), e.name) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.e),
  )
  const items = createMemo<ListItem[]>(() => [
    ...matches().map((e) => ({ key: e.key, label: e.name, marker: e.ref.kind === "group" ? "#" : "•" })),
    { key: ADD, label: "Add a Kindroid or group…", marker: "+", suffixColor: theme.accent },
  ])

  const choose = (i: number) => {
    const item = items()[i]
    if (!item) return
    if (item.key === ADD) return props.onAdd()
    const entry = props.entries.find((e) => e.key === item.key)
    if (entry) props.onPick(entry)
  }
  const move = (delta: number) => {
    const n = items().length
    setCursor((c) => (((c + delta) % n) + n) % n)
  }

  useBindings(() => ({
    priority: 100,
    commands: [
      { name: "picker.up", run: () => move(-1) },
      { name: "picker.down", run: () => move(1) },
      { name: "picker.choose", run: () => choose(cursor()) },
      { name: "picker.cancel", run: () => props.onCancel() },
    ],
    bindings: [
      { key: "up", cmd: "picker.up" },
      { key: "ctrl+p", cmd: "picker.up" },
      { key: "down", cmd: "picker.down" },
      { key: "ctrl+n", cmd: "picker.down" },
      { key: "return", cmd: "picker.choose" },
      { key: "escape", cmd: "picker.cancel" },
      { key: "ctrl+k", cmd: "picker.cancel" },
    ],
  }))

  return (
    <Dialog title="Jump to chat" width={50} footer="↑↓ or click · enter open · esc close">
      <input
        focused
        placeholder="type to filter…"
        placeholderColor={theme.muted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        onInput={(v: string) => {
          setQuery(v)
          setCursor(0)
        }}
      />
      <ListView
        items={items()}
        cursor={cursor()}
        showCursor
        activeKey={props.activeKey}
        height={Math.min(12, items().length)}
        onPick={choose}
      />
    </Dialog>
  )
}
