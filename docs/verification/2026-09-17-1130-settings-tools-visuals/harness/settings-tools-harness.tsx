// #1130 — Settings「工具」节六态视觉 harness(真组件挂载,零生产代码改动;与已批
// 2026-08-12-583-584-586 harness 同一模式)。
//
// 挂载现役生产组件 AlphaSettings(整页 overlay,含左侧类别导航)与现役生产 CSS(组件自身 import
// 原样加载),`api.toolPolicy` 是按状态给定的夹具(wire 形状与引擎 schema 同形,手写字面量),
// 其余 settings / extensionStorage 通道给最小成功桩。只在 loopback Vite 构建 + Chrome
// --headless=new 下截图;不启动 Electron、不用任何账号/API key。
// 用法:?state=default|rebind|quarantine|savefail|loading|loadfail&theme=light|dark&width=narrow|wide
/* @jsxImportSource solid-js */
import { render } from "solid-js/web"
import { AlphaSettings } from "../../../../packages/ui-mac/src/renderer/alpha-ui/settings"
import type { SettingsSurfaceApi } from "../../../../packages/ui-mac/src/renderer/alpha-ui/settings-authority-client"
import type {
  ToolPolicyInventoryV1,
  ToolPolicyWriteResult,
} from "../../../../packages/ui-mac/src/shared/tool-policy-wire"
import { ALPHA_SETTINGS_DEFAULTS } from "../../../../packages/ui-mac/src/shared/settings-adapters"
import { setLocale } from "../../../../packages/ui-mac/src/renderer/i18n"

setLocale("zh")

const params = new URLSearchParams(location.search)
const state = params.get("state") ?? "default"
const theme = params.get("theme") === "dark" ? "dark" : "light"

document.documentElement.dataset.colorScheme = theme
document.documentElement.style.colorScheme = theme
document.body.style.margin = "0"

const DIGEST_A = `sha256:${"3f21".padEnd(64, "9ce4")}`
const DIGEST_B = `sha256:${"b07a".padEnd(64, "52d1")}`
const DIRECTORY = "/Users/kai/app/kama-bot-local"

type Tool = ToolPolicyInventoryV1["services"][number]["tools"][number]
type Service = ToolPolicyInventoryV1["services"][number]

const tool = (
  partial: Partial<Tool> & { canonical: string; name: string; source: Tool["identity"]["source"]; origin: string },
): Tool => {
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

const builtinTool = (name: string, extra: Partial<Tool> = {}) =>
  tool({
    canonical: `builtin::${name}`,
    name,
    source: "builtin",
    origin: "",
    effective: { state: "enabled", action: "allow", reason: { kind: "default", class: "builtin" } },
    ...extra,
  })

function defaultInventory(): ToolPolicyInventoryV1 {
  const cloudAuthority = { kind: "alpha-cloud", bindingId: "cloud-1", evidenceDigest: DIGEST_A } as const
  const services: Service[] = [
    {
      source: "builtin",
      origin: "",
      class: "builtin",
      authority: { kind: "not-asserted" },
      bindingDigest: DIGEST_A,
      tools: [
        builtinTool("read"),
        builtinTool("bash", {
          effective: { state: "ask", action: "ask", reason: { kind: "user", level: "tool" } },
          record: { selector: { level: "tool", canonical: "builtin::bash" }, state: "ask" },
        }),
        builtinTool("edit"),
        builtinTool("glob"),
        builtinTool("grep"),
        builtinTool("list"),
        builtinTool("write"),
        builtinTool("webfetch"),
        builtinTool("todowrite"),
        builtinTool("task"),
        builtinTool("skill"),
      ],
    },
    {
      source: "host",
      origin: "",
      class: "builtin",
      authority: { kind: "not-asserted" },
      bindingDigest: DIGEST_A,
      tools: [
        tool({
          canonical: "host::read_mcp_resource",
          name: "read_mcp_resource",
          source: "host",
          origin: "",
          effective: { state: "enabled", action: "allow", reason: { kind: "default", class: "builtin" } },
        }),
      ],
    },
    {
      source: "mcp",
      origin: "alpha-cloud",
      class: "alpha-cloud",
      authority: cloudAuthority,
      bindingDigest: DIGEST_A,
      tools: [
        tool({
          canonical: "mcp:alpha-cloud:websearch",
          name: "websearch",
          source: "mcp",
          origin: "alpha-cloud",
          authority: cloudAuthority,
          billing: { class: "按用量计费", evidenceId: "ev-1" },
          effective: { state: "ask", action: "ask", reason: { kind: "default", class: "alpha-cloud" } },
        }),
        tool({
          canonical: "mcp:alpha-cloud:docgen",
          name: "docgen",
          source: "mcp",
          origin: "alpha-cloud",
          authority: cloudAuthority,
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
        ...["search", "list-versions", "get-changelog", "compare"].map((name) =>
          tool({ canonical: `mcp:context7:${name}`, name, source: "mcp", origin: "context7", bindingDigest: DIGEST_B }),
        ),
      ],
    },
    {
      source: "mcp",
      origin: "fetcher",
      class: "third-party-mcp",
      authority: { kind: "not-asserted" },
      bindingDigest: DIGEST_A,
      tools: [
        tool({ canonical: "mcp:fetcher:fetch", name: "fetch", source: "mcp", origin: "fetcher" }),
        tool({ canonical: "mcp:fetcher:crawl", name: "crawl", source: "mcp", origin: "fetcher" }),
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
          canonical: "plugin:team-scripts:release-check",
          name: "release-check",
          source: "plugin",
          origin: "team-scripts",
          effective: { state: "ask", action: "ask", reason: { kind: "default", class: "plugin" } },
        }),
        tool({
          canonical: "plugin:team-scripts:deploy",
          name: "deploy",
          source: "plugin",
          origin: "team-scripts",
          effective: { state: "disabled", action: "deny", reason: { kind: "cap-managed" } },
        }),
        tool({
          canonical: "plugin:team-scripts:lint",
          name: "lint",
          source: "plugin",
          origin: "team-scripts",
          effective: { state: "ask", action: "ask", reason: { kind: "default", class: "plugin" } },
        }),
      ],
    },
  ]
  return {
    version: 1,
    partition: { account: "anonymous", workspace: "prj_kama" },
    user: { status: "ok" },
    managed: { status: "ok" },
    classRecords: [],
    services,
    invalid: { count: 1, entries: [{ technicalId: "context7_legacy", detail: "MCP tool is missing its source identity" }] },
  }
}

function rebindInventory(): ToolPolicyInventoryV1 {
  const inv = defaultInventory()
  const service = inv.services.find((item) => item.origin === "context7")!
  service.bindingDigest = DIGEST_B
  service.record = { selector: { level: "service", source: "mcp", origin: "context7" }, state: "enabled", bindingDigest: DIGEST_A }
  for (const item of service.tools) {
    item.effective = { state: "ask", action: "ask", reason: { kind: "binding-changed", level: "service" } }
    item.newlyDiscovered = false
  }
  const docs = service.tools.find((item) => item.identity.name === "get-library-docs")!
  docs.effective = { state: "ask", action: "ask", reason: { kind: "binding-changed", level: "tool" } }
  docs.record = { selector: { level: "tool", canonical: docs.canonical }, state: "enabled", bindingDigest: DIGEST_A }
  inv.invalid = { count: 0, entries: [] }
  return inv
}

function quarantineInventory(): ToolPolicyInventoryV1 {
  const inv = defaultInventory()
  inv.user = { status: "quarantined", reason: "unexpected token at line 3" }
  for (const service of inv.services)
    for (const item of service.tools)
      item.effective = { state: "disabled", action: "deny", reason: { kind: "quarantine", detail: "unexpected token" } }
  inv.invalid = { count: 0, entries: [] }
  return inv
}

const ok = async (): Promise<ToolPolicyWriteResult> => ({ ok: true })
const never = () => new Promise<never>(() => undefined)

function toolPolicyFor(key: string): SettingsSurfaceApi["toolPolicy"] {
  const inventory =
    key === "rebind" ? rebindInventory : key === "quarantine" ? quarantineInventory : defaultInventory
  return {
    inventory:
      key === "loading"
        ? never
        : key === "loadfail"
          ? async () => ({ ok: false, code: "request-failed" }) as const
          : async () => ({ ok: true, inventory: inventory() }) as const,
    setRecord: key === "savefail" ? async () => ({ ok: false, code: "write-failed" }) as const : ok,
    removeRecord: ok,
    reset: async () => ({ ok: true, backup: "/tmp/policy.json.quarantined-1" }) as const,
  }
}

const api: SettingsSurfaceApi = {
  settings: {
    read: async () => ({ ok: true, value: structuredClone(ALPHA_SETTINGS_DEFAULTS), revision: "s1:harness" }),
    validate: async () => ({ ok: true }),
    write: async (input) => ({ ok: true, changed: true, value: input.value, revision: "s1:harness" }),
  },
  extensionStorage: {
    snapshot: async () => ({ state: "not-run", result: null }),
    inspect: async () => ({ code: "ok", blobsTotal: 0, sweepableCount: 0, sweptCount: 0, keptByGrace: 0, warningCount: 0 }),
    collect: async () => ({ code: "ok", blobsTotal: 0, sweepableCount: 0, sweptCount: 0, keptByGrace: 0, warningCount: 0 }),
  },
  toolPolicy: toolPolicyFor(state),
}

document.body.style.background = "var(--a-bg-canvas)"
render(() => <AlphaSettings open={true} onClose={() => undefined} api={api} directory={() => DIRECTORY} />, document.body)

setTimeout(() => {
  document.querySelector<HTMLElement>("[data-settings-section='tools']")?.click()
  setTimeout(() => {
    if (state === "savefail") {
      // 保存失败态:对 context7 下 resolve-library-id 点「询问」⇒ 夹具拒写 ⇒ 行内 alert + 重试。
      document
        .querySelector<HTMLButtonElement>("[data-tools-row='mcp:context7:resolve-library-id'] [data-tools-radio='ask']")
        ?.click()
    }
    if (state === "default") {
      // 与帧一致:服务层「启用」先弹确认条(抓取服务 = fetcher,默认折叠)。
      document
        .querySelector<HTMLButtonElement>("[data-tools-service='mcp:fetcher'] [data-tools-radio='enabled']")
        ?.click()
    }
    setTimeout(() => {
      document.documentElement.dataset.visualReady = "true"
    }, 160)
  }, 160)
}, 160)
