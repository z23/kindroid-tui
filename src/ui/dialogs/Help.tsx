import { useBindings } from "@opentui/keymap/solid"
import { For } from "solid-js"
import { span } from "../Message"
import { theme } from "../theme"
import { Dialog } from "./Dialog"

export const HELP_KEYS: Array<[string, string]> = [
  ["enter", "send message"],
  ["shift+enter / ctrl+j", "new line (shift+enter needs Ghostty/Kitty)"],
  ["esc", "stop the reply / group loop"],
  ["tab / shift+tab", "move focus: composer → chats → history"],
  ["ctrl+k", "jump to a chat"],
  ["pgup / pgdn", "scroll history (pgup at the top loads older)"],
  ["ctrl+z", "undo last exchange (rewind)"],
  ["ctrl+r", "regenerate last reply"],
  ["ctrl+n", "group: let the AIs keep talking"],
  ["ctrl+b", "chat break (new chat, optional memory wipe)"],
  ["ctrl+l", "sync history now"],
  ["ctrl+o", "show / hide images"],
  ["ctrl+t", "show / hide the chat list"],
  ["a (in chat list)", "add a Kindroid or group"],
  ["ctrl+x", "dismiss error"],
  ["ctrl+c twice", "quit"],
]

export function HelpDialog(props: { onClose: () => void; configPath: string }) {
  useBindings(() => ({
    priority: 100,
    commands: [{ name: "help.close", run: () => props.onClose() }],
    bindings: [
      { key: "escape", cmd: "help.close" },
      { key: "f1", cmd: "help.close" },
      { key: "q", cmd: "help.close" },
      { key: "?", cmd: "help.close" },
      { key: "return", cmd: "help.close" },
    ],
  }))
  return (
    <Dialog title="Keys" width={66} footer="esc close">
      <box flexDirection="column">
        <For each={HELP_KEYS}>
          {([key, what]) => (
            <text>
              <span style={span({ fg: theme.accent })}>{key.padEnd(24)}</span>
              <span style={span({ fg: theme.text })}>{what}</span>
            </text>
          )}
        </For>
      </box>
      <text fg={theme.muted} wrapMode="word">
        {`Config: ${props.configPath}. Limits: 10 requests / 30 s, 600 history fetches / day.`}
      </text>
    </Dialog>
  )
}
