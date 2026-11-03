import { createCliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider, useBindings } from "@opentui/keymap/solid"
import { render } from "@opentui/solid"
import { createMemo, createSignal, Show, type Accessor } from "solid-js"
import { parseArgs } from "node:util"
import { KindroidClient } from "./api/client"
import { DailyBudget, RateLimiter } from "./api/rateLimiter"
import { ensureConfigFile, loadConfig, type Config } from "./config"
import { appPaths } from "./paths"
import { HistoryCache } from "./store/cache"
import { App } from "./ui/App"
import { theme } from "./ui/theme"
import { VERSION } from "./version"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    config: { type: "string", short: "c" },
  },
})

if (values.help) {
  console.log(`kindroid-tui ${VERSION} — a terminal client for Kindroid

Usage: kindroid-tui [--config <path>]
       kindroid-tui serve [--config <path>]   headless helper for the Omarchy plugin (JSON lines on stdio)

Environment:
  KINDROID_API_KEY     your kn_ API key (overrides config.toml)
  KINDROID_API_BASE    API base URL (default https://api.kindroid.ai/v1)
  KINDROID_TUI_CONFIG  config file path (default ~/.config/kindroid-tui/config.toml)
  KINDROID_TUI_DATA    data dir for the history cache (default ~/.local/share/kindroid-tui)

Press F1 inside the app for keys.`)
  process.exit(0)
}
if (values.version) {
  console.log(VERSION)
  process.exit(0)
}

const paths = appPaths()
const configPath = values.config ?? paths.configFile
ensureConfigFile(configPath)
const reloadConfig = () => loadConfig({ path: configPath })

const cache = new HistoryCache(paths.dbFile)
const limiter = new RateLimiter()
const budget = new DailyBudget(cache.budgetStore())

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  targetFps: 60,
  onDestroy: () => cache.close(),
})
const keymap = createDefaultOpenTuiKeymap(renderer)

const quit = () => {
  renderer.destroy()
  process.exit(0)
}

function Setup(props: { config: Config; onReload: () => void }) {
  useBindings(() => ({
    commands: [
      { name: "setup.reload", run: props.onReload },
      { name: "setup.quit", run: quit },
    ],
    bindings: [
      { key: "r", cmd: "setup.reload" },
      { key: "q", cmd: "setup.quit" },
      { key: "ctrl+c", cmd: "setup.quit" },
    ],
  }))
  return (
    <box width="100%" height="100%" justifyContent="center" alignItems="center">
      <box
        border
        borderStyle="rounded"
        borderColor={theme.borderFocus}
        title=" kindroid-tui · setup "
        titleColor={theme.accent}
        width={74}
        maxWidth="95%"
        flexDirection="column"
        padding={1}
        gap={1}
      >
        <text fg={theme.text} wrapMode="word">
          No Kindroid API key found. Get yours in the Kindroid app under Profile → Preferences → API &amp; Integrations, then either:
        </text>
        <text fg={theme.accent} wrapMode="word">
          {`  export KINDROID_API_KEY=kn_…   and restart, or\n  add  api_key = "kn_…"  to ${props.config.path}`}
        </text>
        <text fg={theme.muted} wrapMode="word">
          The config file was created with permissions 0600 so only you can read it. Treat the key like a password: anyone with it can act on your account.
        </text>
        <Show when={props.config.warnings.length > 0}>
          <text fg={theme.warn} wrapMode="word">
            {props.config.warnings.join("\n")}
          </text>
        </Show>
        <text fg={theme.muted}>r: reload config · q: quit</text>
      </box>
    </box>
  )
}

function Root() {
  const [config, setConfig] = createSignal(reloadConfig())
  const client = createMemo(() => {
    const c = config()
    if (!c.apiKey) return null
    return new KindroidClient({ apiKey: c.apiKey, baseUrl: c.baseUrl, limiter, budget })
  })
  return (
    <Show when={client()} fallback={<Setup config={config()} onReload={() => setConfig(reloadConfig())} />}>
      {(c: Accessor<KindroidClient>) => <App config={config()} client={c()} cache={cache} reloadConfig={reloadConfig} onQuit={quit} />}
    </Show>
  )
}

await render(
  () => (
    <KeymapProvider keymap={keymap}>
      <Root />
    </KeymapProvider>
  ),
  renderer,
)

const startupWarnings = reloadConfig().warnings
if (startupWarnings.length) for (const w of startupWarnings) console.warn(w)
