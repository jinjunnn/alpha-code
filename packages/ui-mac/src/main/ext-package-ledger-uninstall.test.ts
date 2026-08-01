// REQ-128 `#706` —— V3 账本的**全写入口**闸:真实卸载路径、生产接线、篡改响亮失败。
//
// 本文件与 `ext-package-ledger-v3.test.ts` 的分工:那边测纯代数与解码器,这边把真账本落在真盘上,
// 走**生产的** `uninstallByKey`,断言可观察的后果。三件事各自对应一个已被证伪过的失效形态:
//
//   ① **repository 拒绝时实物一件都没动。** 卸载编排今天的形状是「先删实物、再去账」,而 V3 会在
//      仍有 Bundle owner 时拒写 —— 判决晚一步,用户就会看到「卸载失败」而东西真的已经没了。
//      这里的断言不是「文件还在」(那在很多路径下本来就成立),而是**先把不修就会被删的前置状态
//      造出来**:假 installer 会真的 rm,plugin-path 分支里 planner 自己还有一次 `fs.rmSync`。
//      把 `planDirectUninstall` 从 `ext-install-planner.ts` 拿掉,本组每一条都变红。
//
//   ② **每条路径只有一次 ledger mutation。** 用 `spyOn(fs.renameSync)` 数落到 installs.json 的
//      原子换名 —— `writeFileAtomicSync` 每次提交恰好一次 rename,所以这是对物理提交次数的直接
//      测量,不是对最终内容的推断(内容对幂等的重复写不敏感,数不出双写)。
//      **它抓得到什么、抓不到什么(实测,别高估它)**:在卸载尾部插一次 `releaseStandaloneClaim`
//      再 `removeRecordV2`,skill/agent 两条立刻红 —— 两次真写它数得出来。但再插一次
//      `removeRecordV2` 它**不红**:record 已经没了,第二次是幂等 no-op,一个字节都不写。
//      也就是说这道闸管的是「重复落盘」,不是「重复调用」。**内层 receipt 副作用有没有被接回来**
//      不归它管 —— 那由 `ext-fs-installer.test.ts` / `ext-config.test.ts` 里的字节零改动钉子看着
//      (本文件用的是注入的假 installer,production 的那几个函数根本不在这条链上)。
//
//   ③ **篡改/悬空/冲突一律响亮失败且字节零改动。** 负向夹具里违规项**从不放在第一个**,并且集合里
//      同时有合法项 —— 「检查每一个」写成「检查第一个」时必须红。
//
// 账本夹具全部由**生产写器**造(upsert → applyPackageMutation → upsert),不手搓 JSON:手搓的
// 夹具只能证明解码器读得懂我写的东西,证明不了生产路径写得出这个形状。

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { addReceipt, readLedger } from "./alpha-installs"
import {
  bundleOwner,
  computeInstalledGraphDigest,
  standaloneOwner,
  LEGACY_PROTECTED_OWNER,
  type PackageClaimV1,
  type PackageGraphV1,
  type PackageLedgerMutationV1,
} from "./ext-package-ledger-v3"
import {
  applyPackageMutation,
  findRecordV2,
  lookupForUninstall,
  migrateV1Ledger,
  packageClaimOwners,
  probeLedgerForWrite,
  readLedgerV2,
  readPackageGraphs,
  releaseStandaloneClaim,
  removeRecordV2,
  setDesiredStateV2,
  upsertRecordV2,
  upsertRecordsV2,
  type UpsertInput,
} from "./ext-receipt-v2"
import {
  uninstallByKey,
  type ConfigOutcome,
  type FsOutcome,
  type PlannerDeps,
  type PlannerInstallers,
  type TargetArg,
} from "./ext-install-planner"

let tmp = ""
let root = ""

const ledgerFile = (): string => path.join(root, "installs.json")
const readRaw = (): string => fs.readFileSync(ledgerFile(), "utf8")
const parsedLedger = (): { v: number; receipts: unknown[]; records: unknown[]; packageGraphs?: PackageGraphV1[]; claims?: PackageClaimV1[] } =>
  JSON.parse(readRaw()) as { v: number; receipts: unknown[]; records: unknown[]; packageGraphs?: PackageGraphV1[]; claims?: PackageClaimV1[] }

// ── 夹具:一个装了 package 的真账本 ────────────────────────────────────────────────────────────

const PACKAGE_ID = "package:shared-kit"
const ROOT_DIGEST = `sha256:${"a".repeat(64)}`
const ENVELOPE_DIGEST = `sha256:${"b".repeat(64)}`
const OWNER = bundleOwner(PACKAGE_ID, ROOT_DIGEST)

/** package 的 5 个组件 —— 每一种卸载路径各一个,好让「仍有 Bundle owner」这件事在每条路径上都可达。 */
const SHARED = [
  { componentId: "skill:shared-skill", kind: "skill" as const, name: "shared-skill" },
  { componentId: "agent:shared-agent", kind: "agent" as const, name: "shared-agent" },
  { componentId: "mcp:shared-mcp", kind: "mcp" as const, name: "shared-mcp" },
  { componentId: "plugin:shared-plugin", kind: "plugin" as const, name: "shared-plugin" },
  { componentId: "plugin:shared-vendored", kind: "plugin" as const, name: "shared-vendored" },
]

/** 用户自己单装的同类物件 —— 卸载它们走的是「删」这一支,用来证明 V3 段不会在正常卸载里蒸发。 */
const SOLO = [
  { kind: "skill" as const, name: "solo-skill" },
  { kind: "agent" as const, name: "solo-agent" },
  { kind: "mcp" as const, name: "solo-mcp" },
  { kind: "plugin" as const, name: "solo-plugin" },
  { kind: "plugin" as const, name: "solo-vendored" },
]

const configKeyFor = (kind: string, name: string): string | undefined => {
  if (kind === "mcp") return `mcp.${name}`
  if (kind !== "plugin") return undefined
  return name.includes("vendored") ? `plugin-path:${path.join(root, "plugins", name, "plugin.js")}` : `plugin:${name}@1.0.0`
}

const upsertInput = (kind: "skill" | "agent" | "mcp" | "plugin", name: string): UpsertInput => {
  const configKey = configKeyFor(kind, name)
  return {
    id: `${kind}:${name}`,
    name,
    kind,
    environment: "prod",
    scope: { kind: "global" },
    version: "1.0.0",
    manifestDigest: ROOT_DIGEST,
    desiredState: "enabled",
    origin: "catalog",
    installedAt: "2026-07-31T00:00:00.000Z",
    ...(configKey ? { configKey } : {}),
  }
}

const packageGraph = (): PackageGraphV1 => {
  const [head, ...rest] = SHARED
  const withoutDigest = {
    packageId: PACKAGE_ID,
    envelopeDigest: ENVELOPE_DIGEST,
    root: { componentId: head!.componentId, kind: head!.kind, name: head!.name, required: true, manifestDigest: ROOT_DIGEST },
    children: rest.map((c) => ({ componentId: c.componentId, kind: c.kind, name: c.name, required: false, manifestDigest: ROOT_DIGEST })),
  }
  return { ...withoutDigest, installedGraphDigest: computeInstalledGraphDigest(withoutDigest) }
}

const packageMutation = (): PackageLedgerMutationV1 => ({
  transactionId: "tx-shared-kit-1",
  operation: "install",
  graphBeforeDigest: null,
  graphAfter: packageGraph(),
  childRecordMutations: SHARED.map((c) => ({ op: "upsert" as const, input: upsertInput(c.kind, c.name) })),
  claimMutations: SHARED.map((c) => ({ op: "acquire" as const, kind: c.kind, name: c.name, owner: OWNER })),
})

/** 实物:skill 目录、agent md、vendored plugin 目录。假 installer 与 planner 自己都会真的删它们。 */
function materialiseArtifacts(): void {
  for (const { kind, name } of [...SHARED, ...SOLO]) {
    if (kind === "skill") {
      fs.mkdirSync(path.join(root, "skills", name), { recursive: true })
      fs.writeFileSync(path.join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nbody`)
    }
    if (kind === "agent") {
      fs.mkdirSync(path.join(root, "agents"), { recursive: true })
      fs.writeFileSync(path.join(root, "agents", `${name}.md`), "---\ndescription: d\n---\nsys")
    }
    if (kind === "plugin" && name.includes("vendored")) {
      fs.mkdirSync(path.join(root, "plugins", name), { recursive: true })
      fs.writeFileSync(path.join(root, "plugins", name, "plugin.js"), "// vendored")
    }
  }
}

const artifactPath = (kind: string, name: string): string =>
  kind === "skill"
    ? path.join(root, "skills", name)
    : kind === "agent"
      ? path.join(root, "agents", `${name}.md`)
      : path.join(root, "plugins", name)

/**
 * 生产写器造账本:①applyPackageMutation 装包(child record 由 mutation 自己带来,这正是
 * `commitTransactionLedger` 从 commit records 派生 upsert 的形状)②V3 之后再单装 5 个 solo。
 *
 * `#698` review R1 Blocker 3 修正:此前这里**先** `upsertRecordsV2(SHARED)` 再 apply。那让 5 个
 * child 变成「V3 之前就在账上、且没人认领」的存量 —— 也就是「用户自己先装过」的语义,而本组用例
 * 通篇自称测的是 **fresh package 安装后的默认形状**。当时之所以还能绿,是因为收编循环会跳过本次
 * mutation 碰过的 key(那正是 Blocker 3);判据修正之后,那一步会如实给它们打上 `legacy-protected`。
 * 换句话说:这个夹具当初是**靠着那个缺陷**才表达出它想表达的意思。真正的 fresh 形状不需要预热。
 */
function seedV3Ledger(): void {
  const applied = applyPackageMutation(root, packageMutation())
  if (!applied.ok) throw new Error(`fixture: activating V3 failed: ${applied.reason}`)
  const second = upsertRecordsV2(root, SOLO.map((c) => upsertInput(c.kind, c.name)))
  if (!second.ok) throw new Error(`fixture: seeding solo children failed: ${second.reason}`)
  materialiseArtifacts()
}

// ── 假 installer:真删实物(这样「实物没动」才是有代价的断言)────────────────────────────────────

type Calls = string[]

function makeDeps(calls: Calls): PlannerDeps {
  const refuse = (fn: string) => (): never => {
    throw new Error(`install-only installer ${fn} must not run on an uninstall path`)
  }
  const installers: PlannerInstallers = {
    applyMcpWritePolicy: refuse("applyMcpWritePolicy"),
    mcpSecretRefFor: refuse("mcpSecretRefFor"),
    claimMcpSecretVersionDir: refuse("claimMcpSecretVersionDir"),
    writeMcpSecretVersioned: refuse("writeMcpSecretVersioned"),
    removeMcpSecretVersionDir: refuse("removeMcpSecretVersionDir"),
    gcMcpSecrets: (name: string) => {
      calls.push(`gcMcpSecrets:${name}`)
      return { removed: [], warnings: [] }
    },
    legacyMcpRefPaths: refuse("legacyMcpRefPaths"),
    readMcpLeafStrict: refuse("readMcpLeafStrict"),
    removeMcpConfigInLock: (name: string): ConfigOutcome => {
      calls.push(`removeMcpConfigInLock:${name}`)
      return { ok: true }
    },
    removeMcpSecretsStrict: (name: string) => {
      calls.push(`removeMcpSecretsStrict:${name}`)
      return { ok: true }
    },
    // #704:卸载路径会释放该组件的 Alpha Connection 绑定(共享 connection 本身保留)。
    // 记进 calls 账而不是 refuse —— 这是卸载的正当动作,不是 install-only。
    releaseAlphaConnectionBindings: (componentId: string) => {
      calls.push(`releaseAlphaConnectionBindings:${componentId}`)
      return { ok: true }
    },
    findPluginBaseConflictStrict: refuse("findPluginBaseConflictStrict"),
    readPluginArrayStrict: refuse("readPluginArrayStrict"),
    readLegacyPluginArrayStrict: refuse("readLegacyPluginArrayStrict"),
    mcpConfigTruthPath: () => path.join(root, "alpha.jsonc"),
    stageVendoredPluginVersioned: refuse("stageVendoredPluginVersioned"),
    removePlugin: (pkg: string): ConfigOutcome => {
      calls.push(`removePlugin:${pkg}`)
      return { ok: true }
    },
    collectVendoredPluginPayload: refuse("collectVendoredPluginPayload"),
    removePluginPath: (name: string, absJsPath: string): ConfigOutcome => {
      calls.push(`removePluginPath:${name}`)
      fs.rmSync(absJsPath, { force: true }) // 生产同形:配置撤除 + 实物消失
      return { ok: true }
    },
    installBuiltinSkill: refuse("installBuiltinSkill"),
    collectBuiltinSkillPayload: refuse("collectBuiltinSkillPayload"),
    collectBuiltinAgentPayload: refuse("collectBuiltinAgentPayload"),
    installRemoteSkill: refuse("installRemoteSkill"),
    removeFsInstall: (type: "skill" | "agent", name: string, _target?: TargetArg): FsOutcome => {
      calls.push(`removeFsInstall:${type}:${name}`)
      const target = artifactPath(type, name)
      fs.rmSync(target, { recursive: true, force: true }) // 生产同形:实物真的没了
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
    casBaseRoot: () => path.join(tmp, "cas-base"),
    installers,
  }
}

// ── ledger 物理提交计数(writeFileAtomicSync = tmp→rename,一次提交恰好一次 rename)──────────────

let renameSpy: ReturnType<typeof spyOn<typeof fs, "renameSync">> | null = null

function countLedgerWrites(): () => number {
  const spy = spyOn(fs, "renameSync")
  renameSpy = spy
  const target = ledgerFile()
  return () => spy.mock.calls.filter((args) => args[1] === target).length
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ext-v3-ledger-"))
  root = path.join(tmp, "global")
  fs.mkdirSync(root, { recursive: true })
})

afterEach(() => {
  renameSpy?.mockRestore()
  renameSpy = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ── ① 真实卸载路径 ────────────────────────────────────────────────────────────────────────────

describe("REQ-128 #706 —— 真实卸载:仍有 Bundle owner ⇒ 实物一件都不动", () => {
  // 判据不是「文件还在」。夹具里假 installer 与 planner 都会**真的删**,所以这四条只有在
  // claim-aware 判决位于删实物之前时才成立;把 `planDirectUninstall` 拿掉即全红。
  for (const { kind, name } of SHARED) {
    test(`${kind}:${name} —— 只释放 standalone claim,零实物副作用,一次 mutation`, async () => {
      seedV3Ledger()
      const graphsBefore = readPackageGraphs(root)
      const artifact = artifactPath(kind, name)
      const artifactExisted = fs.existsSync(artifact)
      // 用户此前也单装过同一个 child:standalone owner 与 Bundle owner 并存(共享的真实形态)。
      const claimed = upsertRecordsV2(root, [upsertInput(kind, name)])
      expect(claimed.ok).toBe(true)
      expect(packageClaimOwners(root, kind, name).sort()).toEqual([OWNER, standaloneOwner(kind, name)].sort())

      const calls: Calls = []
      const writes = countLedgerWrites()
      const outcome = await uninstallByKey({ type: kind, name, scope: "global" }, makeDeps(calls))

      // 实物先判:把 `planDirectUninstall` 拿掉时,生产代码自己会说
      // 「ledger removal failed … artifacts already removed; retry (idempotent)」—— 而重试永远
      // 不会成功(Bundle owner 不会自己消失)。所以这两行是本票 Blocker 的直接回归。
      expect(calls).toEqual([]) // 没有任何 installer 被调用 = 一件实物都没动
      if (artifactExisted) expect(fs.existsSync(artifact)).toBe(true)
      expect(outcome).toMatchObject({ ok: true, retainedForOwners: [OWNER] })
      expect(writes()).toBe(1) // 只有「释放 claim」这一次提交
      // 账本:record 仍在(它还属于这个 package)、图逐字不变、claim 只少了用户那一份。
      expect(findRecordV2(root, kind, name)).not.toBeNull()
      expect(readPackageGraphs(root)).toEqual(graphsBefore)
      expect(packageClaimOwners(root, kind, name)).toEqual([OWNER])
    })
  }
})

describe("REQ-128 #706 —— 真实卸载:没有别的 owner ⇒ 正常删,且 V3 段不丢失", () => {
  for (const { kind, name } of SOLO) {
    test(`${kind}:${name} —— record/claim 一并消失,packageGraphs 与他人 claim 原样`, async () => {
      seedV3Ledger()
      const graphsBefore = readPackageGraphs(root)
      const otherClaimsBefore = parsedLedger().claims?.filter((c) => !(c.kind === kind && c.name === name))
      expect(packageClaimOwners(root, kind, name)).toEqual([standaloneOwner(kind, name)])

      const calls: Calls = []
      const writes = countLedgerWrites()
      const outcome = await uninstallByKey({ type: kind, name, scope: "global" }, makeDeps(calls))

      expect(outcome).toMatchObject({ ok: true })
      expect(calls.length).toBeGreaterThan(0) // 这一支必须真的走到 installer
      expect(writes()).toBe(1) // 一次 mutation —— 内层 receipt 副作用回来就是 2
      expect(findRecordV2(root, kind, name)).toBeNull()
      expect(packageClaimOwners(root, kind, name)).toEqual([])
      // V3 段活着:图逐字不变,其余 claim 逐字不变,信封仍是 v:3。
      expect(readPackageGraphs(root)).toEqual(graphsBefore)
      expect(parsedLedger().claims).toEqual(otherClaimsBefore)
      expect(parsedLedger().v).toBe(3)
    })
  }
})

describe("REQ-128 #706 —— 真实卸载:**只有** Bundle owner(用户从没单装过)⇒ 响亮失败", () => {
  // 这是 fresh package 安装后的**默认**形状:`packageMutationEnvelope` 只 acquire 一个
  // `bundle:` owner,standalone owner 要等用户自己再单装一次才会出现。上一版把「有 Bundle
  // owner」直接当成「释放 standalone claim」,而那份 claim 根本不存在 —— `withoutOwner` 原样
  // 返回、`releaseStandaloneClaim` 照旧提交一次、planner 回 `ok:true`,Hub 只看 `ok` ⇒ 显示
  // 「已移除」,而文件、record、图、claim 一件没动。用户刷新后条目还在。
  //
  // 四条断言各钉一件事:失败(不是 ok:true)/ 零落盘(字节与 rename 次数)/ 零实物副作用 /
  // Hub 拿不到会显示「已移除」的结果。
  for (const { kind, name } of SHARED) {
    test(`${kind}:${name} —— ok:false、字节零改动、零实物副作用、claim 原样`, async () => {
      seedV3Ledger()
      // 前置事实:这就是 fresh 安装的形状 —— owner 集合里只有 Bundle。
      expect(packageClaimOwners(root, kind, name)).toEqual([OWNER])
      const before = readRaw()
      const graphsBefore = readPackageGraphs(root)
      const artifact = artifactPath(kind, name)
      const artifactExisted = fs.existsSync(artifact)

      const calls: Calls = []
      const writes = countLedgerWrites()
      const outcome = await uninstallByKey({ type: kind, name, scope: "global" }, makeDeps(calls))

      // ① 失败,且理由说得出「由 Bundle 拥有、没有可释放的独立安装」。
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toContain(OWNER)
        expect(outcome.reason).toContain("no standalone install to release")
      }
      // ② Hub 只读 `ok`(extension-hub.tsx `onUninstall`):ok:false ⇒ 只可能显示失败。
      expect((outcome as { retainedForOwners?: string[] }).retainedForOwners).toBeUndefined()
      // ③ 零落盘:一次 rename 都没有,且文件逐字节不变。
      expect(writes()).toBe(0)
      expect(readRaw()).toBe(before)
      // ④ 零实物副作用:没有任何 installer 被调用,实物仍在。
      expect(calls).toEqual([])
      if (artifactExisted) expect(fs.existsSync(artifact)).toBe(true)
      // 账本语义面同样原样:record 在、图逐字不变、claim 一个 owner 都没少。
      expect(findRecordV2(root, kind, name)).not.toBeNull()
      expect(readPackageGraphs(root)).toEqual(graphsBefore)
      expect(packageClaimOwners(root, kind, name)).toEqual([OWNER])
    })
  }

  // `removeRecordV2` 里那道 claim-aware 闸是**最后一道**(正常路径由 `planDirectUninstall` 先挡)。
  // 实测:把它整段删掉,`bun test src` 一条都不红 —— 也就是说它此前是一道没人看着的闸,可以被
  // 静默删除。它值得被看着,因为 `refuse` 一支若无人消费就会掉进 `delete`:record 与整条 claim
  // 一起没了,而那个 Bundle 的图还指着它 —— 从此这个 package 无法正确卸载。
  test("removeRecordV2 的最后一道闸:仍被 Bundle 拥有的 child 去不了账(两支都拒,且字节零改动)", () => {
    seedV3Ledger()
    // ① 纯 Bundle 拥有(refuse 支)。违规项不取集合首位。
    const bundleOnly = SHARED[SHARED.length - 1]!
    expect(packageClaimOwners(root, bundleOnly.kind, bundleOnly.name)).toEqual([OWNER])
    let before = readRaw()
    const refused = removeRecordV2(root, bundleOnly.kind, bundleOnly.name)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain("no standalone install to release")
    expect(readRaw()).toBe(before)
    expect(findRecordV2(root, bundleOnly.kind, bundleOnly.name)).not.toBeNull()
    expect(packageClaimOwners(root, bundleOnly.kind, bundleOnly.name)).toEqual([OWNER])

    // ② standalone + Bundle 并存(release-claim-only 支)—— 同样不得去账。
    const shared = SHARED[1]!
    expect(upsertRecordsV2(root, [upsertInput(shared.kind, shared.name)]).ok).toBe(true)
    before = readRaw()
    const alsoRefused = removeRecordV2(root, shared.kind, shared.name)
    expect(alsoRefused.ok).toBe(false)
    if (!alsoRefused.ok) expect(alsoRefused.reason).toContain("release the standalone claim instead of dropping the record")
    expect(readRaw()).toBe(before)
    expect(findRecordV2(root, shared.kind, shared.name)).not.toBeNull()

    // ③ 对照:没有 Bundle 拥有的 solo child 照样去得了账 —— 这道闸不是「一律拒」。
    const solo = SOLO[SOLO.length - 1]!
    expect(removeRecordV2(root, solo.kind, solo.name).ok).toBe(true)
    expect(findRecordV2(root, solo.kind, solo.name)).toBeNull()
  })

  test("releaseStandaloneClaim 被直接调用时同样拒绝(没有可释放的 owner ⇒ 不写盘)", () => {
    seedV3Ledger()
    // 违规项不放第一个:取 SHARED 的最后一个 child,且账本里同时有一堆合法的 solo claim。
    const victim = SHARED[SHARED.length - 1]!
    const before = readRaw()
    const writes = countLedgerWrites()

    const released = releaseStandaloneClaim(root, victim.kind, victim.name)

    expect(released.ok).toBe(false)
    if (!released.ok) expect(released.reason).toContain("no standalone claim to release")
    expect(writes()).toBe(0)
    expect(readRaw()).toBe(before)
    expect(packageClaimOwners(root, victim.kind, victim.name)).toEqual([OWNER])
    // 合法的那一支不受影响:solo child 的 standalone claim 照样释放得掉。
    const solo = SOLO[SOLO.length - 1]!
    const ok = releaseStandaloneClaim(root, solo.kind, solo.name)
    expect(ok.ok).toBe(true)
    expect(packageClaimOwners(root, solo.kind, solo.name)).toEqual([])
  })
})

describe("REQ-128 #706 —— 只有一次 mutation:v:2 账本上的内层副作用探测器", () => {
  // V3 未激活时,`alpha-installs` 的 v1 写器不会被 `refuseIfV3` 挡住 —— 于是「内层 removeReceipt
  // 有没有被接回来」在这里是**可见的**:它会多出一次 rename。v:3 夹具上测不出这一条(v1 写器被
  // 拒在写之前),所以这个探测器必须留在 v:2 上。
  for (const { kind, name } of SOLO) {
    test(`${kind}:${name} —— v:2 账本上卸载恰好提交一次`, async () => {
      const seeded = upsertRecordsV2(root, SOLO.map((c) => upsertInput(c.kind, c.name)))
      expect(seeded.ok).toBe(true)
      materialiseArtifacts()
      expect(parsedLedger().v).toBe(2)

      const calls: Calls = []
      const writes = countLedgerWrites()
      const outcome = await uninstallByKey({ type: kind, name, scope: "global" }, makeDeps(calls))

      expect(outcome).toMatchObject({ ok: true })
      expect(writes()).toBe(1)
      expect(findRecordV2(root, kind, name)).toBeNull()
    })
  }
})

// ── ② 第一次 V3 write 之后,扩展管理面全须仍然可用 ──────────────────────────────────────────────

describe("REQ-128 #706 —— 第一次 V3 write 后全部扩展管理操作仍可用", () => {
  test("读/单装/批装/启停/卸载/查询/迁移全绿,且信封保持 v:3", () => {
    seedV3Ledger()
    expect(parsedLedger().v).toBe(3)

    expect(probeLedgerForWrite(root).ok).toBe(true)
    expect(readLedgerV2(root).records.length).toBe(SHARED.length + SOLO.length)
    expect(readLedger(root).receipts.length).toBe(SHARED.length + SOLO.length)
    expect(lookupForUninstall(root, "skill", "solo-skill").status).toBe("valid")

    // 单装一个全新的 child(V3 已激活 ⇒ 它自带 standalone claim)
    const fresh = upsertRecordV2(root, upsertInput("skill", "fresh-skill"))
    expect(fresh.ok).toBe(true)
    expect(packageClaimOwners(root, "skill", "fresh-skill")).toEqual([standaloneOwner("skill", "fresh-skill")])

    // 批装
    const batch = upsertRecordsV2(root, [upsertInput("agent", "fresh-agent"), upsertInput("mcp", "fresh-mcp")])
    expect(batch.ok).toBe(true)

    // 启停(对 V3 段是纯透传)
    const graphsBefore = readPackageGraphs(root)
    expect(setDesiredStateV2(root, "skill", "solo-skill", "disabled").ok).toBe(true)
    expect(findRecordV2(root, "skill", "solo-skill")?.desiredState).toBe("disabled")
    expect(readPackageGraphs(root)).toEqual(graphsBefore)

    // 去账
    expect(removeRecordV2(root, "skill", "fresh-skill").ok).toBe(true)
    expect(findRecordV2(root, "skill", "fresh-skill")).toBeNull()

    // v1 → v2 迁移仍然跑得动(v:3 信封是它认得的形状)
    expect(migrateV1Ledger(root, "prod").ok).toBe(true)
    expect(parsedLedger().v).toBe(3)
    expect(readPackageGraphs(root)).toEqual(graphsBefore)
  })

  test("第二个物理写器(v1 addReceipt/removeReceipt)在 V3 账本上响亮拒绝,字节零改动", () => {
    seedV3Ledger()
    const before = readRaw()
    const written = addReceipt(root, {
      id: "skill:v1-writer",
      name: "v1-writer",
      type: "skill",
      scope: "global",
      installedAt: "2026-07-31T00:00:00.000Z",
      origin: "catalog",
    })
    expect(written.ok).toBe(false)
    if (!written.ok) expect(written.reason).toContain("v1 writer would silently drop them")
    expect(readRaw()).toBe(before)
  })
})

// ── ③ 篡改 / 悬空 / 冲突 / 未知 child 一律响亮失败 ─────────────────────────────────────────────

describe("REQ-128 #706 —— 篡改的 V3 账本:所有写路径拒绝且字节零改动", () => {
  // 负向夹具纪律:违规项**从不是第一个**,并且集合里同时有合法项 —— 「只检查第一个」必须红。
  const mutate = (edit: (ledger: Record<string, unknown>) => void): string => {
    seedV3Ledger()
    const ledger = JSON.parse(readRaw()) as Record<string, unknown>
    edit(ledger)
    fs.writeFileSync(ledgerFile(), `${JSON.stringify(ledger, null, 2)}\n`)
    return readRaw()
  }

  const everyWritePathRefuses = (before: string, needle: string): void => {
    const probe = probeLedgerForWrite(root)
    expect(probe.ok).toBe(false)
    const upsert = upsertRecordV2(root, upsertInput("skill", "late-arrival"))
    expect(upsert.ok).toBe(false)
    if (!upsert.ok) expect(upsert.reason).toContain(needle)
    expect(removeRecordV2(root, "skill", "solo-skill").ok).toBe(false)
    expect(setDesiredStateV2(root, "skill", "solo-skill", "disabled").ok).toBe(false)
    expect(applyPackageMutation(root, packageMutation()).ok).toBe(false)
    expect(releaseStandaloneClaim(root, "skill", "solo-skill").ok).toBe(false)
    expect(readRaw()).toBe(before) // 拒绝 = 原文件一个字节都不动
  }

  test("被篡改的 graph 节点(digest 不再自洽)", () => {
    const before = mutate((ledger) => {
      const graphs = ledger.packageGraphs as PackageGraphV1[]
      graphs[0]!.children[1]!.name = "hijacked" // 第二个 child —— 不是第一个
    })
    everyWritePathRefuses(before, "does not match the graph contents")
  })

  test("认不出的 owner token(混在合法 owner 后面)", () => {
    const before = mutate((ledger) => {
      const claims = ledger.claims as PackageClaimV1[]
      claims[claims.length - 1]!.owners = [LEGACY_PROTECTED_OWNER, "bundle:evil"] // 违规项在第二位
    })
    everyWritePathRefuses(before, "unrecognised owner token")
  })

  test("dangling claim:claim 指向一个没有 record 的 child", () => {
    const before = mutate((ledger) => {
      const claims = ledger.claims as PackageClaimV1[]
      claims.push({ kind: "skill", name: "never-installed", owners: [standaloneOwner("skill", "never-installed")] })
    })
    everyWritePathRefuses(before, "dangling claim")
  })

  test("unknown child:图里的节点没有 claim 认领", () => {
    const before = mutate((ledger) => {
      const claims = ledger.claims as PackageClaimV1[]
      const victim = SHARED[2]! // 第三个组件 —— 不是 root、也不是第一个 child
      ledger.claims = claims.filter((c) => !(c.kind === victim.kind && c.name === victim.name))
    })
    everyWritePathRefuses(before, "unknown child")
  })

  test("孤儿 bundle owner:claim 指名一张账本里没有的图", () => {
    const before = mutate((ledger) => {
      const claims = ledger.claims as PackageClaimV1[]
      claims[claims.length - 1]!.owners = [standaloneOwner(claims[claims.length - 1]!.kind, claims[claims.length - 1]!.name), bundleOwner("package:ghost", ROOT_DIGEST)]
    })
    everyWritePathRefuses(before, "orphan owner")
  })

  test("V3 段在场但信封自称 v:2 —— 被半写过或被降级构建改过", () => {
    const before = mutate((ledger) => {
      ledger.v = 2
    })
    everyWritePathRefuses(before, "carries package graphs/claims")
  })

  test("graphBeforeDigest 对不上 ⇒ package mutation 拒绝,账本原样", () => {
    // 「陈旧前像」必须是**真的会改写图**的那种,才谈得上冲突。图已经等于目标态时,
    // 前像对不上只说明这是一次重放(下一个 describe 覆盖),不是冲突 —— 两者不可混。
    seedV3Ledger()
    const before = readRaw()
    const updated = { ...packageGraph(), envelopeDigest: `sha256:${"c".repeat(64)}` }
    const updatedGraph: PackageGraphV1 = { ...updated, installedGraphDigest: computeInstalledGraphDigest(updated) }
    const stale: PackageLedgerMutationV1 = {
      ...packageMutation(),
      operation: "update",
      graphBeforeDigest: `sha256:${"f".repeat(64)}`, // 账本上根本不是这张图
      graphAfter: updatedGraph,
    }
    const applied = applyPackageMutation(root, stale)
    expect(applied.ok).toBe(false)
    if (!applied.ok) expect(applied.reason).toContain("does not match the expected before-image")
    expect(readRaw()).toBe(before)
  })
})

// ── ④ legacy / 身份不确定的内容永不被自动回收 ─────────────────────────────────────────────────

describe("REQ-128 #706 —— legacy / unmanaged 内容永不 GC", () => {
  test("V3 激活时,账本里已有的、没人认领的存量一律 legacy-protected(不猜它属于哪个历史 Bundle)", () => {
    const seeded = upsertRecordsV2(root, [upsertInput("skill", "ancient-skill"), upsertInput("agent", "ancient-agent")])
    expect(seeded.ok).toBe(true)
    expect(parsedLedger().v).toBe(2) // 还没装过 package ⇒ 不凭空造 claim
    expect(parsedLedger().claims).toBeUndefined()

    const applied = applyPackageMutation(root, packageMutation())
    expect(applied.ok).toBe(true)
    expect(packageClaimOwners(root, "skill", "ancient-skill")).toEqual([LEGACY_PROTECTED_OWNER])
    expect(packageClaimOwners(root, "agent", "ancient-agent")).toEqual([LEGACY_PROTECTED_OWNER])
  })

  test("v1 存量迁移进 V3 账本一律 legacy-protected,且释放 standalone claim 不会把它摘掉", () => {
    seedV3Ledger()
    // v1-only receipt(没有 v2 record)—— 迁移会把它收编。
    const raw = JSON.parse(readRaw()) as { receipts: unknown[] }
    raw.receipts.push({
      id: "skill:from-v1",
      name: "from-v1",
      type: "skill",
      scope: "global",
      installedAt: "2026-07-31T00:00:00.000Z",
      origin: "catalog",
    })
    fs.writeFileSync(ledgerFile(), `${JSON.stringify(raw, null, 2)}\n`)

    const migrated = migrateV1Ledger(root, "prod")
    expect(migrated.ok).toBe(true)
    if (migrated.ok) expect(migrated.migrated).toBe(1)
    expect(packageClaimOwners(root, "skill", "from-v1")).toEqual([LEGACY_PROTECTED_OWNER])

    // 释放「用户那一份」摘不掉 legacy 保护。review #757 Major 之后这不再是**静默成功的空操作**:
    // 没有可释放的 owner 就在写盘之前响亮失败(空操作 + ok 正是「谎报已移除」的燃料)。
    // 用户真要卸载它走的是另一支:legacy-protected 不是 Bundle,不阻挡显式直接卸载。
    const before = readRaw()
    const released = releaseStandaloneClaim(root, "skill", "from-v1")
    expect(released.ok).toBe(false)
    if (!released.ok) expect(released.reason).toContain("no standalone claim to release")
    expect(readRaw()).toBe(before)
    expect(packageClaimOwners(root, "skill", "from-v1")).toEqual([LEGACY_PROTECTED_OWNER])
  })
})

// ── ⑤ exact replay:同一事务重放不得二次施加 claim mutation ────────────────────────────────────

describe("REQ-128 #706 —— 崩溃前滚的 exact replay", () => {
  test("同一份 mutation 重放:第二次报 replayed,账本字节逐字相同,零额外提交", () => {
    const seeded = upsertRecordsV2(root, SOLO.map((c) => upsertInput(c.kind, c.name)))
    expect(seeded.ok).toBe(true)

    const first = applyPackageMutation(root, packageMutation())
    expect(first).toMatchObject({ ok: true, replayed: false })
    const afterFirst = readRaw()

    const writes = countLedgerWrites()
    const second = applyPackageMutation(root, packageMutation())
    expect(second).toMatchObject({ ok: true, replayed: true })
    expect(writes()).toBe(0) // 重放不写盘
    expect(readRaw()).toBe(afterFirst)
    for (const c of SHARED) expect(packageClaimOwners(root, c.kind, c.name)).toEqual([OWNER])
  })
})
