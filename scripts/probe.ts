#!/usr/bin/env bun
/**
 * Probe the live Kindroid API to pin down behaviour the docs leave open. Read-only by default.
 *
 *   bun run probe -- --kin <ai_id> [--group <group_id>] [--send "test message"]
 *
 * Only metadata is printed (field names, sender types, timestamps, lengths); message text is never
 * printed or saved. `--send` posts a REAL message to the kin and should only be used on a test kin.
 * Uses KINDROID_API_KEY or the api_key from ~/.config/kindroid-tui/config.toml.
 */
import { parseArgs } from "node:util"
import { KindroidClient } from "../src/api/client"
import { describeError } from "../src/api/errors"
import type { ChatMessage, ConversationRef } from "../src/api/types"
import { loadConfig } from "../src/config"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    kin: { type: "string" },
    group: { type: "string" },
    send: { type: "string" },
  },
})

const config = loadConfig()
if (!config.apiKey) {
  console.error("No API key: set KINDROID_API_KEY or api_key in", config.path)
  process.exit(1)
}
const kinId = values.kin ?? config.kins[0]?.ai_id
if (!kinId) {
  console.error("Pass --kin <ai_id> or add a [[kin]] to", config.path)
  process.exit(1)
}

const baseUrl = process.env.KINDROID_API_BASE
const client = new KindroidClient({ apiKey: config.apiKey, baseUrl })
const findings: Record<string, unknown> = { probedAt: new Date().toISOString(), baseUrl: client.baseUrl }

const shape = (m: ChatMessage) => ({
  fields: Object.keys(m).sort(),
  sender: m.sender === kinId ? "<ai_id>" : m.sender.length > 12 ? `<${m.sender.length} chars>` : m.sender,
  sender_type: m.sender_type,
  display_name_present: !!m.display_name,
  timestamp: m.timestamp,
  messageLength: m.message.length,
  images: m.image_urls?.length ?? 0,
})

function unit(ts: number) {
  if (ts > 1e15) return "microseconds?"
  if (ts > 1e12) return "milliseconds"
  if (ts > 1e9) return "seconds"
  return "unknown"
}

async function probeHistory(ref: ConversationRef) {
  console.log(`\n== history for ${ref.kind} ==`)
  const latest1 = await client.getChatMessages(ref, { limit: 1 })
  const m0 = latest1.messages[0]
  console.log("no-cursor limit=1:", { count: latest1.messages.length, pagination: latest1.pagination, first: m0 && shape(m0) })
  if (!m0) return { empty: true }

  const after = await client.getChatMessages(ref, { limit: 1, startAfter: m0.timestamp })
  const newerExists = after.messages.length > 0
  const mode = newerExists ? "oldest (no cursor starts at the beginning)" : "latest (no cursor returns the newest)"
  console.log("start_after=<that ts> limit=1:", { count: after.messages.length, pagination: after.pagination })
  console.log("=> no-cursor semantics:", mode)

  const page = await client.getChatMessages(ref, { limit: 10 })
  const senderTypes = [...new Set(page.messages.map((m) => m.sender_type))]
  const tsAgeHours = (Date.now() - (unit(m0.timestamp) === "seconds" ? m0.timestamp * 1000 : m0.timestamp)) / 3.6e6
  console.log("sender_type values:", senderTypes, "| timestamp unit:", unit(m0.timestamp), `| first msg age ≈ ${tsAgeHours.toFixed(1)} h`)
  console.log("sample shapes:", page.messages.slice(0, 4).map(shape))
  return {
    noCursor: newerExists ? "oldest" : "latest",
    timestampUnit: unit(m0.timestamp),
    senderTypes,
    shapes: page.messages.map(shape),
    pagination: page.pagination,
  }
}

async function probeSend(aiId: string, message: string) {
  console.log("\n== streamed send-message (REAL message) ==")
  const base = (baseUrl ?? "https://api.kindroid.ai/v1").replace(/\/+$/, "")
  const started = performance.now()
  const res = await fetch(`${base}/send-message`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ai_id: aiId, message, stream: true }),
  })
  const headers = Object.fromEntries(
    [...res.headers].filter(([k]) => /content-type|transfer-encoding|content-length|cache|connection|x-/i.test(k)),
  )
  console.log("status", res.status, headers)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const chunks: Array<{ atMs: number; bytes: number; whitespaceOnly: boolean }> = []
  let text = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    const s = decoder.decode(value, { stream: true })
    text += s
    chunks.push({ atMs: Math.round(performance.now() - started), bytes: value.length, whitespaceOnly: !s.trim() })
  }
  const leadingWs = text.length - text.trimStart().length
  const summary = {
    status: res.status,
    headers,
    chunkCount: chunks.length,
    firstChunks: chunks.slice(0, 6),
    lastChunk: chunks.at(-1),
    leadingWhitespace: leadingWs,
    startsWithMarker: /^\s*<<(HTTP_)?ERROR>>/.test(text),
    tail: JSON.stringify(text.slice(-12).replace(/[^\s<>_A-Z]/g, "·")),
    totalChars: text.length,
  }
  console.log(summary)
  return summary
}

try {
  findings.kin = await probeHistory({ kind: "kin", id: kinId })
  if (values.group) findings.group = await probeHistory({ kind: "group", id: values.group })
  if (values.send) findings.send = await probeSend(kinId, values.send)
  findings.dailyBudgetRemaining = client.budget.remaining()
} catch (err) {
  console.error("probe failed:", describeError(err))
  findings.error = describeError(err)
}

const out = `docs/fixtures/raw/probe-${Date.now()}.json`
await Bun.write(out, JSON.stringify(findings, null, 2))
console.log(`\nsaved anonymised findings to ${out}`)
