#!/usr/bin/env bun
// Entry point. `kindroid-tui serve` runs the headless JSON-lines helper used by the Omarchy plugin;
// anything else starts the terminal UI. The UI is imported lazily so the helper never loads OpenTUI.
if (Bun.argv[2] === "serve") {
  const { main } = await import("./serve/main")
  await main(Bun.argv.slice(3))
} else {
  await import("./tui")
}
