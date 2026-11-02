import type { MouseEvent, Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createSignal, For, on, onCleanup } from "solid-js"
import { span } from "./Message"
import { theme } from "./theme"

export interface ListItem {
  key: string
  label: string
  /** One-cell glyph before the label. */
  marker?: string
  suffix?: string
  suffixColor?: string
}

/**
 * A clickable, scrollable list. OpenTUI's <select> only handles the keyboard, so each row here is a box
 * with its own mouse handler. Keyboard movement is up to the parent (it owns `cursor`), so the list works
 * both as a focus target (the chat list) and next to a text input (the picker).
 */
export function ListView(props: {
  items: ListItem[]
  /** Highlighted row for keyboard navigation. */
  cursor: number
  /** Show the cursor highlight (the list or its dialog has focus). */
  showCursor: boolean
  /** The row that is open/current, drawn in the accent colour. */
  activeKey?: string
  height?: number
  /** Called for a left click or for enter (via the parent). */
  onPick: (index: number) => void
}) {
  let sb: ScrollBoxRenderable | undefined
  const rows = new Map<string, Renderable>()
  const [hover, setHover] = createSignal(-1)

  // Keep the keyboard cursor visible as it moves.
  createEffect(
    on(
      () => props.items[props.cursor]?.key,
      (key) => {
        const row = key ? rows.get(key) : undefined
        if (sb && row) sb.scrollChildIntoView(row, { align: "nearest" })
      },
      { defer: true },
    ),
  )

  const bg = (i: number) =>
    props.showCursor && i === props.cursor ? theme.selectedBg : i === hover() ? theme.hoverBg : "transparent"

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => (sb = r)}
      flexGrow={props.height === undefined ? 1 : 0}
      height={props.height}
      scrollY
      verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.faint, backgroundColor: "transparent" } }}
    >
      <For each={props.items}>
        {(item, i) => {
          onCleanup(() => rows.delete(item.key))
          const active = () => item.key === props.activeKey
          return (
            <box
              ref={(r: Renderable) => rows.set(item.key, r)}
              height={1}
              flexShrink={0}
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={bg(i())}
              onMouseDown={(e: MouseEvent) => {
                if (e.button !== 0) return
                // Don't let the click also reach the pane behind, which would move focus back to it.
                e.stopPropagation()
                props.onPick(i())
              }}
              onMouseOver={() => setHover(i())}
              onMouseOut={() => setHover((h) => (h === i() ? -1 : h))}
            >
              <text flexGrow={1} flexShrink={1} truncate>
                <span style={span({ fg: active() ? theme.accent : theme.muted })}>{`${active() ? "▶" : (item.marker ?? " ")} `}</span>
                <span style={span({ fg: active() ? theme.accent : theme.text, bold: active() })}>{item.label}</span>
                <span style={span({ fg: item.suffixColor ?? theme.muted })}>{item.suffix ?? ""}</span>
              </text>
            </box>
          )
        }}
      </For>
    </scrollbox>
  )
}
