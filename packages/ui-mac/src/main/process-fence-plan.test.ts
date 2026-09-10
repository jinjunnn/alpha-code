// REQ-159 (`#1321`) —— planner 的接线判据(假 store / 假 fs / 假编译器;electron-free,全平台跑)。
//
// 它守的是 main 侧那几条会静默出错的事:父目录预建(§6.3.1 第 3 条)、store 读挂不炸 boot 但出声、
// 试编译丢尾、原生模块缺失即拒、默认工作区不在盘上即拒。真编译器与真 profile 的判据在别的文件。

import { describe, expect, test } from "bun:test"
import { planProcessFence, type PlanProcessFenceDeps, type PlanProcessFenceInput } from "./process-fence-plan"

const describeDarwin = process.platform === "darwin" ? describe : describe.skip

const HOME = "/Users/alpha"
const USER_DATA = `${HOME}/Library/Application Support/ai.opencode.desktop`
const GLOBAL = `${HOME}/Library/Application Support/alpha-code-state/env/prod`
const ADDON = "/App/Contents/Resources/alpha-fence/alpha_fence.node"

function harness(overrides: Partial<PlanProcessFenceDeps> = {}, existing = new Set<string>([ADDON])) {
  const made: string[] = []
  const logs: string[] = []
  const dirs = new Set([`${HOME}/code-puppy`, `${HOME}/proj-a`, `${HOME}/proj-b`])
  const deps: PlanProcessFenceDeps = {
    homeDir: () => HOME,
    alphaGlobalRoot: () => GLOBAL,
    defaultWorkspace: () => `${HOME}/code-puppy`,
    readStore: () => ({
      tabs: [
        { type: "draft", draftID: "a", server: "sidecar", directory: `${HOME}/proj-a` },
        { type: "draft", draftID: "b", server: "sidecar", directory: `${HOME}/proj-b` },
      ],
      recent: { key: "draft:b" },
      info: {},
    }),
    isDirectory: (p) => dirs.has(p),
    mkdirp: (p) => void made.push(p),
    compile: () => ({ ok: true }),
    log: (l) => void logs.push(l),
    ...overrides,
  }
  const input: PlanProcessFenceInput = {
    userDataPath: USER_DATA,
    sidecarEnv: { HOME },
    addon: { packaged: true, resourcesPath: "/App/Contents/Resources", moduleDir: "/unused", exists: (p) => existing.has(p) },
  }
  return { deps, input, made, logs }
}

describeDarwin("planProcessFence", () => {
  test("正向:并集 = 默认 → recent → tab 栏;父目录 W4/W5/W6/W7 预建;addonPath 解析到 extraResources;日志一行账", () => {
    const h = harness()
    const plan = planProcessFence(h.input, h.deps)
    expect(plan.workspaces).toEqual([`${HOME}/code-puppy`, `${HOME}/proj-b`, `${HOME}/proj-a`])
    expect(plan.addonPath).toBe(ADDON)
    expect(plan.dropped).toEqual([])
    expect(plan.attempts).toBe(1)
    expect(plan.profileBytes).toBe(Buffer.byteLength(plan.profile))
    expect(h.made).toEqual([`${HOME}/.local/share/opencode`, `${HOME}/.cache/opencode`, `${HOME}/.config/opencode`, `${HOME}/.npm`])
    expect(h.logs.some((l) => /process fence planned: workspaces=3 \(candidates=3, excluded=0, dropped=0\)/.test(l))).toBe(true)
    // W16 / W10 / W17 / W18 刻意不建
    expect(h.made.some((d) => d.endsWith("/.opencode") || d.endsWith("/.zsh_sessions") || d.includes("bun"))).toBe(false)
  })

  test("用户导出 XDG_STATE_HOME ⇒ 多建 <state>/opencode,profile 多一行 W3;XDG_DATA_HOME 跟着 env", () => {
    const h = harness()
    h.input.sidecarEnv = { HOME, XDG_STATE_HOME: "/Volumes/s", XDG_DATA_HOME: "/Volumes/d" }
    const plan = planProcessFence(h.input, h.deps)
    expect(h.made).toContain("/Volumes/s/opencode")
    expect(h.made).toContain("/Volumes/d/opencode")
    expect(plan.profile).toContain(`(subpath "/Volumes/s/opencode")`)
    expect(plan.roots.stateHome).toBe("/Volumes/s")
  })

  test("store 读挂:不炸,并集退到默认工作区,日志点名原因", () => {
    const h = harness({
      readStore: () => {
        throw new Error("store corrupt")
      },
    })
    const plan = planProcessFence(h.input, h.deps)
    expect(plan.workspaces).toEqual([`${HOME}/code-puppy`])
    expect(h.logs.some((l) => /tab store unreadable.*store corrupt/.test(l))).toBe(true)
  })

  test("试编译只放得下 2 个 ⇒ 丢掉最旧的(尾部),日志写明丢了谁与编译器原文", () => {
    const h = harness({
      compile: (profile) => ((profile.match(/; W1$/gm)?.length ?? 0) <= 2 ? { ok: true } : { ok: false, reason: "data object length 70173 exceeds maximum (65535)" }),
    })
    const plan = planProcessFence(h.input, h.deps)
    expect(plan.workspaces).toEqual([`${HOME}/code-puppy`, `${HOME}/proj-b`])
    expect(plan.dropped).toEqual([`${HOME}/proj-a`])
    expect(plan.attempts).toBe(2)
    expect(h.logs.some((l) => l.includes("dropped=1") && l.includes(`${HOME}/proj-a`) && l.includes("exceeds maximum"))).toBe(true)
  })

  test("fail-closed ①:最小集也编不过 ⇒ 抛,原因原文可读", () => {
    const h = harness({ compile: () => ({ ok: false, reason: "profile compilation failed" }) })
    expect(() => planProcessFence(h.input, h.deps)).toThrow(/minimum writable set.*profile compilation failed/)
  })

  test("fail-closed ②:原生模块不在 ⇒ 抛并点名路径(打包漏了 extraResources 就是这一格)", () => {
    const h = harness({}, new Set())
    expect(() => planProcessFence(h.input, h.deps)).toThrow(new RegExp(`native module missing at ${ADDON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
  })

  test("fail-closed ③:默认工作区不在盘上 ⇒ 抛(不代建)", () => {
    const h = harness({ isDirectory: () => false })
    expect(() => planProcessFence(h.input, h.deps)).toThrow(/default workspace is not a directory/)
    expect(h.made).not.toContain(`${HOME}/code-puppy`)
  })

  test("dev 形态:addonPath 解析到 native/alpha-fence/build/(相对 out/main)", () => {
    const h = harness({}, new Set(["/repo/packages/ui-mac/native/alpha-fence/build/alpha_fence.node"]))
    h.input.addon = { packaged: false, resourcesPath: "/unused", moduleDir: "/repo/packages/ui-mac/out/main", exists: (p) => p === "/repo/packages/ui-mac/native/alpha-fence/build/alpha_fence.node" }
    expect(planProcessFence(h.input, h.deps).addonPath).toBe("/repo/packages/ui-mac/native/alpha-fence/build/alpha_fence.node")
  })
})
