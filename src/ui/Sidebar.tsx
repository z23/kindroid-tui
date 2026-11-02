import type { MouseEvent } from "@opentui/core"
import { useBindings } from "@opentui/keymap/solid"
import { createEffect, createMemo, createSignal, on } from "solid-js"
import type { ConversationRef } from "../api/types"
import { ListView, type ListItem } from "./ListView"
import { span } from "./Message"
import { theme } from "./theme"

export interface ConvEntry {
  ref: ConversationRef
  name: string
  key: string
}

export function Sidebar(props: {
  entries: ConvEntry[]
  activeKey: string | undefined
  busyKeys: ReadonlySet<string>
  focused: boolean
  width: number
  onSelect: (entry: ConvEntry) => void
  onAdd: () => void
  onMouseDown?: () => void
}) {
  const activeIndex = () => Math.max(0, props.entries.findIndex((e) => e.key === props.activeKey))
  const [cursor, setCursor] = createSignal(activeIndex())
  // Follow the open chat when it changes from elsewhere (picker, adding a chat).
  createEffect(on(() => props.activeKey, () => setCursor(activeIndex()), { defer: true }))

  const items = createMemo<ListItem[]>(() =>
    props.entries.map((e) => ({
      key: e.key,
      label: e.name,
      marker: e.ref.kind === "group" ? "#" : "•",
      suffix: props.busyKeys.has(e.key) ? " ●" : undefined,
      suffixColor: theme.ai,
    })),
  )

  const move = (delta: number) => {
    const n = props.entries.length
    if (n > 0) setCursor((c) => (((c + delta) % n) + n) % n)
  }
  const open = (i: number) => {
    const entry = props.entries[i]
    if (!entry) return
    setCursor(i)
    props.onSelect(entry)
  }

  useBindings(() => ({
    priority: 50,
    commands: [
      { name: "sidebar.up", run: () => move(-1) },
      { name: "sidebar.down", run: () => move(1) },
      { name: "sidebar.first", run: () => setCursor(0) },
      { name: "sidebar.last", run: () => setCursor(Math.max(0, props.entries.length - 1)) },
      { name: "sidebar.open", run: () => open(cursor()) },
    ],
    bindings: props.focused
      ? [
          { key: "up", cmd: "sidebar.up" },
          { key: "k", cmd: "sidebar.up" },
          { key: "down", cmd: "sidebar.down" },
          { key: "j", cmd: "sidebar.down" },
          { key: "home", cmd: "sidebar.first" },
          { key: "end", cmd: "sidebar.last" },
          { key: "return", cmd: "sidebar.open" },
          { key: "space", cmd: "sidebar.open" },
        ]
      : [],
  }))

  return (
    <box
      onMouseDown={() => props.onMouseDown?.()}
      border
      borderStyle="rounded"
      borderColor={props.focused ? theme.borderFocus : theme.border}
      title=" Chats "
      titleColor={theme.muted}
      width={props.width}
      flexShrink={0}
      flexDirection="column"
    >
      <ListView items={items()} cursor={cursor()} showCursor={props.focused} activeKey={props.activeKey} onPick={open} />
      <box
        height={1}
        flexShrink={0}
        paddingLeft={1}
        onMouseDown={(e: MouseEvent) => {
          if (e.button !== 0) return
          e.stopPropagation()
          props.onAdd()
        }}
      >
        <text>
          <span style={span({ fg: theme.accent })}>{"+ add"}</span>
          <span style={span({ fg: theme.muted })}>{" (a)"}</span>
        </text>
      </box>
    </box>
  )
}
