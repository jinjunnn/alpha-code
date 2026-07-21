import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { createComponent, createSignal } from "solid-js"
import type { render } from "solid-js/web"
import type { AlphaSettings } from "./settings"
import type { SettingsSurfaceApi } from "./settings-authority-client"
import { ALPHA_SETTINGS_DEFAULTS, type AlphaSettings as AlphaSettingsValue } from "../../shared/settings-adapters"

type TestRuntime = {
  createComponent: typeof createComponent
  createSignal: typeof createSignal
  render: typeof render
  AlphaSettings: typeof AlphaSettings
}

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-settings-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "settings-test-runtime.ts"),
      formats: ["es"],
      fileName: () => "settings-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(pathToFileURL(join(runtimeDirectory, "settings-test-runtime.js")).href)) as TestRuntime

beforeEach(() => {
  document.body.replaceChildren()
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
})

afterEach(async () => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  await flush()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function value(): AlphaSettingsValue {
  return structuredClone(ALPHA_SETTINGS_DEFAULTS)
}

function api(
  overrides: {
    read?: SettingsSurfaceApi["settings"]["read"]
    validate?: SettingsSurfaceApi["settings"]["validate"]
    write?: SettingsSurfaceApi["settings"]["write"]
    snapshot?: SettingsSurfaceApi["extensionStorage"]["snapshot"]
    inspect?: SettingsSurfaceApi["extensionStorage"]["inspect"]
    collect?: SettingsSurfaceApi["extensionStorage"]["collect"]
  } = {},
) {
  return {
    settings: {
      read: overrides.read ?? mock(async () => ({ ok: true, value: value(), revision: "s1:initial" }) as const),
      validate: overrides.validate ?? mock(async () => ({ ok: true }) as const),
      write:
        overrides.write ??
        mock(
          async (input) =>
            ({ ok: true, changed: true, value: structuredClone(input.value), revision: "s1:saved" }) as const,
        ),
    },
    extensionStorage: {
      snapshot: overrides.snapshot ?? mock(async () => ({ state: "not-run", result: null }) as const),
      inspect:
        overrides.inspect ??
        mock(
          async () =>
            ({ code: "ok", blobsTotal: 0, sweepableCount: 0, sweptCount: 0, keptByGrace: 0, warningCount: 0 }) as const,
        ),
      collect:
        overrides.collect ??
        mock(
          async () =>
            ({ code: "ok", blobsTotal: 0, sweepableCount: 0, sweptCount: 0, keptByGrace: 0, warningCount: 0 }) as const,
        ),
    },
  } satisfies SettingsSurfaceApi
}

function mount(surfaceApi: SettingsSurfaceApi) {
  const [open, setOpen] = runtime.createSignal(true)
  const host = document.createElement("div")
  document.getElementById("root")!.append(host)
  const onClose = mock(() => setOpen(false))
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.AlphaSettings, {
          get open() {
            return open()
          },
          onClose,
          api: surfaceApi,
        }),
      host,
    ),
  )
  return { open, setOpen, onClose }
}

function input(selector: string, next: string) {
  const element = document.querySelector<HTMLInputElement>(selector)!
  element.value = next
  element.dispatchEvent(new Event("input", { bubbles: true }))
  return element
}

function click(selector: string) {
  document.querySelector<HTMLElement>(selector)!.click()
}

describe("Alpha Settings real Solid render", () => {
  test("fails closed on read failure and recovers by reading authority again", async () => {
    const read = mock()
    read.mockImplementationOnce(async () => ({ ok: false, code: "read-failed" }) as const)
    read.mockImplementationOnce(async () => ({ ok: true, value: value(), revision: "s1:recovered" }) as const)
    const surfaceApi = api({ read: read as SettingsSurfaceApi["settings"]["read"] })
    mount(surfaceApi)
    await flush()

    expect(document.body.textContent).toContain("无法读取设置")
    expect(document.querySelector("[data-setting='font-size']")).toBeNull()
    click(".a-banner-action")
    await flush()

    expect(read).toHaveBeenCalledTimes(2)
    expect(document.querySelector("[data-setting='font-size']")).not.toBeNull()
  })

  test("reads authority, validates before save, blocks invalid input, then saves a corrected draft", async () => {
    const validate = mock(async (candidate: unknown) => {
      const fontSize = (candidate as AlphaSettingsValue).appearance.fontSize
      return fontSize >= 8 && fontSize <= 72 ? ({ ok: true } as const) : ({ ok: false, code: "invalid-input" } as const)
    })
    const write = mock(
      async (payload: { value: AlphaSettingsValue; expectedRevision: string }) =>
        ({
          ok: true,
          changed: true,
          value: structuredClone(payload.value),
          revision: "s1:corrected",
        }) as const,
    )
    const surfaceApi = api({ validate, write })
    mount(surfaceApi)
    await flush()

    expect(surfaceApi.settings.read).toHaveBeenCalledTimes(1)
    input("[data-setting='font-size']", "100")
    click("[data-settings-save]")
    await flush()
    expect(validate).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("设置值没有通过校验")

    input("[data-setting='font-size']", "16")
    click("[data-settings-save]")
    await flush()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0].expectedRevision).toBe("s1:initial")
    expect(write.mock.calls[0]![0].value.appearance.fontSize).toBe(16)
    expect(document.body.textContent).toContain("设置已保存")
  })

  test("keeps a failed draft, adopts returned authority revision, and recovers on retry", async () => {
    const current = value()
    const write = mock()
    write.mockImplementationOnce(
      async () =>
        ({
          ok: false,
          code: "revision-conflict",
          authoritative: { value: current, revision: "s1:new-authority" },
        }) as const,
    )
    write.mockImplementationOnce(
      async (payload: { value: AlphaSettingsValue }) =>
        ({
          ok: true,
          changed: true,
          value: structuredClone(payload.value),
          revision: "s1:retry-saved",
        }) as const,
    )
    const surfaceApi = api({ write: write as SettingsSurfaceApi["settings"]["write"] })
    mount(surfaceApi)
    await flush()

    const toggle = document.querySelector<HTMLInputElement>("input[type='checkbox']")!
    toggle.click()
    click("[data-settings-save]")
    await flush()
    expect(toggle.checked).toBe(false)
    expect(document.body.textContent).toContain("草稿仍保留")
    expect(document.body.textContent).toContain("有更改未保存")

    click(".a-banner-action")
    await flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]![0].expectedRevision).toBe("s1:new-authority")
    expect(document.body.textContent).toContain("设置已保存")
  })

  test("renders all five aggregate counts and drives inspect then manual collection", async () => {
    const inspect = mock(
      async () =>
        ({
          code: "ok",
          blobsTotal: 12,
          sweepableCount: 4,
          sweptCount: 0,
          keptByGrace: 3,
          warningCount: 2,
        }) as const,
    )
    const collect = mock(
      async () =>
        ({
          code: "ok",
          blobsTotal: 8,
          sweepableCount: 0,
          sweptCount: 4,
          keptByGrace: 3,
          warningCount: 1,
        }) as const,
    )
    mount(api({ inspect, collect }))
    await flush()
    click("[data-settings-section='storage']")
    click("[data-storage-inspect]")
    await flush()

    expect(inspect).toHaveBeenCalledTimes(1)
    expect(document.querySelector("[data-storage-field='blobsTotal']")?.textContent).toContain("12")
    expect(document.querySelector("[data-storage-field='sweepableCount']")?.textContent).toContain("4")
    expect(document.querySelector("[data-storage-field='sweptCount']")?.textContent).toContain("0")
    expect(document.querySelector("[data-storage-field='keptByGrace']")?.textContent).toContain("3")
    expect(document.querySelector("[data-storage-field='warningCount']")?.textContent).toContain("2")
    expect(document.querySelector("[data-storage-code='ok']")?.textContent).toContain("ok")

    click("[data-storage-collect]")
    await flush()
    expect(collect).toHaveBeenCalledTimes(1)
    expect(document.querySelector("[data-storage-field='sweptCount']")?.textContent).toContain("4")
  })

  test("never renders report details outside the aggregate whitelist", async () => {
    const result = {
      code: "fail-closed",
      blobsTotal: 9,
      sweepableCount: 0,
      sweptCount: 0,
      keptByGrace: 2,
      warningCount: 1,
      digest: "sha256-secret-digest",
      path: "/Users/private/extensions/blob",
      warnings: ["private warning detail"],
      bytes: 42_000_000,
      finishedAt: "2026-07-21T12:00:00Z",
    }
    mount(
      api({
        snapshot: async () =>
          ({ state: "ready", result }) as Awaited<ReturnType<SettingsSurfaceApi["extensionStorage"]["snapshot"]>>,
      }),
    )
    await flush()
    click("[data-settings-section='storage']")
    await flush()

    expect(document.body.textContent).toContain("fail-closed")
    expect(document.body.textContent).not.toContain(result.digest)
    expect(document.body.textContent).not.toContain(result.path)
    expect(document.body.textContent).not.toContain(result.warnings[0]!)
    expect(document.body.textContent).not.toContain("42 MB")
    expect(document.body.textContent).not.toContain(result.finishedAt)
  })

  test("recovers a worker failure through a fresh typed inspect", async () => {
    const inspect = mock(
      async () =>
        ({
          code: "ok",
          blobsTotal: 3,
          sweepableCount: 1,
          sweptCount: 0,
          keptByGrace: 1,
          warningCount: 0,
        }) as const,
    )
    mount(
      api({
        snapshot: async () =>
          ({
            state: "ready",
            result: {
              code: "worker-failed",
              blobsTotal: 0,
              sweepableCount: 0,
              sweptCount: 0,
              keptByGrace: 0,
              warningCount: 0,
            },
          }) as const,
        inspect,
      }),
    )
    await flush()
    click("[data-settings-section='storage']")
    expect(document.querySelector("[data-storage-code='worker-failed']")).not.toBeNull()

    click("[data-storage-inspect]")
    await flush()
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(document.querySelector("[data-storage-code='ok']")).not.toBeNull()
  })

  test("closes on Escape and restores the calling focus", async () => {
    const trigger = document.createElement("button")
    trigger.textContent = "Settings trigger"
    document.body.append(trigger)
    trigger.focus()
    const mounted = mount(api())
    await flush()

    document
      .querySelector("[data-alpha-settings]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    await flush()
    expect(mounted.onClose).toHaveBeenCalledTimes(1)
    expect(document.querySelector("[data-alpha-settings]")).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  test("keeps the surface open when Escape belongs to an IME composition", async () => {
    const mounted = mount(api())
    await flush()
    document
      .querySelector("[data-alpha-settings]")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }),
      )
    await flush()
    expect(mounted.onClose).not.toHaveBeenCalled()
    expect(document.querySelector("[data-alpha-settings]")).not.toBeNull()
  })

  test("keeps keyboard focus within the full-page surface", async () => {
    mount(api())
    await flush()
    const surface = document.querySelector<HTMLElement>("[data-alpha-settings]")!
    const focusable = Array.from(surface.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"))
    focusable[0]!.focus()
    focusable[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(focusable.at(-1))
  })
})
