# `kindroid-tui serve` protocol

`kindroid-tui serve [--config <path>]` runs the same client core as the terminal UI (API client, rate limiter,
daily history budget, history cache, conversation controller) without a UI. It reads requests from stdin and
writes responses and events to stdout, one JSON object per line. The Omarchy plugin
([omarchy-plugin-kindroid](https://github.com/z23/omarchy-plugin-kindroid)) is its only client so far.

It exits when stdin closes, or on SIGTERM or SIGINT. It never writes message text to stderr.

Like the terminal UI, it only calls Kindroid when a request asks it to. It has no timers that reach the network.

## Versioning

The first line is always the `ready` event. Its `protocol` number goes up on any change a client could
misread. A client should refuse a helper whose `protocol` it doesn't know. The current version is **1**.

## Requests and responses

```json
{"id": 7, "method": "send", "params": {"key": "kin:abc123", "text": "hi"}}
{"id": 7, "ok": true, "result": null}
{"id": 8, "ok": false, "error": "Unknown conversation; it may have been removed from config.toml"}
```

`id` is a number or string chosen by the client and echoed back. A line that isn't JSON gets
`{"id": null, "ok": false, "error": "invalid JSON"}`. Any `conversation` events a request caused are written
before its response.

Conversations are addressed by `key`: `kin:<ai_id>` or `group:<group_id>`, as listed in the `config` event.

| Method | Params | Result | Notes |
|---|---|---|---|
| `hello` | | `{protocol, version}` | |
| `reload` | | `null` | Re-reads config.toml, then sends `config`. A changed key or base URL resets every conversation. |
| `setActive` | `key` | `null` | Remembers the selected chat; shared with the terminal UI. |
| `open` | `key` | `null` | Sends the cached state at once, then syncs (at most every 2 minutes per chat, and not when the daily budget is low). |
| `send` | `key`, `text` | `null` | Answers immediately. The reply streams through `conversation` events. Group chats run the turn loop. |
| `stop` | `key` | `null` | Stops a streaming reply or the group loop. |
| `continue` | `key` | `null` | Groups only: let the AIs keep talking. |
| `regenerate` | `key` | `null` | 1:1 only: rewind the last exchange and send it again. |
| `sync` | `key` | `null` | Manual sync. |
| `dismiss` | `key` | `null` | Clears the error and notice. |
| `loadOlder` | `key`, `count?` | `{added}` | Shows more of the local cache. |
| `undoPreview` | `key`, `steps` | `{unit, steps, maxSteps, messages, problem?}` | What `undo` would remove. |
| `undo` | `key`, `steps` | `{restored}` | `restored` is the first removed user message, to put back in the composer. |
| `scene` | `key`, `text` | `{ok}` | Sets `current_scene` only. |
| `chatBreak` | `key`, `greeting`, `wipe?` | `null` | `wipe: true` also clears long-term memory. |
| `lookup` | `kind`, `id` | `{id, name}` | Checks an ID with one history call and suggests a name. Accepts a pasted web URL. |
| `add` | `kind`, `id`, `name` | `{key}` | Appends to config.toml and reloads. |

## Events

`ready`: `{"event": "ready", "protocol": 1, "version": "0.2.0"}`

`config`: sent at start and after every reload. It never contains the API key.

```json
{"event": "config", "path": "/home/me/.config/kindroid-tui/config.toml", "hasKey": true, "keySource": "file",
 "warnings": [], "userName": null, "maxGroupTurns": 4, "active": "kin:abc123",
 "conversations": [{"key": "kin:abc123", "kind": "kin", "id": "abc123", "name": "Ava"}]}
```

`limits`: sent at start and when the rate limiter or budget changes (throttled to 5 a second). `waitMs` was
measured at `at`.

```json
{"event": "limits", "at": 1793700764636, "queued": 0, "waitMs": 0, "available": 10, "limit": 10,
 "budgetRemaining": 598, "budgetLimit": 600}
```

`conversation`: changes to one conversation's state, gathered over about 33 ms, so a streaming reply arrives
as a growing `draft` a few dozen times a second rather than once per network chunk. With `full: true` the
state is complete and replaces what the client has. Otherwise it holds only the fields that changed. Merge it.

```json
{"event": "conversation", "key": "kin:abc123", "full": false,
 "state": {"activity": {"kind": "streaming", "speakerId": "abc123", "name": "Ava"},
           "draft": {"speakerId": "abc123", "name": "Ava", "text": "*waves* Hi",
                     "segments": [{"kind": "action", "text": "waves"}, {"kind": "plain", "text": " Hi"}]}}}
```

State fields: `messages`, `draft`, `activity`, `error`, `notice`, `canLoadOlder`, `lastSyncedAt`, `scene`
(`{text, at}` for the last scene set from this machine, or null).

`activity.kind` is one of `idle`, `syncing`, `sending`, `turn`, `streaming` (with `speakerId` and `name`),
`rewinding`, `breaking` and `updating`.

A message:

```json
{"key": "m000123", "id": "m000123", "role": "ai", "speakerId": "abc123", "name": "Ava",
 "text": "*waves* Hi", "segments": [{"kind": "action", "text": "waves"}, {"kind": "plain", "text": " Hi"}],
 "ts": 1793700764000, "images": ["https://…"], "notes": ["image: Ava smiling"], "local": false}
```

`segments` is the text split into `plain`, `action` (`*…*`, asterisks removed), `quote` ("…") and `bold`
(`**…**`). Messages sent from this session are `local` until the next sync gives them a server id. They also
carry `failed` (why) and `notSent` (the server never got it) when something went wrong.

## Sharing with the terminal UI

The helper and the terminal UI use the same config.toml and the same history cache, so either one can be
used. Each process runs its own rate limiter. If both send at once they can go past Kindroid's 10-per-30-second
limit together. Both then back off from the 429 and retry, so nothing is lost, only slowed down. The 600-a-day
history budget is counted in the shared cache, so it holds across both.
