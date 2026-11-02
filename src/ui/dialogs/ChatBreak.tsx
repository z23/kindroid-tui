import type { TextareaRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/solid"
import { createSignal, Match, Switch } from "solid-js"
import { span } from "../Message"
import { theme } from "../theme"
import { Dialog } from "./Dialog"

/**
 * Chat break: start a new chat with a greeting. Wiping long-term (cascaded) memory is opt-in and
 * needs a second confirmation.
 */
export function ChatBreakDialog(props: {
  name: string
  onSubmit: (greeting: string, wipe: boolean) => void
  onCancel: () => void
}) {
  let ta: TextareaRenderable | undefined
  const [wipe, setWipe] = createSignal(false)
  const [step, setStep] = createSignal<"edit" | "confirm">("edit")
  const [greeting, setGreeting] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)

  const next = () => {
    const text = (ta?.plainText ?? greeting()).trim()
    if (!text) {
      setError("A greeting is required: it becomes the first message of the new chat.")
      return
    }
    setGreeting(text)
    setStep("confirm")
  }

  useBindings(() => ({
    priority: 100,
    commands: [
      { name: "break.toggleWipe", run: () => step() === "edit" && setWipe((w) => !w) },
      { name: "break.cancel", run: () => (step() === "confirm" ? setStep("edit") : props.onCancel()) },
      { name: "break.confirm", run: () => props.onSubmit(greeting(), wipe()) },
    ],
    bindings:
      step() === "edit"
        ? [
            { key: "ctrl+t", cmd: "break.toggleWipe" },
            { key: "escape", cmd: "break.cancel" },
          ]
        : [
            { key: "y", cmd: "break.confirm" },
            { key: "return", cmd: "break.confirm" },
            { key: "n", cmd: "break.cancel" },
            { key: "escape", cmd: "break.cancel" },
          ],
  }))

  return (
    <Dialog
      title={`Chat break · ${props.name}`}
      danger={wipe()}
      width={64}
      footer={step() === "edit" ? "enter continue · ctrl+t wipe memory · esc cancel" : "enter/y do it · esc back"}
    >
      <Switch>
        <Match when={step() === "edit"}>
          <text fg={theme.text} wrapMode="word">
            Ends the current chat and resets short-term memory. The greeting below becomes the first message of the new chat.
          </text>
          <box border borderStyle="rounded" borderColor={theme.border} height={6} paddingLeft={1} paddingRight={1}>
            <textarea
              ref={(r: TextareaRenderable) => (ta = r)}
              focused
              initialValue={greeting()}
              placeholder={`*${props.name} looks up* Hey, good to see you.`}
              placeholderColor={theme.muted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              wrapMode="word"
              flexGrow={1}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "return", shift: true, action: "newline" },
                { name: "linefeed", action: "newline" },
              ]}
              onSubmit={next}
            />
          </box>
          <text>
            <span style={span({ fg: wipe() ? theme.error : theme.muted })}>{wipe() ? "[x]" : "[ ]"}</span>
            <span style={span({ fg: wipe() ? theme.error : theme.text })}>{" Also wipe long-term memory"}</span>
            <span style={span({ fg: theme.muted })}>{"  (ctrl+t)"}</span>
          </text>
          <text fg={theme.error}>{error() ?? ""}</text>
        </Match>
        <Match when={step() === "confirm"}>
          <text fg={wipe() ? theme.error : theme.text} wrapMode="word">
            {wipe()
              ? `This ends the chat AND permanently wipes ${props.name}'s long-term memory of it. This cannot be undone. Continue?`
              : `End the current chat with ${props.name} and start fresh with your greeting?`}
          </text>
        </Match>
      </Switch>
    </Dialog>
  )
}
