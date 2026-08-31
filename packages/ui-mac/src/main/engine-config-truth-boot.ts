// REQ-059 T2:启动 reconcile —— 存量引擎配置迁进当前环境 `alpha.jsonc`(copy-don't-delete)。
//
// 读 legacy(`~/.opencode/opencode.jsonc`,REQ-018 时代 mcp/plugin/治理键)+ XDG provider 域 →
// 所有权判定(isAlphaOwnedConfig,越界/非账内 mcp = bail-out loud 不迁,保留原布局功能零损失)→
// planConfigMerge(幂等 + existing 优先)→ 写 alpha.jsonc。**不删源**:`~/.opencode` 清理(拆桥 +
// 删目录)属 T3(桥退役),迁移期两处内容一致(merge 幂等),引擎从两处读无冲突。
//
// 逃生:ALPHA_JSONC_TRUTH_DISABLE=1 / ALPHA_LEGACY_INSTALL_ROOT=1 → 不迁(回旧行为,与 sidecar 注入
// 及 ext-config 写入目标三侧一致)。启动早期(sidecar fork 前)调用一次;幂等,重复启动 no-op。
//
// ADR-040(`#832`):本模块**不再有自己的写盘原语**。它曾经 `writeFileSync(tmp)+rename` 写整个
// `alpha.jsonc` —— 整文件写,`writeKeyUnlocked` / `prepareConfigTx` / `writeConfigLeafEditsUnlocked`
// 三道白名单一道都不过,于是「往引擎 `plugin[]` 里加东西」在这条路上是免检的(它每次启动都跑)。
// 现在落盘经 `ext-config` 那个**已挂咽喉**的原子提交点:本函数将来无论新增什么注入步,只要写完
// 之后 `plugin[]` 里多出写之前没有的元素,就在写盘那一刻被具名拒掉,不需要谁记得来这里登记。
// 与之配套,legacy 的 `plugin[]` 并集已从 `planConfigMerge` 删除 —— 那是唯一真的会撞上这道闸的
// 加法,留着它等于每次启动都拿一次拒绝换一次「整个 reconcile 不写盘」。

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse } from "jsonc-parser"
import { alphaGlobalRoot } from "./alpha-installs"
import { opencodeHomeDir } from "./alpha-bridge"
import { readLedger } from "./alpha-installs"
import { agentMdToEntry } from "./agent-md-entry"
import { persistAgentEntry, writeConfigTextAtomic } from "./ext-config"
import {
  alphaJsoncPath,
  alphaSkillsDir,
  ensureSkillsPath,
  isAlphaOwnedConfig,
  isJunkOnlyDir,
  planConfigMerge,
  rewriteFactorySkillPaths,
  stripFactoryBuiltinPolicyLeaves,
} from "./engine-config-truth"
import { FACTORY_SKILL_IDS } from "./factory-skills"
import { FACTORY_DENIED_SKILLS } from "./alpha-builtin-policy"

type Logger = { log: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void }

export type ReconcileOutcome =
  | { skipped: true; reason: string }
  | { skipped: false; migrated: boolean; added: string[]; bailedOut?: string }

/** Mirror ext-config userConfigDir()/userConfigPath() for the shared XDG provider domain. */
function xdgConfigPath(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR
    ? process.env.OPENCODE_CONFIG_DIR
    : process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(os.homedir(), ".config", "opencode")
  const jsonc = path.join(dir, "opencode.jsonc")
  const json = path.join(dir, "opencode.json")
  if (fs.existsSync(jsonc)) return jsonc
  if (fs.existsSync(json)) return json
  return jsonc
}

function legacyOpencodePath(): string {
  const dir = opencodeHomeDir()
  const jsonc = path.join(dir, "opencode.jsonc")
  const json = path.join(dir, "opencode.json")
  if (fs.existsSync(jsonc)) return jsonc
  if (fs.existsSync(json)) return json
  return jsonc
}

type JsoncRead =
  // `text` = 盘上那份**原始文本**。`#832`:落盘要过咽喉,而咽喉判的是 before/after 两份整文本 ——
  // 拿解析后的对象反序列化回去当 before 会把「盘上本来就语法坏掉」这个事实抹平(它正是要 fail-closed
  // 的那一格)。缺席记 `""`(咽喉与 `"{}"` 等价处理)。
  | { status: "ok"; value: Record<string, unknown>; text: string }
  | { status: "absent"; text: string }
  | { status: "unreadable"; reason: string }

/** #395(Codex r5)步骤4:读错误只容缺席(ENOENT/ENOTDIR)—— EACCES/EIO 等「读不出」≠「不存在」。
 *  truth 读不出还照写 = 以不完整基底重建 alpha.jsonc,会抹掉既有内容(含 disabled 投影键);
 *  legacy/XDG 读不出当缺席 = 该迁的没迁还可能触发清理。非缺席错误一律显式上报,由调用方 fail-closed。
 *  (解析容忍度不变:jsonc-parser 容错解析,非对象/解析异常仍视作无内容 —— 与既有迁移语义一致。) */
function readJsonc(file: string): JsoncRead {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "absent", text: "" }
    return { status: "unreadable", reason: `${file}: ${code ?? String(e)}` }
  }
  try {
    const parsed = parse(text) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { status: "ok", value: parsed as Record<string, unknown>, text }
      : { status: "absent", text }
  } catch {
    return { status: "absent", text }
  }
}

export type ReconcileOptions = {
  /** REQ-065(修订):出厂路径已改内存注入(env → ext config hook),不再写入 alpha.jsonc。
   *  此参数现用于**剥离**历史版本写盘的出厂条目:传 [](reconcile 成功时的常态)= 只清不加;
   *  不传 = 不动该组(factory reconcile 失败时的保守态/测试兼容)。 */
  factorySkillDirs?: string[]
  /** 仅用于测试隔离退休根；生产默认真实 home。 */
  retiredHomeDir?: string
  /** 仅用于退休桥竞争测试；生产固定使用 node:fs。 */
  retiredBridgeFs?: RetiredBridgeFs
}

type RetiredBridgeFs = {
  lstatSync: (file: string) => fs.Stats
  readlinkSync: (file: string) => string
  readdirSync: (directory: string) => string[]
  unlinkSync: (file: string) => void
}

/**
 * Migrate legacy engine config into the alpha truth file. Copy-don't-delete + idempotent.
 * Returns an outcome for logging/telemetry. Retirement bridge cleanup errors propagate so startup can
 * fail closed; ordinary migration misses retain the existing best-effort outcome semantics.
 */
export function reconcileEngineConfigTruth(log?: Logger, opts?: ReconcileOptions): ReconcileOutcome {
  // 退休桥断链与配置迁移完全独立：必须早于 escape hatch、truth 读失败、ownership bail-out 等
  // 任一提前返回。这里只 lstat/readlink 桥本身，不 realpath/读取/迁移退休目标。
  unlinkRetiredOpencodeBridges(opts?.retiredHomeDir ?? os.homedir(), log, opts?.retiredBridgeFs)
  if (process.env.ALPHA_JSONC_TRUTH_DISABLE === "1" || process.env.ALPHA_LEGACY_INSTALL_ROOT === "1") {
    return { skipped: true, reason: "escape hatch set (ALPHA_JSONC_TRUTH_DISABLE / ALPHA_LEGACY_INSTALL_ROOT)" }
  }
  const truth = alphaJsoncPath()
  const legacyFile = legacyOpencodePath()
  const xdgFile = xdgConfigPath()

  const existingRead = readJsonc(truth)
  if (existingRead.status === "unreadable") {
    // 步骤4(#395):truth 读不出(非缺席)→ 不写 —— 以不完整基底重建 alpha.jsonc 会抹掉既有
    // 内容(含 disabled 投影键 = 禁用被复活)。fail-closed,本次启动跳过 reconcile。
    log?.warn(`[req059] alpha.jsonc unreadable — reconcile fail-closed, config untouched: ${existingRead.reason}`)
    return { skipped: true, reason: `alpha.jsonc unreadable (fail closed): ${existingRead.reason}` }
  }
  const existing = existingRead.status === "ok" ? existingRead.value : undefined
  const legacyRead = readJsonc(legacyFile)
  const xdgRead = readJsonc(xdgFile)
  if (xdgRead.status === "unreadable")
    log?.warn(`[req059] XDG config unreadable — provider domain not lifted this launch: ${xdgRead.reason}`)
  const legacy = legacyRead.status === "ok" ? legacyRead.value : undefined
  const xdg = xdgRead.status === "ok" ? xdgRead.value : undefined

  // Ownership judgement only gates the legacy ~/.opencode MIGRATION (alpha wrote it wholesale) — NOT the
  // skills.paths injection below. Critical: a bail-out (e.g. an mcp without a receipt) must NOT block
  // skills.paths, or factory skills would go dark on exactly the machines that keep their legacy config.
  let bailedOut: string | undefined
  let legacyToMerge = legacy
  if (legacyRead.status === "unreadable") {
    // 步骤4(#395):legacy 读不出 ≠ 缺席 —— 不迁移、不清理(bail-out loud,原布局功能零损失)。
    log?.warn(`[req059] legacy ~/.opencode config unreadable — skipping MIGRATION (kept in place): ${legacyRead.reason}`)
    bailedOut = `legacy unreadable: ${legacyRead.reason}`
  } else if (legacy) {
    const receipts = readLedger(alphaGlobalRoot()).receipts
    const receiptMcpNames = new Set(receipts.filter((r) => r.type === "mcp").map((r) => r.name))
    const receiptPluginKeys = new Set(
      receipts.filter((r) => r.type === "plugin").map((r) => r.configKey ?? r.name),
    )
    const verdict = isAlphaOwnedConfig({ parsed: legacy, receiptMcpNames, receiptPluginKeys })
    if (!verdict.owned) {
      log?.warn(`[req059] legacy ~/.opencode config not alpha-owned — skipping MIGRATION (kept in place): ${verdict.reason}`)
      bailedOut = verdict.reason
      legacyToMerge = undefined // don't migrate legacy content; skills.paths still injected below
    } else if (verdict.unaccountedMcp && verdict.unaccountedMcp.length > 0) {
      // .opencode 是 alpha 领地 → 迁移;但这些 mcp 无 receipt(早期装的记账丢),loud 留痕(卸载/更新
      // 对它们会失真,直到 receipt 补齐)。用户拍板「放宽」:记账不全不阻断品牌收敛。
      log?.warn(`[req059] migrating legacy mcp without receipts (bookkeeping incomplete)`, {
        unaccounted: verdict.unaccountedMcp.slice(0, 8),
      })
    }
  }

  // XDG provider domain is lifted only when we're not bailing out (bail = leave the legacy world intact).
  const xdgProvider = !bailedOut && xdg && "provider" in xdg ? { provider: xdg.provider } : undefined

  const plan = planConfigMerge(existing, legacyToMerge, xdgProvider)
  // T3:全局 skills 经 skills.paths(文件通道生效)发现当前环境 skills —— 恒定注入(非迁移物,独立于
  // ownership bail),使桥退役后引擎仍能发现**用户装的**技能。幂等。
  const skillsAdded = ensureSkillsPath(plan.merged, alphaSkillsDir())
  // REQ-065:出厂技能条目组重写 —— 直指 app 资源(不再经全局 skills 链中转;alphaGlobalRoot() 只承载
  // 用户自有内容)。每启动重写,跟随 app 安装路径/版本变化;stale 出厂路径按名单+布局判定移除。
  const factoryRewritten = opts?.factorySkillDirs
    ? rewriteFactorySkillPaths(plan.merged, opts.factorySkillDirs, FACTORY_SKILL_IDS)
    : false
  // REQ-067:剥离历史物化的「出厂默认禁」明文(permission.skill deny + 占位 command)——
  // 该行为现由 env → ext hook 内存注入,用户配置零痕迹。幂等,无条件执行(只针对出厂清单名)。
  const denyStripped = stripFactoryBuiltinPolicyLeaves(plan.merged, FACTORY_DENIED_SKILLS)
  const added = [
    ...plan.added,
    ...(skillsAdded ? ["skills[]"] : []),
    ...(factoryRewritten ? ["skills.factory[]"] : []),
    ...(denyStripped ? ["factory-deny-stripped"] : []),
  ]

  let migrated = false
  if (plan.changed || skillsAdded || factoryRewritten || denyStripped) {
    // ADR-040(`#832`)咽喉:整文件写盘收进 ext-config 的唯一原子提交点(mkdir / .bak / tmp+rename /
    // 结果 jsonc 校验都在里面)。拒绝 = 一个字节都不落,且**本次 reconcile 到此为止** —— 不继续去
    // 清理 `~/.opencode`(那一步的前提是「内容已经安全落到真源」,前提没成立就不能删源)。
    const written = writeConfigTextAtomic(truth, existingRead.text, JSON.stringify(plan.merged, null, 2) + "\n")
    if (!written.ok) {
      log?.warn(`[req059] alpha.jsonc write refused during reconcile — config untouched`, { reason: written.reason })
      // 报的是**这次为什么一个字节都没写**(而不是更早那条 legacy 所有权 bail 的理由 —— 它已经
      // 各自 loud 过一遍了)。写不下去比「legacy 没迁」严重一档,报低的那条会让人查错方向。
      return { skipped: false, migrated: false, added: [], bailedOut: written.reason }
    }
    log?.log(`[req059] current-environment engine config truth updated`, { added })
    migrated = true
  }

  // Bail-out → leave ~/.opencode fully intact (legacy mcp/plugin still read by the engine). Only clean up
  // when the legacy world is alpha-owned (or absent) so nothing user-authored is touched.
  if (bailedOut) return { skipped: false, migrated, added, bailedOut }

  // T3:migration/injection 落定后清理 ~/.opencode —— 拆自有链、删已迁配置,junk-only 则整目录删。
  // 只在 legacy owned(未 bail-out)时执行:含用户内容的机器保留 + loud(§风险)。
  cleanupOpencodeHome(log)

  return { skipped: false, migrated, added }
}

type RetiredBridgeProbe =
  | { status: "absent" }
  | { status: "other"; stat: fs.Stats }
  | { status: "retired"; dev: number; ino: number; target: string }

const RETIRED_BRIDGE_UNLINK_ATTEMPTS = 3

function unlinkRetiredOpencodeBridges(homeDir: string, log?: Logger, injected?: RetiredBridgeFs): void {
  const bridgeFs = injected ?? {
    lstatSync: fs.lstatSync,
    readlinkSync: fs.readlinkSync,
    readdirSync: fs.readdirSync,
    unlinkSync: fs.unlinkSync,
  }
  const opencodeDir = opencodeHomeDir()
  const retiredRoot = path.resolve(homeDir, ".alpha")
  for (const kind of ["skills", "agents", "commands"] as const) {
    const kindPath = path.join(opencodeDir, kind)
    const kindProbe = probeRetiredBridge(kindPath, retiredRoot, bridgeFs)
    if (kindProbe.status === "absent") continue
    if (kindProbe.status === "retired") {
      if (unlinkRetiredBridge(kindPath, retiredRoot, kindProbe, bridgeFs)) {
        log?.log(`[req098] retired ~/.opencode/${kind} bridge removed`)
      }
      continue
    }
    if (!kindProbe.stat.isDirectory()) continue
    for (const name of readdirOrAbsent(kindPath, bridgeFs)) {
      const itemPath = path.join(kindPath, name)
      const itemProbe = probeRetiredBridge(itemPath, retiredRoot, bridgeFs)
      if (itemProbe.status !== "retired") continue
      if (unlinkRetiredBridge(itemPath, retiredRoot, itemProbe, bridgeFs))
        log?.log(`[req098] retired ~/.opencode/${kind}/${name} bridge removed`)
    }
  }
}

function probeRetiredBridge(link: string, root: string, bridgeFs: RetiredBridgeFs): RetiredBridgeProbe {
  const stat = lstatOrAbsent(link, bridgeFs)
  if (!stat) return { status: "absent" }
  if (!stat.isSymbolicLink()) return { status: "other", stat }
  const target = readlinkOrAbsent(link, bridgeFs)
  if (target === null) return { status: "absent" }
  const resolved = path.resolve(path.dirname(link), target)
  const relative = path.relative(root, resolved)
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) return { status: "other", stat }
  return { status: "retired", dev: stat.dev, ino: stat.ino, target }
}

function unlinkRetiredBridge(
  link: string,
  root: string,
  expected: Extract<RetiredBridgeProbe, { status: "retired" }>,
  bridgeFs: RetiredBridgeFs,
): boolean {
  let admitted = expected
  for (let attempt = 0; attempt < RETIRED_BRIDGE_UNLINK_ATTEMPTS; attempt++) {
    const current = probeRetiredBridge(link, root, bridgeFs)
    if (current.status !== "retired") return false
    if (current.dev !== admitted.dev || current.ino !== admitted.ino || current.target !== admitted.target) {
      // #428 r3：竞争换位只有变成非退休对象才跳过；换入另一条退休链则采用新身份继续重验删除。
      admitted = current
      continue
    }
    // 删除前用 dev/ino + 原始 target 紧邻重验同一退休链。接受的残余仅为这次
    // lstat/readlink 重验到单次 unlink 之间的微秒级竞态；与 #358 r3 同口径，不引入 openat。
    try {
      bridgeFs.unlinkSync(link)
      return true
    } catch (error) {
      if (isEnoent(error)) return false
      throw error
    }
  }
  throw new Error(`retired bridge kept changing identity after ${RETIRED_BRIDGE_UNLINK_ATTEMPTS} attempts: ${link}`)
}

function lstatOrAbsent(file: string, bridgeFs: RetiredBridgeFs): fs.Stats | null {
  try {
    return bridgeFs.lstatSync(file)
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
}

function readlinkOrAbsent(file: string, bridgeFs: RetiredBridgeFs): string | null {
  try {
    return bridgeFs.readlinkSync(file)
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
}

function readdirOrAbsent(directory: string, bridgeFs: RetiredBridgeFs): string[] {
  try {
    return bridgeFs.readdirSync(directory)
  } catch (error) {
    if (isEnoent(error)) return []
    throw error
  }
}

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"
}

/**
 * T3 桥退役 + `~/.opencode` 清理:拆指向当前环境根的 alpha 自有 skills/agents/commands 链、
 * 删已迁的 opencode.jsonc/.json + `.alpha-bak-*` 残留;剩余仅引擎 junk 白名单 → 整目录删除。
 * 含用户自建内容(非链、非 junk)→ 保留 + loud(降级共存,ADR-019 §4)。幂等、best-effort。
 */
function cleanupOpencodeHome(log?: Logger): void {
  const dir = opencodeHomeDir()
  const alphaRoot = alphaGlobalRoot()
  try {
    if (!fs.existsSync(dir)) return
  } catch {
    return
  }
  // 0.(T3b)存量 agents 桥 → 条目化迁移 + 拆链:<current-environment-root>/agents/*.md → alpha.jsonc
  //    agent 条目;**全部成功才拆 agents 桥**(任一转换失败 → loud 保留桥 = 该 agent 继续经桥可见,
  //    诚实降级)。幂等:persistAgentEntry 覆盖写同值;无 agents 目录/无桥 → no-op。
  migrateAgentBridges(dir, alphaRoot, log)
  // 1. 拆 alpha 自有的类目 symlink(dir-link 指向当前环境的 <kind>)。用户真实目录/异源链不碰。
  //    skills = REQ-059 T3(skills.paths 文件通道接管);agents 由上一步全权处理(迁移成功才拆);
  //    commands = 防御性(无写入方,预留目录,若存在 alpha 链一并拆)。
  for (const kind of ["skills", "commands"]) {
    const p = path.join(dir, kind)
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(p)
        const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target)
        if (resolved === path.join(alphaRoot, kind) || resolved.startsWith(alphaRoot + path.sep)) {
          fs.unlinkSync(p)
          log?.log(`[req059] unbridged ~/.opencode/${kind} (pointed into current environment root)`)
        }
      }
    } catch {
      /* not present / not a link → nothing to unbridge */
    }
  }
  // 2. 删已迁的 alpha 引擎配置文件 + 会话残留备份(内容已 merge 进真源,幂等安全)。
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f === "opencode.jsonc" || f === "opencode.json" || f.startsWith("opencode.jsonc.alpha-bak") || f.startsWith("opencode.json.alpha-bak")) {
        try {
          fs.unlinkSync(path.join(dir, f))
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* unreadable dir */
  }
  // 3. 剩余仅引擎 junk → 整目录删;含用户内容 → 保留 loud。
  try {
    const residual = fs.readdirSync(dir)
    if (isJunkOnlyDir(residual, [])) {
      fs.rmSync(dir, { recursive: true, force: true })
      log?.log(`[req059] removed ~/.opencode (only engine junk remained)`)
    } else if (residual.length > 0) {
      log?.warn(`[req059] ~/.opencode retained — user-authored content present`, { residual: residual.slice(0, 8) })
    }
  } catch {
    /* best effort */
  }
}

/**
 * T3b:存量 agents 桥的条目化迁移。桥形态两种(alpha-bridge):目录级 dir-link
 * `~/.opencode/agents → <current-environment-root>/agents`,或真实目录内的逐条目链。逐 md 转换写条目;
 * **全部成功才拆链**(部分失败 → 保留桥,loud;下次启动重试 —— persistAgentEntry 幂等)。
 */
function migrateAgentBridges(opencodeDir: string, alphaRoot: string, log?: Logger): void {
  const bridged = path.join(opencodeDir, "agents")
  const alphaAgents = path.join(alphaRoot, "agents")
  let form: "dir-link" | "item-links" | null = null
  const itemLinks: string[] = []
  try {
    const st = fs.lstatSync(bridged)
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(bridged)
      const resolved = path.isAbsolute(target) ? target : path.resolve(opencodeDir, target)
      if (resolved === alphaAgents || resolved.startsWith(alphaRoot + path.sep)) form = "dir-link"
    } else if (st.isDirectory()) {
      for (const f of fs.readdirSync(bridged)) {
        const p = path.join(bridged, f)
        try {
          const ls = fs.lstatSync(p)
          if (!ls.isSymbolicLink()) continue
          const target = fs.readlinkSync(p)
          const resolved = path.isAbsolute(target) ? target : path.resolve(bridged, target)
          if (resolved.startsWith(alphaRoot + path.sep)) itemLinks.push(p)
        } catch {
          /* skip */
        }
      }
      if (itemLinks.length > 0) form = "item-links"
    }
  } catch {
    return // no agents bridge at all
  }
  if (!form) return

  // 迁移:真源 md 全部转换成条目(alpha.jsonc);任一失败 → 保留桥 loud。
  let mds: string[] = []
  try {
    mds = fs.existsSync(alphaAgents) ? fs.readdirSync(alphaAgents).filter((f) => f.endsWith(".md")) : []
  } catch {
    mds = []
  }
  for (const f of mds) {
    const name = f.slice(0, -3)
    let content: string
    try {
      content = fs.readFileSync(path.join(alphaAgents, f), "utf8")
    } catch (error) {
      log?.warn(`[req059-t3b] agent md unreadable — bridge kept`, { file: f, error: String(error) })
      return
    }
    const parsed = agentMdToEntry(content)
    if (!parsed.ok) {
      log?.warn(`[req059-t3b] agent "${name}" not convertible (${parsed.reason}) — bridge kept for all agents`)
      return
    }
    const persisted = persistAgentEntry(name, parsed.entry)
    if (!persisted.ok) {
      log?.warn(`[req059-t3b] agent "${name}" entry write failed (${persisted.reason}) — bridge kept`)
      return
    }
  }
  // 全部条目就位 → 拆桥
  try {
    if (form === "dir-link") {
      fs.unlinkSync(bridged)
    } else {
      for (const p of itemLinks) fs.unlinkSync(p)
      if (fs.readdirSync(bridged).length === 0) fs.rmSync(bridged, { recursive: true, force: true })
    }
    log?.log(`[req059-t3b] agents bridge retired (${mds.length} agent(s) migrated to alpha.jsonc entries)`)
  } catch (error) {
    log?.warn(`[req059-t3b] agents bridge unlink failed`, { error: String(error) })
  }
}
