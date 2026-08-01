// REQ-128 #705 — 单装 planning builders 的 before/after parity 闸。
//
// 本票是纯重构:把 skill / agent / MCP 的 tx item 构造从 package-admission 的执行体里抽成
// ext-package-tx-builders 的三个 builder,并把 probe 组合收敛成 extensionHealthProbeRouter。
// **行为零变化是唯一验收轴**,所以这里冻结的是「事务引擎真正拿到的东西」:计划、账本模板、
// hook 面、populate 的产物、precondition 的判决、以及该计划能呈给引擎的**每一种 item 形状**
// 上的 probe 判决。字面量取自 origin/alpha@59211fe8 的实测捕获(抽取前),不是照实现回抄。
//
// 唯一一处刻意的差异也钉在这里:MCP 计划从「无 probe」变成「有 probe(恒 healthy)」。
// 它是不是 no-op 不靠推理 —— 最后一个用例直接对**真引擎**证明 config-only 计划的 probe
// 调用数为 0(engine 只对 generation 与 file item 调 probe)。

import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { agentFileProbe } from "./ext-agent-install"
import { extensionHealthProbeRouter, seedPluginFileProbe } from "./ext-health-probe-router"
import { skillGenerationProbe } from "./ext-skill-generations"
import { runExtensionTransaction, type HealthProbe, type TxPlanItem } from "./ext-transaction"
import { createPackageAdmissionCoordinator } from "./package-admission"

const SKILL_MD = "---\nname: parity-skill\ndescription: parity fixture\n---\nbody\n"
const AGENT_MD = "---\nname: parity-agent\ndescription: parity fixture\nmode: subagent\n---\nprompt body\n"
const SECRET_VERSION = "v-0123456789abcdef"

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
const canonicalBytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)

let tmp = ""
let root = ""
let userData = ""
const previousRoot = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "req128-705-parity-"))
  root = join(tmp, "root")
  userData = join(tmp, "user-data")
  mkdirSync(root, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = root
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  rmSync(tmp, { recursive: true, force: true })
})

function envelopeFor(kind: "skill" | "agent" | "mcp") {
  const profileId = kind === "mcp" ? "mcp-remote" : kind
  const assetBytes = new TextEncoder().encode(kind === "skill" ? SKILL_MD : AGENT_MD)
  const payload =
    kind === "mcp"
      ? {
          schema: "alpha.host-extension-package.payload.mcp-remote.v1",
          behavior: {
            url: "https://mcp.example.invalid/service",
            headersTemplate: { Authorization: "Bearer {A_KEY}" },
            requiredSecrets: ["A_KEY"],
            auth: "none",
          },
        }
      : {
          schema: `alpha.host-extension-package.payload.${kind}.v1`,
          behavior: {
            targetDir: kind === "skill" ? "alpha-skills" : "alpha-agents",
            asset: {
              sha256: sha(assetBytes),
              bytes: assetBytes.byteLength,
              mediaType: "text/markdown",
              url: "https://example.invalid/extension.md",
            },
          },
        }
  const payloadBytes = canonicalBytes(payload)
  const capabilities = kind === "mcp" ? ["alpha.secret-prerequisite.v1"] : []
  return {
    assetBytes,
    payloadBytes,
    envelope: {
      schema: "alpha.host-extension-package.v1",
      prelude: { packageId: `package:parity-${profileId}`, version: "1.0.0" },
      // #749 合同 v2:信封新增必填 `root`。本夹具是单组件,root 即该组件自身。
      root: `${kind}:demo`,
      presentation: { displayName: profileId, description: "REQ-128 #705 parity fixture" },
      components: [
        {
          id: `${kind}:demo`,
          required: true,
          dependencies: [],
          profileId,
          profileVersion: 1,
          capabilities,
          payloadRef: {
            sha256: sha(payloadBytes),
            bytes: payloadBytes.byteLength,
            mediaType: `application/vnd.alpha.host-extension-package.${profileId}.v1+json`,
            url: "https://example.invalid/payload.json",
          },
        },
      ],
      capabilities,
    },
  }
}

type Hooks = {
  populate?: (item: unknown, dir: string) => void
  populatePrepared?: () => void
  probePrepared?: () => unknown
  releasePrepared?: (resources: unknown[]) => void
  precondition?: () => unknown
  probe?: HealthProbe
  commitReceipt?: unknown
}

/** 跑到「引擎入口」为止:拦下事务,交出计划与 hook 面。 */
async function captureBuild(kind: "skill" | "agent" | "mcp") {
  const { envelope, payloadBytes, assetBytes } = envelopeFor(kind)
  let captured:
    | { root: string; plan: { items: TxPlanItem[]; authorization?: unknown; prepared?: unknown }; hooks: Hooks }
    | undefined
  const admit = createPackageAdmissionCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: [envelope] },
      snapshotDigest: "5".repeat(64),
    }),
    root: () => root,
    userDataPath: userData,
    environment: () => "dev",
    installability: { fetchPayload: async () => payloadBytes },
    fetchAsset: async () => assetBytes,
    secretVersionId: () => SECRET_VERSION,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    transaction: async (txRoot, plan, hooks) => {
      captured = { root: txRoot, plan, hooks }
      return { ok: false, stage: "staging", reason: "parity capture: transaction intercepted" }
    },
  })
  const intent = {
    catalogId: envelope.prelude.packageId,
    scope: { scope: "global" as const },
    attemptId: `parity-${kind}`,
  }
  const preview = (await admit(intent)) as {
    authorization: Array<{ key: string; requested: string[] }>
    packageAuthorization: { binding: unknown }
  }
  await admit({
    ...intent,
    ...(kind === "mcp" ? { grants: { secrets: { "mcp:demo#A_KEY": "PARITY_SECRET_VALUE" } } } : {}),
    authorization: {
      confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
      binding: preview.packageAuthorization.binding,
    },
  })
  if (!captured) throw new Error(`${kind}: the transaction engine was never reached`)
  return captured
}

describe("REQ-128 #705 single-install builder parity", () => {
  test("skill: plan, receipt, hook surface, populate and precondition are unchanged", async () => {
    const { root: txRoot, plan, hooks } = await captureBuild("skill")
    expect(txRoot).toBe(root)
    expect(Object.keys(hooks).sort()).toEqual(["commitReceipt", "populate", "precondition", "probe"])
    expect(plan.items).toEqual([
      {
        key: "skill--demo",
        files: [{ path: "SKILL.md", sha256: sha(SKILL_MD), size: 60 }],
        manifestDigest: plan.items[0]!.manifestDigest,
        capabilities: [],
        receipt: {
          id: "skill:demo",
          name: "demo",
          kind: "skill",
          environment: "dev",
          scope: { kind: "global" },
          version: "1.0.0",
          manifestDigest: plan.items[0]!.manifestDigest,
          payloadDigest: (plan.items[0]!.receipt as { payloadDigest: string }).payloadDigest,
          grantDigest: "sha256:e63ffda29c91acbee6af26541abd8752aafed9091e115c03dd563e14695d6fa9",
          desiredState: "disabled",
          origin: "catalog",
          installedAt: "2026-07-31T00:00:00.000Z",
        },
      },
    ])
    expect(plan.authorization).toEqual({ confirmed: { "skill--demo": [] }, decidedAt: "2026-07-31T00:00:00.000Z" })
    const staging = join(tmp, "staging")
    mkdirSync(staging, { recursive: true })
    hooks.populate!(plan.items[0], staging)
    expect(readdirSync(staging)).toEqual(["SKILL.md"])
    expect(readFileSync(join(staging, "SKILL.md"), "utf8")).toBe(SKILL_MD)
    expect(hooks.precondition!()).toEqual({ ok: true })
  })

  test("agent: file + config double item, receipt files/configKey, requireAbsent are unchanged", async () => {
    const { plan, hooks } = await captureBuild("agent")
    expect(Object.keys(hooks).sort()).toEqual(["commitReceipt", "populate", "precondition", "probe"])
    expect(plan.items).toHaveLength(2)
    const file = plan.items[0]!
    expect(file.key).toBe("agent--demo")
    expect(file.action).toBe("file")
    expect(file.file!.relTarget).toBe("agents/demo.md")
    expect(file.file!.requireAbsent).toBe(true)
    expect(sha(file.file!.next)).toBe(sha(AGENT_MD))
    expect(file.capabilities).toEqual([])
    expect(file.receipt).toMatchObject({
      id: "agent:demo",
      kind: "agent",
      desiredState: "disabled",
      files: [join(root, "agents/demo.md")],
      configKey: "agent.demo",
      installedAt: "2026-07-31T00:00:00.000Z",
    })
    const config = plan.items[1]!
    expect(config.key).toBe("agent--demo--config")
    expect(config.action).toBe("config")
    expect(config.capabilities).toBeUndefined()
    expect(config.receipt).toBeUndefined()
    expect(config.config).toEqual({
      target: join(root, "alpha.jsonc"),
      edits: [
        {
          keyPath: ["agent", "demo"],
          // desiredState=disabled ⇒ 引擎原生 disable:true 投影(#395)。
          value: { description: "parity fixture", mode: "subagent", prompt: "prompt body", disable: true },
        },
      ],
    })
    // agent 不经 populate(file 适配器自己落 staging)。
    const staging = join(tmp, "staging-agent")
    mkdirSync(staging, { recursive: true })
    for (const item of plan.items) hooks.populate!(item, staging)
    expect(readdirSync(staging)).toEqual([])
    expect(hooks.precondition!()).toEqual({ ok: true })
  })

  test("mcp: config item, secret refs, prepared resource and precondition are unchanged", async () => {
    const { plan, hooks } = await captureBuild("mcp")
    // #712 是这份 parity 冻结面上**唯一**一处有意的偏离:hook 面多出 releasePrepared,plan 多出
    // 类型化 prepared descriptor(见下)。#705 冻结的其余各项(item 形状/账本模板/populate 产物/
    // precondition 判决/probe 判决)保持逐字不变。
    expect(Object.keys(hooks).sort()).toEqual([
      "commitReceipt",
      "populate",
      "populatePrepared",
      "precondition",
      "probe",
      "probePrepared",
      "releasePrepared",
    ])
    // 计划里的 prepared 面 = **只有身份**。多一个字段(files/明文/摘要)引擎 validatePlan 就拒。
    expect(plan.prepared).toEqual([
      { kind: "mcp-secret-version", store: "alpha-mcp-secrets", server: "demo", version: SECRET_VERSION },
    ])
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]!
    expect(item.key).toBe("mcp--demo")
    expect(item.action).toBe("config")
    expect(item.capabilities).toEqual(["alpha.secret-prerequisite.v1"])
    const secretFile = join(userData, "alpha-mcp-secrets", "demo", SECRET_VERSION, "A_KEY")
    expect(item.config).toEqual({
      target: join(root, "alpha.jsonc"),
      edits: [
        {
          keyPath: ["mcp", "demo"],
          value: {
            type: "remote",
            url: "https://mcp.example.invalid/service",
            headers: { Authorization: `Bearer {file:${secretFile}}` },
            enabled: false,
          },
        },
      ],
    })
    expect(item.receipt).toMatchObject({ id: "mcp:demo", kind: "mcp", configKey: "mcp.demo" })
    // prepared resource:填充前不健康、填充后健康,密钥只落版本目录内的那一个文件。
    expect(hooks.probePrepared!()).toEqual({ healthy: false, reason: "prepared secret file is missing" })
    hooks.populatePrepared!()
    expect(hooks.probePrepared!()).toEqual({ healthy: true, reason: "prepared secret file is missing" })
    expect(readFileSync(secretFile, "utf8")).toBe("PARITY_SECRET_VALUE")
    expect(readdirSync(join(userData, "alpha-mcp-secrets", "demo"))).toEqual([SECRET_VERSION])
    expect(hooks.precondition!()).toEqual({ ok: true })
    // 计划与账本模板都不得携带密钥明文。
    expect(JSON.stringify(plan)).not.toContain("PARITY_SECRET_VALUE")
  })

  // 每个计划能呈给引擎的 item 形状 × 相位 × 内容状态 —— 判决逐条冻结(抽取前实测)。
  test("probe verdicts for every item shape each plan can present are unchanged", async () => {
    const fixtures = join(tmp, "fixtures")
    const genGood = join(fixtures, "gen-good")
    const genBad = join(fixtures, "gen-bad")
    mkdirSync(genGood, { recursive: true })
    mkdirSync(genBad, { recursive: true })
    writeFileSync(join(genGood, "SKILL.md"), SKILL_MD.replace("parity-skill", "demo"))
    writeFileSync(join(genBad, "SKILL.md"), "no frontmatter here")
    const mdGood = join(fixtures, "good.md")
    const mdBad = join(fixtures, "bad.md")
    writeFileSync(mdGood, AGENT_MD.replace("parity-agent", "demo"))
    writeFileSync(mdBad, "not an agent md")
    const base = { genId: "gen-000000-000000", generationDir: genGood }

    const skill = (await captureBuild("skill")).hooks.probe!
    expect(await skill({ ...base, key: "skill--demo", action: "generation", phase: "pre-switch" })).toEqual({
      healthy: true,
    })
    expect(await skill({ ...base, key: "skill--demo", action: "generation", phase: "post-switch" })).toEqual({
      healthy: true,
    })
    expect(
      await skill({ ...base, generationDir: genBad, key: "skill--demo", action: "generation", phase: "pre-switch" }),
    ).toEqual({ healthy: false, reason: 'skill "demo": 非法 frontmatter:缺少 --- 头' })
    expect(
      await skill({ ...base, generationDir: genBad, key: "skill--demo", action: "generation", phase: "recovery" }),
    ).toEqual({ healthy: false, reason: 'skill "demo": 非法 frontmatter:缺少 --- 头' })

    const agent = (await captureBuild("agent")).hooks.probe!
    expect(
      await agent({
        ...base,
        key: "agent--demo",
        action: "file",
        phase: "pre-switch",
        stagedFile: mdGood,
        fileDigest: sha(readFileSync(mdGood)),
      }),
    ).toEqual({ healthy: true })
    expect(
      await agent({
        ...base,
        key: "agent--demo",
        action: "file",
        phase: "pre-switch",
        stagedFile: mdBad,
        fileDigest: sha(readFileSync(mdBad)),
      }),
    ).toEqual({ healthy: false, reason: 'agent "demo": md not convertible: missing frontmatter' })
    expect(
      await agent({
        ...base,
        key: "agent--demo",
        action: "file",
        phase: "pre-switch",
        stagedFile: mdGood,
        fileDigest: "0".repeat(64),
      }),
    ).toEqual({ healthy: false, reason: 'agent "demo": staged md digest mismatch' })
    expect(
      await agent({
        ...base,
        key: "agent--demo",
        action: "file",
        phase: "post-switch",
        fileTarget: mdGood,
        fileDigest: sha(readFileSync(mdGood)),
      }),
    ).toEqual({ healthy: false, reason: 'agent "demo": live config not readable' })
    expect(
      await agent({
        ...base,
        key: "agent--demo",
        action: "file",
        phase: "recovery",
        fileTarget: join(root, "missing.md"),
      }),
    ).toEqual({ healthy: false, reason: 'agent "demo": live md not readable' })
    for (const phase of ["pre-switch", "post-switch"] as const)
      expect(await agent({ ...base, key: "agent--demo--config", action: "config", phase })).toEqual({ healthy: true })

    const mcp = (await captureBuild("mcp")).hooks.probe!
    for (const phase of ["pre-switch", "post-switch", "recovery"] as const)
      expect(await mcp({ ...base, key: "mcp--demo", action: "config", phase })).toEqual({ healthy: true })
  })

  // #705 之前 MCP 计划根本没有 probe hook。现在有了 —— 证明它是 no-op 的方式不是「读代码觉得」,
  // 而是让**真引擎**跑一个 config-only 计划并数调用次数。数字必须是 0。
  test("the engine never probes a config-only plan — the MCP path's added probe is provably inert", async () => {
    let probeCalls = 0
    const probe: HealthProbe = (input) => {
      probeCalls++
      return { healthy: false, reason: `probe must not be called for ${input.action} item "${input.key}"` }
    }
    const result = await runExtensionTransaction(
      root,
      {
        items: [
          {
            key: "mcp--inert",
            action: "config",
            config: { target: join(root, "alpha.jsonc"), edits: [{ keyPath: ["mcp", "inert"], value: { type: "local", command: ["demo"] } }] },
            capabilities: [],
          },
        ],
        authorization: { confirmed: { "mcp--inert": [] }, decidedAt: "2026-07-31T00:00:00.000Z" },
      },
      { populate: () => {}, probe, log: () => {} },
    )
    expect(result.ok).toBe(true)
    expect(probeCalls).toBe(0)
  })

  // router 与 #705 之前那份手写组合(ext-ipc 恢复接线)在全部 item 形状上判决相同。
  test("extensionHealthProbeRouter is verdict-identical to the pre-#705 hand-written composition", async () => {
    const legacy: HealthProbe = async (input) => {
      const gen = await skillGenerationProbe(input)
      if (!gen.healthy) return gen
      if (input.action !== "file") return { healthy: true }
      return input.key.startsWith("agent--") ? agentFileProbe(root)(input) : seedPluginFileProbe()(input)
    }
    const router = extensionHealthProbeRouter(root)
    const fixtures = join(tmp, "router-fixtures")
    mkdirSync(fixtures, { recursive: true })
    const genDir = join(fixtures, "gen")
    mkdirSync(genDir, { recursive: true })
    writeFileSync(join(genDir, "SKILL.md"), SKILL_MD.replace("parity-skill", "demo"))
    const md = join(fixtures, "a.md")
    writeFileSync(md, AGENT_MD.replace("parity-agent", "demo"))
    const inputs = [
      { key: "skill--demo", action: "generation" as const, phase: "pre-switch" as const, genId: "g", generationDir: genDir },
      { key: "skill--missing", action: "generation" as const, phase: "post-switch" as const, genId: "g", generationDir: fixtures },
      { key: "agent--demo", action: "file" as const, phase: "pre-switch" as const, genId: "g", generationDir: genDir, stagedFile: md, fileDigest: sha(readFileSync(md)) },
      { key: "agent--demo", action: "file" as const, phase: "recovery" as const, genId: "g", generationDir: genDir, fileTarget: md },
      { key: "agent--demo--config", action: "file" as const, phase: "pre-switch" as const, genId: "g", generationDir: genDir, stagedFile: md },
      { key: "plugin--demo--f0", action: "file" as const, phase: "pre-switch" as const, genId: "g", generationDir: genDir, stagedFile: md, fileDigest: sha(readFileSync(md)) },
      { key: "plugin--demo--f0", action: "file" as const, phase: "pre-switch" as const, genId: "g", generationDir: genDir, stagedFile: md, fileDigest: "1".repeat(64) },
      { key: "mystery--x", action: "file" as const, phase: "pre-switch" as const, genId: "g", generationDir: genDir, stagedFile: md },
      { key: "mcp--demo", action: "config" as const, phase: "post-switch" as const, genId: "g", generationDir: genDir },
      { key: "cloud--demo", action: "receipt" as const, phase: "post-switch" as const, genId: "g", generationDir: genDir },
    ]
    for (const input of inputs) expect(await router(input)).toEqual(await legacy(input))
    // 未登记的 file item 必须仍然 fail-closed(组合收敛不得变成静默放行)。
    expect(await router(inputs[7]!)).toEqual({
      healthy: false,
      reason: 'no typed probe for file item "mystery--x" — refusing (fail closed)',
    })
  })
})
