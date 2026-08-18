// REQ-136 wiring contract:the one verified catalog MCP exit may carry the route's project D;
// skill/agent/plugin/cloud/bundle/package remain global-only. Main remains the admission authority.
// Hook mounting depends on the engine client + Solid browser runtime, so this file locks the
// production call graph while use-extensions-ipc.test.ts exercises the pure target/state helpers.
import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const here = import.meta.dir

/** 提取每个 `installCatalog(` 调用的实参文本(括号配平;跳过注释里的提及)。 */
function installCatalogCallArgs(source: string): string[] {
  const out: string[] = []
  const needle = "installCatalog("
  let idx = source.indexOf(needle)
  while (idx !== -1) {
    const lineStart = source.lastIndexOf("\n", idx) + 1
    const linePrefix = source.slice(lineStart, idx).trimStart()
    if (!linePrefix.startsWith("//") && !linePrefix.startsWith("*") && !linePrefix.startsWith("/*")) {
      let depth = 1
      let i = idx + needle.length
      while (i < source.length && depth > 0) {
        if (source[i] === "(") depth++
        else if (source[i] === ")") depth--
        i++
      }
      out.push(source.slice(idx + needle.length, i - 1))
    }
    idx = source.indexOf(needle, idx + needle.length)
  }
  return out
}

const read = (rel: string) => readFileSync(join(here, rel), "utf8")
const functionSlice = (source: string, name: string, nextName: string) =>
  source.slice(source.indexOf(`async function ${name}(`), source.indexOf(`async function ${nextName}(`))

describe("REQ-136 wiring: only catalog MCP may submit Current project", () => {
  test("use-extensions.ts keeps one scoped MCP exit and five literal-global non-MCP exits", () => {
    const source = read("use-extensions.ts")
    const calls = installCatalogCallArgs(source)
    expect(calls).toHaveLength(6)

    const mcpCalls = installCatalogCallArgs(functionSlice(source, "addMcp", "liveAddAndConnect"))
    expect(mcpCalls).toHaveLength(1)
    expect(mcpCalls[0]).toContain("scope: target.target")

    const globalOnly = [
      ["installSkill", "installPlugin"],
      ["installPlugin", "installAgentEntry"],
      ["installAgentEntry", "installCatalogIntent"],
      ["installCatalogIntent", "importSkillFolder"],
      ["enableCloud", "updateEntry"],
    ] as const
    for (const [name, nextName] of globalOnly) {
      const exit = installCatalogCallArgs(functionSlice(source, name, nextName))
      expect(exit).toHaveLength(1)
      expect(exit[0]).toContain(`scope: { scope: "global" }`)
      expect(exit[0]).not.toContain(`"project"`)
    }
  })

  test("extension-hub.tsx:一个 installCatalog 调用都不许有(`#810` 收口)", () => {
    // 呈现层不得自己出站。这条从「三个调用点都得写对 scope」收紧成「一个都不许有」——
    // 直连回来一个,引擎重扫就对它默认放行,而那是静默的。
    expect(installCatalogCallArgs(read("extension-hub.tsx"))).toHaveLength(0)
  })

  test("整个 renderer 树无其它 installCatalog 调用文件(新入口必须显式登记)", () => {
    const rendererRoot = resolve(here, "..")
    const withCalls: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else if (
          (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) &&
          !e.name.endsWith(".test.ts") &&
          !e.name.endsWith(".test.tsx") &&
          installCatalogCallArgs(readFileSync(abs, "utf8")).length > 0
        )
          withCalls.push(relative(rendererRoot, abs))
      }
    }
    walk(rendererRoot)
    expect(withCalls.sort()).toEqual(["extensions/use-extensions.ts"])
  })

  test("MCP confirmation uses route-gated native radios and no install-time directory picker", () => {
    const source = read("extension-hub.tsx")
    const start = source.indexOf('<fieldset class="alpha-ext-install-scope" data-install-scope="mcp">')
    const scope = source.slice(start, source.indexOf("</fieldset>", start))
    const confirmation = source.slice(source.indexOf("{/* Install confirmation"))
    expect(start).toBeGreaterThan(0)
    expect(scope).toContain('type="radio"')
    expect(scope).toContain('value="global"')
    expect(scope).toContain('checked={installScope() === "global"}')
    expect(scope).toContain('<Show when={projectDir()}>')
    expect(scope).toContain('value="project"')
    expect(scope).not.toMatch(/openFilePicker|showOpenDialog|workspaceDefaultDir|workspaceEnsureDefault|type="file"/)
    expect(confirmation).not.toMatch(/openFilePicker|showOpenDialog|workspaceDefaultDir|workspaceEnsureDefault|type="file"/)
    expect(source).toContain('const [installScope, setInstallScope] = createSignal<CatalogInstallScopeChoice>(DEFAULT_CATALOG_INSTALL_SCOPE)')
    const open = source.slice(source.indexOf("const openInstallConfirmation ="), source.indexOf("// T5:", source.indexOf("const openInstallConfirmation =")))
    expect(open.indexOf("setInstallScope(DEFAULT_CATALOG_INSTALL_SCOPE)")).toBeLessThan(
      open.indexOf("setConfirming(entry)"),
    )
    expect(source.match(/setConfirming\((?!null\))/g)).toHaveLength(1)
    expect(source.slice(source.lastIndexOf("<Show", start), start)).toContain(
      '<Show when={entry().type === "mcp"}>',
    )
  })

  test("authorization redrive keeps the chosen scope and project rows consume main's safe state", () => {
    const source = read("extension-hub.tsx")
    const hook = read("use-extensions.ts")
    expect(source).toContain("projectDir: selectedProjectDir")
    expect(source).toContain("onAdd(e, secretsArg, undefined, scope, selectedProjectDir)")
    expect(source).toContain("onAdd(a.entry, a.secrets, decision, a.scope, a.projectDir)")
    expect(source).toContain('const selectedProjectDir = scope === "project" ? projectDir() : undefined')
    expect(source).toContain("addMcpEntry(e, secrets, true, authorization, scope, selectedProjectDir)")
    expect(source).toContain("projectMcpStatusView(row.receipt.projectMcpState)")
    expect(source).toContain("sdkMcpStatusForReceipt(r, ext.store.mcp)")
    expect(source).toContain("nameOnlyLiveMcpIsUnambiguousGlobal(s.name, ext.store.projectReceipts)")
    expect(hook).toContain('if (r.mcpActivation?.status === "reload-pending") return { ok: true, reason: "reload-pending" }')
    expect(source).toContain('else if (res.reason === "reload-pending") flash(t("alpha.ext.addedPendingReload"))')
    expect(hook).toContain("c.instance.dispose({ directory: projectDir })")
    expect(hook).toContain("c.event.subscribe({ directory: projectDir }, { signal: abort.signal })")
    expect(hook).toContain('event.type === "server.instance.disposed"')
    expect(hook).toContain("loadInstalls(target.target.projectDir, refreshed ? undefined : r.name)")
    const onAdd = source.slice(source.indexOf("const onAdd = async"), source.indexOf("const closeAuthz ="))
    expect(onAdd.indexOf('if (scope === "project" && e.type !== "mcp")')).toBeLessThan(
      onAdd.indexOf('if (e.type === "mcp")'),
    )
  })

  test("same-name scoped rows stay independent through rendering and project uninstall", () => {
    const source = read("extension-hub.tsx")
    const hook = read("use-extensions.ts")
    expect(source).toContain('key: `${r.type}:${r.name}:project`')
    expect(source).toContain('for (const r of ext.store.receipts)')
    expect(source).toContain('for (const r of ext.store.projectReceipts)')
    expect(source).toContain("data-project-mcp-state={project().state}")
    const routeEffect = hook.slice(hook.lastIndexOf("createEffect(() =>"), hook.indexOf("// #408:会话结束事件"))
    expect(routeEffect).toContain("withoutProjectOnlyLiveMcp(mcp, projectReceipts, receipts)")
    expect(routeEffect.indexOf('setStore("projectReceipts", [])')).toBeLessThan(
      routeEffect.indexOf("void loadInstalls()"),
    )
    expect(routeEffect.indexOf('setStore("projectReceipts", [])')).toBeLessThan(
      routeEffect.indexOf("void loadStatus()"),
    )
    const uninstall = functionSlice(hook, "uninstall", "setInstallState")
    expect(uninstall).toContain('receipt.scope === "project"')
    expect(uninstall).toContain("refreshProjectEngine(selectedProjectDir!)")
    expect(uninstall.indexOf('receipt.scope === "project"')).toBeLessThan(
      uninstall.indexOf("client?.mcp.disconnect"),
    )
    expect(source).toContain('res.reason === "reload-pending"')
    expect(source).toContain('t("alpha.ext.statePendingReload")')
  })

  test("main projects consent first and probes only the resolved current project", () => {
    const source = read("../../main/ext-ipc.ts")
    const state = source.slice(source.indexOf("const projectMcpState ="), source.indexOf("const { persistMcpBody }"))
    expect(state).toContain('return "awaiting-consent"')
    expect(state).toContain('return "consent-denied"')
    expect(state).toContain('return "disabled"')
    expect(state).toContain("probeProjectMcpActivation(name, projectDir, awaitServer)")
    expect(state.indexOf("hasExtensionsDecision")).toBeLessThan(state.indexOf("extensionsGranted"))
    expect(state.indexOf("extensionsGranted")).toBeLessThan(state.indexOf('if (disabled) return "disabled"'))
    expect(state.indexOf('if (disabled) return "disabled"')).toBeLessThan(
      state.indexOf("probeProjectMcpActivation"),
    )
    expect(state).not.toContain("withExtensionsConsent")
    expect(source).toContain("disabledMcpNames.has(receipt.name)")
    expect(source).toContain('if (decoded.ok && decoded.intent.scope.scope === "project") return result')
    expect(source.indexOf('decoded.intent.scope.scope === "project"')).toBeLessThan(
      source.indexOf("if (result.installedDisabled) return result"),
    )
  })
})
