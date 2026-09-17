// REQ-131 / #1130 —— Settings「工具」节的行为闸(真 Solid 渲染,happy-dom;同 settings.test.ts 的
// vite 运行时构建模式)。判据来自已批设计稿 docs/design/2026-08-25-req131-settings-tool-policy §3/§4:
//   · 四来源分组、服务展开到工具、每行「生效:状态 · 原因」用 9 型 reason 逐型文案;
//   · 收紧畅通(询问/停用一点即存,不带 digest)、放宽有闸(class/service 启用先弹确认;service/tool
//     启用写入必须携带 inventory 给出的当前 bindingDigest,class 层必须不带);
//   · 三态控件 = 用户 override(无记录 = 无选中),徽标 = resolver 终值,二者可不一致;
//   · 写失败回退到权威值 + role=alert + 重试;quarantine 整节横幅 + 全部只读 + reset;
//   · 读取失败 fail-closed 文案;没有项目目录时不向引擎发请求。
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
import { ALPHA_SETTINGS_DEFAULTS } from "../../shared/settings-adapters"
import type {
  ToolPolicyInventoryV1,
  ToolPolicyRecord,
  ToolPolicySelector,
  ToolPolicyWriteResult,
} from "../../shared/tool-policy-wire"
import { dict as zh } from "../i18n/zh"

type TestRuntime = {
  createComponent: typeof createComponent
  createSignal: typeof createSignal
  render: typeof render
  AlphaSettings: typeof AlphaSettings
}

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-settings-tools-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  resolve: { alias: { "@": join(import.meta.dir, "../../../../app/src") } },
  worker: { format: "es" },
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "settings-test-runtime.tsx"),
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

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

// ── 夹具:手写的 wire 形状(不从 schema 导出期望)──────────────────────────────
const DIGEST_A = `sha256:${"a".repeat(64)}`
const DIGEST_B = `sha256:${"b".repeat(64)}`
const DIRECTORY = "/Users/kai/app/kama-bot-local"

type Tool = ToolPolicyInventoryV1["services"][number]["tools"][number]
type Service = ToolPolicyInventoryV1["services"][number]

function tool(partial: Partial<Tool> & { canonical: string; name: string; source: Tool["identity"]["source"]; origin: string }): Tool {
  const { name, source, origin, ...rest } = partial
  return {
    identity: { source, origin, name },
    technicalId: name,
    authority: { kind: "not-asserted" },
    bindingDigest: DIGEST_A,
    effective: { state: "ask", action: "ask", reason: { kind: "default", class: "third-party-mcp" } },
    newlyDiscovered: false,
    ...rest,
  }
}

function inventory(overrides: Partial<ToolPolicyInventoryV1> = {}): ToolPolicyInventoryV1 {
  const services: Service[] = [
    {
      source: "builtin",
      origin: "",
      class: "builtin",
      authority: { kind: "not-asserted" },
      bindingDigest: DIGEST_A,
      tools: [
        tool({
          canonical: "builtin::read",
          name: "read",
          source: "builtin",
          origin: "",
          effective: { state: "enabled", action: "allow", reason: { kind: "default", class: "builtin" } },
        }),
        tool({
          canonical: "builtin::bash",
          name: "bash",
          source: "builtin",
          origin: "",
          effective: { state: "ask", action: "ask", reason: { kind: "user", level: "tool" } },
          record: { selector: { level: "tool", canonical: "builtin::bash" }, state: "ask" },
        }),
      ],
    },
    {
      source: "mcp",
      origin: "alpha-cloud",
      class: "alpha-cloud",
      authority: { kind: "alpha-cloud", bindingId: "cloud-1", evidenceDigest: DIGEST_A },
      bindingDigest: DIGEST_A,
      tools: [
        tool({
          canonical: "mcp:alpha-cloud:websearch",
          name: "websearch",
          source: "mcp",
          origin: "alpha-cloud",
          authority: { kind: "alpha-cloud", bindingId: "cloud-1", evidenceDigest: DIGEST_A },
          billing: { class: "metered", evidenceId: "ev-1" },
          effective: { state: "ask", action: "ask", reason: { kind: "default", class: "alpha-cloud" } },
        }),
        tool({
          canonical: "mcp:alpha-cloud:docgen",
          name: "docgen",
          source: "mcp",
          origin: "alpha-cloud",
          authority: { kind: "alpha-cloud", bindingId: "cloud-1", evidenceDigest: DIGEST_A },
          effective: { state: "disabled", action: "deny", reason: { kind: "cap-entitlement", verdict: "missing" } },
        }),
      ],
    },
    {
      source: "mcp",
      origin: "context7",
      class: "third-party-mcp",
      authority: { kind: "not-asserted" },
      bindingDigest: DIGEST_B,
      tools: [
        tool({
          canonical: "mcp:context7:resolve-library-id",
          name: "resolve-library-id",
          source: "mcp",
          origin: "context7",
          bindingDigest: DIGEST_B,
          newlyDiscovered: true,
        }),
        tool({
          canonical: "mcp:context7:get-library-docs",
          name: "get-library-docs",
          source: "mcp",
          origin: "context7",
          bindingDigest: DIGEST_B,
          effective: { state: "enabled", action: "allow", reason: { kind: "user", level: "tool" } },
          record: {
            selector: { level: "tool", canonical: "mcp:context7:get-library-docs" },
            state: "enabled",
            bindingDigest: DIGEST_B,
          },
        }),
      ],
    },
    {
      source: "plugin",
      origin: "team-scripts",
      class: "plugin",
      authority: { kind: "not-asserted" },
      bindingDigest: DIGEST_A,
      tools: [
        tool({
          canonical: "plugin:team-scripts:deploy",
          name: "deploy",
          source: "plugin",
          origin: "team-scripts",
          effective: { state: "disabled", action: "deny", reason: { kind: "cap-managed" } },
        }),
      ],
    },
  ]
  return {
    version: 1,
    partition: { account: "anonymous", workspace: "prj_1" },
    user: { status: "ok" },
    managed: { status: "ok" },
    classRecords: [],
    services,
    invalid: { count: 0, entries: [] },
    ...overrides,
  }
}

function api(overrides: Partial<SettingsSurfaceApi["toolPolicy"]> = {}, inv: ToolPolicyInventoryV1 = inventory()) {
  const toolPolicy = {
    inventory: overrides.inventory ?? mock(async () => ({ ok: true, inventory: structuredClone(inv) }) as const),
    setRecord: overrides.setRecord ?? mock(async (): Promise<ToolPolicyWriteResult> => ({ ok: true })),
    removeRecord: overrides.removeRecord ?? mock(async (): Promise<ToolPolicyWriteResult> => ({ ok: true })),
    reset: overrides.reset ?? mock(async () => ({ ok: true, backup: "/x/policy.json.quarantined-1" }) as const),
  }
  return {
    settings: {
      read: mock(async () => ({ ok: true, value: structuredClone(ALPHA_SETTINGS_DEFAULTS), revision: "s1:initial" }) as const),
      validate: mock(async () => ({ ok: true }) as const),
      write: mock(async (input: { value: typeof ALPHA_SETTINGS_DEFAULTS }) => ({ ok: true, changed: true, value: input.value, revision: "s1:saved" }) as const),
    },
    extensionStorage: {
      snapshot: mock(async () => ({ state: "not-run", result: null }) as const),
      inspect: mock(async () => ({ code: "ok", blobsTotal: 0, sweepableCount: 0, sweptCount: 0, keptByGrace: 0, warningCount: 0 }) as const),
      collect: mock(async () => ({ code: "ok", blobsTotal: 0, sweepableCount: 0, sweptCount: 0, keptByGrace: 0, warningCount: 0 }) as const),
    },
    toolPolicy,
  } satisfies SettingsSurfaceApi
}

function mount(surfaceApi: SettingsSurfaceApi, directory: string | null = DIRECTORY) {
  const host = document.createElement("div")
  document.getElementById("root")!.append(host)
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.AlphaSettings, {
          open: true,
          onClose: () => undefined,
          api: surfaceApi,
          directory: () => directory ?? undefined,
        }),
      host,
    ),
  )
}

async function openTools(surfaceApi: SettingsSurfaceApi, directory: string | null = DIRECTORY) {
  mount(surfaceApi, directory)
  await flush()
  document.querySelector<HTMLElement>("[data-settings-section='tools']")!.click()
  await flush()
  await flush()
}

const q = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector)
const row = (canonical: string) => q(`[data-tools-row="${canonical}"]`)!
const radio = (scope: Element, state: "enabled" | "ask" | "disabled") =>
  scope.querySelector<HTMLButtonElement>(`[data-tools-radio="${state}"]`)!
const text = (element: Element | null | undefined) => element?.textContent ?? ""
const zhFill = (key: keyof typeof zh, params: Record<string, string | number>) =>
  Object.entries(params).reduce((value, [name, param]) => value.replaceAll(`{{${name}}}`, String(param)), zh[key])

describe("Alpha Settings 「工具」节", () => {
  test("T1 lists four source groups from the live inventory with effective state and reason copy per row", async () => {
    const surfaceApi = api()
    await openTools(surfaceApi)

    expect(surfaceApi.toolPolicy.inventory).toHaveBeenCalledWith({ directory: DIRECTORY })
    expect(q("[data-tools-state='ready']")).not.toBeNull()
    for (const cls of ["builtin", "alpha-cloud", "third-party-mcp", "plugin"]) {
      expect(q(`[data-tools-class='${cls}']`)).not.toBeNull()
    }
    // 本地工具:默认 enabled 的原因文案;用户 tool 层 ask 的行 radiogroup 选中「询问」+ ↺。
    expect(text(row("builtin::read"))).toContain(
      zhFill("alpha.settings.toolsEffective", {
        state: zh["alpha.settings.toolsEffectiveEnabled"],
        reason: zh["alpha.settings.toolsReasonDefaultBuiltin"],
      }),
    )
    expect(radio(row("builtin::read"), "enabled").getAttribute("aria-checked")).toBe("false")
    expect(radio(row("builtin::bash"), "ask").getAttribute("aria-checked")).toBe("true")
    expect(row("builtin::bash").querySelector("[data-tools-clear]")).not.toBeNull()
    expect(row("builtin::read").querySelector("[data-tools-clear]")).toBeNull()
    // Alpha Cloud:已核验徽标、计费徽标、套餐锁定行不可点。
    expect(text(q("[data-tools-class='alpha-cloud']"))).toContain(zh["alpha.settings.toolsVerified"])
    expect(text(row("mcp:alpha-cloud:websearch"))).toContain(zhFill("alpha.settings.toolsBilling", { value: "metered" }))
    expect(text(row("mcp:alpha-cloud:docgen"))).toContain(zh["alpha.settings.toolsReasonEntitlement"])
    expect(radio(row("mcp:alpha-cloud:docgen"), "disabled").disabled).toBe(true)
    expect(row("mcp:alpha-cloud:docgen").querySelector("[role='radiogroup']")?.getAttribute("aria-disabled")).toBe("true")
    // 第三方 MCP:服务行可展开,新发现徽标,tool 层 enabled 记录选中「启用」。
    const service = q("[data-tools-service='mcp:context7']")!
    expect(service.querySelector("[data-tools-expand]")?.getAttribute("aria-expanded")).toBe("true")
    expect(text(row("mcp:context7:resolve-library-id"))).toContain(zh["alpha.settings.toolsNew"])
    expect(radio(row("mcp:context7:get-library-docs"), "enabled").getAttribute("aria-checked")).toBe("true")
    // 插件:管理策略锁定。
    expect(text(row("plugin:team-scripts:deploy"))).toContain(zh["alpha.settings.toolsReasonManaged"])
    // 精确 canonical 只在开发者详情里。
    expect(q("details[data-tools-dev]")).not.toBeNull()
    expect(text(q("details[data-tools-dev]"))).toContain("builtin::read")
    // 脚注:会话内 once/always 不改这里。
    expect(text(q("[data-alpha-settings]"))).toContain(zh["alpha.settings.toolsFooter"])
  })

  test("T2 tightening writes immediately without a digest, then re-reads the inventory", async () => {
    const calls: ToolPolicyRecord[] = []
    let current = inventory()
    const surfaceApi = api({
      inventory: mock(async () => ({ ok: true, inventory: structuredClone(current) }) as const),
      setRecord: mock(async (input: { directory: string; record: ToolPolicyRecord }) => {
        calls.push(input.record)
        current = inventory()
        const read = current.services[0]!.tools[0]!
        read.effective = { state: "disabled", action: "deny", reason: { kind: "user", level: "tool" } }
        read.record = { selector: { level: "tool", canonical: "builtin::read" }, state: "disabled" }
        return { ok: true } as const
      }),
    })
    await openTools(surfaceApi)

    radio(row("builtin::read"), "disabled").click()
    await flush(8)

    expect(calls).toEqual([{ selector: { level: "tool", canonical: "builtin::read" }, state: "disabled" }])
    expect(surfaceApi.toolPolicy.setRecord).toHaveBeenCalledWith({
      directory: DIRECTORY,
      record: { selector: { level: "tool", canonical: "builtin::read" }, state: "disabled" },
    })
    expect(surfaceApi.toolPolicy.inventory).toHaveBeenCalledTimes(2)
    expect(radio(row("builtin::read"), "disabled").getAttribute("aria-checked")).toBe("true")
    expect(text(row("builtin::read"))).toContain(zh["alpha.settings.toolsEffectiveDisabled"])
    expect(text(q("[data-tools-live]"))).toContain(zh["alpha.settings.toolsSaved"])
  })

  test("T3 broad enable is gated: service-level Enable asks first, then writes with the service's current digest", async () => {
    const surfaceApi = api()
    await openTools(surfaceApi)

    const service = q("[data-tools-service='mcp:context7']")!
    radio(service, "enabled").click()
    await flush()
    expect(surfaceApi.toolPolicy.setRecord).not.toHaveBeenCalled()
    const confirm = q("[role='alertdialog'][data-tools-confirm]")!
    expect(text(confirm)).toContain(zh["alpha.settings.toolsConfirmServiceTitle"])

    confirm.querySelector<HTMLButtonElement>("[data-tools-cancel]")!.click()
    await flush()
    expect(q("[data-tools-confirm]")).toBeNull()
    expect(surfaceApi.toolPolicy.setRecord).not.toHaveBeenCalled()

    radio(service, "enabled").click()
    await flush()
    q("[data-tools-confirm] [data-tools-confirm-accept]")!.click()
    await flush(8)
    expect(surfaceApi.toolPolicy.setRecord).toHaveBeenCalledWith({
      directory: DIRECTORY,
      record: { selector: { level: "service", source: "mcp", origin: "context7" }, state: "enabled", bindingDigest: DIGEST_B },
    })
  })

  test("T4 class-level Enable asks first and writes WITHOUT a digest; tool-level Enable writes at once WITH the tool's digest", async () => {
    const surfaceApi = api()
    await openTools(surfaceApi)

    const group = q("[data-tools-class='third-party-mcp']")!
    group.querySelector<HTMLButtonElement>("[data-tools-class-radio='enabled']")!.click()
    await flush()
    expect(text(q("[data-tools-confirm]"))).toContain(zh["alpha.settings.toolsConfirmClassTitle"])
    q("[data-tools-confirm] [data-tools-confirm-accept]")!.click()
    await flush(8)
    expect(surfaceApi.toolPolicy.setRecord).toHaveBeenCalledWith({
      directory: DIRECTORY,
      record: { selector: { level: "class", class: "third-party-mcp" }, state: "enabled" },
    })

    radio(row("mcp:context7:resolve-library-id"), "enabled").click()
    await flush(8)
    expect(q("[data-tools-confirm]")).toBeNull()
    expect(surfaceApi.toolPolicy.setRecord).toHaveBeenLastCalledWith({
      directory: DIRECTORY,
      record: {
        selector: { level: "tool", canonical: "mcp:context7:resolve-library-id" },
        state: "enabled",
        bindingDigest: DIGEST_B,
      },
    })
  })

  test("T5 a failed write keeps the authoritative control, raises a row alert, and retries the same record", async () => {
    const setRecord = mock()
    setRecord.mockImplementationOnce(async () => ({ ok: false, code: "write-failed" }) as const)
    setRecord.mockImplementation(async () => ({ ok: true }) as const)
    const surfaceApi = api({ setRecord: setRecord as SettingsSurfaceApi["toolPolicy"]["setRecord"] })
    await openTools(surfaceApi)

    radio(row("builtin::read"), "ask").click()
    await flush(8)
    expect(setRecord).toHaveBeenCalledTimes(1)
    // 权威值:inventory 没变 ⇒ 控件仍无选中,徽标仍是启用。
    expect(radio(row("builtin::read"), "ask").getAttribute("aria-checked")).toBe("false")
    const alert = row("builtin::read").parentElement!.querySelector("[role='alert'][data-tools-row-alert]")!
    expect(text(alert)).toContain(zh["alpha.settings.toolsSaveFailed"])
    expect(document.activeElement).toBe(alert)

    alert.querySelector<HTMLButtonElement>("[data-tools-retry]")!.click()
    await flush(8)
    expect(setRecord).toHaveBeenCalledTimes(2)
    expect(setRecord.mock.calls[1]![0]).toEqual(setRecord.mock.calls[0]![0])
    expect(q("[data-tools-row-alert]")).toBeNull()
  })

  test("T6 quarantine: section alert takes focus, every control is read-only, reset backs up then re-reads", async () => {
    let current = inventory({ user: { status: "quarantined", reason: "bad json" } })
    for (const service of current.services)
      for (const item of service.tools)
        item.effective = { state: "disabled", action: "deny", reason: { kind: "quarantine", detail: "bad json" } }
    const surfaceApi = api({
      inventory: mock(async () => ({ ok: true, inventory: structuredClone(current) }) as const),
      reset: mock(async () => {
        current = inventory()
        return { ok: true, backup: "/x/policy.json.quarantined-1" } as const
      }),
    })
    await openTools(surfaceApi)

    const banner = q("[data-tools-banner='quarantine']")!
    expect(banner.getAttribute("role")).toBe("alert")
    expect(text(banner)).toContain(zh["alpha.settings.toolsQuarantineTitle"])
    expect(text(banner)).toContain(zh["alpha.settings.toolsResetNote"])
    expect(document.activeElement).toBe(banner)
    expect(text(row("builtin::read"))).toContain(zh["alpha.settings.toolsReasonQuarantine"])
    const radios = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tools-radio], [data-tools-class-radio]"))
    expect(radios.length).toBeGreaterThan(0)
    expect(radios.every((button) => button.disabled)).toBe(true)

    banner.querySelector<HTMLButtonElement>("[data-tools-reset]")!.click()
    await flush(8)
    expect(surfaceApi.toolPolicy.reset).toHaveBeenCalledWith({ directory: DIRECTORY })
    expect(surfaceApi.toolPolicy.inventory).toHaveBeenCalledTimes(2)
    expect(q("[data-tools-banner='quarantine']")).toBeNull()
    expect(radio(row("builtin::read"), "ask").disabled).toBe(false)
  })

  test("T7 read failure is fail-closed copy with retry; no project directory never calls the engine", async () => {
    const inventoryMock = mock()
    inventoryMock.mockImplementationOnce(async () => ({ ok: false, code: "request-failed" }) as const)
    inventoryMock.mockImplementation(async () => ({ ok: true, inventory: inventory() }) as const)
    const surfaceApi = api({ inventory: inventoryMock as SettingsSurfaceApi["toolPolicy"]["inventory"] })
    await openTools(surfaceApi)

    expect(q("[data-tools-state='failed']")).not.toBeNull()
    expect(text(q("[data-alpha-settings]"))).toContain(zh["alpha.settings.toolsLoadFailedDetail"])
    expect(q("[data-tools-row]")).toBeNull()
    q("[data-tools-state='failed'] [data-tools-retry]")!.click()
    await flush(8)
    expect(inventoryMock).toHaveBeenCalledTimes(2)
    expect(q("[data-tools-state='ready']")).not.toBeNull()

    document.body.replaceChildren()
    const root = document.createElement("div")
    root.id = "root"
    document.body.append(root)
    const noProject = api()
    await openTools(noProject, null)
    expect(noProject.toolPolicy.inventory).not.toHaveBeenCalled()
    expect(q("[data-tools-state='no-project']")).not.toBeNull()
    expect(text(q("[data-alpha-settings]"))).toContain(zh["alpha.settings.toolsNoProject"])
  })

  test("T8 binding change: the row offers Enable again (rewrites enabled with the CURRENT digest) and Restore inherited", async () => {
    const inv = inventory()
    const docs = inv.services[2]!.tools[1]!
    docs.effective = { state: "ask", action: "ask", reason: { kind: "binding-changed", level: "tool" } }
    docs.bindingDigest = DIGEST_A
    docs.record = { selector: { level: "tool", canonical: docs.canonical }, state: "enabled", bindingDigest: DIGEST_B }
    const surfaceApi = api({}, inv)
    await openTools(surfaceApi)

    const target = row("mcp:context7:get-library-docs")
    expect(text(target)).toContain(zh["alpha.settings.toolsReasonBindingChanged"])
    expect(target.querySelector("[role='radiogroup']")).toBeNull()
    target.querySelector<HTMLButtonElement>("[data-tools-reenable]")!.click()
    await flush(8)
    expect(surfaceApi.toolPolicy.setRecord).toHaveBeenCalledWith({
      directory: DIRECTORY,
      record: { selector: { level: "tool", canonical: "mcp:context7:get-library-docs" }, state: "enabled", bindingDigest: DIGEST_A },
    })

    // 写成功 ⇒ 重读 inventory ⇒ 行重新渲染,旧节点已脱离文档;按权威值重新取行。
    row("mcp:context7:get-library-docs").querySelector<HTMLButtonElement>("[data-tools-clear]")!.click()
    await flush(8)
    const selector: ToolPolicySelector = { level: "tool", canonical: "mcp:context7:get-library-docs" }
    expect(surfaceApi.toolPolicy.removeRecord).toHaveBeenCalledWith({ directory: DIRECTORY, selector })
  })

  test("T9 keyboard: the radiogroup follows the shared roving contract (Tab lands once; arrows move AND activate; modifiers pass through)", async () => {
    const surfaceApi = api()
    await openTools(surfaceApi)
    const target = row("builtin::read")
    // 无记录 ⇒ 组内 Tab 落点是第一个可选项,且整组只有一个落点。
    expect(Array.from(target.querySelectorAll("[data-tools-radio][tabindex='0']")).length).toBe(1)
    expect(radio(target, "enabled").tabIndex).toBe(0)
    // 有记录 ⇒ 落点在选中项。
    expect(radio(row("builtin::bash"), "ask").tabIndex).toBe(0)
    expect(radio(row("builtin::bash"), "enabled").tabIndex).toBe(-1)

    const first = radio(target, "enabled")
    first.focus()
    // 带修饰键的方向键归系统 / 读屏(VoiceOver 光标),组不吞。
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, bubbles: true, cancelable: true }))
    expect(surfaceApi.toolPolicy.setRecord).not.toHaveBeenCalled()
    // 无修饰的 → = 移动即激活(APG Radio Group):焦点到「询问」,并走同一条收紧即存路径。
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(radio(target, "ask"))
    await flush(8)
    expect(surfaceApi.toolPolicy.setRecord).toHaveBeenCalledWith({
      directory: DIRECTORY,
      record: { selector: { level: "tool", canonical: "builtin::read" }, state: "ask" },
    })
    expect(text(q(".alpha-settings-section-head h2"))).toContain(zh["alpha.settings.tools"])
  })
})
