// alpha 自有文件(basename `alpha-*`;ADR-043 谓词因子②)。
//
// REQ-131 / #1128 —— 分层工具策略的 **managed cap 读取器**(#724 CLOSE_DECIDE §4 第 1 步)。
//
// ── 为什么不用 `ConfigManaged.managedConfigDir()`(本票必修条款)────────────────
// `packages/opencode/src/config/managed.ts:31-32` 是
// `process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR || systemManagedConfigDir()` ——
// env 一旦存在,**系统 managed 目录被整个替换掉**:org/MDM 下发的 deny 从 cap 层
// 静默消失。cap 的定义是「不可突破」,一个进程环境变量就能摘掉的东西不配叫 cap。
// 本读取器因此**无条件读系统目录**;`OPENCODE_TEST_MANAGED_CONFIG_DIR` 只作为
// **additive 且优先级更低**的补充来源(它能加规则,压不掉系统规则)。
// 负向闸:`test/permission/alpha-tool-policy.test.ts` 证明「env 存在时系统 managed
// deny 仍生效」。
//
// managed.ts 本体是上游文件(north-star UPSTREAM_PATHS,未收编),不能改它 ——
// 所以系统目录的平台映射在这里**逐字重述**(darwin/win32/linux 三行)。这份重复
// 是刻意的、登记过的:上游若改那三行,alpha 的 cap 目录不跟着漂,方向是 fail-closed
// (我们至多多读一个不存在的目录,不会少读系统目录)。
//
// ── 优先级(低 → 高;`findLast` 语义下排在后面的赢)──────────────────────────
//   1. OPENCODE_TEST_MANAGED_CONFIG_DIR(additive,最低)
//   2. 系统 managed 目录(darwin: /Library/Application Support/opencode …)
//   3. macOS MDM managed preferences(.mobileconfig;上游 config.ts 同款「override everything」)
//
// ── 坏输入的方向(§5 同源:不得静默忽略一条可能原本是 deny 的坏记录)────────────
// 任一 **managed 来源**(系统目录文件 / MDM plist)存在但读不出 ⇒ 整个 cap 层
// `unreadable`,resolver 对所有用户可配置工具判 disabled。测试目录读不出**不算**
// unreadable —— 它是 additive 的测试便利,不承载 org 意志;丢掉它只会更严,不会更松。
import { existsSync, readFileSync } from "fs"
import path from "path"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Schema } from "effect"
import { ConfigManaged } from "@/config/managed"
import { ConfigParse } from "@/config/parse"
import { fromConfig } from "./index"

/** 与 `config/managed.ts` 的私有 `systemManagedConfigDir()` 逐字对应(见抬头)。 */
export function systemManagedPolicyDir(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "/Library/Application Support/opencode"
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")
    default:
      return "/etc/opencode"
  }
}

/** 与上游 `config/config.ts` 读 managed 目录的文件名单逐字对应。 */
const MANAGED_FILES = ["opencode.json", "opencode.jsonc"] as const

export type ManagedPolicyResult =
  | { status: "ok"; ruleset: PermissionV1.Ruleset; sources: readonly string[] }
  | { status: "unreadable"; reason: string; source: string }

const decodePermission = Schema.decodeUnknownSync(ConfigPermissionV1.Info)

function rulesFromConfigText(
  text: string,
  source: string,
): { ok: true; rules: PermissionV1.Rule[] } | { ok: false; reason: string } {
  try {
    const parsed = ConfigParse.jsonc(text, source)
    if (parsed === null || parsed === undefined) return { ok: true, rules: [] }
    if (typeof parsed !== "object" || Array.isArray(parsed))
      return { ok: false, reason: "managed config root is not an object" }
    const permission = (parsed as Record<string, unknown>)["permission"]
    if (permission === undefined) return { ok: true, rules: [] }
    return { ok: true, rules: fromConfig(decodePermission(permission)) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 读出 managed cap 的 permission ruleset(供 resolver 的第 1 步)。
 *
 * `options` **仅经测试注入**(必修条款允许的口):生产调用方一律零参调用;
 * 没有任何 env / 配置能把 `systemDir` 换掉 —— 这正是与上游 `managedConfigDir()`
 * 的区别所在。`plist` 注入仅用于让测试不依赖本机 MDM 状态。
 */
export async function readManagedPolicy(options?: {
  readonly systemDir?: string
  readonly plist?: { source: string; text: string } | null
}): Promise<ManagedPolicyResult> {
  const ruleset: PermissionV1.Rule[] = []
  const sources: string[] = []

  // 1. 测试目录:additive,最低优先。读不出不致命(见抬头)。
  const testDir = process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"]
  if (testDir && existsSync(testDir)) {
    for (const file of MANAGED_FILES) {
      const source = path.join(testDir, file)
      if (!existsSync(source)) continue
      try {
        const parsed = rulesFromConfigText(readFileSync(source, "utf8"), source)
        if (parsed.ok) {
          ruleset.push(...parsed.rules)
          sources.push(source)
        }
      } catch {
        // additive 来源读不出:忽略即更严,不影响系统 cap。
      }
    }
  }

  // 2. 系统 managed 目录:无条件读,env 不可替换。存在但读不出 ⇒ 整层 unreadable。
  const systemDir = options?.systemDir ?? systemManagedPolicyDir()
  if (existsSync(systemDir)) {
    for (const file of MANAGED_FILES) {
      const source = path.join(systemDir, file)
      if (!existsSync(source)) continue
      let text: string
      try {
        text = readFileSync(source, "utf8")
      } catch (error) {
        return { status: "unreadable", reason: error instanceof Error ? error.message : String(error), source }
      }
      const parsed = rulesFromConfigText(text, source)
      if (!parsed.ok) return { status: "unreadable", reason: parsed.reason, source }
      ruleset.push(...parsed.rules)
      sources.push(source)
    }
  }

  // 3. MDM managed preferences:最高优先(上游同款「override everything」)。
  // readManagedPreferences 自身对 plutil 非零码返回 undefined;能抛到这里的只有
  // 环境级异常(spawn 失败等)—— fail-closed,按 unreadable 上报。
  let plist: { source: string; text: string } | null | undefined
  if (options !== undefined && "plist" in options) plist = options.plist
  else {
    try {
      plist = await ConfigManaged.readManagedPreferences()
    } catch (error) {
      return {
        status: "unreadable",
        reason: error instanceof Error ? error.message : String(error),
        source: "managed-preferences",
      }
    }
  }
  if (plist) {
    const parsed = rulesFromConfigText(plist.text, plist.source)
    if (!parsed.ok) return { status: "unreadable", reason: parsed.reason, source: plist.source }
    ruleset.push(...parsed.rules)
    sources.push(plist.source)
  }

  return { status: "ok", ruleset, sources }
}

/**
 * managed cap 对一个 canonical identity 的判定 —— 与既有 `Permission.disabled` 的
 * identity hard-deny 语义**同一条**:最后一条 `Wildcard.match(canonical, rule.permission)`
 * 命中的规则,`pattern === "*"` 且 `action === "deny"` 才构成 cap deny。
 * managed 的 allow 只表示「上限不阻止」,不给下层扩权(§4)。
 */
export function managedCapDenies(canonical: string, ruleset: PermissionV1.Ruleset): boolean {
  const rule = ruleset.findLast((item) => Wildcard.match(canonical, item.permission))
  return rule?.pattern === "*" && rule.action === "deny"
}
