import { parseArgs } from "node:util"
import { DailyBudget, RateLimiter } from "../api/rateLimiter"
import { ensureConfigFile, loadConfig } from "../config"
import { appPaths } from "../paths"
import { HistoryCache } from "../store/cache"
import { Server } from "./server"

/**
 * `kindroid-tui serve`: run the JSON-lines helper on stdin/stdout until stdin closes.
 * Nothing chat-related goes to stderr, so a shell log never holds message text.
 */
export async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { config: { type: "string", short: "c" } } })
  const paths = appPaths()
  const configPath = values.config ?? paths.configFile
  ensureConfigFile(configPath)

  const cache = new HistoryCache(paths.dbFile)
  const server = new Server({
    loadConfig: () => loadConfig({ path: configPath }),
    cache,
    limiter: new RateLimiter(),
    budget: new DailyBudget(cache.budgetStore()),
    write: (line) => {
      process.stdout.write(line + "\n")
    },
  })

  let exiting = false
  const exit = (code: number) => {
    if (exiting) return
    exiting = true
    server.shutdown()
    try {
      cache.close()
    } catch {
      // already closed
    }
    process.exit(code)
  }
  process.on("SIGTERM", () => exit(0))
  process.on("SIGINT", () => exit(0))
  process.stdout.on("error", () => exit(0))

  server.start()

  const decoder = new TextDecoder()
  let buf = ""
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true })
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) void server.handle(line)
    }
  }
  // stdin closed: the shell (or whoever started us) is gone.
  exit(0)
}
