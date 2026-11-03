import type { InputRenderable } from "@opentui/core"
import { useBindings } from "@opentui/keymap/solid"
import { createSignal, Show } from "solid-js"
import { describeError } from "../../api/errors"
import { normalizeId } from "../../ids"
import type { ConversationKind } from "../../api/types"
import { span } from "../Message"
import { theme } from "../theme"
import { Dialog } from "./Dialog"

export { normalizeId }

type Field = "id" | "name"

export interface NewConversation {
  kind: ConversationKind
  name: string
  id: string
}


/**
 * Add a Kindroid (by ai_id) or a group (by group_id). Kindroid's API can't list your Kindroids or read
 * their names, so you paste the ID; enter checks it with one history call and fills in the name from the
 * history it got back. You can edit the name before saving.
 */
export function AddConversationDialog(props: {
  /** Check the ID with Kindroid; resolves with a suggested name when history provides one. */
  lookup: (kind: ConversationKind, id: string) => Promise<string | undefined>
  /** Persist the entry; throw to show an error in the dialog. */
  onSave: (entry: NewConversation) => void
  onCancel: () => void
}) {
  let idInput: InputRenderable | undefined
  let nameInput: InputRenderable | undefined
  const [kind, setKind] = createSignal<ConversationKind>("kin")
  const [field, setField] = createSignal<Field>("id")
  const [error, setError] = createSignal<string | null>(null)
  const [status, setStatus] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  /** The kind and ID that passed the check, so saving doesn't re-check an unchanged ID. */
  const [checked, setChecked] = createSignal<{ kind: ConversationKind; id: string } | null>(null)
  /** The name we filled in, so a re-check may replace it but never a name you typed. */
  let autoName: string | null = null

  const currentId = () => normalizeId(idInput?.plainText ?? "")
  const currentName = () => (nameInput?.plainText ?? "").trim()
  const isChecked = () => {
    const c = checked()
    return !!c && c.kind === kind() && c.id === currentId()
  }

  const check = async (): Promise<boolean> => {
    const id = currentId()
    if (!id) {
      setField("id")
      setError(kind() === "kin" ? "Paste the ai_id from the bottom of the Kin's settings menu" : "Paste the group_id from the group's web URL")
      return false
    }
    if (isChecked()) return true
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const suggested = await props.lookup(kind(), id)
      setChecked({ kind: kind(), id })
      if (suggested && (!currentName() || currentName() === autoName)) {
        nameInput?.setText(suggested)
        nameInput?.gotoBufferEnd()
        autoName = suggested
      }
      setStatus(
        suggested
          ? `✓ Found ${kind() === "kin" ? suggested : "the group"}. Edit the name if you like, then enter to add.`
          : kind() === "kin"
            ? "✓ ID works, but there's no history to take a name from. Give it one."
            : "✓ ID works. Kindroid doesn't share group names, so give it one.",
      )
      setField("name")
      return true
    } catch (err) {
      setChecked(null)
      setError(describeError(err))
      setField("id")
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!(await check())) return
    const name = currentName()
    if (!name) {
      setField("name")
      setError("Give it a name")
      return
    }
    try {
      props.onSave({ kind: kind(), name, id: currentId() })
    } catch (err) {
      setError(describeError(err))
    }
  }

  const onEnter = () => {
    if (busy()) return
    void (field() === "id" ? check() : save())
  }

  const toggleKind = () => {
    setKind((k) => (k === "kin" ? "group" : "kin"))
    setChecked(null)
    setStatus(null)
    setError(null)
  }

  useBindings(() => ({
    priority: 100,
    commands: [
      { name: "add.next", run: () => setField((f) => (f === "id" ? "name" : "id")) },
      { name: "add.kind", run: toggleKind },
      { name: "add.enter", run: onEnter },
      { name: "add.cancel", run: () => props.onCancel() },
    ],
    bindings: [
      { key: "tab", cmd: "add.next" },
      { key: "shift+tab", cmd: "add.next" },
      { key: "ctrl+t", cmd: "add.kind" },
      { key: "return", cmd: "add.enter" },
      { key: "escape", cmd: "add.cancel" },
    ],
  }))

  return (
    <Dialog title="Add a chat" width={66} footer="enter check/add · tab next field · ctrl+t kin/group · esc cancel">
      <text>
        <span style={span({ fg: kind() === "kin" ? theme.accent : theme.muted, bold: kind() === "kin" })}>{"[ Kindroid ]"}</span>
        <span style={span({ fg: theme.faint })}>{"  "}</span>
        <span style={span({ fg: kind() === "group" ? theme.accent : theme.muted, bold: kind() === "group" })}>{"[ Group chat ]"}</span>
        <span style={span({ fg: theme.muted })}>{"   ctrl+t to switch"}</span>
      </text>
      <text fg={theme.muted} wrapMode="word">
        {kind() === "kin"
          ? "Kindroid's API can't list your Kindroids, so paste the ai_id from the bottom of the Kin's settings menu. The name is filled in for you."
          : "Paste the group_id: the last part of the group's web URL (…/v2/chat/group/<id>). The whole URL works too. Group chats need a subscription."}
      </text>
      <box flexDirection="column">
        <text fg={field() === "id" ? theme.accent : theme.muted}>{kind() === "kin" ? "ai_id" : "group_id or URL"}</text>
        <input
          ref={(r: InputRenderable) => (idInput = r)}
          focused={field() === "id" && !busy()}
          placeholder="paste the ID, then enter"
          placeholderColor={theme.faint}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.panelBg}
          focusedBackgroundColor={theme.panelBg}
          onInput={() => {
            setError(null)
            if (!isChecked()) setStatus(null)
          }}
        />
      </box>
      <box flexDirection="column">
        <text fg={field() === "name" ? theme.accent : theme.muted}>Name</text>
        <input
          ref={(r: InputRenderable) => (nameInput = r)}
          focused={field() === "name" && !busy()}
          placeholder="filled in after the ID check"
          placeholderColor={theme.faint}
          textColor={theme.text}
          focusedTextColor={theme.text}
          backgroundColor={theme.panelBg}
          focusedBackgroundColor={theme.panelBg}
        />
      </box>
      <Show when={busy() || error() || status()}>
        <text fg={busy() ? theme.accent : error() ? theme.error : theme.ok} wrapMode="word">
          {busy() ? "Checking the ID with Kindroid…" : (error() ?? status() ?? "")}
        </text>
      </Show>
    </Dialog>
  )
}
