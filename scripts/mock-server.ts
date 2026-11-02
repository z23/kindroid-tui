#!/usr/bin/env bun
/**
 * Run the fake Kindroid API on 127.0.0.1:8787 for development.
 *
 *   bun run mock               # in one terminal
 *   bun run dev:mock           # in another (sets KINDROID_API_BASE and a dummy key)
 *
 * Env: MOCK_PORT, MOCK_HISTORY=oldest|latest, MOCK_RATE_LIMIT=0, MOCK_UNSUBSCRIBED=1, MOCK_WORD_DELAY_MS
 */
import { startMockKindroid } from "./mock-kindroid"

const mock = startMockKindroid({
  port: Number(process.env.MOCK_PORT ?? 8787),
  historyMode: process.env.MOCK_HISTORY === "latest" ? "latest" : "oldest",
  rateLimit: process.env.MOCK_RATE_LIMIT !== "0",
  subscribed: process.env.MOCK_UNSUBSCRIBED !== "1",
  wordDelayMs: Number(process.env.MOCK_WORD_DELAY_MS ?? 30),
  log: true,
})

console.log(`mock Kindroid API on ${mock.url}/v1`)
console.log("kins: kin_ava (Ava), kin_rex (Rex), kin_mira (Mira)   group: grp_friends (Friends)")
console.log("magic words: /error /break /slow /long selfie")
