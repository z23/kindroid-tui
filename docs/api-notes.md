# Kindroid API notes

Summary of the public API as the client uses it, with the gaps the docs leave open. Source: the official API
documentation at <https://kindroid.ai/v2/docs/api-documentation/>.

## Behaviour the client relies on (from the docs)

- Base URL `https://api.kindroid.ai/v1`, `Authorization: Bearer kn_…`.
- Rate limit: 10 requests per 30 s per account (429 when exceeded); `/get-chat-messages` also 600 per 24 h.
- Streaming (`stream: true`): plain text chunks, not SSE. May start with whitespace keep-alive bytes. The
  status is sent before generation, so failures arrive inside a 200 body: `<<ERROR>>` (generation failed) or
  `<<HTTP_ERROR>>` (HTTP-level failure mid-stream).
- `/get-chat-messages`: exactly one of `ai_id` / `group_id`; `limit` 1–100 (default 50);
  `start_after_timestamp` cursor. Oldest first. Returns `{ messages, pagination: { hasMore, lastTimestamp, limit } }`.
  Selfies and other images only appear here (`image_urls`), never in a send reply.
- `/rewind-messages`: `count` 1–10, even for 1:1 chats; 409 when a message can't be rewound or a voice call is active.
- Groups: `groupchats-user-message` → `groupchats-get-turn` (an `ai_id`, or an empty body for the user's
  turn) → `groupchats-ai-response` → repeat. Subscription required (403 otherwise).
- There is no endpoint to list Kindroids or groups, or to read a Kindroid's profile.
- `/update-info` and `/groupchats-update` are write-only: they change settings but nothing reads them back.
  The client uses them only to set `current_scene` (see `KindroidClient.setScene`). It never sends memory,
  backstory, directive, group members or other profile fields, because overwriting values it can't read
  could destroy what the user wrote in the app.

## Confirmed against the real API

Hands-on use with a real account (November 2026) worked for:

- Bearer auth with a `kn_` key.
- `GET /get-chat-messages` with `ai_id` and `limit` as query parameters, including the history check that runs
  when you add a Kindroid. AI messages carry a `display_name`, which the app uses to fill in names.
- Telling the user's messages from the Kindroid's (the `sender_type` handling in `roleOf`).
- Streamed `send-message` replies arriving and displaying as they generate.

This was ordinary use rather than the probe script, so the edge cases below were not exercised.

## Open questions (run the probe to settle them)

The client handles each case below defensively either way.

| Question | Assumption in the code | Where |
|---|---|---|
| Does a history call without a cursor return the oldest page or the newest N? | Either works: `syncHistory` pages forward until `hasMore` is false, capped at 10 pages per sync, and resumes on later syncs. If the API returns the oldest page, the first open of a long chat spends several calls. | `src/store/cache.ts` |
| Is `timestamp` in seconds or milliseconds? | Values below 1e12 are treated as seconds for display; cache queries use the raw value. | `toMs` in `src/store/conversation.ts` |
| What values do `sender` / `sender_type` take? | Attribution works in practice (see above), but the exact values haven't been recorded. `sender_type` of user/human/you/self means the user, and any other value means an AI. Whether `sender` is the `ai_id` matters for discovering group members. | `roleOf` in `src/store/conversation.ts` |
| Does a failed generation (`<<ERROR>>`) still store the user's message? | Assumed yes. Regenerate then refuses, because a 1:1 rewind must be even. | `Conversation.undo` |
| What exactly does `groupchats-get-turn` return? | A plain `ai_id`, a JSON string, or `{ "ai_id": … }` are all accepted; empty or `null` means the user's turn. | `parseTurn` in `src/api/client.ts` |
| How does a stream end? | When the connection closes. | `parseKindroidStream` |

### Probe

```sh
bun run probe -- --kin <ai_id> [--group <group_id>]          # read-only: about 3 history calls per conversation
bun run probe -- --kin <test_ai_id> --send "probe test"      # also sends ONE real streamed message
```

The probe prints and saves only metadata (field names, sender types, timestamp units, lengths and chunk
timings), never message text. It writes `docs/fixtures/raw/probe-*.json`, which git ignores.
