import { KindroidError } from "./errors"

export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new KindroidError("aborted"))
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, Math.max(0, ms))
      const onAbort = () => {
        clearTimeout(timer)
        reject(new KindroidError("aborted"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    }),
}

export interface RateLimiterOptions {
  /** Requests allowed per window. Kindroid: 10 per 30 s per account. */
  limit?: number
  windowMs?: number
  clock?: Clock
}

/**
 * Account-wide sliding-window limiter. Requests queue (FIFO) instead of failing, so a burst such as a
 * group-chat round simply waits. `waitMs()` reports how long the next request would wait.
 */
export class RateLimiter {
  readonly limit: number
  readonly windowMs: number
  private readonly clock: Clock
  private stamps: number[] = []
  private pausedUntil = 0
  private tail: Promise<void> = Promise.resolve()
  private waiting = 0
  private listeners = new Set<() => void>()

  constructor(opts: RateLimiterOptions = {}) {
    this.limit = opts.limit ?? 10
    this.windowMs = opts.windowMs ?? 30_000
    this.clock = opts.clock ?? realClock
  }

  /** Wait for a slot. Rejects with an `aborted` error if `signal` fires first. */
  acquire(signal?: AbortSignal): Promise<void> {
    this.waiting++
    this.emit()
    const slot = this.tail.then(() => this.take(signal))
    this.tail = slot.catch(() => {})
    return slot.finally(() => {
      this.waiting--
      this.emit()
    })
  }

  /** Called after a 429: stop issuing requests for a full window. */
  penalize(ms = this.windowMs): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms)
    this.emit()
  }

  /** Milliseconds until a new request could be sent right now. */
  waitMs(): number {
    const now = this.clock.now()
    this.prune(now)
    const pause = Math.max(0, this.pausedUntil - now)
    const full = this.stamps.length >= this.limit ? this.stamps[0]! + this.windowMs - now : 0
    return Math.max(pause, full, 0)
  }

  /** Number of requests queued behind the limiter. */
  get queued(): number {
    return this.waiting
  }

  /** Slots still free in the current window. */
  available(): number {
    this.prune(this.clock.now())
    return Math.max(0, this.limit - this.stamps.length)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new KindroidError("aborted")
      const wait = this.waitMs()
      if (wait <= 0) {
        this.stamps.push(this.clock.now())
        this.emit()
        return
      }
      this.emit()
      await this.clock.sleep(wait, signal)
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    while (this.stamps.length > 0 && this.stamps[0]! <= cutoff) this.stamps.shift()
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}

export interface BudgetStore {
  /** Timestamps (ms) of spends inside the last window. */
  load(sinceMs: number): number[]
  record(ts: number): void
  prune(beforeMs: number): void
}

export class MemoryBudgetStore implements BudgetStore {
  private stamps: number[] = []
  load(sinceMs: number) {
    return this.stamps.filter((t) => t > sinceMs)
  }
  record(ts: number) {
    this.stamps.push(ts)
  }
  prune(beforeMs: number) {
    this.stamps = this.stamps.filter((t) => t > beforeMs)
  }
}

/**
 * Rolling daily budget for /get-chat-messages (600 per 24 h). Persisted so restarts don't reset it.
 * Background syncs check `canSpend(reserve)` and skip themselves when the budget runs low; manual
 * actions only need one remaining call.
 */
export class DailyBudget {
  readonly limit: number
  readonly windowMs: number
  private readonly store: BudgetStore
  private readonly clock: Clock
  private listeners = new Set<() => void>()

  constructor(store: BudgetStore, opts: { limit?: number; windowMs?: number; clock?: Clock } = {}) {
    this.store = store
    this.limit = opts.limit ?? 600
    this.windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000
    this.clock = opts.clock ?? realClock
  }

  remaining(): number {
    const since = this.clock.now() - this.windowMs
    return Math.max(0, this.limit - this.store.load(since).length)
  }

  canSpend(reserve = 0): boolean {
    return this.remaining() > reserve
  }

  spend(): void {
    const now = this.clock.now()
    this.store.prune(now - this.windowMs)
    this.store.record(now)
    for (const l of this.listeners) l()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
