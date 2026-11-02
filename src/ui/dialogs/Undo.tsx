import { useBindings } from "@opentui/keymap/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { UndoPreview } from "../../store/conversation"
import { span } from "../Message"
import { speakerColor, theme } from "../theme"
import { Dialog } from "./Dialog"

/**
 * Choose how far to rewind. Lists the messages that would be removed (and reports them so the chat can
 * highlight them), and only confirms when the rewind is possible.
 */
export function UndoDialog(props: {
  initialSteps: number
  preview: (steps: number) => UndoPreview
  onHighlight: (keys: ReadonlySet<string>) => void
  onConfirm: (steps: number) => void
  onCancel: () => void
}) {
  const [steps, setSteps] = createSignal(props.initialSteps)
  const preview = createMemo(() => props.preview(steps()))

  createEffect(() => props.onHighlight(new Set(preview().messages.map((m) => m.key))))
  onCleanup(() => props.onHighlight(new Set()))

  const change = (delta: number) => setSteps(() => Math.min(preview().maxSteps, Math.max(1, preview().steps + delta)))
  const confirm = () => {
    if (!preview().problem) props.onConfirm(preview().steps)
  }

  useBindings(() => ({
    priority: 100,
    commands: [
      { name: "undo.more", run: () => change(1) },
      { name: "undo.less", run: () => change(-1) },
      { name: "undo.confirm", run: confirm },
      { name: "undo.cancel", run: () => props.onCancel() },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ name: `undo.set${n}`, run: () => setSteps(Math.min(n, preview().maxSteps)) })),
    ],
    bindings: [
      { key: "up", cmd: "undo.more" },
      { key: "k", cmd: "undo.more" },
      { key: "plus", cmd: "undo.more" },
      { key: "down", cmd: "undo.less" },
      { key: "j", cmd: "undo.less" },
      { key: "minus", cmd: "undo.less" },
      { key: "return", cmd: "undo.confirm" },
      { key: "y", cmd: "undo.confirm" },
      { key: "escape", cmd: "undo.cancel" },
      { key: "n", cmd: "undo.cancel" },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ key: String(n), cmd: `undo.set${n}` })),
    ],
  }))

  const label = () => {
    const p = preview()
    const what = p.unit === "exchange" ? (p.steps === 1 ? "exchange" : "exchanges") : p.steps === 1 ? "message" : "messages"
    return `Undo the last ${p.steps} ${what}`
  }

  return (
    <Dialog
      title="Undo"
      width={70}
      danger={preview().messages.length > 2}
      footer={preview().problem ? "↑↓ change · esc cancel" : "↑↓ change · enter/y undo · esc cancel"}
    >
      <text>
        <span style={span({ fg: theme.text, bold: true })}>{label()}</span>
        <span style={span({ fg: theme.muted })}>{`   (1–${preview().maxSteps}, ↑↓ or a number)`}</span>
      </text>
      <text fg={theme.muted} wrapMode="word">
        {preview().unit === "exchange"
          ? "Each exchange is one of your messages and its reply. They're removed from Kindroid, and your earliest removed message goes back into the message box."
          : "These messages are removed from the group on Kindroid. Your earliest removed message goes back into the message box."}
      </text>
      <box flexDirection="column">
        <For each={preview().messages}>
          {(m) => (
            <text truncate>
              <span style={span({ fg: theme.error })}>{"✗ "}</span>
              <span style={span({ fg: m.role === "user" ? theme.user : speakerColor(m.speakerId), bold: true })}>{`${m.name}: `}</span>
              <span style={span({ fg: theme.muted })}>{m.text.replace(/\s+/g, " ")}</span>
            </text>
          )}
        </For>
      </box>
      <Show when={preview().problem}>
        <text fg={theme.error} wrapMode="word">{`Can't undo: ${preview().problem}`}</text>
      </Show>
    </Dialog>
  )
}
