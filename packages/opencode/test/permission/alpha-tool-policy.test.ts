// #1128(REQ-131 CODE)—— 分层工具策略 resolver / selector / 持久化 / managed cap 的判据
// (#724 CLOSE_DECIDE §2/§3/§4/§5 + 本票必修的负向闸)。
//
// 锚点纪律:期望值一律手写字面量(canonical 串、路径、默认态),不从被测模块反向导出;
// 唯一的例外是文件末的「锚点核对」用例,它反向核对字面量没有抄错,方向与生产相反。
//
// 必修负向闸(M 组):`OPENCODE_TEST_MANAGED_CONFIG_DIR` **存在时**,系统 managed 目录的
// deny 仍然生效 —— env 只能 additive(加规则),永远压不掉、替不掉系统目录。
// 变异验证(交付时实跑,结论写进 PR):把 `readManagedPolicy` 的系统目录读取改回上游
// `managedConfigDir()`(env 替换语义)⇒ M1/M4 当场红。
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  classDefaultState,
  classifyTool,
  parseToolPolicyDocument,
  selectorKey,
  selectorMatches,
  toPermissionAction,
  type ToolPolicyRecord,
  type ToolPolicySubject,
} from "@opencode-ai/schema/alpha-tool-policy"
import { AlphaToolPolicy } from "../../src/permission/alpha-tool-policy"
import { managedCapDenies, readManagedPolicy, systemManagedPolicyDir } from "../../src/permission/alpha-managed-policy"
import {
  loadPolicyDocument,
  policyFilePath,
  resetPolicyDocument,
  savePolicyDocument,
} from "../../src/permission/alpha-tool-policy-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"

// ── 手写字面量锚点 ───────────────────────────────────────────────────────────
const ID_MCP_PAID = "mcp:policy:paid_action"
const DIGEST_A = `sha256:${"a".repeat(64)}`
const DIGEST_B = `sha256:${"b".repeat(64)}`

const mcpSubject = (bindingDigest?: string): ToolPolicySubject => ({
  identity: { source: "mcp", origin: "policy", name: "paid_action" },
  authority: { kind: "not-asserted" },
  bindingDigest,
})

const cloudSubject = (evidenceDigest: string): ToolPolicySubject => ({
  identity: { source: "mcp", origin: "alpha", name: "web_search" },
  authority: { kind: "alpha-cloud", bindingId: "mcp:alpha", evidenceDigest },
})

const NO_CAPS = { managed: { status: "ok", ruleset: [], sources: [] } } as const
const NO_USER = { status: "absent" } as const

const tmpdirs: string[] = []
function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpdirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpdirs.length > 0) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true })
})

const PARTITION = { account: "acct-1", workspace: "ws-1" }

// ═══ S. 分类与 selector(§2/§3)═══════════════════════════════════════════════
describe("classify + selector matcher", () => {
  test("S1 四类分类只认 identity.source 与 verified authority", () => {
    expect(classifyTool({ identity: { source: "builtin", origin: "", name: "write" }, authority: { kind: "not-asserted" } })).toBe("builtin")
    expect(classifyTool({ identity: { source: "builtin-v2", origin: "", name: "write" }, authority: { kind: "not-asserted" } })).toBe("builtin")
    expect(classifyTool({ identity: { source: "host", origin: "", name: "list_mcp_resources" }, authority: { kind: "not-asserted" } })).toBe("builtin")
    expect(classifyTool(cloudSubject(DIGEST_A))).toBe("alpha-cloud")
    expect(classifyTool(mcpSubject())).toBe("third-party-mcp")
    expect(classifyTool({ identity: { source: "plugin", origin: "probe", name: "default" }, authority: { kind: "not-asserted" } })).toBe("plugin")
    // identity 铸不出 canonical(空 name)⇒ 无类可归。
    expect(classifyTool({ identity: { source: "mcp", origin: "x", name: "" }, authority: { kind: "not-asserted" } })).toBeUndefined()
    expect(classDefaultState("builtin")).toBe("enabled")
    expect(classDefaultState("alpha-cloud")).toBe("ask")
    expect(classDefaultState("third-party-mcp")).toBe("ask")
    expect(classDefaultState("plugin")).toBe("ask")
  })

  test("S2 手拼 wildcard 不是一个层级:`mcp:policy:*` 被 schema 拒绝;name=`*` 只匹配那个字面工具", () => {
    // 非规范形(裸 `*` 应编码为 %2A)⇒ decode loud fail,不落成一条永不命中的死记录。
    expect(() =>
      parseToolPolicyDocument({
        version: 1,
        partition: PARTITION,
        records: [{ selector: { level: "tool", canonical: "mcp:policy:*" }, state: "disabled" }],
      }),
    ).toThrow()
    // 真有个名字叫 `*` 的工具:canonical 是 mcp:policy:%2A,只匹配它自己。
    const starTool: ToolPolicySubject = {
      identity: { source: "mcp", origin: "policy", name: "*" },
      authority: { kind: "not-asserted" },
    }
    const starSelector = { level: "tool", canonical: "mcp:policy:%2A" } as const
    expect(selectorMatches(starSelector, starTool)).toBe(true)
    expect(selectorMatches(starSelector, mcpSubject())).toBe(false)
  })

  test("S3 service selector 结构匹配一台 server 的全部工具,不匹配别台", () => {
    const service = { level: "service", source: "mcp", origin: "policy" } as const
    expect(selectorMatches(service, mcpSubject())).toBe(true)
    expect(
      selectorMatches(service, {
        identity: { source: "mcp", origin: "policy", name: "free_action" },
        authority: { kind: "not-asserted" },
      }),
    ).toBe(true)
    expect(
      selectorMatches(service, {
        identity: { source: "mcp", origin: "other", name: "paid_action" },
        authority: { kind: "not-asserted" },
      }),
    ).toBe(false)
    expect(toPermissionAction("enabled")).toBe("allow")
    expect(toPermissionAction("ask")).toBe("ask")
    expect(toPermissionAction("disabled")).toBe("deny")
  })
})

// ═══ R. 纯合成核(§4)═══════════════════════════════════════════════════════
describe("resolveToolPolicy", () => {
  const resolve = AlphaToolPolicy.resolveToolPolicy

  test("R1 默认:本地 enabled;Alpha Cloud / 第三方 MCP / plugin 一律 ask", () => {
    const builtin = resolve({
      subject: { identity: { source: "builtin", origin: "", name: "write" }, authority: { kind: "not-asserted" } },
      caps: NO_CAPS,
      user: NO_USER,
    })
    expect(builtin).toEqual({ state: "enabled", action: "allow", reason: { kind: "default", class: "builtin" } })
    expect(resolve({ subject: cloudSubject(DIGEST_A), caps: NO_CAPS, user: NO_USER }).state).toBe("ask")
    expect(resolve({ subject: mcpSubject(), caps: NO_CAPS, user: NO_USER }).state).toBe("ask")
    expect(
      resolve({
        subject: { identity: { source: "plugin", origin: "probe", name: "default" }, authority: { kind: "not-asserted" } },
        caps: NO_CAPS,
        user: NO_USER,
      }).state,
    ).toBe("ask")
  })

  test("R2 同层优先级:exact tool > service > class(§3)", () => {
    const classRec: ToolPolicyRecord = { selector: { level: "class", class: "third-party-mcp" }, state: "disabled" }
    const serviceRec: ToolPolicyRecord = {
      selector: { level: "service", source: "mcp", origin: "policy" },
      state: "enabled",
      bindingDigest: DIGEST_A,
    }
    const toolRec: ToolPolicyRecord = { selector: { level: "tool", canonical: ID_MCP_PAID }, state: "ask" }
    const subject = mcpSubject(DIGEST_A)
    const all = resolve({ subject, caps: NO_CAPS, user: { status: "ok", records: [classRec, serviceRec, toolRec] } })
    expect(all).toEqual({ state: "ask", action: "ask", reason: { kind: "user", level: "tool" } })
    const noTool = resolve({ subject, caps: NO_CAPS, user: { status: "ok", records: [classRec, serviceRec] } })
    expect(noTool).toEqual({ state: "enabled", action: "allow", reason: { kind: "user", level: "service" } })
    const onlyClass = resolve({ subject, caps: NO_CAPS, user: { status: "ok", records: [classRec] } })
    expect(onlyClass).toEqual({ state: "disabled", action: "deny", reason: { kind: "user", level: "class" } })
  })

  test("R3 managed cap deny 压过用户 enabled(cap 在第 1 步,§4)", () => {
    const result = resolve({
      subject: mcpSubject(DIGEST_A),
      caps: { managed: { status: "ok", ruleset: [{ permission: ID_MCP_PAID, pattern: "*", action: "deny" }], sources: ["managed"] } },
      user: {
        status: "ok",
        records: [{ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "enabled", bindingDigest: DIGEST_A }],
      },
    })
    expect(result).toEqual({ state: "disabled", action: "deny", reason: { kind: "cap-managed" } })
  })

  test("R4 entitlement 缺失/deny 与 sovereignty/kill-switch deny 都是 cap ⇒ disabled", () => {
    expect(resolve({ subject: cloudSubject(DIGEST_A), caps: { ...NO_CAPS, entitlement: "missing" }, user: NO_USER }))
      .toEqual({ state: "disabled", action: "deny", reason: { kind: "cap-entitlement", verdict: "missing" } })
    expect(resolve({ subject: cloudSubject(DIGEST_A), caps: { ...NO_CAPS, entitlement: "deny" }, user: NO_USER }).state).toBe("disabled")
    expect(
      resolve({ subject: mcpSubject(), caps: { ...NO_CAPS, hardDeny: ["web-search-kill-switch"] }, user: NO_USER }),
    ).toEqual({ state: "disabled", action: "deny", reason: { kind: "cap-hard-deny", sources: ["web-search-kill-switch"] } })
    // entitlement allow 只是必要条件,不产生 enabled:默认仍是 ask。
    expect(resolve({ subject: cloudSubject(DIGEST_A), caps: { ...NO_CAPS, entitlement: "allow" }, user: NO_USER }).state).toBe("ask")
  })

  test("R6 binding guard:service/tool enabled 只在 digest 逐字相等时生效,变了/缺了回 ask(§5)", () => {
    const record: ToolPolicyRecord = {
      selector: { level: "service", source: "mcp", origin: "policy" },
      state: "enabled",
      bindingDigest: DIGEST_A,
    }
    const user = { status: "ok", records: [record] } as const
    expect(resolve({ subject: mcpSubject(DIGEST_A), caps: NO_CAPS, user }).state).toBe("enabled")
    expect(resolve({ subject: mcpSubject(DIGEST_B), caps: NO_CAPS, user })).toEqual({
      state: "ask",
      action: "ask",
      reason: { kind: "binding-changed", level: "service" },
    })
    // 当前 binding 不可得 ⇒ 不放行(fail-closed),回 ask。
    expect(resolve({ subject: mcpSubject(undefined), caps: NO_CAPS, user }).state).toBe("ask")
    // disabled 不因 rebind 失效:收紧是安全方向。
    const disabledRec: ToolPolicyRecord = { selector: { level: "service", source: "mcp", origin: "policy" }, state: "disabled" }
    expect(resolve({ subject: mcpSubject(DIGEST_B), caps: NO_CAPS, user: { status: "ok", records: [disabledRec] } }).state).toBe("disabled")
  })

  test("R7 Alpha Cloud 的 binding 就是 verified evidenceDigest:换了证据 ⇒ 回 ask", () => {
    const record: ToolPolicyRecord = {
      selector: { level: "tool", canonical: "mcp:alpha:web_search" },
      state: "enabled",
      bindingDigest: DIGEST_A,
    }
    const user = { status: "ok", records: [record] } as const
    expect(resolve({ subject: cloudSubject(DIGEST_A), caps: NO_CAPS, user }).state).toBe("enabled")
    expect(resolve({ subject: cloudSubject(DIGEST_B), caps: NO_CAPS, user })).toEqual({
      state: "ask",
      action: "ask",
      reason: { kind: "binding-changed", level: "tool" },
    })
  })

  test("R8/R9/R10/R11 fail-closed 族:非法 identity / quarantine / managed unreadable / 冲突记录 ⇒ disabled", () => {
    expect(
      resolve({
        subject: { identity: { source: "mcp", origin: "x", name: "" }, authority: { kind: "not-asserted" } },
        caps: NO_CAPS,
        user: NO_USER,
      }).reason.kind,
    ).toBe("invalid-identity")
    expect(
      resolve({ subject: mcpSubject(), caps: NO_CAPS, user: { status: "quarantined", reason: "broken" } }),
    ).toEqual({ state: "disabled", action: "deny", reason: { kind: "quarantine", detail: "broken" } })
    expect(
      resolve({
        subject: mcpSubject(),
        caps: { managed: { status: "unreadable", reason: "corrupt", source: "s" } },
        user: NO_USER,
      }).reason.kind,
    ).toBe("cap-managed-unreadable")
    const dup: ToolPolicyRecord = { selector: { level: "tool", canonical: ID_MCP_PAID }, state: "enabled", bindingDigest: DIGEST_A }
    const conflicting = resolve({
      subject: mcpSubject(DIGEST_A),
      caps: NO_CAPS,
      user: { status: "ok", records: [dup, { ...dup, state: "disabled", bindingDigest: undefined }] },
    })
    expect(conflicting.state).toBe("disabled")
    expect(conflicting.reason.kind).toBe("quarantine")
  })
})

// ═══ T. versioned 持久化 + quarantine(§5)═══════════════════════════════════
describe("policy store", () => {
  test("T1 roundtrip + 原子写 + 分区文件名不含明文", () => {
    const dir = tmpdir("alpha-policy-t1-")
    const records: ToolPolicyRecord[] = [
      { selector: { level: "tool", canonical: ID_MCP_PAID }, state: "disabled" },
      { selector: { level: "class", class: "plugin" }, state: "enabled" },
    ]
    savePolicyDocument(dir, PARTITION, records)
    const file = policyFilePath(dir, PARTITION)
    expect(path.basename(file)).toMatch(/^[0-9a-f]{64}\.json$/)
    expect(path.basename(file)).not.toContain("acct-1")
    const loaded = loadPolicyDocument(dir, PARTITION)
    expect(loaded.status).toBe("ok")
    if (loaded.status !== "ok") return
    expect(loaded.doc.version).toBe(1)
    expect(loaded.doc.records).toEqual(records)
    // 没有半截 tmp 残留。
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  test("T2 文件不存在 = 首次使用(absent),不是错误", () => {
    expect(loadPolicyDocument(tmpdir("alpha-policy-t2-"), PARTITION)).toEqual({ status: "absent" })
  })

  test("T3 坏文档整份 quarantine:损坏 JSON / 未知版本 / 部分非法记录 / 分区不符 / selector 重复", () => {
    const dir = tmpdir("alpha-policy-t3-")
    const file = policyFilePath(dir, PARTITION)
    fs.mkdirSync(path.dirname(file), { recursive: true })

    fs.writeFileSync(file, "{ not json")
    expect(loadPolicyDocument(dir, PARTITION).status).toBe("quarantined")

    fs.writeFileSync(file, JSON.stringify({ version: 2, partition: PARTITION, records: [] }))
    expect(loadPolicyDocument(dir, PARTITION).status).toBe("quarantined")

    // 一条非法(service enabled 缺 bindingDigest)⇒ 整份坏,不是丢那一条。
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        partition: PARTITION,
        records: [
          { selector: { level: "tool", canonical: ID_MCP_PAID }, state: "disabled" },
          { selector: { level: "service", source: "mcp", origin: "policy" }, state: "enabled" },
        ],
      }),
    )
    expect(loadPolicyDocument(dir, PARTITION).status).toBe("quarantined")

    // 把别的分区的文件拷过来 ⇒ 文档体内分区核不上 ⇒ quarantine。
    const other = { account: "acct-2", workspace: "ws-1" }
    savePolicyDocument(dir, other, [])
    fs.copyFileSync(policyFilePath(dir, other), file)
    const stolen = loadPolicyDocument(dir, PARTITION)
    expect(stolen.status).toBe("quarantined")

    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        partition: PARTITION,
        records: [
          { selector: { level: "tool", canonical: ID_MCP_PAID }, state: "disabled" },
          { selector: { level: "tool", canonical: ID_MCP_PAID }, state: "ask" },
        ],
      }),
    )
    expect(loadPolicyDocument(dir, PARTITION).status).toBe("quarantined")
  })

  test("T4 reset:坏文件挪去带时间戳备份(可恢复),加载回到 absent(批准默认)", () => {
    const dir = tmpdir("alpha-policy-t4-")
    const file = policyFilePath(dir, PARTITION)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "{ broken")
    const { backup } = resetPolicyDocument(dir, PARTITION)
    expect(backup).toBeDefined()
    expect(fs.existsSync(backup!)).toBe(true)
    expect(fs.readFileSync(backup!, "utf8")).toBe("{ broken")
    expect(loadPolicyDocument(dir, PARTITION)).toEqual({ status: "absent" })
  })

  test("T5 写入前校验:selector 重复与非法记录在写入者手里 loud fail,不落盘", () => {
    const dir = tmpdir("alpha-policy-t5-")
    const rec: ToolPolicyRecord = { selector: { level: "tool", canonical: ID_MCP_PAID }, state: "disabled" }
    expect(() => savePolicyDocument(dir, PARTITION, [rec, { ...rec, state: "ask" }])).toThrow()
    expect(() =>
      savePolicyDocument(dir, PARTITION, [
        { selector: { level: "service", source: "mcp", origin: "policy" }, state: "enabled" } as ToolPolicyRecord,
      ]),
    ).toThrow()
    expect(loadPolicyDocument(dir, PARTITION)).toEqual({ status: "absent" })
  })

  test("T6 分区隔离:账户 A 的记录不出现在账户 B / 别的工作区的文档里", () => {
    const dir = tmpdir("alpha-policy-t6-")
    savePolicyDocument(dir, PARTITION, [{ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "enabled", bindingDigest: DIGEST_A }])
    expect(loadPolicyDocument(dir, { account: "acct-2", workspace: "ws-1" })).toEqual({ status: "absent" })
    expect(loadPolicyDocument(dir, { account: "acct-1", workspace: "ws-2" })).toEqual({ status: "absent" })
    const own = loadPolicyDocument(dir, PARTITION)
    expect(own.status).toBe("ok")
  })
})

// ═══ M. managed cap 负向闸(本票必修)══════════════════════════════════════════
describe("managed cap —— env 存在时系统 managed deny 仍生效", () => {
  const ENV = "OPENCODE_TEST_MANAGED_CONFIG_DIR"

  function withEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
    const saved = process.env[ENV]
    process.env[ENV] = value
    return fn().finally(() => {
      if (saved === undefined) delete process.env[ENV]
      else process.env[ENV] = saved
    })
  }

  function writeManaged(dir: string, permission: Record<string, unknown>) {
    fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ permission }))
  }

  test("M1 env 指向 allow-all 目录,系统目录的 deny 仍然构成 cap ⇒ resolver disabled", async () => {
    const systemDir = tmpdir("alpha-managed-system-")
    const envDir = tmpdir("alpha-managed-env-")
    writeManaged(systemDir, { [ID_MCP_PAID]: "deny" })
    writeManaged(envDir, { "*": "allow", [ID_MCP_PAID]: "allow" })
    await withEnv(envDir, async () => {
      const result = await readManagedPolicy({ systemDir, plist: null })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      // env 的 allow 排在系统规则**之前**(更低优先),findLast 语义下压不掉系统 deny。
      expect(managedCapDenies(ID_MCP_PAID, result.ruleset)).toBe(true)
      // 走完整 resolver:用户层甚至写了 enabled,cap 仍然赢。
      const effective = AlphaToolPolicy.resolveToolPolicy({
        subject: mcpSubject(DIGEST_A),
        caps: { managed: result },
        user: {
          status: "ok",
          records: [{ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "enabled", bindingDigest: DIGEST_A }],
        },
      })
      expect(effective).toEqual({ state: "disabled", action: "deny", reason: { kind: "cap-managed" } })
    })
  })

  test("M2 env 目录是 additive 的:它能补上系统没提的 deny(方向只会更严)", async () => {
    const systemDir = tmpdir("alpha-managed-system-")
    const envDir = tmpdir("alpha-managed-env-")
    writeManaged(systemDir, {})
    writeManaged(envDir, { "mcp:extra:tool": "deny" })
    await withEnv(envDir, async () => {
      const result = await readManagedPolicy({ systemDir, plist: null })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(managedCapDenies("mcp:extra:tool", result.ruleset)).toBe(true)
      expect(managedCapDenies(ID_MCP_PAID, result.ruleset)).toBe(false)
    })
  })

  test("M3 系统目录显式 allow 时,env 的 deny 不越权覆盖(env 优先级更低)", async () => {
    const systemDir = tmpdir("alpha-managed-system-")
    const envDir = tmpdir("alpha-managed-env-")
    writeManaged(systemDir, { [ID_MCP_PAID]: "allow" })
    writeManaged(envDir, { [ID_MCP_PAID]: "deny" })
    await withEnv(envDir, async () => {
      const result = await readManagedPolicy({ systemDir, plist: null })
      expect(result.status).toBe("ok")
      if (result.status !== "ok") return
      expect(managedCapDenies(ID_MCP_PAID, result.ruleset)).toBe(false)
    })
  })

  test("M4 系统 managed 文件损坏 ⇒ 整层 unreadable ⇒ resolver disabled(不静默丢 org deny)", async () => {
    const systemDir = tmpdir("alpha-managed-system-")
    fs.writeFileSync(path.join(systemDir, "opencode.json"), "{ broken")
    const envDir = tmpdir("alpha-managed-env-")
    writeManaged(envDir, { "*": "allow" })
    await withEnv(envDir, async () => {
      const result = await readManagedPolicy({ systemDir, plist: null })
      expect(result.status).toBe("unreadable")
      const effective = AlphaToolPolicy.resolveToolPolicy({ subject: mcpSubject(), caps: { managed: result }, user: NO_USER })
      expect(effective.state).toBe("disabled")
      expect(effective.reason.kind).toBe("cap-managed-unreadable")
    })
  })

  test("M5 MDM plist 的 deny 同样是 cap(最高优先来源)", async () => {
    const systemDir = tmpdir("alpha-managed-system-")
    writeManaged(systemDir, {})
    const result = await readManagedPolicy({
      systemDir,
      plist: { source: "mobileconfig:test", text: JSON.stringify({ permission: { [ID_MCP_PAID]: "deny" } }) },
    })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(managedCapDenies(ID_MCP_PAID, result.ruleset)).toBe(true)
  })

  test("M6 生产系统目录是平台常量(独立字面量锚点),与 env 无关", () => {
    expect(systemManagedPolicyDir("darwin")).toBe("/Library/Application Support/opencode")
    expect(systemManagedPolicyDir("linux")).toBe("/etc/opencode")
  })
})

// ═══ V. Effect service(#1129/#1130 消费的 API)════════════════════════════════
const SERVICE_BASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-policy-service-"))
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const serviceEnv = AppNodeBuilder.build(
  LayerNode.group([AlphaToolPolicy.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [
      AlphaToolPolicy.node,
      AlphaToolPolicy.layer({
        baseDir: SERVICE_BASE_DIR,
        account: Effect.succeed("acct-service"),
        managed: () => Promise.resolve({ status: "ok", ruleset: [], sources: [] }),
      }),
    ],
  ],
)
const it = testEffect(serviceEnv)

it.instance(
  "V1 service:分区来自账户与当前工作区;setRecord → resolve 生效;removeRecord 回默认",
  () =>
    Effect.gen(function* () {
      const policy = yield* AlphaToolPolicy.Service
      const { partition } = yield* policy.inspect()
      expect(partition.account).toBe("acct-service")
      expect(partition.workspace.length).toBeGreaterThan(0)

      // 默认:第三方 MCP ⇒ ask。
      expect((yield* policy.resolve(mcpSubject())).state).toBe("ask")

      yield* policy.setRecord({ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "disabled" })
      const disabled = yield* policy.resolve(mcpSubject())
      expect(disabled).toEqual({ state: "disabled", action: "deny", reason: { kind: "user", level: "tool" } })

      yield* policy.removeRecord({ level: "tool", canonical: ID_MCP_PAID })
      expect((yield* policy.resolve(mcpSubject())).state).toBe("ask")
    }),
  { git: true },
)

it.instance(
  "V2 service:quarantine 期间拒绝写入(先 reset 才能重写),resolve 全程 disabled",
  () =>
    Effect.gen(function* () {
      const policy = yield* AlphaToolPolicy.Service
      const { partition } = yield* policy.inspect()
      const file = policyFilePath(SERVICE_BASE_DIR, partition)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, "{ broken")

      expect((yield* policy.resolve(mcpSubject())).reason.kind).toBe("quarantine")

      const write = yield* policy
        .setRecord({ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "ask" })
        .pipe(Effect.exit)
      expect(write._tag).toBe("Failure")

      const { backup } = yield* policy.reset()
      expect(backup).toBeDefined()
      expect((yield* policy.resolve(mcpSubject())).state).toBe("ask")
      yield* policy.setRecord({ selector: { level: "tool", canonical: ID_MCP_PAID }, state: "ask" })
      expect((yield* policy.resolve(mcpSubject())).reason).toEqual({ kind: "user", level: "tool" })
    }),
  { git: true },
)

// ═══ 锚点核对(方向与生产相反,只证字面量没抄错)═══════════════════════════════
test("字面量锚点与生产编码一致", () => {
  expect(selectorKey({ level: "tool", canonical: ID_MCP_PAID })).toBe(JSON.stringify(["tool", ID_MCP_PAID]))
  expect(AlphaToolPolicy.mcpBindingDigest("policy", { type: "remote", url: "https://x.test/mcp" })).toMatch(
    /^sha256:[0-9a-f]{64}$/,
  )
  // 去秘密:headers/oauth 变了 digest 不变;url 变了 digest 变(rebind)。
  const base = AlphaToolPolicy.mcpBindingDigest("policy", { type: "remote", url: "https://x.test/mcp" })
  const withSecret = AlphaToolPolicy.mcpBindingDigest("policy", {
    type: "remote",
    url: "https://x.test/mcp",
    headers: { authorization: "Bearer s3cret" },
  })
  const rebound = AlphaToolPolicy.mcpBindingDigest("policy", { type: "remote", url: "https://evil.test/mcp" })
  expect(withSecret).toBe(base)
  expect(rebound).not.toBe(base)
})
