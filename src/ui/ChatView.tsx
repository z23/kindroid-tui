import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { For, onCleanup, Show, type Accessor } from "solid-js"
import type { ImageMode } from "../config"
import type { ConversationState, Draft } from "../store/conversation"
import { DraftView, MessageView } from "./Message"
import { theme } from "./theme"

export interface ChatViewApi {
  pageUp(): void
  pageDown(): void
  toTop(): void
  toEnd(): void
}

export function ChatView(props: {
  title: string
  subtitle?: string
  state: ConversationState
  focused: boolean
  images: ImageMode
  showImages: boolean
  width: number
  spinner: string
  emptyHint: string
  onLoadOlder: () => number
  onMouseDown?: () => void
  api?: (api: ChatViewApi) => void
}) {
  let sb: ScrollBoxRenderable | undefined
  const rows = new Map<string, Renderable>()

  /** Pull older cached messages in above the current ones without moving the view. */
  const loadOlderAnchored = () => {
    if (!sb || !props.state.canLoadOlder) return false
    const first = props.state.messages[0]
    const node = first ? rows.get(first.key) : undefined
    const release = node ? sb.anchor(node) : undefined
    const added = props.onLoadOlder()
    if (release) sb.afterLayout(release)
    return added > 0
  }

  props.api?.({
    pageUp() {
      if (!sb) return
      if (sb.scrollTop <= 0 && loadOlderAnchored()) return
      sb.scrollBy(-0.5, "viewport")
    },
    pageDown() {
      sb?.scrollBy(0.5, "viewport")
    },
    toTop() {
      if (!sb) return
      if (sb.scrollTop <= 0) loadOlderAnchored()
      else sb.scrollTo(0)
    },
    toEnd() {
      sb?.scrollTo(Infinity)
    },
  })

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => (sb = r)}
      onMouseDown={() => props.onMouseDown?.()}
      stickyScroll
      stickyStart="bottom"
      focused={props.focused}
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={props.focused ? theme.borderFocus : theme.border}
      title={` ${props.title}${props.subtitle ? ` · ${props.subtitle}` : ""} `}
      titleColor={theme.accent}
      contentOptions={{ flexDirection: "column", paddingTop: 1 }}
      verticalScrollbarOptions={{ trackOptions: { foregroundColor: theme.faint, backgroundColor: "transparent" } }}
    >
      <Show when={props.state.canLoadOlder}>
        <text fg={theme.muted} paddingLeft={1} marginBottom={1}>
          ↑ older messages · pgup at the top to load
        </text>
      </Show>
      <Show when={props.state.messages.length === 0 && !props.state.draft}>
        <text fg={theme.muted} paddingLeft={1} wrapMode="word">
          {props.emptyHint}
        </text>
      </Show>
      <For each={props.state.messages}>
        {(m) => {
          onCleanup(() => rows.delete(m.key))
          return (
          <MessageView
            message={m}
            images={props.images}
            showImages={props.showImages}
            width={props.width}
            ref={(el) => {
              rows.set(m.key, el as Renderable)
            }}
          />
          )
        }}
      </For>
      <Show when={props.state.draft}>{(d: Accessor<Draft>) => <DraftView draft={d()} spinner={props.spinner} />}</Show>
    </scrollbox>
  )
}
