import { useBindings } from "@opentui/keymap/solid"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch, type Accessor } from "solid-js"
import type { KindroidClient } from "../api/client"
import { convKey, type ConversationKind } from "../api/types"
import { addConversation, type Config } from "../config"
import type { HistoryCache } from "../store/cache"
import { Conversation, suggestName } from "../store/conversation"
import { ChatView, type ChatViewApi } from "./ChatView"
import { Composer, type ComposerApi } from "./Composer"
import { AddConversationDialog, type NewConversation } from "./dialogs/AddConversation"
import { ChatBreakDialog } from "./dialogs/ChatBreak"
import { ConfirmDialog } from "./dialogs/Confirm"
import { HelpDialog } from "./dialogs/Help"
import { PickerDialog } from "./dialogs/Picker"
import { useConversationState, useLimitStatus } from "./hooks"
import { Sidebar, type ConvEntry } from "./Sidebar"
import { StatusBar } from "./StatusBar"

export interface AppProps {
  config: Config
  client: KindroidClient
  cache: HistoryCache
  reloadConfig: () => Config
  onQuit: () => void
}

type DialogState =
  | { kind: "help" }
  | { kind: "picker" }
  | { kind: "add" }
  | { kind: "break" }
  | { kind: "confirm"; title: string; message: string; confirmLabel?: string; danger?: boolean; action: () => void }

type Focus = "composer" | "sidebar" | "chat"
const FOCUS_ORDER: Focus[] = ["composer", "sidebar", "chat"]
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const SIDEBAR_WIDTH = 24

export function App(props: AppProps) {
  const dims = useTerminalDimensions()
  const [config, setConfig] = createSignal(props.config)
  const entries = createMemo<ConvEntry[]>(() => [
    ...config().kins.map((k) => ({ ref: { kind: "kin" as const, id: k.ai_id }, name: k.name, key: convKey({ kind: "kin", id: k.ai_id }) })),
    ...config().groups.map((g) => ({ ref: { kind: "group" as const, id: g.group_id }, name: g.name, key: convKey({ kind: "group", id: g.group_id }) })),
  ])
  const remembered = props.cache.getMeta("active")
  const [activeKey, setActiveKey] = createSignal<string | undefined>(
    entries().some((e) => e.key === remembered) ? remembered! : entries()[0]?.key,
  )
  const [focus, setFocus] = createSignal<Focus>("composer")
  const [dialog, setDialog] = createSignal<DialogState | null>(null)
  const [showImages, setShowImages] = createSignal(config().ui.images !== "off")
  const [sidebarPref, setSidebarPref] = createSignal(true)
  const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<string>>(new Set())
  const [quitArmed, setQuitArmed] = createSignal(false)
  const [appNotice, setAppNotice] = createSignal<string | null>(null)
  const limits = useLimitStatus(props.client.limiter, props.client.budget)

  const showSidebar = () => sidebarPref() && dims().width >= 70 && entries().length > 0
  const chatWidth = () => dims().width - (showSidebar() ? SIDEBAR_WIDTH : 0) - 4

  // One controller per conversation, kept alive so a reply keeps streaming when you switch away.
  const conversations = new Map<string, Conversation>()
  const nameFor = (aiId: string) => config().kins.find((k) => k.ai_id === aiId)?.name
  const conversationFor = (entry: ConvEntry): Conversation => {
    let conv = conversations.get(entry.key)
    if (!conv) {
      conv = new Conversation({
        client: props.client,
        cache: props.cache,
        ref: entry.ref,
        title: entry.name,
        nameFor,
        userName: config().ui.userName,
        maxGroupTurns: config().ui.maxGroupTurns,
      })
      conv.subscribe((s) => {
        const busy = s.activity.kind !== "idle"
        const set = busyKeys()
        if (busy !== set.has(entry.key)) {
          const next = new Set(set)
          if (busy) next.add(entry.key)
          else next.delete(entry.key)
          setBusyKeys(next)
        }
      })
      conversations.set(entry.key, conv)
    }
    return conv
  }

  const activeEntry = createMemo(() => entries().find((e) => e.key === activeKey()))
  const active = createMemo(() => {
    const e = activeEntry()
    return e ? conversationFor(e) : undefined
  })
  const state = useConversationState(active)
  const isGroup = () => activeEntry()?.ref.kind === "group"

  createEffect(
    on(active, (conv) => {
      if (!conv) return
      props.cache.setMeta("active", conv.key)
      void conv.open()
    }),
  )

  const [frame, setFrame] = createSignal(0)
  const ticker = setInterval(() => {
    if (busyKeys().size > 0 || limits().queued > 0) setFrame((f) => (f + 1) % SPINNER.length)
  }, 90)
  onCleanup(() => clearInterval(ticker))
  const spinner = () => SPINNER[frame()]!

  let composer: ComposerApi | undefined
  let chat: ChatViewApi | undefined

  const closeDialog = () => {
    setDialog(null)
    setFocus("composer")
  }
  const flash = (text: string, ms = 2500) => {
    setAppNotice(text)
    setTimeout(() => setAppNotice((n) => (n === text ? null : n)), ms)
  }

  const send = (text: string): boolean => {
    const conv = active()
    if (!conv) {
      flash("Add a chat first: ctrl+k, then “Add”")
      return false
    }
    if (!conv.canAct()) {
      flash("Still replying (esc to stop first)")
      return false
    }
    chat?.toEnd()
    void conv.send(text).then(() => {
      const last = conv.state.messages.at(-1)
      if (last?.notSent && last.text === text.trim() && composer?.isEmpty()) composer.setText(text)
    })
    return true
  }

  /** The open conversation if it can take an action now; otherwise explain why not. */
  const actionable = (): Conversation | undefined => {
    const conv = active()
    if (!conv) return undefined
    if (!conv.canAct()) {
      flash("Still replying (esc to stop first)")
      return undefined
    }
    return conv
  }

  const undo = () => {
    const conv = actionable()
    if (!conv) return
    setDialog({
      kind: "confirm",
      title: "Undo",
      message: isGroup()
        ? "Remove the last message in this group from Kindroid?"
        : "Remove your last message and its reply from Kindroid? Your message goes back into the composer.",
      confirmLabel: "undo",
      action: () => {
        closeDialog()
        void conv.undo().then((text) => {
          if (text && composer?.isEmpty()) composer.setText(text)
        })
      },
    })
  }

  const regenerate = () => {
    const conv = actionable()
    if (!conv) return
    if (isGroup()) return flash("Regenerate works in 1:1 chats; use ctrl+n to hear from someone else")
    setDialog({
      kind: "confirm",
      title: "Regenerate",
      message: "Replace the last reply? This rewinds the exchange on Kindroid and sends your message again.",
      confirmLabel: "regenerate",
      action: () => {
        closeDialog()
        void conv.regenerate()
      },
    })
  }

  const quit = () => {
    if (quitArmed()) return props.onQuit()
    setQuitArmed(true)
    flash("Press ctrl+c again to quit", 1500)
    setTimeout(() => setQuitArmed(false), 1500)
  }

  const escape = () => {
    const conv = active()
    if (conv?.busy) return conv.stop()
    if (focus() !== "composer") return setFocus("composer")
    conv?.dismissError()
    setAppNotice(null)
  }

  const cycleFocus = (dir: 1 | -1) => {
    const order = FOCUS_ORDER.filter((f) => f !== "sidebar" || showSidebar())
    const i = order.indexOf(focus())
    setFocus(order[(i + dir + order.length) % order.length]!)
  }

  useBindings(() => {
    const open = dialog() !== null
    const f = focus()
    return {
      commands: [
        { name: "app.quit", run: quit },
        { name: "app.escape", run: escape },
        { name: "app.focusNext", run: () => cycleFocus(1) },
        { name: "app.focusPrev", run: () => cycleFocus(-1) },
        { name: "app.picker", run: () => setDialog({ kind: "picker" }) },
        { name: "app.help", run: () => setDialog({ kind: "help" }) },
        { name: "app.add", run: () => setDialog({ kind: "add" }) },
        { name: "app.undo", run: undo },
        { name: "app.regenerate", run: regenerate },
        { name: "app.more", run: () => (isGroup() ? void actionable()?.continueGroup() : flash("ctrl+n is for group chats")) },
        { name: "app.break", run: () => actionable() && setDialog({ kind: "break" }) },
        { name: "app.sync", run: () => void active()?.sync({ manual: true }) },
        { name: "app.images", run: () => setShowImages((v) => !v) },
        { name: "app.sidebar", run: () => setSidebarPref((v) => !v) },
        { name: "app.dismiss", run: () => (active()?.dismissError(), setAppNotice(null)) },
        { name: "app.pageUp", run: () => chat?.pageUp() },
        { name: "app.pageDown", run: () => chat?.pageDown() },
      ],
      bindings: open
        ? [{ key: "ctrl+c", cmd: "app.quit" }]
        : [
            { key: "ctrl+c", cmd: "app.quit" },
            { key: "escape", cmd: "app.escape" },
            { key: "tab", cmd: "app.focusNext" },
            { key: "shift+tab", cmd: "app.focusPrev" },
            { key: "ctrl+k", cmd: "app.picker" },
            { key: "f1", cmd: "app.help" },
            { key: "ctrl+z", cmd: "app.undo" },
            { key: "ctrl+r", cmd: "app.regenerate" },
            { key: "ctrl+n", cmd: "app.more" },
            { key: "ctrl+b", cmd: "app.break" },
            { key: "ctrl+l", cmd: "app.sync" },
            { key: "ctrl+o", cmd: "app.images" },
            { key: "ctrl+t", cmd: "app.sidebar" },
            { key: "ctrl+x", cmd: "app.dismiss" },
            { key: "pageup", cmd: "app.pageUp" },
            { key: "pagedown", cmd: "app.pageDown" },
            ...(f !== "composer" ? [{ key: "?", cmd: "app.help" }] : []),
            ...(f === "sidebar" ? [{ key: "a", cmd: "app.add" }] : []),
          ],
    }
  })

  const hint = () =>
    !activeEntry()
      ? "ctrl+k to add your first Kindroid · f1 help"
      : isGroup()
        ? "enter send · ctrl+n more replies · ctrl+z undo · ctrl+b chat break"
        : "enter send · ctrl+z undo · ctrl+r regenerate · ctrl+b chat break"

  const emptyHint = () =>
    !activeEntry()
      ? "No chats yet. Press ctrl+k and choose “Add”, or add [[kin]] entries to " + config().path +
        ". Kindroid's API can't list your Kindroids, so each is added once by its ai_id (bottom of the Kin's settings menu)."
      : `No messages with ${activeEntry()!.name} yet. Say hello!`

  /** Check an ID and suggest a name from its history. One history call either way. */
  const lookup = async (kind: ConversationKind, id: string) => {
    const res = await props.client.getChatMessages({ kind, id }, { limit: 20 })
    return suggestName(kind, res.messages)
  }

  const saveConversation = (entry: NewConversation) => {
    const key = convKey({ kind: entry.kind, id: entry.id })
    const existing = entries().find((e) => e.key === key)
    if (existing) throw new Error(`Already in your list as “${existing.name}”`)
    addConversation(config().path, entry)
    setConfig(props.reloadConfig())
    setActiveKey(key)
    closeDialog()
    flash(`Added ${entry.name} to ${config().path}`)
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" flexGrow={1}>
        <Show when={showSidebar()}>
          <Sidebar
              onMouseDown={() => setFocus("sidebar")}
              entries={entries()}
              activeKey={activeKey()}
              busyKeys={busyKeys()}
              focused={focus() === "sidebar" && !dialog()}
              width={SIDEBAR_WIDTH}
              onAdd={() => setDialog({ kind: "add" })}
              onSelect={(e) => {
                setActiveKey(e.key)
                setFocus("composer")
              }}
            />
        </Show>
        <box flexDirection="column" flexGrow={1}>
          <ChatView
            title={activeEntry()?.name ?? "kindroid-tui"}
            subtitle={isGroup() ? "group" : undefined}
            state={state()}
            focused={focus() === "chat" && !dialog()}
            images={config().ui.images}
            showImages={showImages()}
            width={chatWidth()}
            spinner={spinner()}
            emptyHint={emptyHint()}
            onLoadOlder={() => active()?.loadOlder() ?? 0}
            onMouseDown={() => setFocus("chat")}
            api={(a) => (chat = a)}
          />
          <Composer
              onMouseDown={() => setFocus("composer")}
              focused={focus() === "composer" && !dialog()}
              busy={state().activity.kind !== "idle"}
              placeholder={activeEntry() ? `Message ${activeEntry()!.name}…` : "Add a chat first (ctrl+k)"}
              onSubmit={send}
              api={(a) => (composer = a)}
            />
        </box>
      </box>
      <StatusBar
        activity={state().activity}
        error={state().error}
        notice={appNotice() ?? state().notice}
        spinner={spinner()}
        limits={limits()}
        hint={hint()}
      />

      <Switch>
        <Match when={dialog()?.kind === "help"}>
          <HelpDialog configPath={config().path} onClose={closeDialog} />
        </Match>
        <Match when={dialog()?.kind === "picker"}>
          <PickerDialog
            entries={entries()}
            activeKey={activeKey()}
            onPick={(e) => {
              setActiveKey(e.key)
              closeDialog()
            }}
            onAdd={() => setDialog({ kind: "add" })}
            onCancel={closeDialog}
          />
        </Match>
        <Match when={dialog()?.kind === "add"}>
          <AddConversationDialog lookup={lookup} onSave={saveConversation} onCancel={closeDialog} />
        </Match>
        <Match when={dialog()?.kind === "break" && activeEntry()}>
          <ChatBreakDialog
            name={activeEntry()!.name}
            onCancel={closeDialog}
            onSubmit={(greeting, wipe) => {
              const conv = active()
              closeDialog()
              if (conv) void conv.chatBreak(greeting, wipe)
            }}
          />
        </Match>
        <Match when={dialog()?.kind === "confirm" && (dialog() as Extract<DialogState, { kind: "confirm" }>)}>
          {(d: Accessor<Extract<DialogState, { kind: "confirm" }>>) => (
            <ConfirmDialog
              title={d().title}
              message={d().message}
              confirmLabel={d().confirmLabel}
              danger={d().danger}
              onConfirm={d().action}
              onCancel={closeDialog}
            />
          )}
        </Match>
      </Switch>
    </box>
  )
}
