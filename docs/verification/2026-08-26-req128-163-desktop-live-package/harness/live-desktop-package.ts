// aw#163 / REQ-128 —— 桌面端对**公网 stable**(https://codepuppy.cn/catalog/v1)的
// 浏览 / 详情 / 安装取证 harness。
//
// 纪律(alpha-work/CLAUDE.md《断言的粒度不能比缺陷粗一格》《观测手段自己有盲区》):
//   · 期望值是**独立字面量**(下面的 EXPECTED),2026-08-26 由一次独立 `curl` 直取后逐字抄写;
//     绝不 import 生产常量当期望值 —— 比较基准与被测对象同源 = 自指等价链。
//     §0 再用一次**不经任何生产代码**的裸 `fetch` 复核这些字面量仍描述着线上那份载荷,
//     发布侧改了内容就当场红(而不是让证据静默过期)。
//   · 走的是**生产那条路径**:零 deps 注入 ⇒ 真 fetch、真 CHANNEL_BASE_URL、真内置公钥、
//     真 Date.now;浏览/详情经**真的 IPC handler 注册面**(registerPackageCatalogReadIpcHandlers,
//     即 ext-ipc.ts:356-358 注册进 ipcMain 的那两条),安装经生产 admission coordinator。
//   · 「引擎会读的那个目录」由**引擎自己的读**交出来(packages/ext 的 injectSkillGenerationPaths),
//     不是我们拼一条路径去 existsSync。
//   · §4 是负向对照:先证明这套观测能测出已知的坏(换错公钥 / 篡改载荷 / 不存在的 id),
//     再用它判未知的好。
//
// 用法(仓根):
//   bun docs/verification/2026-08-26-req128-163-desktop-live-package/harness/live-desktop-package.ts
// 需要公网。**不进任何闸门**:它打真网络,不属于 `bun test src` / test-component 的采集面。

import { createHash, generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  PACKAGE_DETAIL_IPC_CHANNEL,
  refreshRemoteCatalog,
  registerPackageCatalogReadIpcHandlers,
} from "../../../../packages/ui-mac/src/main/remote-catalog"
import { CHANNEL_BASE_URL } from "../../../../packages/ui-mac/src/main/catalog-channels"
import { installableCatalogPackages } from "../../../../packages/ui-mac/src/renderer/extensions/catalog-installable-view"
import { createPackageAdmissionCoordinator } from "../../../../packages/ui-mac/src/main/package-admission"
import { resolveVerifiedPackageV1 } from "../../../../packages/ui-mac/src/main/package-installability"
import { resolveLiveGenerationDir } from "../../../../packages/ui-mac/src/main/ext-transaction"
import { skillGenerationKey } from "../../../../packages/ui-mac/src/main/ext-skill-generations"
import { readPackageLedgerStateV1 } from "../../../../packages/ui-mac/src/main/ext-receipt-v2"
import { setInstallStateByKey } from "../../../../packages/ui-mac/src/main/ext-install-planner"
import { makeAdvisoryGate } from "../../../../packages/ui-mac/src/main/ext-advisory-gate"
import { parseSkillFrontmatter } from "../../../../packages/ui-mac/src/main/ext-import-validate"
import { injectSkillGenerationPaths } from "../../../../packages/ext/src/gen-skill-paths"

// ── 独立字面量(2026-08-26 curl 直取) ────────────────────────────────────────────────────────
const EXPECTED = {
  host: "https://codepuppy.cn/catalog/v1",
  channelSequence: 11,
  catalogVersion: "2026-08-25.2",
  catalogSha256: "1bdc9ad8d1bff83252eaa41cb1bc48b4bced7553e570439b4f1379b65c14b99d",
  catalogBytes: 95220,
  entriesLength: 28,
  packagesLength: 1,
  catalogId: "package:alpha-first",
  packageVersion: "1.0.0",
  displayName: "Alpha install check",
  description:
    "A single first-party skill that checks an Alpha extension package finished installing and reports what landed on disk. Local state only: no network, no credentials, no writes.",
  rootComponentId: "skill:alpha-first",
  skillName: "alpha-first",
  payloadUrl:
    "https://codepuppy.cn/catalog/assets/skill.alpha-first/1.0.0/alpha-package/495b415b54f2821efd267a7f0199ef8662e144aaa640efb3cf12b00386db45dc.json",
  payloadSha256: "495b415b54f2821efd267a7f0199ef8662e144aaa640efb3cf12b00386db45dc",
  payloadBytes: 624,
  skillTargetDir: "alpha-skills",
  assets: [
    { path: "LICENSE.txt", bytes: 1065, sha256: "91d6e75b756d929a8cfa1bb0de0de5b1b945e3ac9f2c9c6212c8400ed993dde5" },
    { path: "SKILL.md", bytes: 2679, sha256: "27e1b014f09ec6db8a9b74442d3614efaabf9599705d134d26229a1a99d3cdca" },
  ],
} as const

// ── 记账 ────────────────────────────────────────────────────────────────────────────────────
let checks = 0
let failures = 0
const log = (line = "") => console.log(line)
/** 键序无关的稳定序列化 —— 值仍然逐字段精确;键集另有专门断言(§2 的 wire 键集)。 */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === "object")
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
  return v
}
function check(label: string, actual: unknown, expected: unknown) {
  checks += 1
  const a = JSON.stringify(canon(actual))
  const e = JSON.stringify(canon(expected))
  const ok = a === e
  if (!ok) failures += 1
  log(`  ${ok ? "PASS" : "FAIL"}  ${label}`)
  log(`        actual   = ${a}`)
  if (!ok) log(`        expected = ${e}`)
}
function checkTrue(label: string, actual: boolean, note = "") {
  checks += 1
  if (!actual) failures += 1
  log(`  ${actual ? "PASS" : "FAIL"}  ${label}${note ? `  [${note}]` : ""}`)
}
const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex")
const indent = (v: unknown) => JSON.stringify(v, null, 2).split("\n").join("\n  ")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw163-live-"))
const mk = (name: string) => {
  const p = path.join(tmp, name)
  fs.mkdirSync(p, { recursive: true })
  return p
}
const userData = mk("user-data")
const root = mk("alpha-root")
const casBase = mk("cas-base")

log(`# aw#163 · REQ-128 桌面端浏览/详情/安装 package:alpha-first(公网 stable)`)
log(`started      ${new Date().toISOString()}`)
log(`tmp root     ${tmp}`)
log(`runtime      node ${process.version} / bun ${(process.versions as Record<string, string>).bun ?? "n/a"}`)
log()

// ══ §0 独立取证(不经任何生产代码) ═══════════════════════════════════════════════════════════
log(`## §0 独立取证 —— 裸 fetch,不经生产代码`)
const raw = async (url: string) => {
  const r = await fetch(url)
  const b = Buffer.from(await r.arrayBuffer())
  return { status: r.status, bytes: b.byteLength, sha256: sha256(b), body: b }
}
const rawChannel = await raw(`${EXPECTED.host}/channels/stable.json`)
const rawSnapshot = await raw(`${EXPECTED.host}/channels/snapshot.json`)
const rawTrust = await raw(`${EXPECTED.host}/channels/trust.json`)
const channelDoc = JSON.parse(rawChannel.body.toString("utf8")) as {
  sequence: number
  target: { catalogVersion: string; sha256: string; bytes: number; url: string }
}
const rawRelease = await raw(channelDoc.target.url)
const rawPayload = await raw(EXPECTED.payloadUrl)
log(`  stable.json    http=${rawChannel.status} bytes=${rawChannel.bytes} sequence=${channelDoc.sequence}`)
log(`  snapshot.json  http=${rawSnapshot.status} bytes=${rawSnapshot.bytes} sha256=${rawSnapshot.sha256}`)
log(`  trust.json     http=${rawTrust.status} bytes=${rawTrust.bytes} sha256=${rawTrust.sha256}`)
log(`  release        http=${rawRelease.status} bytes=${rawRelease.bytes} sha256=${rawRelease.sha256}`)
log(`  skill payload  http=${rawPayload.status} bytes=${rawPayload.bytes} sha256=${rawPayload.sha256}`)
check("裸取 stable.json sequence", channelDoc.sequence, EXPECTED.channelSequence)
check("裸取 target.catalogVersion", channelDoc.target.catalogVersion, EXPECTED.catalogVersion)
check("裸取 release catalog sha256", rawRelease.sha256, EXPECTED.catalogSha256)
check("裸取 release catalog bytes", rawRelease.bytes, EXPECTED.catalogBytes)
check("裸取 skill payload sha256", rawPayload.sha256, EXPECTED.payloadSha256)
const rawCatalog = JSON.parse(rawRelease.body.toString("utf8")) as {
  version: string
  entries: unknown[]
  packages: Array<Record<string, any>>
}
check("裸取 entries/packages 条数", [rawCatalog.entries.length, rawCatalog.packages.length], [
  EXPECTED.entriesLength,
  EXPECTED.packagesLength,
])
const rawEnvelope = rawCatalog.packages[0]!
check("裸取 envelope prelude", rawEnvelope.prelude, {
  packageId: EXPECTED.catalogId,
  version: EXPECTED.packageVersion,
})
check("裸取 envelope presentation", rawEnvelope.presentation, {
  description: EXPECTED.description,
  displayName: EXPECTED.displayName,
})
const rawPayloadDoc = JSON.parse(rawPayload.body.toString("utf8")) as {
  behavior: { targetDir: string; files: Array<{ path: string; bytes: number; sha256: string }> }
}
check("裸取 payload.behavior.targetDir", rawPayloadDoc.behavior.targetDir, EXPECTED.skillTargetDir)
check(
  "裸取 payload.behavior.files(名/字节/sha256)",
  rawPayloadDoc.behavior.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })).sort((l, r) => (l.path < r.path ? -1 : 1)),
  EXPECTED.assets.map((a) => ({ ...a })),
)
log()

// ── 生产常量(被测对象的一部分) ─────────────────────────────────────────────────────────────
log(`## 前置 —— 生产编译进桌面端的 catalog host`)
check("CHANNEL_BASE_URL(packages/ui-mac/src/main/catalog-channels.ts:30)", CHANNEL_BASE_URL, EXPECTED.host)
log()

// ── 真 IPC 注册面 ────────────────────────────────────────────────────────────────────────────
type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
registerPackageCatalogReadIpcHandlers(
  (channel, handler) => handlers.set(channel, handler),
  // ext-ipc.ts:356-358 逐字同形:() => refreshRemoteCatalog(userDataPath, registryChannel)
  () => refreshRemoteCatalog(userData, "stable"),
)
check("注册到 ipcMain 的读通道", [...handlers.keys()].sort(), ["ext-package-detail", "ext-remote-catalog"])
const invoke = async (channel: string, ...args: unknown[]) => {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no IPC handler registered for ${channel}`)
  return await h({}, ...args)
}
log()

// ══ §1 AC1 浏览 ══════════════════════════════════════════════════════════════════════════════
log(`## §1 · AC1 —— package-capable desktop build 在 Extensions hub 浏览到 package:alpha-first`)
log(`   ipcMain.handle("ext-remote-catalog") → refreshRemoteCatalog(userData,"stable")`)
log(`   → catalog-channels 全链验签(trust → snapshot → channel → payload)`)
log(`   → evaluateCatalogPackagesForHost → projectRemoteCatalogForRenderer`)
log(`   → renderer installableCatalogPackages()(extension-hub.tsx:886-888 喂给浏览区的同一个函数)`)
const t0 = Date.now()
const browsed = (await invoke("ext-remote-catalog")) as {
  source: string
  version: string
  via: string
  channel: string
  error?: string
  catalog: { version: string; entries: unknown[]; packages?: Array<Record<string, any>> }
}
log(`  → source=${browsed.source} via=${browsed.via} channel=${browsed.channel} version=${browsed.version} ` +
  `error=${JSON.stringify(browsed.error ?? null)} (${Date.now() - t0} ms)`)
check("IPC source(远端已验签,不是缓存/内置)", browsed.source, "remote")
check("IPC via(channel-first 指针链,不是 legacy v1)", browsed.via, "channel-stable")
check("IPC channel", browsed.channel, "stable")
check("catalog.version", browsed.version, EXPECTED.catalogVersion)
check("catalog.entries 条数", browsed.catalog.entries.length, EXPECTED.entriesLength)
check("catalog.packages 条数(main 评估过的 view)", (browsed.catalog.packages ?? []).length, EXPECTED.packagesLength)
checkTrue(
  "过线的是 view 不是 raw envelope(renderer 拿不到 payloadRef/url)",
  !/payloadRef|catalog\/assets/.test(JSON.stringify(browsed.catalog.packages ?? [])),
)
const hubPackages = installableCatalogPackages(
  (browsed.catalog.packages ?? []) as never,
  browsed.catalog.entries as never,
)
check("Hub 浏览区可安装 package 的 catalogId 清单", hubPackages.map((v) => v.catalogId), [EXPECTED.catalogId])
const hubCard = hubPackages.find((v) => v.catalogId === EXPECTED.catalogId)
checkTrue("Hub 浏览区确有 package:alpha-first 卡片", hubCard !== undefined)
if (hubCard) {
  check("卡片 displayName", hubCard.presentation.displayName, EXPECTED.displayName)
  check("卡片 description", hubCard.presentation.description, EXPECTED.description)
  check("卡片 version", hubCard.presentation.version, EXPECTED.packageVersion)
  check("卡片 verdict", hubCard.verdict, "compatible")
  check("卡片 action", hubCard.action, { kind: "install", enabled: true, reasonCode: "package-compatible" })
}
log()

// ══ §2 AC2 详情 ══════════════════════════════════════════════════════════════════════════════
log(`## §2 · AC2 —— 详情页正确`)
log(`   preload/index.ts:228 packageDetail() → ipcMain.handle("ext-package-detail")`)
log(`   → extension-detail.tsx:148-152 createResource 消费的就是这个返回值`)
const detail = (await invoke(PACKAGE_DETAIL_IPC_CHANNEL, EXPECTED.catalogId)) as Record<string, unknown> | null
log(`  ${PACKAGE_DETAIL_IPC_CHANNEL}("${EXPECTED.catalogId}") → ${indent(detail)}`)
checkTrue("详情 IPC 返回非 null", detail !== null)
if (detail) {
  check("detail.catalogId", detail.catalogId, EXPECTED.catalogId)
  check("detail.presentation(逐字段)", detail.presentation, {
    displayName: EXPECTED.displayName,
    description: EXPECTED.description,
    version: EXPECTED.packageVersion,
  })
  check("detail.verdict", detail.verdict, "compatible")
  check("detail.action", detail.action, { kind: "install", enabled: true, reasonCode: "package-compatible" })
  check("detail.components(逐字段)", detail.components, [
    { componentId: EXPECTED.rootComponentId, role: "root", required: true, included: true, skipReasonCode: null },
  ])
  check("detail.prerequisites", detail.prerequisites, { status: "ready", items: [] })
  check("detail 的 wire 键集(不多不少)", Object.keys(detail).sort(), [
    "action", "catalogId", "components", "prerequisites", "presentation", "verdict",
  ])
  checkTrue(
    "详情面不泄漏 payloadRef / 资产 URL / digest",
    !/payloadRef|https?:\/\/|sha256/.test(JSON.stringify(detail)),
  )
}
check("负向:未知 catalogId 的详情", await invoke(PACKAGE_DETAIL_IPC_CHANNEL, "package:does-not-exist-aw163"), null)
check("负向:非字符串 catalogId", await invoke(PACKAGE_DETAIL_IPC_CHANNEL, 42), null)
log()

// ══ §3 AC3 安装 ══════════════════════════════════════════════════════════════════════════════
log(`## §3 · AC3 —— 安装成功;skill 落到预期的 targetDir`)
log(`   ext-ipc.ts:359-380 createPackageAdmissionCoordinator(生产接线同形,零 deps 注入)`)
log(`   两趟:①preview(stage=authorize)→ ②带 binding 确认 → runExtensionTransaction`)
const loadVerifiedCatalog = async () => {
  const loaded = await refreshRemoteCatalog(userData, "stable")
  return loaded.source === "none"
    ? { source: "none" as const, error: loaded.error }
    : { source: loaded.source, catalog: loaded.catalog, snapshotDigest: loaded.snapshotDigest }
}
const admit = createPackageAdmissionCoordinator({
  loadVerifiedCatalog,
  root: () => root,
  userDataPath: userData,
  casBaseRoot: () => casBase,
  environment: () => "dev",
})
const intent = { catalogId: EXPECTED.catalogId, scope: { scope: "global" as const }, attemptId: `aw163-${Date.now()}` }
const preview = (await admit(intent)) as Record<string, any>
log(`  preview → ok=${preview.ok} stage=${preview.stage ?? "-"} reason=${JSON.stringify(preview.reason ?? null)}`)
check("preview 是授权阶段(不是一键直装)", { ok: preview.ok, stage: preview.stage }, { ok: false, stage: "authorize" })
if (preview.packageAuthorization) {
  log(`  preview.plan = ${indent(preview.packageAuthorization.plan)}`)
  log(`  preview.binding = ${indent(preview.packageAuthorization.binding)}`)
  check("plan.packageId / version", [preview.packageAuthorization.plan.packageId, preview.packageAuthorization.plan.version], [
    EXPECTED.catalogId, EXPECTED.packageVersion,
  ])
  check("plan 组件", preview.packageAuthorization.plan.items.map((i: any) => i.componentId), [EXPECTED.rootComponentId])
  check("plan item kind/name/key", preview.packageAuthorization.plan.items.map((i: any) => [i.kind, i.name, i.key]), [
    ["skill", EXPECTED.skillName, "skill--alpha-first"],
  ])
  check("plan item payloadDigest(= 独立取到的载荷 sha256)", preview.packageAuthorization.plan.items[0].payloadDigest,
    `sha256:${EXPECTED.payloadSha256}`)
  check("binding.snapshotDigest(= §0 裸取 snapshot.json 的 sha256)",
    preview.packageAuthorization.binding.snapshotDigest, rawSnapshot.sha256)
  check("binding.itemDigests 的键", Object.keys(preview.packageAuthorization.binding.itemDigests), [EXPECTED.rootComponentId])
  // 纯 skill 包不声明任何 capability ⇒ 一行 diff、空集、无需确认(不是"没有行")。
  check("授权 diff(纯 skill 包:一行空 capability、无需确认)", preview.authorization, [
    { key: "skill--alpha-first", requested: [], previous: null, added: [], removed: [], requiresConfirmation: false },
  ])
}
const confirmed = (await admit({
  ...intent,
  authorization: {
    confirmed: Object.fromEntries((preview.authorization ?? []).map((i: any) => [i.key, i.requested])),
    binding: preview.packageAuthorization.binding,
  },
})) as Record<string, any>
log(`  commit → ${indent(confirmed)}`)
check("安装结果 ok", confirmed.ok, true)
check("安装结果 kind/name", { kind: confirmed.kind, name: confirmed.name }, { kind: "skill", name: EXPECTED.skillName })
check("installed / skipped", { installed: confirmed.installed, skipped: confirmed.skipped }, {
  installed: [EXPECTED.rootComponentId], skipped: [],
})

// —— 实物落点:用**生产的**指针解析器,不自己拼路径
const liveDir = resolveLiveGenerationDir(root, skillGenerationKey(EXPECTED.skillName))
log(`  resolveLiveGenerationDir(root, "${skillGenerationKey(EXPECTED.skillName)}") = ${liveDir}`)
checkTrue("live generation 目录解析得出(current.json 指针有效)", liveDir !== null)
if (liveDir) {
  const rel = path.relative(root, liveDir)
  checkTrue(
    "落点 = <globalRoot>/ext-store/skill--alpha-first/generations/<genId>",
    /^ext-store\/skill--alpha-first\/generations\/gen-\d{6,}-[a-f0-9]{6,}$/.test(rel),
    rel,
  )
  const landed = fs
    .readdirSync(liveDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const data = fs.readFileSync(path.join(liveDir, e.name))
      return { path: e.name, bytes: data.byteLength, sha256: sha256(data) }
    })
    .sort((l, r) => (l.path < r.path ? -1 : 1))
  check("落地文件(名/字节/sha256 逐字段 = 公网资产)", landed, EXPECTED.assets.map((a) => ({ ...a })))
  const fm = parseSkillFrontmatter(fs.readFileSync(path.join(liveDir, "SKILL.md"), "utf8"))
  check("SKILL.md frontmatter name(生产 parseSkillFrontmatter)", fm.ok ? fm.name : fm, EXPECTED.skillName)
  checkTrue("flat 旧路径 <root>/skills/alpha-first 不存在(单一真源)", !fs.existsSync(path.join(root, "skills", EXPECTED.skillName)))
}

// —— 账本
const ledger = readPackageLedgerStateV1(root)
checkTrue("账本可读", ledger.ok, ledger.ok ? "" : String((ledger as any).reason))
if (ledger.ok) {
  check("账本 packageGraphs 的 packageId", ledger.packageGraphs.map((g) => g.packageId), [EXPECTED.catalogId])
  check("账本图的 root 组件", ledger.packageGraphs.map((g) => [g.root.kind, g.root.name]), [["skill", EXPECTED.skillName]])
  const rec = ledger.records.find((r) => r.kind === "skill" && r.name === EXPECTED.skillName)
  checkTrue("账本有 skill:alpha-first 记录", rec !== undefined)
  if (rec) {
    log(`  ledger record: kind=${rec.kind} name=${rec.name} origin=${rec.origin} desiredState=${rec.desiredState}`)
    check("记录 origin", rec.origin, "catalog")
    // 目录安装 + source ≠ "alpha" ⇒ 保守面 disabled(shared/ext-install-policy.ts:68)。
    // 这是既定策略,不是缺陷;记在这里,是为了让下一步「引擎读不到」有一个诚实的解释。
    check("记录 desiredState(目录安装保守面 = 已安装但未启用)", rec.desiredState, "disabled")
  }
}
log()

// —— 引擎侧的读(不是「断言引擎会读的那个文件」)
log(`### §3.1 引擎侧的读 —— packages/ext/src/gen-skill-paths.ts::injectSkillGenerationPaths`)
const cfgDisabled: Record<string, unknown> = {}
check("未启用时引擎注入的 skills.paths(fail-closed 允许集)", injectSkillGenerationPaths(cfgDisabled, root), [])

log(`   经生产启停通道 setInstallStateByKey({type:"skill",name:"alpha-first",scope:"global",state:"enabled"})`)
const plannerDepsForState = {
  globalRoot: () => root,
  advisoryGate: makeAdvisoryGate(userData),
  resolveEntry: async (catalogId: string) => {
    const rc = await refreshRemoteCatalog(userData, "stable")
    if (rc.source === "none") return null
    const cat = rc.catalog as { version: string; entries: Array<{ id: string }> }
    const entry = cat.entries.find((e) => e.id === catalogId)
    return entry ? { entry: entry as never, channel: rc.source, catalogVersion: String(cat.version) } : null
  },
  resolvePackage: async (packageId: string, version: string) => {
    const rc = await refreshRemoteCatalog(userData, "stable")
    if (rc.source === "none") return { status: "refused" as const, reason: rc.error }
    const resolved = resolveVerifiedPackageV1(rc.catalog, packageId, version)
    return resolved.status === "found"
      ? { status: "found" as const, channel: rc.source, identity: resolved.identity }
      : resolved.status === "missing"
        ? { status: "missing" as const, channel: rc.source, anyVersionPresent: resolved.anyVersionPresent }
        : resolved
  },
}
const enabled = await setInstallStateByKey(
  { type: "skill", name: EXPECTED.skillName, scope: "global", state: "enabled" },
  plannerDepsForState as never,
)
log(`  setInstallStateByKey → ${JSON.stringify(enabled)}`)
check("启停通道 ok", (enabled as any).ok, true)
const cfgEnabled: Record<string, unknown> = {}
const added = injectSkillGenerationPaths(cfgEnabled, root)
log(`  injectSkillGenerationPaths → ${indent(cfgEnabled)}`)
check("启用后引擎注入的 skills.paths 恰是 live generation 目录", added, liveDir ? [liveDir] : [])
check("cfg.skills.paths 被真的写进配置对象", (cfgEnabled.skills as any)?.paths, liveDir ? [liveDir] : [])
checkTrue(
  "引擎注入的那个目录里确有 SKILL.md",
  added.length === 1 && fs.existsSync(path.join(added[0]!, "SKILL.md")),
)
log()

// ══ §4 负向对照 —— 先证明这套观测能测出已知的坏 ══════════════════════════════════════════════
log(`## §4 负向对照(证明上面的绿不是「下载了什么就报什么」)`)

// 4a. 换掉内置信任根 ⇒ 整条链必须拒,且是 security 类(绝不借道 legacy v1)
const wrongKey = (generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64")
const forgedTrustState = mk("neg-wrong-key")
const wrongKeyResult = await refreshRemoteCatalog(forgedTrustState, "stable", { builtinKeyB64: wrongKey })
log(`  换错内置公钥 → ${JSON.stringify({ source: wrongKeyResult.source, reasonClass: (wrongKeyResult as any).reasonClass, error: (wrongKeyResult as any).error })}`)
check("4a 换错内置公钥后的 source", wrongKeyResult.source, "none")
check("4a 失败类(security ⇒ 禁 legacy v1 回退)", (wrongKeyResult as any).reasonClass, "security")

// 4b. 篡改载荷字节 ⇒ package view 必须落 blocked / package-payload-integrity
const tamperState = mk("neg-tampered-payload")
const tampered = await refreshRemoteCatalog(tamperState, "stable", {
  packageInstallability: { fetchPayload: async () => new TextEncoder().encode("{}\n") },
})
const tamperedView = tampered.source === "none" ? null : (tampered as any).packageViews?.[0]
log(`  篡改载荷 → source=${tampered.source} view=${JSON.stringify(tamperedView && { verdict: tamperedView.verdict, action: tamperedView.action })}`)
check("4b 篡改载荷后的 verdict/action", tamperedView && { verdict: tamperedView.verdict, action: tamperedView.action }, {
  verdict: "blocked",
  action: { kind: "none", enabled: false, reasonCode: "package-payload-integrity" },
})

// 4c. admission 对不在已验 catalog 里的 id 必须拒
const bogusAdmit = (await admit({
  catalogId: "package:not-published-aw163",
  scope: { scope: "global" as const },
  attemptId: `aw163-neg-${Date.now()}`,
})) as Record<string, any>
log(`  admission(未发布 id) → ${JSON.stringify(bogusAdmit)}`)
check("4c 未发布 id 的 admission ok", bogusAdmit.ok, false)

// 4d. 重放同一个 attemptId 必须拒(证明两趟授权是真的)
const replay = (await admit({
  ...intent,
  authorization: {
    confirmed: Object.fromEntries((preview.authorization ?? []).map((i: any) => [i.key, i.requested])),
    binding: preview.packageAuthorization.binding,
  },
})) as Record<string, any>
log(`  重放已消费的 attemptId → ${JSON.stringify(replay)}`)
check("4d 重放 attemptId 的结果", { ok: replay.ok, reason: replay.reason }, {
  ok: false,
  reason: "package admission: stale or replayed attempt",
})

// 4e. 用**同一个生产客户端**打旧域 —— 证明上面的绿真的来自 codepuppy.cn,
//     而不是任何一份缓存/内置内容(临时 userData 本来就没有缓存,这条是第二重)。
const legacyState = mk("neg-legacy-domain")
const legacyStart = Date.now()
const legacy = await refreshRemoteCatalog(legacyState, "stable", { baseUrl: "https://alphacodeone.com/catalog/v1" })
log(`  旧域 alphacodeone.com → ${JSON.stringify({ source: legacy.source, reasonClass: (legacy as any).reasonClass, error: (legacy as any).error })} (${Date.now() - legacyStart} ms)`)
check("4e 旧域的 source(已停用 ⇒ 拿不到任何内容)", legacy.source, "none")

log()

log(`checks=${checks} failures=${failures}`)
log(`finished     ${new Date().toISOString()}`)
if (failures > 0) process.exitCode = 1
