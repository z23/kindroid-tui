import type { TextareaRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/solid"
import { createSignal } from "solid-js"
import type { SceneRecord } from "../../store/conversation"
import { formatTime } from "../format"
import { theme } from "../theme"
import { Dialog } from "./Dialog"

/**
 * Edit the current scene. Kindroid can't report the scene that's set now, so the editor starts from the
 * last scene set from this app, and saving replaces whatever is set on Kindroid.
 */
export function SceneDialog(props: {
  name: string
  isGroup: boolean
  current: SceneRecord | null
  onSave: (text: string) => void
  onCancel: () => void
}) {
  let ta: TextareaRenderable | undefined
  const [error, setError] = createSignal<string | null>(null)

  const save = () => {
    const text = (ta?.plainText ?? "").trim()
    if (!text) return setError("Describe the scene first; Kindroid doesn't say what an empty scene would do.")
    props.onSave(text)
  }

  useBindings(() => ({
    priority: 100,
    commands: [{ name: "scene.cancel", run: () => props.onCancel() }],
    bindings: [{ key: "escape", cmd: "scene.cancel" }],
  }))

  return (
    <Dialog title={`Scene · ${props.name}`} width={70} footer="enter save · shift+enter new line · esc cancel">
      <text fg={theme.muted} wrapMode="word">
        {props.current
          ? `Kindroid can't tell apps the current scene, so this is the one you set here (${formatTime(props.current.at)}). It may have changed in the Kindroid app since.`
          : "Kindroid can't tell apps the current scene, and you haven't set one from here yet."}
      </text>
      <box border borderStyle="rounded" borderColor={theme.border} height={8} paddingLeft={1} paddingRight={1}>
        <textarea
          ref={(r: TextareaRenderable) => {
            ta = r
            if (props.current) {
              r.setText(props.current.text)
              r.gotoBufferEnd()
            }
          }}
          focused
          placeholder={
            props.isGroup
              ? "Everyone's crammed into a booth at the late-night diner after the concert."
              : "A rainy Sunday afternoon; we're curled up on the couch with tea."
          }
          placeholderColor={theme.faint}
          textColor={theme.text}
          focusedTextColor={theme.text}
          wrapMode="word"
          flexGrow={1}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "linefeed", action: "newline" },
          ]}
          onContentChange={() => setError(null)}
          onSubmit={save}
        />
      </box>
      <text fg={error() ? theme.error : theme.warn} wrapMode="word">
        {error() ?? `Saving replaces the current scene for ${props.name} on Kindroid.`}
      </text>
    </Dialog>
  )
}
