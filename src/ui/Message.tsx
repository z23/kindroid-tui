import { TextAttributes } from "@opentui/core"
import { createSignal, For, Show } from "solid-js"
import type { ImageMode } from "../config"
import type { Draft, ViewMessage } from "../store/conversation"
import { formatMessage, formatTime, type Segment } from "./format"
import { speakerColor, theme } from "./theme"

/** Span styles are applied by the Solid reconciler as fg/bg plus boolean attributes. */
interface SpanStyle {
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
}
export const span = (s: SpanStyle) => s as {}

function Body(props: { text: string; dim?: boolean }) {
  const segments = () => formatMessage(props.text)
  const style = (s: Segment) =>
    span({
      fg: props.dim ? theme.muted : s.kind === "action" ? theme.action : s.kind === "quote" ? theme.quote : theme.text,
      italic: s.kind === "action",
      bold: s.kind === "bold",
    })
  return (
    <text wrapMode="word" fg={theme.text} selectable>
      <For each={segments()}>{(s) => <span style={style(s)}>{s.text}</span>}</For>
    </text>
  )
}

function Header(props: { name: string; color: string; time?: number; suffix?: string; suffixColor?: string }) {
  return (
    <text>
      <span style={span({ fg: props.color, bold: true })}>{props.name}</span>
      <Show when={props.time}>
        <span style={span({ fg: theme.muted })}>{`  ${formatTime(props.time!)}`}</span>
      </Show>
      <Show when={props.suffix}>
        <span style={span({ fg: props.suffixColor ?? theme.muted })}>{`  ${props.suffix}`}</span>
      </Show>
    </text>
  )
}

function InlineImage(props: { url: string; mode: ImageMode; width: number }) {
  const [failed, setFailed] = createSignal(false)
  return (
    <Show
      when={!failed() && props.mode !== "off"}
      fallback={<text fg={theme.muted} attributes={TextAttributes.UNDERLINE}>{props.url}</text>}
    >
      <image
        source={props.url}
        fit="fit"
        protocol={props.mode === "off" ? "auto" : props.mode}
        onError={() => setFailed(true)}
        style={{ width: Math.max(12, Math.min(48, props.width)), height: 14 }}
      />
    </Show>
  )
}

export function MessageView(props: {
  message: ViewMessage
  images: ImageMode
  showImages: boolean
  width: number
  /** Selected by the undo dialog: shown dimmed and marked. */
  pendingRemoval?: boolean
  ref?: (el: unknown) => void
}) {
  const m = () => props.message
  const color = () => (m().role === "user" ? theme.user : speakerColor(m().speakerId))
  const suffix = () =>
    props.pendingRemoval
      ? "✗ will be removed"
      : m().failed
        ? m().notSent
          ? `not sent: ${m().failed}`
          : m().failed
        : m().local
          ? "…"
          : undefined
  return (
    <box ref={props.ref} flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1} flexShrink={0}>
      <Header
        name={m().name}
        color={props.pendingRemoval ? theme.muted : color()}
        time={m().timestamp}
        suffix={suffix()}
        suffixColor={m().failed || props.pendingRemoval ? theme.error : theme.muted}
      />
      <Show when={m().text}>
        <Body text={m().text} dim={m().notSent || props.pendingRemoval} />
      </Show>
      <Show when={m().images.length > 0}>
        <Show
          when={props.showImages}
          fallback={<text fg={theme.muted}>{`[${m().images.length} image${m().images.length > 1 ? "s" : ""} hidden · ctrl+o to show]`}</text>}
        >
          <For each={m().images}>{(url) => <InlineImage url={url} mode={props.images} width={props.width - 4} />}</For>
        </Show>
      </Show>
      <For each={m().notes}>{(note) => <text fg={theme.muted} wrapMode="word">{`↳ ${note}`}</text>}</For>
    </box>
  )
}

export function DraftView(props: { draft: Draft; spinner: string }) {
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} marginBottom={1} flexShrink={0}>
      <Header name={props.draft.name} color={speakerColor(props.draft.speakerId)} suffix={`${props.spinner} typing`} />
      <Show when={props.draft.text} fallback={<text fg={theme.muted}>…</text>}>
        <Body text={props.draft.text} />
      </Show>
    </box>
  )
}
