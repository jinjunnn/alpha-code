import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import { DEFAULT_BUILTIN_POLICY } from "../../main/alpha-builtin-policy"
import type { createComponent } from "solid-js"
import type { render } from "solid-js/web"
import type { BuiltinControlsPanel } from "./builtin-controls-panel"

const directory = mkdtempSync(join(tmpdir(), "alpha-builtin-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!, {
    name: "builtin-test-entry",
    resolveId: (id) => id.endsWith("builtin-test-entry") ? "\0builtin-test-entry" : undefined,
    load: (id) => id === "\0builtin-test-entry" ? `
      export { createComponent } from "solid-js";
      export { render } from "solid-js/web";
      export { BuiltinControlsPanel } from ${JSON.stringify(join(import.meta.dir, "builtin-controls-panel.tsx"))};
    ` : undefined,
  }],
  build: {
    outDir: directory,
    lib: { entry: "builtin-test-entry", formats: ["es"], fileName: () => "runtime.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
GlobalRegistrator.register()
const runtime = await import(pathToFileURL(join(directory, "runtime.js")).href) as {
  createComponent: typeof createComponent
  render: typeof render
  BuiltinControlsPanel: typeof BuiltinControlsPanel
}
afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(directory, { recursive: true, force: true })
})

test.each([{ allowFactory: [] }, { allowFactory: ["customize-opencode"] }])("#1522 AC1:内置面板不显示弃用技能或开关(旧 allowFactory=%j)", async (input) => {
  // IPC 返回形状来自 ext-ipc.ts builtinRead;治理值沿用生产默认值,覆盖旧解禁记录。
  Object.defineProperty(window, "api", { configurable: true, value: { ext: {
    builtinRead: async () => ({
      gov: { ...structuredClone(DEFAULT_BUILTIN_POLICY), skills: { deny: [], allowFactory: input.allowFactory } },
      protection: { hard: [], alphaInjected: [], confirm: [] },
      factoryDenied: ["customize-opencode"],
    }),
  } } })
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = runtime.render(() => runtime.createComponent(runtime.BuiltinControlsPanel, {
    agents: [{ name: "build", mode: "primary", native: true }],
    requestReload: async () => true,
    reloadAgents: async () => {},
    flash: () => {},
  }), host)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const rows = [...host.querySelectorAll(".alpha-ext-man")]
  expect(host.querySelector(".alpha-ext-import-err")).toBeNull()
  expect(host.textContent).not.toContain("customize-opencode")
  expect(rows).toHaveLength(3)
  expect(rows.map((row) => row.querySelector(".alpha-ext-man-name")?.textContent)).toEqual([
    expect.stringContaining("build"), expect.stringContaining("/init"), expect.stringContaining("/review"),
  ])
  dispose()
  host.remove()
})
