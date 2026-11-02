#!/usr/bin/env bun
/**
 * Build a standalone executable: dist/kindroid-tui (Bun runtime, OpenTUI native library and the Solid
 * transform all embedded). Defaults to the host platform; pass --target bun-linux-x64-musl etc. to cross-build.
 */
import solidPlugin from "@opentui/solid/bun-plugin"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { target: { type: "string" }, outfile: { type: "string" } },
})

const target = values.target as Bun.Build.CompileTarget | undefined
const libc = target?.includes("musl") ? "musl" : process.platform === "linux" ? "glibc" : undefined
const outfile = values.outfile ?? `dist/kindroid-tui${target ? `-${target.replace(/^bun-/, "")}` : ""}`

const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  target: "bun",
  plugins: [solidPlugin],
  minify: true,
  sourcemap: "linked",
  // Embed only the native library for one libc instead of both.
  define: libc ? { "process.env.OPENTUI_LIBC": JSON.stringify(libc) } : {},
  compile: {
    outfile,
    ...(target ? { target } : {}),
    // A compiled binary must not pick up bunfig.toml / .env / tsconfig / package.json from whatever
    // directory it runs in: the dev preload would break it, and a stray .env could change its behaviour.
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`built ${outfile}`)
