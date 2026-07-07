import { describe, expect, test } from "bun:test"
import { loadProjectPlugins, mergeHooks } from "./plugin-fanout"

describe("mergeHooks — host + project plugin hooks", () => {
  test("tool maps shallow-merged, own keys win", () => {
    const own = { tool: { alpha_ping: "OWN", shared: "OWN" } }
    const other = { tool: { proj_tool: "P", shared: "PROJ" } }
    const m = mergeHooks(own, [other])
    expect(m.tool).toEqual({ alpha_ping: "OWN", shared: "OWN", proj_tool: "P" }) // shared: own wins
  })

  test("function hooks forwarded — own first, then each project plugin", async () => {
    const calls: string[] = []
    const own = { async event() { calls.push("own") } }
    const p1 = { async event() { calls.push("p1") } }
    const p2 = { async event() { calls.push("p2") } }
    const m = mergeHooks(own, [p1, p2])
    await (m.event as () => Promise<void>)()
    expect(calls).toEqual(["own", "p1", "p2"])
  })

  test("config hook forwarded with shared args (cfg mutation chains)", async () => {
    const own = { async config(cfg: Record<string, unknown>) { cfg.own = true } }
    const proj = { async config(cfg: Record<string, unknown>) { cfg.proj = true } }
    const m = mergeHooks(own, [proj])
    const cfg: Record<string, unknown> = {}
    await (m.config as (c: Record<string, unknown>) => Promise<void>)(cfg)
    expect(cfg).toEqual({ own: true, proj: true })
  })

  test("hook present only in project plugin still forwarded", async () => {
    const calls: string[] = []
    const own = {}
    const proj = { async "chat.message"() { calls.push("proj") } }
    const m = mergeHooks(own, [proj])
    expect(typeof m["chat.message"]).toBe("function")
    await (m["chat.message"] as () => Promise<void>)()
    expect(calls).toEqual(["proj"])
  })

  test("no others → own returned intact", () => {
    const own = { tool: { a: 1 }, async event() {} }
    const m = mergeHooks(own, [])
    expect(m.tool).toEqual({ a: 1 })
    expect(typeof m.event).toBe("function")
  })
})

describe("loadProjectPlugins — trust gate + dynamic import", () => {
  const baseDeps = {
    existsSync: () => true,
    readdirSync: () => ["a.js", "b.js", "notjs.ts"],
    pathToFileURL: (p: string) => `file://${p}`,
    join: (...parts: string[]) => parts.join("/"),
  }

  test("untrusted → returns [] (executable not loaded)", async () => {
    let imported = 0
    const hooks = await loadProjectPlugins("/proj", {}, false, {
      ...baseDeps,
      importModule: async () => (imported++, { default: async () => ({}) }),
    })
    expect(hooks).toEqual([])
    expect(imported).toBe(0)
  })

  test("trusted → imports only .js, calls Plugin(input), collects hooks", async () => {
    const seen: string[] = []
    const hooks = await loadProjectPlugins("/proj", { directory: "/proj" }, true, {
      ...baseDeps,
      importModule: async (url) => {
        seen.push(url)
        return { default: async () => ({ tool: { [`t_${url.slice(-4)}`]: 1 } }) }
      },
    })
    expect(seen).toEqual(["file:///proj/.alpha/plugins/a.js", "file:///proj/.alpha/plugins/b.js"]) // notjs.ts skipped
    expect(hooks.length).toBe(2)
  })

  test("a broken plugin is skipped loud, others still load", async () => {
    const errors: string[] = []
    const hooks = await loadProjectPlugins("/proj", {}, true, {
      ...baseDeps,
      readdirSync: () => ["good.js", "bad.js"],
      importModule: async (url) => {
        if (url.includes("bad")) throw new Error("boom")
        return { default: async () => ({ event: async () => {} }) }
      },
      error: (m) => errors.push(m),
    })
    expect(hooks.length).toBe(1)
    expect(errors.some((e) => e.includes("bad.js"))).toBe(true)
  })

  test("no plugins dir → []", async () => {
    const hooks = await loadProjectPlugins("/proj", {}, true, { ...baseDeps, existsSync: () => false, importModule: async () => ({}) })
    expect(hooks).toEqual([])
  })

  test("module without default fn → skipped loud", async () => {
    const errors: string[] = []
    const hooks = await loadProjectPlugins("/proj", {}, true, {
      ...baseDeps,
      readdirSync: () => ["x.js"],
      importModule: async () => ({ notAPlugin: 1 }),
      error: (m) => errors.push(m),
    })
    expect(hooks).toEqual([])
    expect(errors.some((e) => e.includes("no default export"))).toBe(true)
  })
})
