# kindroid-tui

An unofficial terminal client for [Kindroid](https://kindroid.ai), built on [OpenTUI](https://opentui.com) and Solid.

> **Unofficial.** This project is not affiliated with, endorsed by, or supported by Kindroid. It uses Kindroid's
> public API with your own API key, so everything it does happens on your account. Use it at your own risk.

- Streaming replies, with `*actions*` in italics and "dialogue" highlighted
- 1:1 chats and group chats (the group turn loop runs for you, with a reply cap)
- Undo (rewind), regenerate, chat break with an optional long-term memory wipe
- Selfies and other images inline (Kitty graphics in Ghostty/Kitty, Sixel, or Unicode blocks elsewhere)
- A local history cache, so opening a chat is instant and the 600/day history limit goes further
- A client-side rate limiter that queues requests instead of tripping Kindroid's 10-per-30-seconds limit

## Install

Needs [Bun](https://bun.sh) 1.3.14 or newer (pinned to 1.4 in `mise.toml`).

```sh
mise install          # or install Bun another way
bun install
bun run dev           # run from source
bun run build         # standalone binary at dist/kindroid-tui
cp dist/kindroid-tui ~/.local/bin/
```

## Setup

1. Get your API key: Kindroid app → Profile → Preferences → API & Integrations. Treat it like a password.
2. Either `export KINDROID_API_KEY=kn_…` or put it in `~/.config/kindroid-tui/config.toml`
   (created on first run with permissions `0600`; the environment variable wins if both are set).
3. Add your Kindroids and groups, once each, by ID (see [Why you add Kindroids by ID](#why-you-add-kindroids-by-id)):
   - **ai_id**: at the bottom of the Kin's settings menu.
   - **group_id**: the last part of the group's web URL, `kindroid.ai/v2/chat/group/<group_id>`. Pasting the
     whole URL works too.

   In the app, press ctrl+k → “Add” (or `a` in the chat list), paste the ID and press enter. The app checks
   the ID with Kindroid and fills in the name; edit it if you like, then press enter again to save it to the
   config. Or edit the config by hand:

```toml
api_key = "kn_..."

[[kin]]
name = "Ava"
ai_id = "..."

[[group]]
name = "Friends"
group_id = "..."

[ui]
images = "auto"        # auto | kitty | sixel | blocks | off
max_group_turns = 4    # most AI replies per message in a group chat
# user_name = "Sam"    # label for your messages (default: your name from Kindroid)
```

Group chats need a Kindroid subscription. Add each group member as a `[[kin]]` too, so their messages get your
names for them.

## Why you add Kindroids by ID

Kindroid's public API has **no endpoint that lists your Kindroids or group chats**, and none that reads a
Kindroid's name, avatar or settings. An API key can only reach the documented endpoints: send a message, read
chat history, rewind, chat break, update a Kindroid's settings, and the group-chat calls. All of them need you
to supply the `ai_id` or `group_id`. So the app can't discover what's on your account, and every Kindroid and
group has to be added by ID once. After that it's saved in `config.toml`.

To keep that to a single paste, when you add an ID the app fetches a little of that chat's history (one call
from the daily allowance) and takes the name from it:

- **Kindroid:** its display name from its own messages. A brand-new chat with no history has nothing to read,
  so you type the name.
- **Group:** Kindroid doesn't expose group names either, so the app suggests the names of the Kindroids
  talking in it (for example “Ava, Rex & Mira”).

The Kindroid web and phone apps can list your Kindroids because they use your logged-in account session and
private endpoints, not the API key. This app sticks to the documented API: those private endpoints aren't
documented for outside use and could change at any time.

## Keys

| Key | Action |
|---|---|
| enter | send |
| shift+enter, ctrl+j | new line (shift+enter needs Ghostty, Kitty or another kitty-keyboard terminal) |
| esc | stop the reply / group loop |
| tab, shift+tab | move focus: composer → chat list → history |
| ctrl+k | jump to a chat (fuzzy filter), or add one |
| pgup, pgdn | scroll history; pgup at the top loads older cached messages |
| ctrl+z | undo the last exchange (asks first) |
| ctrl+r | regenerate the last reply (asks first) |
| ctrl+n | group chats: let the AIs keep talking |
| ctrl+b | chat break: new chat with a greeting, optional memory wipe (asks twice) |
| ctrl+l | sync history now |
| ctrl+o | show/hide images |
| ctrl+t | show/hide the chat list |
| ctrl+x | dismiss an error |
| f1 | help |
| ctrl+c twice | quit |

## Limits

Kindroid allows 10 requests per 30 seconds per account, and 600 history fetches per 24 hours. The status bar
shows both (`req 7/10 · history 594/600`). Requests over the limit wait in a queue, so a busy group round slows
down instead of failing. The app fetches history when you open a chat (at most every 2 minutes per chat), once
after each reply, and when you press ctrl+l. Automatic fetches stop when fewer than 50 remain for the day.

## Privacy

- Chat history is cached in `~/.local/share/kindroid-tui/history.db`, created with permissions `0600`.
  Delete the file to clear it.
- The API key is never logged, and anything that looks like a key is stripped from error messages.
- The binary doesn't read `.env`, `bunfig.toml` or similar files from the directory you run it in.

## Development

```sh
bun test                  # unit, integration (against the mock API) and UI tests
bun run typecheck
bun run mock              # fake Kindroid API on 127.0.0.1:8787
bun run dev:mock          # the app pointed at the mock, in another terminal
bun run probe -- --kin <ai_id>   # read-only checks against the real API; see docs/api-notes.md
```

The mock server reproduces the documented API behaviour, including streaming keep-alives, the `<<ERROR>>` and
`<<HTTP_ERROR>>` markers, 429s and the group turn loop. Magic words in a message trigger edge cases: `/error`,
`/break`, `/slow`, `/long`, and `selfie`.

Layout: `src/api` (HTTP client, stream parser, rate limiter), `src/store` (sqlite cache, per-conversation
controller), `src/ui` (OpenTUI/Solid components).

## License

[MIT](LICENSE). Kindroid is a trademark of its owner; the name is used here only to say what this client
works with.
