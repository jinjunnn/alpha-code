// REQ-100 #347(review #376 Major3)—— 写通道表的行为测试:对**真实生产表**
// (buildGatedWriteChannels + GATED_WRITE_CHANNELS)逐通道断言「先恢复、拒绝短路、root 正确、
// 实参透传」;任何通道被改回直连 body、resolver 接错、或新写通道漏登记都会在此显形。
// 另含一张真根集成:真实 gate + 真盘 journal,证明表构造的通道确实先收敛再执行。
import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { makeRecoveryGate, type RecoveryGate } from "./ext-recovery-gate"
import { probeTransactionJournals } from "./ext-transaction"
import { buildGatedWriteChannels, GATED_WRITE_CHANNELS, LOCAL_PACKAGE_READ_CHANNELS, type WriteChannelBodies, type WriteChannelRoots } from "./ext-write-channels"

const GLOBAL = "/roots/global"
const PROJECT = "/roots/project"

function makeHarness(admit: boolean) {
  const gateLog: string[] = []
  const bodyLog: Array<{ key: string; args: unknown[] }> = []
  const gate: RecoveryGate = {
    withRecoveredWrite: async (root, op) => {
      gateLog.push(root)
      if (!admit) return { ok: false as const, reason: "gate refused" }
      return op()
    },
  }
  const roots: WriteChannelRoots = {
    global: () => ({ ok: true, root: GLOBAL }),
    uninstallIntent: (intent) =>
      intent === "bad" ? { ok: false, reason: "bad uninstall intent" } : { ok: true, root: intent === "proj" ? PROJECT : GLOBAL },
    setStateIntent: (intent) => (intent === "proj" ? { ok: true, root: PROJECT } : { ok: true, root: GLOBAL }),
    importTarget: (target) => (target?.scope === "project" ? { ok: true, root: PROJECT } : { ok: true, root: GLOBAL }),
    projectDir: () => ({ ok: true, root: PROJECT }),
  }
  const body =
    (key: string) =>
    async (...args: unknown[]) => {
      bodyLog.push({ key, args })
      return { ok: true as const, via: key }
    }
  const bodies: WriteChannelBodies = {
    installCatalog: body("installCatalog"),
    uninstallV2: body("uninstallV2"),
    // `#698`:整包卸载。**必须逐条列在下面三处枚举里** —— `WriteChannelBodies` 是编译期类型,
    // 而测试文件不进 typecheck 且 bun 直接剥类型:漏掉它时 body 是 undefined,而
    // 「键集一一对应」那条仍然全绿(builder 照样吐出这个键)。判据只能是显式枚举。
    uninstallPackage: body("uninstallPackage"),
    rollback: body("rollback"),
    setInstallState: body("setInstallState"),
    projectResidualsClean: body("projectResidualsClean"),
    removeMcpLegacy: body("removeMcpLegacy"),
    persistMcp: body("persistMcp"),
    installPlugin: body("installPlugin"),
    importAgentConfirm: body("importAgentConfirm"),
    // `#782`:同上 —— 漏掉这一行时 body 是 undefined,而「键集一一对应」仍然全绿。
    importClaudePluginConfirm: body("importClaudePluginConfirm"),
    importSkillFolder: body("importSkillFolder"),
    importSkillGit: body("importSkillGit"),
  }
  return { gate, roots, bodies, gateLog, bodyLog }
}

describe("GATED_WRITE_CHANNELS — 表完整性", () => {
  test("builder 键集与通道名表一一对应(新写通道必须同时登记两处)", () => {
    const h = makeHarness(true)
    const handlers = buildGatedWriteChannels(h)
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(GATED_WRITE_CHANNELS).sort())
    // 通道名唯一且全为 ext-* 前缀
    const names = Object.values(GATED_WRITE_CHANNELS)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n.startsWith("ext-")).toBe(true)
  })

  // `#782`:**表内容逐名断言**,而不只是「builder 与表键集一一对应」。
  // 那条对应关系对「有人往表里加了一条**不该写盘**的通道」是瞎的 —— 加一条 body、加一条键,
  // 两边照样一一对应,全绿。这里把整张表的名字写死:表一变,这条就红,改的人必须回来解释。
  test("写表内容逐名钉死:preview / cancel / 列表三条纯读通道**不在**表内", () => {
    expect(Object.values(GATED_WRITE_CHANNELS)).toEqual([
      "ext-install-catalog",
      "ext-uninstall-v2",
      "ext-uninstall-package",
      "ext-rollback",
      "ext-set-install-state",
      "ext-project-residuals-clean",
      "ext-remove-mcp",
      "ext-persist-mcp",
      "ext-install-plugin",
      "ext-import-agent-confirm",
      "ext-import-claude-plugin-confirm",
      "ext-import-skill-folder",
      "ext-import-skill-git",
    ])
    // 两段式的既有先例:agent 的 preview 不在表内、confirm 在表内。本地插件包逐字同款。
    const write = new Set<string>(Object.values(GATED_WRITE_CHANNELS))
    expect(write.has("ext-import-agent-preview")).toBe(false)
    expect(write.has("ext-import-agent-confirm")).toBe(true)
    expect(write.has("ext-import-claude-plugin-confirm")).toBe(true)
    // ↓ 这三条是本条用例存在的理由:把 preview 挪进写表,这里立刻红。
    expect(write.has("ext-import-claude-plugin-preview")).toBe(false)
    expect(write.has("ext-import-claude-plugin-cancel")).toBe(false)
    expect(write.has("ext-installed-packages")).toBe(false)
  })

  test("纯读通道表:内容逐名钉死,且与写表**互斥**", () => {
    expect(Object.values(LOCAL_PACKAGE_READ_CHANNELS)).toEqual([
      "ext-import-claude-plugin-preview",
      "ext-import-claude-plugin-cancel",
      "ext-installed-packages",
    ])
    const write = new Set<string>(Object.values(GATED_WRITE_CHANNELS))
    // 集合级互斥:将来往读表里加通道的人,若顺手也登进写表,这条一起红。
    for (const name of Object.values(LOCAL_PACKAGE_READ_CHANNELS)) expect(write.has(name)).toBe(false)
    const names = Object.values(LOCAL_PACKAGE_READ_CHANNELS)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n.startsWith("ext-")).toBe(true)
  })
})

describe("逐通道:gate 先行、root 正确、拒绝短路、实参透传", () => {
  test("放行:全部 13 通道 body 收到原实参,gate 收到该通道的解析 root", async () => {
    const h = makeHarness(true)
    const w = buildGatedWriteChannels(h)
    await w.installCatalog({ catalogId: "x" })
    await w.uninstallV2("proj")
    await w.uninstallPackage("package:kit")
    await w.rollback({ type: "skill" }, "gen-000001-abcdef12")
    await w.setInstallState("proj")
    await w.projectResidualsClean("/some/project")
    await w.removeMcpLegacy("live-mcp")
    await w.persistMcp("m", { type: "local" }, ["K"])
    await w.installPlugin("@scope/pkg")
    await w.importAgentConfirm("preview-1")
    await w.importClaudePluginConfirm("local-preview-1")
    await w.importSkillFolder("/picked/dir", { scope: "project", projectDir: "/p" })
    await w.importSkillGit("https://x.git", undefined)
    expect(h.bodyLog.map((b) => b.key)).toEqual([
      "installCatalog",
      "uninstallV2",
      "uninstallPackage",
      "rollback",
      "setInstallState",
      "projectResidualsClean",
      "removeMcpLegacy",
      "persistMcp",
      "installPlugin",
      "importAgentConfirm",
      "importClaudePluginConfirm",
      "importSkillFolder",
      "importSkillGit",
    ])
    // root 断言:global 面 / intent 定根 / 项目面 / 导入 target 定根
    expect(h.gateLog).toEqual([GLOBAL, PROJECT, GLOBAL, GLOBAL, PROJECT, PROJECT, GLOBAL, GLOBAL, GLOBAL, GLOBAL, GLOBAL, PROJECT, GLOBAL])
    // 实参透传抽查
    expect(h.bodyLog[7]?.args).toEqual(["m", { type: "local" }, ["K"]])
    expect(h.bodyLog[3]?.args).toEqual([{ type: "skill" }, "gen-000001-abcdef12"])
    expect(h.bodyLog[11]?.args).toEqual(["/picked/dir", { scope: "project", projectDir: "/p" }])
    expect(h.bodyLog[2]?.args).toEqual(["package:kit"])
    // `#782`:confirm **只**拿到 previewId 一个实参。表构造器若把 event / target / srcDir
    // 之类的东西一起透进 body,这条立刻红 —— 那正是「renderer 给得出写入内容」的第一步。
    expect(h.bodyLog[10]?.args).toEqual(["local-preview-1"])
  })

  test("gate 拒绝:全部 13 通道 body 零调用,拒因原样返回", async () => {
    const h = makeHarness(false)
    const w = buildGatedWriteChannels(h)
    const results = await Promise.all([
      w.installCatalog({}),
      w.uninstallV2({}),
      w.uninstallPackage("package:kit"),
      w.rollback({}, "g"),
      w.setInstallState({}),
      w.projectResidualsClean("/p"),
      w.removeMcpLegacy("m"),
      w.persistMcp("m", {}, undefined),
      w.installPlugin("p"),
      w.importAgentConfirm("id"),
      w.importClaudePluginConfirm("id"),
      w.importSkillFolder("/d", undefined),
      w.importSkillGit("u", undefined),
    ])
    expect(h.bodyLog).toEqual([])
    expect(h.gateLog).toHaveLength(13)
    for (const r of results) expect(r).toEqual({ ok: false, reason: "gate refused" })
  })

  test("root 解析失败:原样返回,gate 与 body 都不执行", async () => {
    const h = makeHarness(true)
    const w = buildGatedWriteChannels(h)
    const r = await w.uninstallV2("bad")
    expect(r).toEqual({ ok: false, reason: "bad uninstall intent" })
    expect(h.gateLog).toEqual([])
    expect(h.bodyLog).toEqual([])
  })
})

describe("真根集成:真实 gate × 真盘 journal × 表构造通道", () => {
  test("非终态 journal → 表通道先收敛再执行 body", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-wc-"))
    try {
      const jd = path.join(root, "ext-tx", "journal")
      fs.mkdirSync(jd, { recursive: true })
      fs.writeFileSync(
        path.join(jd, "tx-open.json"),
        JSON.stringify({
          v: 1,
          txId: "tx-open",
          op: "uninstall",
          state: "uninstalling",
          createdAt: "2026-07-15T00:00:00.000Z",
          updatedAt: "2026-07-15T00:00:00.000Z",
          items: [{ key: "skill--demo", genId: "gen-000000-000000", files: [] }],
        }),
      )
      const gate = makeRecoveryGate(() => ({ commitUninstall: () => {}, uninstallArtifacts: () => {} }))
      const h = makeHarness(true)
      const w = buildGatedWriteChannels({ gate, roots: { ...h.roots, global: () => ({ ok: true, root }) }, bodies: h.bodies })
      const r = await w.installCatalog({ catalogId: "x" })
      expect(r).toEqual({ ok: true, via: "installCatalog" })
      const converged = probeTransactionJournals(root)
      expect(converged.entries.map((j) => `${j.txId}:${j.state}`)).toEqual(["tx-open:uninstalled"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

test("真实 catalog MCP 写通道结果只公开状态且不回显提交的 secret canary", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test",
      path.resolve(import.meta.dir, "../../test-component/ext-install-catalog-result.cases.ts"),
    ],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 用词边界而非 toContain:`"11 pass"` 含 `"1 pass"`、`"10 fail"` 含 `"0 fail"`,
  // 子串匹配会在用例数增减时假绿。五条子用例:enabled / installedDisabled 两条返回分支,加 #702 的 detail 通道注册、package 预检接线、browse 数据源。
  expect(output).toMatch(/\b5 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
}, 120_000)
