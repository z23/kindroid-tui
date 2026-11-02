import { describe, expect, test } from "bun:test"
import { DailyBudget, MemoryBudgetStore, RateLimiter, type Clock } from "../src/api/rateLimiter"

/** Deterministic clock: sleeps resolve when `advance` passes their deadline. */
class FakeClock implements Clock {
  t = 0
  private sleepers: Array<{ at: number; resolve: () => void; reject: (e: unknown) => void }> = []
  now() {
    return this.t
  }
  sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const s = { at: this.t + ms, resolve, reject }
      this.sleepers.push(s)
      signal?.addEventListener("abort", () => {
        this.sleepers = this.sleepers.filter((x) => x !== s)
        reject(new DOMException("aborted", "AbortError"))
      })
    })
  }
  async advance(ms: number) {
    const target = this.t + ms
    for (;;) {
      await flush()
      this.sleepers.sort((a, b) => a.at - b.at)
      const next = this.sleepers[0]
      if (!next || next.at > target) break
      this.t = next.at
      this.sleepers.shift()
      next.resolve()
    }
    this.t = target
    await flush()
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe("RateLimiter", () => {
  test("allows `limit` requests immediately, then queues", async () => {
    const clock = new FakeClock()
    const rl = new RateLimiter({ limit: 3, windowMs: 1000, clock })
    const done: number[] = []
    for (let i = 0; i < 5; i++) rl.acquire().then(() => done.push(i))
    await flush()
    expect(done).toEqual([0, 1, 2])
    expect(rl.waitMs()).toBe(1000)
    await clock.advance(999)
    expect(done).toEqual([0, 1, 2])
    await clock.advance(1)
    expect(done).toEqual([0, 1, 2, 3, 4])
  })

  test("is a sliding window", async () => {
    const clock = new FakeClock()
    const rl = new RateLimiter({ limit: 2, windowMs: 1000, clock })
    await rl.acquire()
    await clock.advance(600)
    await rl.acquire()
    let third = false
    rl.acquire().then(() => (third = true))
    await clock.advance(399)
    expect(third).toBe(false)
    await clock.advance(1)
    expect(third).toBe(true)
  })

  test("penalize pauses everything for a window", async () => {
    const clock = new FakeClock()
    const rl = new RateLimiter({ limit: 10, windowMs: 1000, clock })
    rl.penalize()
    let ok = false
    rl.acquire().then(() => (ok = true))
    await clock.advance(999)
    expect(ok).toBe(false)
    await clock.advance(1)
    expect(ok).toBe(true)
  })

  test("an aborted waiter does not block the queue", async () => {
    const clock = new FakeClock()
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, clock })
    await rl.acquire()
    const ac = new AbortController()
    const aborted = rl.acquire(ac.signal).catch((e) => e)
    let next = false
    rl.acquire().then(() => (next = true))
    ac.abort()
    expect(await aborted).toBeDefined()
    await clock.advance(1000)
    expect(next).toBe(true)
  })

  test("reports queued count", async () => {
    const clock = new FakeClock()
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, clock })
    rl.acquire()
    rl.acquire()
    rl.acquire()
    await flush()
    expect(rl.queued).toBe(2)
    await clock.advance(2000)
    expect(rl.queued).toBe(0)
  })
})

describe("DailyBudget", () => {
  test("counts down and recovers after the window", () => {
    const clock = new FakeClock()
    const budget = new DailyBudget(new MemoryBudgetStore(), { limit: 3, windowMs: 1000, clock })
    budget.spend()
    budget.spend()
    expect(budget.remaining()).toBe(1)
    expect(budget.canSpend(1)).toBe(false)
    expect(budget.canSpend(0)).toBe(true)
    clock.t = 1001
    expect(budget.remaining()).toBe(3)
  })
})
