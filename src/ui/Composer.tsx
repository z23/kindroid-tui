import type { TextareaRenderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { theme } from "./theme"

export interface ComposerApi {
  setText(text: string): void
  focus(): void
  isEmpty(): boolean
}

// enter sends; shift+enter, alt+enter and ctrl+j insert a newline (shift+enter needs a terminal with
// the kitty keyboard protocol, e.g. Ghostty or Kitty).
const KEYS = [
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "return", meta: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
]

export function Composer(props: {
  focused: boolean
  placeholder: string
  busy: boolean
  /** Return false to keep the text in the composer (the message was not accepted). */
  onSubmit: (text: string) => boolean
  onMouseDown?: () => void
  api?: (api: ComposerApi) => void
}) {
  let ta: TextareaRenderable | undefined
  const [lines, setLines] = createSignal(1)

  const recount = () => setLines(Math.min(8, Math.max(1, (ta?.plainText ?? "").split("\n").length)))

  props.api?.({
    setText(text) {
      ta?.setText(text)
      ta?.gotoBufferEnd()
      recount()
    },
    focus() {
      ta?.focus()
    },
    isEmpty() {
      return !(ta?.plainText ?? "").trim()
    },
  })

  return (
    <box
      onMouseDown={() => props.onMouseDown?.()}
      border
      borderStyle="rounded"
      borderColor={props.focused ? theme.borderFocus : theme.border}
      height={lines() + 2}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      title={props.busy ? " esc to stop " : undefined}
      titleAlignment="right"
      titleColor={theme.muted}
    >
      <textarea
        ref={(r: TextareaRenderable) => (ta = r)}
        focused={props.focused}
        placeholder={props.placeholder}
        placeholderColor={theme.muted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.accent}
        wrapMode="word"
        keyBindings={KEYS}
        flexGrow={1}
        onContentChange={recount}
        onSubmit={() => {
          const text = ta?.plainText ?? ""
          if (!text.trim()) return
          if (props.onSubmit(text) === false) return
          ta?.clear()
          recount()
        }}
      />
    </box>
  )
}
