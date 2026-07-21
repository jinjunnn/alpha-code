import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { createComponent } from "solid-js"
import type { render } from "solid-js/web"
import type { UpstreamDialogHarness } from "./upstream-dialog-test-runtime"

type Runtime = {
  createComponent: typeof createComponent
  render: typeof render
  UpstreamDialogHarness: typeof UpstreamDialogHarness
}

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-upstream-dialog-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "upstream-dialog-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

let runtime: Runtime

beforeAll(async () => {
  GlobalRegistrator.register()
  runtime = (await import(pathToFileURL(join(runtimeDirectory, "runtime.js")).href)) as Runtime
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

describe("selected upstream Dialog consumers", () => {
  test("render through exactly one real Alpha Dialog mount", async () => {
    const root = document.createElement("div")
    document.body.replaceChildren(root)
    const dispose = runtime.render(() => runtime.createComponent(runtime.UpstreamDialogHarness, {}), root)
    document.querySelector<HTMLButtonElement>("[data-test-open-dialog]")?.click()
    await Promise.resolve()
    await Promise.resolve()

    expect(document.querySelectorAll("[role='dialog']")).toHaveLength(1)
    expect(document.querySelector(".a-dialog-root")).not.toBeNull()
    expect(document.querySelector("[data-component='dialog']")).toBeNull()
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("Delete session")
    dispose()
  })
})
