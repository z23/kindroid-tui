import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface AppPaths {
  configFile: string
  configDir: string
  dataDir: string
  dbFile: string
}

/** XDG locations. KINDROID_TUI_CONFIG (file) and KINDROID_TUI_DATA (dir) override them for dev and tests. */
export function appPaths(env: Record<string, string | undefined> = process.env): AppPaths {
  const home = homedir()
  const configFile =
    env.KINDROID_TUI_CONFIG ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), "kindroid-tui", "config.toml")
  const dataDir = env.KINDROID_TUI_DATA ?? join(env.XDG_DATA_HOME || join(home, ".local", "share"), "kindroid-tui")
  return { configFile, configDir: dirname(configFile), dataDir, dbFile: join(dataDir, "history.db") }
}
