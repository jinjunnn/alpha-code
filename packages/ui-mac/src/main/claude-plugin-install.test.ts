// REQ-128 Phase 3 `[T2-install]`(#781)—— 一次事务装 N 个多文件技能 + V3 包图落账 + 默认关。
//
// 本文件里每一道闸都配一条**绕过配方**;写不出绕过的闸判为假闸,不许留下充数(基线 §6 首句)。
// 判决全部落在**可观察结果**上:账本文件、盘上目录、派生允许集、真实卸载路径的回答 ——
// 不是「函数返回了 ok」。
//
// 夹具一律用**生产写器**造:preview 走 T1 的 `previewLocalClaudePlugin`,安装走
// `installLocalClaudePluginV1`,卸载走生产的 `uninstallByKey` / `uninstallPackageV1`。
// 手搓的账本只能证明解码器读得懂我写的东西,证明不了生产路径写得出这个形状。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { previewLocalClaudePlugin, type LocalPackagePreviewV1 } from "./claude-plugin-intake"
import {
  buildLocalPackageInstallPlanV1,
  collectLocalPackagePayloadsV1,
  installLocalClaudePluginV1,
  type LocalPackageInstallDepsV1,
  type LocalPackagePayloadV1,
} from "./claude-plugin-install"
import { casBlobPath } from "./ext-cas"
import {
  removeInstallGrants,
  uninstallByKey,
  type ConfigOutcome,
  type FsOutcome,
  type PlannerDeps,
  type PlannerInstallers,
  type TargetArg,
} from "./ext-install-planner"
import {
  bundleOwner,
  computeInstalledGraphDigest,
  validateV3State,
  type PackageGraphV1,
  type PackageMutationEnvelopeV1,
} from "./ext-package-ledger-v3"
import { uninstallPackageV1, type PackageArtifactInstallersV1 } from "./ext-package-uninstall"
import {
  packageClaimOwners,
  readLedgerV2,
  readPackageGraphs,
  setDesiredStateV2,
  skillsEnabledPath,
  upsertRecordsV2,
  type UpsertInput,
} from "./ext-receipt-v2"
import { skillGenerationKey, skillStorePaths } from "./ext-skill-generations"
import { resolveLiveGenerationDir, runExtensionTransaction } from "./ext-transaction"

let tmp = ""
let root = ""
let casBase = ""
let pluginDir = ""
let deps: LocalPackageInstallDepsV1

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-local-pkg-"))
  root = path.join(tmp, "alpha-root")
  casBase = path.join(tmp, "cas-base")
  pluginDir = path.join(tmp, "tide-plugin")
  fs.mkdirSync(root, { recursive: true })
  deps = { globalRoot: () => root, casBaseRoot: () => casBase, environment: () => "prod" }
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ── 夹具 ──────────────────────────────────────────────────────────────────────────────────

type SkillSpec = { name: string; extra?: Record<string, string> }

/** 造一个真实形状的 Claude 插件目录:`.claude-plugin/plugin.json` + `skills/<n>/SKILL.md`。 */
function makePlugin(pluginName: string, skills: SkillSpec[], options: { version?: string } = {}): void {
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: pluginName, description: `${pluginName} 插件`, ...(options.version ? { version: options.version } : {}) }, null, 2),
  )
  for (const skill of skills) {
    const dir = path.join(pluginDir, "skills", skill.name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.name} 干什么用的\n---\n\n# ${skill.name}\n`)
    for (const [rel, content] of Object.entries(skill.extra ?? {})) {
      const target = path.join(dir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
  }
}

const preview = (): LocalPackagePreviewV1 => previewLocalClaudePlugin(fs.realpathSync(pluginDir))

function payloadsOf(p: LocalPackagePreviewV1): LocalPackagePayloadV1[] {
  const collected = collectLocalPackagePayloadsV1(fs.realpathSync(pluginDir), p)
  if (!collected.ok) throw new Error(`fixture: 载荷采集失败:${collected.reason}`)
  return collected.payloads
}

async function install(): Promise<ReturnType<typeof installLocalClaudePluginV1>> {
  const p = preview()
  return installLocalClaudePluginV1({ pluginRoot: fs.realpathSync(pluginDir), preview: p, payloads: payloadsOf(p) }, deps)
}

// ── 可观察结果的读取面(断言账本与磁盘,不是返回值)────────────────────────────────────────

const ledgerFile = (): string => path.join(root, "installs.json")
const ledgerBytes = (): string => (fs.existsSync(ledgerFile()) ? fs.readFileSync(ledgerFile(), "utf8") : "<absent>")
const recordNames = (): string[] => readLedgerV2(root).records.map((r) => `${r.kind}:${r.name}`).sort()
const graphKeys = (): string[] =>
  readPackageGraphs(root).flatMap((g) => [g.root, ...g.children].map((n) => `${n.kind}:${n.name}`)).sort()
const storeDirs = (): string[] => {
  try {
    return fs.readdirSync(path.join(root, "ext-store")).sort()
  } catch {
    return []
  }
}
/** live generation 目录由**生产的**指针解析给出;内容比对随后由独立扫描做(见 `independentScan`)。 */
const liveSkillDir = (name: string): string | null => resolveLiveGenerationDir(root, skillGenerationKey(name))
const enabledSkillKeys = (): string[] => {
  try {
    const parsed = JSON.parse(fs.readFileSync(skillsEnabledPath(root), "utf8")) as { keys?: string[] }
    return parsed.keys ?? []
  } catch {
    return []
  }
}

/** 对源目录做**独立于生产采集器**的递归扫描。G3 的比较基准必须是这个 ——
 *  拿 `collectImportSkillPayload().files[]` 当基准是拿实现自己拼的等价链当断言:
 *  凡它悄悄丢掉的(symlink、`.git`/`node_modules`/`__pycache__`)结构上永远不会红。 */
function independentScan(dir: string): Array<{ rel: string; bytes: number; sha: string }> {
  const out: Array<{ rel: string; bytes: number; sha: string }> = []
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(childRel)
        continue
      }
      if (!entry.isFile()) continue
      const data = fs.readFileSync(path.join(dir, childRel))
      out.push({ rel: childRel, bytes: data.length, sha: createHash("sha256").update(data).digest("hex") })
    }
  }
  walk("")
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

// ── 生产卸载路径的注入面(与 `ext-package-ledger-uninstall.test.ts` 同形:假件真删)────────

function artifactInstallers(calls: string[]): PackageArtifactInstallersV1 {
  return {
    removeFsInstall: (type, name): FsOutcome => {
      calls.push(`removeFsInstall:${type}:${name}`)
      const target = path.join(root, type === "skill" ? "skills" : "agents", name)
      fs.rmSync(target, { recursive: true, force: true })
      return { ok: true, files: [target] }
    },
    removeMcpConfig: () => ({ ok: true }),
    removeMcpSecretsStrict: () => ({ ok: true }),
    releaseAlphaConnectionBindings: () => ({ ok: true }),
    // 授权账清除走**生产那一个**函数(ext-store 下的 grants.json 是事务拥有的路径)。
    removeInstallGrants,
  }
}

function plannerDeps(calls: string[]): PlannerDeps {
  const refuse = (fn: string) => (): never => {
    throw new Error(`install-only installer ${fn} must not run on an uninstall path`)
  }
  const installers: PlannerInstallers = {
    applyMcpWritePolicy: refuse("applyMcpWritePolicy"),
    mcpSecretRefFor: refuse("mcpSecretRefFor"),
    claimMcpSecretVersionDir: refuse("claimMcpSecretVersionDir"),
    writeMcpSecretVersioned: refuse("writeMcpSecretVersioned"),
    removeMcpSecretVersionDir: refuse("removeMcpSecretVersionDir"),
    gcMcpSecrets: () => ({ removed: [], warnings: [] }),
    legacyMcpRefPaths: refuse("legacyMcpRefPaths"),
    readMcpLeafStrict: refuse("readMcpLeafStrict"),
    removeMcpConfigInLock: (): ConfigOutcome => ({ ok: true }),
    removeMcpSecretsStrict: () => ({ ok: true }),
    releaseAlphaConnectionBindings: () => ({ ok: true }),
    findPluginBaseConflictStrict: refuse("findPluginBaseConflictStrict"),
    readPluginArrayStrict: refuse("readPluginArrayStrict"),
    readLegacyPluginArrayStrict: refuse("readLegacyPluginArrayStrict"),
    mcpConfigTruthPath: () => path.join(root, "alpha.jsonc"),
    stageVendoredPluginVersioned: refuse("stageVendoredPluginVersioned"),
    removePlugin: (): ConfigOutcome => ({ ok: true }),
    collectVendoredPluginPayload: refuse("collectVendoredPluginPayload"),
    removePluginPath: (): ConfigOutcome => ({ ok: true }),
    installBuiltinSkill: refuse("installBuiltinSkill"),
    collectBuiltinSkillPayload: refuse("collectBuiltinSkillPayload"),
    collectBuiltinAgentPayload: refuse("collectBuiltinAgentPayload"),
    installRemoteSkill: refuse("installRemoteSkill"),
    removeFsInstall: (type: "skill" | "agent", name: string, _target?: TargetArg): FsOutcome => {
      calls.push(`removeFsInstall:${type}:${name}`)
      const target = path.join(root, type === "skill" ? "skills" : "agents", name)
      fs.rmSync(target, { recursive: true, force: true })
      return { ok: true, files: [target] }
    },
    agentPresent: refuse("agentPresent"),
    downloadRemoteAsset: refuse("downloadRemoteAsset"),
  }
  return {
    advisoryGate: () => ({ allowed: true }),
    resolveEntry: async () => null,
    environment: () => "prod",
    platform: () => "darwin",
    globalRoot: () => root,
    casBaseRoot: () => casBase,
    installers,
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// G15 —— 四集双射(本票第一 AC)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G15 四集双射:装了 N 个,图里就得有 N 个", () => {
  test("三个技能一次装完:record / 图节点 / claim 三者逐字同一集合", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }, { name: "riskscan" }])
    const outcome = await install()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.packageId).toBe("local:tide-plugin")
    expect(outcome.installed.sort()).toEqual(["postmarket", "premarket", "riskscan"])

    const expected = ["skill:postmarket", "skill:premarket", "skill:riskscan"]
    expect(recordNames()).toEqual(expected)
    expect(graphKeys()).toEqual(expected)
    for (const name of ["premarket", "postmarket", "riskscan"])
      expect(packageClaimOwners(root, "skill", name)).toEqual([bundleOwner("local:tide-plugin", readPackageGraphs(root)[0]!.root.manifestDigest)])
    expect(storeDirs()).toEqual(["skill--postmarket", "skill--premarket", "skill--riskscan"])
  })

  test("整包卸载之后:record / generation 目录 / claim **三清零**", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }, { name: "riskscan" }])
    expect((await install()).ok).toBe(true)
    const calls: string[] = []
    const removed = uninstallPackageV1("local:tide-plugin", { globalRoot: () => root, installers: artifactInstallers(calls) })
    expect(removed.ok).toBe(true)
    expect(recordNames()).toEqual([])
    expect(graphKeys()).toEqual([])
    expect(storeDirs()).toEqual([])
    for (const name of ["premarket", "postmarket", "riskscan"]) expect(packageClaimOwners(root, "skill", name)).toEqual([])
  })

  // 这条用例证明**这道闸是承重的,不是装饰**:把图里少写一个节点(item 照留),
  // 账本、探针、安装全绿,而用户会看到 N−1 个组件,整包卸载之后漏掉的那个继续留在盘上、
  // 还能被单独卸掉。`validateV3State` 抓不到它 —— 它只走「图→claim→record」,没有反向。
  test("洞是真的:图少一个节点 ⇒ 全绿落账,整包卸载后那一个仍在盘上且可单独卸载", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    const p = preview()
    const built = buildLocalPackageInstallPlanV1({ pluginRoot: fs.realpathSync(pluginDir), preview: p, payloads: payloadsOf(p) }, deps)
    expect(built.ok).toBe(true)
    if (!built.ok) return

    // 绕过 G15 的那次派生:从图与 claim 里摘掉一个 leaf,它的 item(带 receipt)原样留着。
    const orphan = built.plan.graph.children[0]!.name
    const kept = built.plan.graph.root.name
    const items = built.plan.plan.items.map((item) => {
      if (item.packageMutation === undefined) return item
      const envelope = item.packageMutation as PackageMutationEnvelopeV1
      const shrunk = { ...envelope.graphAfter!, children: envelope.graphAfter!.children.filter((n) => n.name !== orphan) }
      const graphAfter: PackageGraphV1 = { ...shrunk, installedGraphDigest: computeInstalledGraphDigest(shrunk) }
      return {
        ...item,
        packageMutation: {
          ...envelope,
          graphAfter,
          claimMutations: envelope.claimMutations.filter((m) => m.name !== orphan),
        } satisfies PackageMutationEnvelopeV1,
      }
    })
    const result = await runExtensionTransaction(root, { items }, built.plan.hooks)
    expect(result.ok).toBe(true) // ← 账本层面完全自洽,一句警告都没有

    expect(recordNames()).toEqual([`skill:${kept}`, `skill:${orphan}`].sort()) // 两条 record
    expect(graphKeys()).toEqual([`skill:${kept}`]) // 图里只有一个
    expect(
      validateV3State({
        recordKeys: new Set(recordNames()),
        packageGraphs: readPackageGraphs(root),
        claims: [{ kind: "skill", name: kept, owners: packageClaimOwners(root, "skill", kept) }],
      }),
    ).toEqual({ ok: true }) // ← 探针说这本账没问题

    // 整包卸载之后,游离的那个还在,而且**可以被单独卸掉**(没有任何 Bundle owner 认领它)。
    const calls: string[] = []
    expect(uninstallPackageV1("local:tide-plugin", { globalRoot: () => root, installers: artifactInstallers(calls) }).ok).toBe(true)
    expect(recordNames()).toEqual([`skill:${orphan}`])
    expect(liveSkillDir(orphan)).not.toBeNull()
    const solo = await uninstallByKey({ type: "skill", name: orphan, scope: "global" }, plannerDeps(calls))
    expect(solo.ok).toBe(true)
  })

  test("闸本身:预览可装集与派生集不一致 ⇒ 整次拒绝,零写盘", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    const p = preview()
    const payloads = payloadsOf(p)
    // 少给一份留存载荷 = 「派生出来的四件东西不再是同一个集合」的最小可达形态。
    const built = buildLocalPackageInstallPlanV1(
      { pluginRoot: fs.realpathSync(pluginDir), preview: p, payloads: payloads.filter((entry) => entry.name !== "postmarket") },
      deps,
    )
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.code).toBe("payload-mismatch")
    expect(recordNames()).toEqual([])
    expect(storeDirs()).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G3 —— 多文件技能一个文件都不能少
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G3 载荷完整:比较基准是对源目录的独立扫描", () => {
  test("多文件技能装完之后,generation 目录与源目录逐条相等", async () => {
    makePlugin("tide-plugin", [
      {
        name: "premarket",
        extra: {
          "scripts/fetch.py": "print('fetch')\n",
          "references/glossary.md": "# 名词表\n",
          "references/deep/notes.md": "深一层\n",
        },
      },
      { name: "postmarket" },
    ])
    expect((await install()).ok).toBe(true)

    const live = liveSkillDir("premarket")
    expect(live).not.toBeNull()
    const source = independentScan(path.join(fs.realpathSync(pluginDir), "skills", "premarket"))
    expect(source.map((f) => f.rel)).toEqual(["SKILL.md", "references/deep/notes.md", "references/glossary.md", "scripts/fetch.py"])
    expect(independentScan(live!)).toEqual(source)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G1 —— 原子性
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G1 原子性:第 k 个装不上 ⇒ 一个都不留", () => {
  // 「一次事务」这件事必须由**生产入口**的可观察产物证明,不是由我自己拼的一条等价链证明:
  // 三条 record 上的 `transaction.id` 逐字相同 = 它们出自同一个 txId。改回「一个技能一个事务」
  // 的 for 循环(= B 的形状),这条立刻红 —— 那时会有三个不同的 txId。
  test("生产入口:N 条 record 携带的是**同一个** transactionId", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }, { name: "riskscan" }])
    expect((await install()).ok).toBe(true)
    const txIds = new Set(readLedgerV2(root).records.map((r) => r.transaction?.id ?? "<none>"))
    expect(readLedgerV2(root).records).toHaveLength(3)
    expect([...txIds]).toHaveLength(1)
    expect([...txIds][0]).not.toBe("<none>")
  })

  test("第三个技能的内容在 CAS 里没了 ⇒ 账本零条、盘上零目录、V3 零图零 claim", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }, { name: "riskscan" }])
    const p = preview()
    const payloads = payloadsOf(p)
    const built = buildLocalPackageInstallPlanV1({ pluginRoot: fs.realpathSync(pluginDir), preview: p, payloads }, deps)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    // 把第三个技能的 CAS blob 抹掉(盘损坏是真实可达状态)⇒ populate 阶段整事务 abort。
    const doomed = built.plan.plan.items.find((item) => item.key === skillGenerationKey("riskscan"))!
    fs.rmSync(casBlobPath(casBase, doomed.files![0]!.sha256), { force: true })

    const result = await runExtensionTransaction(root, built.plan.plan, built.plan.hooks)
    expect(result.ok).toBe(false)

    expect(recordNames()).toEqual([])
    expect(graphKeys()).toEqual([])
    expect(fs.existsSync(path.join(root, "skills"))).toBe(false)
    for (const name of ["premarket", "postmarket", "riskscan"]) {
      expect(liveSkillDir(name)).toBeNull()
      expect(packageClaimOwners(root, "skill", name)).toEqual([])
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G2 + 第 8 跳 —— 分组不可被绕过
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G2 分组不可绕:包内单个技能走既有卸载路径必须被拒", () => {
  test("`uninstallByKey` 被 `directUninstallVerdict` 拒绝,且实物与账本一个字节不动", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    expect((await install()).ok).toBe(true)
    const before = ledgerBytes()
    const liveBefore = liveSkillDir("postmarket")
    expect(liveBefore).not.toBeNull()
    const filesBefore = independentScan(liveBefore!)

    const calls: string[] = []
    const refused = await uninstallByKey({ type: "skill", name: "postmarket", scope: "global" }, plannerDeps(calls))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.reason).toContain("uninstall the package instead")
    expect(refused.reason).toContain("local:tide-plugin")

    expect(calls).toEqual([]) // 没有任何 installer 被调用 = 实物删除根本没起跑
    expect(ledgerBytes()).toBe(before)
    expect(independentScan(liveSkillDir("postmarket")!)).toEqual(filesBefore)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G4 + G5 —— 同名预检(复用既有 `uncuratedSkillFreshGate`,不是替身)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G4 不静默改写/认领用户既有内容", () => {
  const zeroWrite = (): void => {
    expect(recordNames()).toEqual([])
    expect(graphKeys()).toEqual([])
    expect(storeDirs()).toEqual([])
  }

  test("负向夹具①:账本损坏 ⇒ 整次零写", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    fs.writeFileSync(ledgerFile(), "{ 这不是 json")
    const outcome = await install()
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(["preview-stale", "package-already-installed"]).toContain(outcome.code)
    expect(storeDirs()).toEqual([])
  })

  test("负向夹具②:同名 v2 record 已在册(catalog 装的)⇒ 具名拒绝,不走到 mutation(G5)", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    const catalogRecord: UpsertInput = {
      id: "skill:premarket",
      name: "premarket",
      kind: "skill",
      environment: "prod",
      scope: { kind: "global" },
      version: "1.0.0",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      desiredState: "enabled",
      origin: "catalog",
      installedAt: "2026-08-01T00:00:00.000Z",
    }
    expect(upsertRecordsV2(root, [catalogRecord]).ok).toBe(true)
    const before = ledgerBytes()

    const outcome = await install()
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe("preview-stale")
    // G5:错误信息必须指向真因(这个技能已经在了),**不是**一句
    // 「non-catalog origin must not carry supply-chain digests」那种驴唇不对马嘴的供给链错误。
    expect(outcome.reason).toContain("premarket")
    expect(outcome.reason).toContain("is a catalog install — uninstall it first")
    expect(outcome.reason).not.toContain("supply-chain")
    expect(ledgerBytes()).toBe(before)
    expect(storeDirs()).toEqual([])
  })

  test("负向夹具③:**无账本的** flat 技能目录在场 ⇒ 拒绝认领,整次零写", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    fs.mkdirSync(path.join(root, "skills", "postmarket"), { recursive: true })
    fs.writeFileSync(path.join(root, "skills", "postmarket", "SKILL.md"), "---\nname: postmarket\ndescription: 用户自己放的\n---\n")
    const outcome = await install()
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain("without a ledger record")
    zeroWrite()
    // 用户自己那份逐字还在。
    expect(fs.readFileSync(path.join(root, "skills", "postmarket", "SKILL.md"), "utf8")).toContain("用户自己放的")
  })

  test("负向夹具④:**残留 generation store** 在场(无健康 current)⇒ 拒绝认领,整次零写", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    fs.mkdirSync(skillStorePaths(root, "premarket").store, { recursive: true })
    const outcome = await install()
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain("not a healthy generation")
    expect(recordNames()).toEqual([])
    expect(graphKeys()).toEqual([])
  })

  test("并发夹具:preview 之后、拿到锁之前被别人占了同名 ⇒ **锁内** precondition 拒,整次零写", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    const p = preview()
    const built = buildLocalPackageInstallPlanV1({ pluginRoot: fs.realpathSync(pluginDir), preview: p, payloads: payloadsOf(p) }, deps)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    // 锁外预检已经过了。现在(计划已建、事务未跑)另一个安装占用了同名技能。
    fs.mkdirSync(path.join(root, "skills", "premarket"), { recursive: true })

    const result = await runExtensionTransaction(root, built.plan.plan, built.plan.hooks)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe("precondition")
    expect(result.reason).toContain("预览已过期")
    expect(recordNames()).toEqual([])
    expect(graphKeys()).toEqual([])
    expect(storeDirs()).toEqual([])
  })

  test("预览已过期 ⇒ **整次**零写,不许把冲突的那个静默摘掉继续装另一个", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    fs.mkdirSync(path.join(root, "skills", "premarket"), { recursive: true })
    fs.writeFileSync(path.join(root, "skills", "premarket", "SKILL.md"), "---\nname: premarket\ndescription: x\n---\n")
    expect((await install()).ok).toBe(false)
    // 没有冲突的那个也**没有**被装进去 —— 这正是「不许临时改 accepted 集」。
    expect(recordNames()).toEqual([])
    expect(liveSkillDir("postmarket")).toBeNull()
  })

  test("重复导入同一个包 ⇒ 在确认之前具名说清「先移除整包」", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }])
    expect((await install()).ok).toBe(true)
    const before = ledgerBytes()
    const again = await install()
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.code).toBe("package-already-installed")
    expect(again.reason).toContain("先移除整包")
    expect(ledgerBytes()).toBe(before)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G7 —— 引擎授权闸(生产变异版)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G7 引擎授权闸在这条路上是空的,但接线是真的", () => {
  test("本地计划的 capabilities 恒空集", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    const p = preview()
    const built = buildLocalPackageInstallPlanV1({ pluginRoot: fs.realpathSync(pluginDir), preview: p, payloads: payloadsOf(p) }, deps)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    for (const item of built.plan.plan.items) expect(item.capabilities).toEqual([])
  })

  test("把 capabilities 改成非空且不给授权 ⇒ 真实事务**停在 authorize、零安装**", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    const p = preview()
    const built = buildLocalPackageInstallPlanV1({ pluginRoot: fs.realpathSync(pluginDir), preview: p, payloads: payloadsOf(p) }, deps)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const mutated = {
      ...built.plan.plan,
      items: built.plan.plan.items.map((item, index) => (index === 0 ? { ...item, capabilities: ["fs:write"] } : item)),
    }
    const result = await runExtensionTransaction(root, mutated, built.plan.hooks)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stage).toBe("authorize")
    expect(recordNames()).toEqual([])
    expect(graphKeys()).toEqual([])
    expect(storeDirs()).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G10 —— 装完默认关(owner 裁决 B)
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("G10 装完默认关,用户自己开", () => {
  test("逐条 `desiredState === disabled`,且都不在派生允许集里", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }, { name: "riskscan" }])
    expect((await install()).ok).toBe(true)
    for (const record of readLedgerV2(root).records) expect(`${record.name}:${record.desiredState}`).toBe(`${record.name}:disabled`)
    expect(enabledSkillKeys()).toEqual([])
  })

  test("用户拨开关之后进入允许集(这一半是 T4 的入口,判据在这里)", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    expect((await install()).ok).toBe(true)
    expect(setDesiredStateV2(root, "skill", "premarket", "enabled").ok).toBe(true)
    expect(enabledSkillKeys()).toEqual(["skill--premarket"])
  })

  test("本地**单个** skill 的既有默认逐字不变(裁决 B 只动包)", async () => {
    const { initialDesiredState } = await import("../shared/ext-install-policy")
    expect(initialDesiredState({ origin: "imported-claude" })).toBe("enabled")
    expect(initialDesiredState({ origin: "imported-claude", localPackage: true })).toBe("disabled")
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
// G13 / G14 / #306 / ADR-030
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("终态、root 选择与账本语义", () => {
  test("G13 一个都装不上:具名终态,事务根本没起跑(零 journal、零锁、零账本)", async () => {
    // 0 个技能的插件在真实语料里是 25/62 —— 这是多数可达终态,不是边角。
    makePlugin("empty-plugin", [])
    const p = preview()
    expect(p.disposition).toBe("blocked")
    expect(p.blockedReasonCode).toBe("no-installable-component")
    const outcome = await installLocalClaudePluginV1(
      { pluginRoot: fs.realpathSync(pluginDir), preview: p, payloads: [] },
      deps,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe("preview-not-installable")
    expect(fs.existsSync(path.join(root, "ext-store"))).toBe(false)
    expect(fs.existsSync(path.join(root, "ext-tx", "journal"))).toBe(false) // 事务函数根本没起跑
    expect(fs.existsSync(ledgerFile())).toBe(false)
  })

  test("G14 root 是一个**真被装的 skill**(不是合成的 kind:plugin 节点),所以整包卸得掉", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }, { name: "postmarket" }])
    expect((await install()).ok).toBe(true)
    const graph = readPackageGraphs(root)[0]!
    expect(graph.root.kind).toBe("skill")
    // root 选择确定性:按组件名字典序取第一个通过判定的。
    expect(graph.root.name).toBe("postmarket")
    expect(readLedgerV2(root).records.some((r) => r.kind === "skill" && r.name === graph.root.name)).toBe(true)
    const calls: string[] = []
    expect(uninstallPackageV1("local:tide-plugin", { globalRoot: () => root, installers: artifactInstallers(calls) }).ok).toBe(true)
  })

  test("origin 恒 imported-claude;record 不携任何供给链摘要(#306);id 恒 user:<name>", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }], { version: "2.1.0" })
    expect((await install()).ok).toBe(true)
    const record = readLedgerV2(root).records[0]!
    expect(record.origin).toBe("imported-claude")
    expect(record.id).toBe("user:premarket")
    expect(record.version).toBe("2.1.0")
    expect(record.manifestDigest).toBeUndefined()
    expect(record.payloadDigest).toBeUndefined()
    expect(record.grantDigest).toBeUndefined()
    expect(record.previousDigest).toBeUndefined()
  })

  test("授权账里的 manifestDigest 带 `sha256-local:` 前缀 —— 它是本机哈希,不是供给链摘要", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }])
    expect((await install()).ok).toBe(true)
    const grant = JSON.parse(fs.readFileSync(path.join(root, "ext-store", "skill--premarket", "grants.json"), "utf8")) as {
      manifestDigest?: string
      capabilities: string[]
    }
    expect(grant.capabilities).toEqual([])
    expect(grant.manifestDigest?.startsWith("sha256-local:")).toBe(true)
  })

  test("ADR-030:project scope 显式拒绝,不悄悄落回 flat 路径", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }])
    const p = preview()
    const outcome = await installLocalClaudePluginV1(
      { pluginRoot: fs.realpathSync(pluginDir), preview: p, payloads: payloadsOf(p), scope: { scope: "project", projectDir: tmp } },
      deps,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe("unsupported-scope")
    expect(recordNames()).toEqual([])
    expect(fs.existsSync(path.join(root, "skills"))).toBe(false)
  })

  test("`local:` 命名空间是铸造期校验:非 local 的 packageId 一律拒", async () => {
    makePlugin("tide-plugin", [{ name: "premarket" }])
    const p = preview()
    const outcome = await installLocalClaudePluginV1(
      { pluginRoot: fs.realpathSync(pluginDir), preview: { ...p, packageId: "mcp:markitdown" }, payloads: payloadsOf(p) },
      deps,
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe("invalid-input")
    expect(recordNames()).toEqual([])
  })
})
