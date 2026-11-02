import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { DailyBudget, RateLimiter } from "../api/rateLimiter"
import type { Conversation, ConversationState } from "../store/conversation"

const EMPTY: ConversationState = {
  messages: [],
  draft: null,
  activity: { kind: "idle" },
  error: null,
  notice: null,
  canLoadOlder: false,
  lastSyncedAt: null,
}

/** Mirror a Conversation's state into a Solid signal. Unchanged arrays and messages keep their identity. */
export function useConversationState(conv: Accessor<Conversation | undefined>): Accessor<ConversationState> {
  const [state, setState] = createSignal<ConversationState>(EMPTY, { equals: false })
  createEffect(() => {
    const c = conv()
    if (!c) {
      setState(EMPTY)
      return
    }
    setState(c.state)
    const off = c.subscribe((s) => setState(s))
    onCleanup(off)
  })
  return state
}

export interface LimitStatus {
  limit: number
  waitMs: number
  queued: number
  available: number
  historyLeft: number
}

/** Rate-limit and daily-budget status, refreshed on change and every second while something waits. */
export function useLimitStatus(limiter: RateLimiter, budget: DailyBudget): Accessor<LimitStatus> {
  const read = (): LimitStatus => ({
    limit: limiter.limit,
    waitMs: limiter.waitMs(),
    queued: limiter.queued,
    available: limiter.available(),
    historyLeft: budget.remaining(),
  })
  const [status, setStatus] = createSignal(read())
  const update = () => setStatus(read())
  const offA = limiter.onChange(update)
  const offB = budget.onChange(update)
  const timer = setInterval(() => {
    if (limiter.queued > 0 || limiter.available() < limiter.limit) update()
  }, 1000)
  onCleanup(() => {
    offA()
    offB()
    clearInterval(timer)
  })
  return status
}
