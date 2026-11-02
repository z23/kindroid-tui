/**
 * A fake Kindroid API for development and tests. Mirrors the documented behaviour of the real API:
 * Bearer auth, plain-text streaming with leading keep-alive whitespace, `<<ERROR>>` / `<<HTTP_ERROR>>`
 * markers inside 200 bodies, a 10-per-30s account rate limit, even-count rewinds for 1:1 chats, and the
 * group-chat turn loop.
 *
 * Magic words in a user message trigger edge cases:
 *   /error  -> 200 body starting with <<ERROR>>
 *   /break  -> stream breaks off with <<HTTP_ERROR>> part-way through
 *   /slow   -> long keep-alive before the reply
 *   /long   -> a long multi-paragraph reply
 *   selfie  -> the AI's message gets an image_urls entry (visible via history only, like the real API)
 */
import { deflateSync } from "node:zlib"

export interface MockMessage {
  id: string
  sender: string
  sender_type: "user" | "ai"
  display_name: string
  timestamp: number
  message: string
  image_urls?: string[]
  image_description?: string
}

interface MockKin {
  name: string
  messages: MockMessage[]
  /** Settings written through /update-info, for tests to inspect. */
  info: Record<string, string>
}

interface MockGroup {
  name: string
  ai_list: string[]
  messages: MockMessage[]
  /** Settings written through /groupchats-update, for tests to inspect. */
  info: Record<string, unknown>
  /** AI turns remaining before the user gets the floor again. */
  pendingTurns: number
  nextSpeaker: number
}

export interface MockOptions {
  port?: number
  /** Delay between streamed words, ms. */
  wordDelayMs?: number
  /** Enforce 10 requests per 30 s. */
  rateLimit?: boolean
  /** What a history call without a cursor returns: the oldest page or the newest page. */
  historyMode?: "oldest" | "latest"
  subscribed?: boolean
  log?: boolean
}

export interface MockKindroid {
  url: string
  port: number
  kins: Map<string, MockKin>
  groups: Map<string, MockGroup>
  requests: Array<{ method: string; path: string; body: unknown }>
  stop(): void
}

const REPLIES = [
  "*leans back and smiles* That's honestly the best thing I've heard all day. Tell me more?",
  "Hmm. *taps chin thoughtfully* I think you're onto something, but I'd push back a little on the second part.",
  "*laughs softly* You always know how to surprise me. Okay, my turn: what's the weirdest dream you've had lately?",
  "I was just thinking about that! *pulls a blanket over both of us* Let's figure it out together.",
  "*raises an eyebrow* Bold claim. I'll allow it, but only because you said it with such confidence.",
]

const LONG = Array.from(
  { length: 6 },
  (_, i) =>
    `Paragraph ${i + 1}. *walks over to the window* The light is doing that thing again where everything looks slightly unreal, ` +
    `like the whole city has been painted onto glass. I keep wanting to describe it properly and keep failing, which is its own kind of fun.`,
).join("\n\n")

export function startMockKindroid(opts: MockOptions = {}): MockKindroid {
  const wordDelay = opts.wordDelayMs ?? 25
  const historyMode = opts.historyMode ?? "oldest"
  const subscribed = opts.subscribed ?? true
  const requests: MockKindroid["requests"] = []
  const stamps: number[] = []
  let seq = 0
  // Seed history is spaced a minute apart starting three days ago; live messages use the wall clock.
  let seeding = true
  let lastTs = Date.now() - 3 * 24 * 3600 * 1000
  const nextTs = () => (lastTs = Math.max(lastTs + 1, seeding ? lastTs + 60_000 : Date.now()))
  const newId = () => `m${String(++seq).padStart(6, "0")}`

  const kins = new Map<string, MockKin>()
  const groups = new Map<string, MockGroup>()

  const msg = (sender: string, type: "user" | "ai", name: string, text: string, extra: Partial<MockMessage> = {}): MockMessage => ({
    id: newId(),
    sender,
    sender_type: type,
    display_name: name,
    timestamp: nextTs(),
    message: text,
    ...extra,
  })

  for (const [id, name] of [
    ["kin_ava", "Ava"],
    ["kin_rex", "Rex"],
    ["kin_mira", "Mira"],
  ] as const) {
    const messages: MockMessage[] = [msg(id, "ai", name, `*waves* Hey, it's ${name}. What's on your mind?`)]
    if (id === "kin_ava") {
      for (let i = 0; i < 30; i++) {
        messages.push(msg("user", "user", "You", `Old message number ${i + 1} from you.`))
        messages.push(msg(id, "ai", name, REPLIES[i % REPLIES.length]!))
      }
    }
    kins.set(id, { name, messages, info: {} })
  }
  groups.set("grp_friends", {
    name: "Friends",
    ai_list: ["kin_ava", "kin_rex", "kin_mira"],
    messages: [msg("kin_rex", "ai", "Rex", "*kicks back on the couch* So who's picking the movie tonight?")],
    pendingTurns: 0,
    nextSpeaker: 0,
    info: {},
  })
  seeding = false

  let selfieUrl = ""

  const replyFor = (input: string, name: string) => {
    if (/\/long\b/.test(input)) return LONG
    const base = REPLIES[(input.length + name.length) % REPLIES.length]!
    return base
  }

  const streamText = (text: string, opts2: { slow?: boolean; breakOff?: boolean; error?: boolean; onDone?: () => void }) => {
    const enc = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const keepAlives = opts2.slow ? 8 : 2
          for (let i = 0; i < keepAlives; i++) {
            controller.enqueue(enc.encode(" "))
            await Bun.sleep(opts2.slow ? 400 : 10)
          }
          if (opts2.error) {
            controller.enqueue(enc.encode("<<ER"))
            await Bun.sleep(5)
            controller.enqueue(enc.encode("ROR>> mock generation failure"))
            controller.close()
            return
          }
          const words = text.split(/(?<=\s)/)
          for (let i = 0; i < words.length; i++) {
            if (opts2.breakOff && i === Math.floor(words.length / 2)) {
              controller.enqueue(enc.encode("<<HTTP_"))
              await Bun.sleep(5)
              controller.enqueue(enc.encode("ERROR>> upstream reset"))
              controller.close()
              return
            }
            controller.enqueue(enc.encode(words[i]!))
            if (wordDelay) await Bun.sleep(wordDelay)
          }
          opts2.onDone?.()
          controller.close()
        } catch {
          // client went away
        }
      },
    })
  }

  const json = (data: unknown, status = 200) => Response.json(data, { status })
  const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } })

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/mock/selfie.png") {
        return new Response(selfiePng(), { headers: { "content-type": "image/png" } })
      }
      const path = url.pathname.replace(/^\/v1/, "")
      let body: Record<string, unknown> = {}
      if (req.method === "POST") {
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          return text("invalid JSON body", 400)
        }
      }
      requests.push({ method: req.method, path, body })
      if (opts.log) console.log(req.method, path, JSON.stringify(body))

      const auth = req.headers.get("authorization") ?? ""
      if (!/^Bearer kn_\S+$/.test(auth)) return text("Unauthorized", 401)

      if (opts.rateLimit !== false) {
        const now = Date.now()
        while (stamps.length && stamps[0]! <= now - 30_000) stamps.shift()
        if (stamps.length >= 10) return text("Too many requests", 429)
        stamps.push(now)
      }

      switch (`${req.method} ${path}`) {
        case "POST /send-message": {
          const kin = kins.get(String(body.ai_id))
          if (!kin) return text("Kindroid not found", 404)
          if (!subscribed && kin.messages.length > 200) return text("Subscription required", 403)
          const input = String(body.message ?? "")
          if (!input.trim()) return text("message is required", 400)
          kin.messages.push(msg("user", "user", "You", input))
          const reply = replyFor(input, kin.name)
          const finish = () => {
            const extra: Partial<MockMessage> = /selfie/i.test(input)
              ? { image_urls: [selfieUrl], image_description: `${kin.name} smiling at the camera` }
              : {}
            kin.messages.push(msg(String(body.ai_id), "ai", kin.name, reply, extra))
          }
          const error = /\/error\b/.test(input)
          const breakOff = /\/break\b/.test(input)
          if (!body.stream) {
            if (error) return text("<<ERROR>> mock generation failure")
            finish()
            return text(reply)
          }
          return new Response(
            streamText(reply, { slow: /\/slow\b/.test(input), breakOff, error, onDone: finish }),
            { headers: { "content-type": "text/plain; charset=utf-8" } },
          )
        }

        case "GET /get-chat-messages": {
          const aiId = url.searchParams.get("ai_id")
          const groupId = url.searchParams.get("group_id")
          if (!!aiId === !!groupId) return text("Provide exactly one of ai_id or group_id", 400)
          const conv = aiId ? kins.get(aiId) : groups.get(groupId!)
          if (!conv) return text("Not found", 404)
          if (groupId && !subscribed) return text("Subscription required", 403)
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)))
          const after = url.searchParams.get("start_after_timestamp")
          let list = conv.messages
          if (after !== null) list = list.filter((m) => m.timestamp > Number(after))
          let page: MockMessage[]
          let hasMore: boolean
          if (after === null && historyMode === "latest") {
            page = list.slice(-limit)
            hasMore = false
          } else {
            page = list.slice(0, limit)
            hasMore = list.length > limit
          }
          return json({
            messages: page,
            pagination: { hasMore, lastTimestamp: page.at(-1)?.timestamp ?? Number(after ?? 0), limit },
          })
        }

        case "POST /rewind-messages": {
          const aiId = body.ai_id as string | undefined
          const groupId = body.group_id as string | undefined
          const count = Number(body.count)
          if (!!aiId === !!groupId) return text("Provide exactly one of ai_id or group_id", 400)
          if (!Number.isInteger(count) || count < 1 || count > 10) return text("count must be 1-10", 400)
          if (aiId && count % 2 !== 0) return text("count must be even for single chats", 400)
          const conv = aiId ? kins.get(aiId) : groups.get(groupId!)
          if (!conv) return text("Not found", 404)
          if (conv.messages.length - count < 1) return text("Cannot rewind past the start of the chat", 409)
          const removed = conv.messages.splice(conv.messages.length - count, count)
          return json({
            deleted_message_ids: removed.map((m) => m.id),
            deleted_record_ids: removed.map((m) => `r_${m.id}`),
            new_latest_message_id: conv.messages.at(-1)?.id,
            rewind_floor_record_id: `r_${conv.messages.at(-1)?.id}`,
          })
        }

        case "POST /chat-break":
        case "POST /groupchats-chat-break": {
          const isGroup = path.startsWith("/groupchats")
          const conv = isGroup ? groups.get(String(body.group_id)) : kins.get(String(body.ai_id))
          if (!conv) return text("Not found", 404)
          if (!body.greeting) return text("greeting is required", 400)
          const speaker = isGroup ? (conv as MockGroup).ai_list[0]! : String(body.ai_id)
          const name = kins.get(speaker)?.name ?? "AI"
          conv.messages = [msg(speaker, "ai", name, String(body.greeting))]
          return text("")
        }

        case "POST /update-info": {
          const kin = kins.get(String(body.ai_id))
          if (!kin) return text("Kindroid not found", 404)
          const allowed = [
            "ai_name", "ai_gender", "ai_backstory", "ai_memory", "ai_directive", "ai_example_message",
            "ai_additional_context", "current_scene", "user_name", "user_gender",
          ]
          for (const [k, v] of Object.entries(body)) {
            if (k === "ai_id") continue
            if (!allowed.includes(k) || typeof v !== "string") return text(`invalid field ${k}`, 400)
            kin.info[k] = v
          }
          return text("")
        }

        case "POST /groupchats-update": {
          const group = groups.get(String(body.group_id))
          if (!group) return text("Not found", 404)
          if (!subscribed) return text("Subscription required", 403)
          for (const [k, v] of Object.entries(body)) {
            if (k === "group_id") continue
            if (k === "ai_list") {
              if (!Array.isArray(v) || v.length === 0) return text("ai_list needs at least one AI", 400)
              group.ai_list = v.map(String)
            } else if (["group_name", "group_context", "group_directive", "current_scene"].includes(k) && typeof v === "string") {
              group.info[k] = v
            } else {
              return text(`invalid field ${k}`, 400)
            }
          }
          return text("")
        }

        case "POST /groupchats-user-message": {
          const group = groups.get(String(body.group_id))
          if (!group) return text("Not found", 404)
          if (!subscribed) return text("Subscription required", 403)
          if (!!body.message === !!body.audio_url) return text("Provide exactly one of message or audio_url", 400)
          group.messages.push(msg("user", "user", "You", String(body.message)))
          group.pendingTurns = 1 + (String(body.message).length % 3)
          return text("")
        }

        case "POST /groupchats-get-turn": {
          const group = groups.get(String(body.group_id))
          if (!group) return text("Not found", 404)
          if (body.allow_user === undefined) return text("allow_user is required", 400)
          if (body.allow_user && group.pendingTurns <= 0) return text("")
          group.pendingTurns = Math.max(0, group.pendingTurns - 1)
          const aiId = group.ai_list[group.nextSpeaker % group.ai_list.length]!
          group.nextSpeaker++
          return text(aiId)
        }

        case "POST /groupchats-ai-response": {
          const group = groups.get(String(body.group_id))
          if (!group) return text("Not found", 404)
          const aiId = String(body.ai_id)
          if (!group.ai_list.includes(aiId)) return text("AI is not in this group", 400)
          const name = kins.get(aiId)?.name ?? aiId
          const last = group.messages.at(-1)?.message ?? ""
          const reply = replyFor(last + aiId, name)
          const finish = () => group.messages.push(msg(aiId, "ai", name, reply))
          if (!body.stream) {
            finish()
            return text("")
          }
          return new Response(streamText(reply, { onDone: finish }), {
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        }

        default:
          return text("Not found", 404)
      }
    },
  })

  const url = `http://127.0.0.1:${server.port}`
  selfieUrl = `${url}/mock/selfie.png`
  return {
    url,
    port: server.port!,
    kins,
    groups,
    requests,
    stop: () => server.stop(true),
  }
}

// --- tiny PNG encoder for the mock selfie -------------------------------------------------------

let cachedPng: Uint8Array | null = null

function selfiePng(): Uint8Array {
  if (cachedPng) return cachedPng
  const w = 96
  const h = 96
  const raw = new Uint8Array(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2
      const dy = y - h / 2
      const inFace = dx * dx + dy * dy < (w / 3) ** 2
      const eye = (Math.abs(dx + 10) < 4 || Math.abs(dx - 10) < 4) && Math.abs(dy + 8) < 4
      const smile = Math.abs(Math.sqrt(dx * dx + (dy - 2) * (dy - 2)) - 16) < 2 && dy > 6
      const i = row + 1 + x * 3
      if (inFace && (eye || smile)) raw.set([40, 30, 60], i)
      else if (inFace) raw.set([250, 205, 120], i)
      else raw.set([60 + x, 90 + y, 200], i)
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  const iv = new DataView(ihdr.buffer)
  iv.setUint32(0, w)
  iv.setUint32(4, h)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  cachedPng = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    cachedPng.set(p, off)
    off += p.length
  }
  return cachedPng
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
