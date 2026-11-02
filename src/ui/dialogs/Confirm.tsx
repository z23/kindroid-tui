import { useBindings } from "@opentui/keymap/solid"
import { theme } from "../theme"
import { Dialog } from "./Dialog"

export function ConfirmDialog(props: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useBindings(() => ({
    priority: 100,
    commands: [
      { name: "confirm.yes", run: () => props.onConfirm() },
      { name: "confirm.no", run: () => props.onCancel() },
    ],
    bindings: [
      { key: "y", cmd: "confirm.yes" },
      { key: "return", cmd: "confirm.yes" },
      { key: "n", cmd: "confirm.no" },
      { key: "escape", cmd: "confirm.no" },
    ],
  }))
  return (
    <Dialog title={props.title} danger={props.danger} width={56} footer={`enter/y ${props.confirmLabel ?? "confirm"} · esc/n cancel`}>
      <text fg={theme.text} wrapMode="word">
        {props.message}
      </text>
    </Dialog>
  )
}
