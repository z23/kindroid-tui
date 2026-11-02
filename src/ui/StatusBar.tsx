import { Show } from "solid-js"
import type { Activity } from "../store/conversation"
import type { LimitStatus } from "./hooks"
import { span } from "./Message"
import { theme } from "./theme"

function activityText(a: Activity, spinner: string, limits: LimitStatus): string | null {
  const waiting = limits.waitMs > 500 && limits.queued > 0 ? ` · rate limited, ${Math.ceil(limits.waitMs / 1000)}s` : ""
  switch (a.kind) {
    case "idle":
      return waiting ? `${spinner}${waiting}` : null
    case "syncing":
      return `${spinner} syncing${waiting}`
    case "sending":
      return `${spinner} sending${waiting}`
    case "turn":
      return `${spinner} waiting for the next speaker${waiting}`
    case "streaming":
      return `${spinner} ${a.name} is typing${waiting}`
    case "rewinding":
      return `${spinner} rewinding${waiting}`
    case "breaking":
      return `${spinner} starting a new chat${waiting}`
    case "updating":
      return `${spinner} updating the scene${waiting}`
  }
}

export function StatusBar(props: {
  activity: Activity
  error: string | null
  notice: string | null
  spinner: string
  limits: LimitStatus
  hint: string
}) {
  const left = () => {
    if (props.error) return { text: `✗ ${props.error}`, color: theme.error }
    const act = activityText(props.activity, props.spinner, props.limits)
    if (act) return { text: act, color: theme.accent }
    if (props.notice) return { text: props.notice, color: theme.warn }
    return { text: props.hint, color: theme.muted }
  }
  const historyColor = () =>
    props.limits.historyLeft < 50 ? theme.error : props.limits.historyLeft < 150 ? theme.warn : theme.muted

  return (
    <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1} paddingRight={1}>
      <text flexGrow={1} flexShrink={1} truncate fg={left().color} marginRight={2}>
        {left().text}
      </text>
      <text flexShrink={0}>
        <span style={span({ fg: props.limits.available <= 2 ? theme.warn : theme.muted })}>
          {`req ${props.limits.available}/${props.limits.limit}`}
        </span>
        <span style={span({ fg: theme.faint })}>{" · "}</span>
        <span style={span({ fg: historyColor() })}>{`history ${props.limits.historyLeft}/600`}</span>
        <Show when={props.error || props.notice}>
          <span style={span({ fg: theme.faint })}>{" · "}</span>
          <span style={span({ fg: theme.muted })}>{"ctrl+x dismiss"}</span>
        </Show>
        <span style={span({ fg: theme.faint })}>{" · "}</span>
        <span style={span({ fg: theme.muted })}>{"f1 help"}</span>
      </text>
    </box>
  )
}
