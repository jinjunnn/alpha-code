// ext-health-probe-router — REQ-128 #705:扩展事务的**唯一** typed health probe 组合点。
//
// 背景:引擎(ext-transaction)对每个 generation / file item 调一次 `hooks.probe`,而一次事务只带
// **一个** probe。单装时代每条路径各自挑一个叶探针(package-admission 的 agent 装挑 agentFileProbe、
// skill 装挑 skillGenerationProbe、planner 的 vendored plugin 装挑 seedPluginFileProbe),ext-ipc 的
// 恢复接线则自己手写了一份三选一的组合。Bundle 一次事务里会同时出现 generation(skill)+ file(agent)
// + config(mcp)三种 item —— 那时「一个事务一个 probe」意味着组合必须存在,而组合有两份就会漂移
// (恢复放行的形状与安装放行的形状不同 = 安装能过、重启后被判不健康回滚)。本模块把组合收敛成一处:
// 安装路径与恢复路径消费同一个 `extensionHealthProbeRouter`。
//
// 路由规则(与 #705 之前 ext-ipc 的组合逐字同构,行为零变化):
//   ① 先过 skillGenerationProbe —— 它只判 action==="generation",其余一律 healthy;
//   ② 非 file item(config/receipt)到此为止 —— 引擎本就不对 config/receipt item 调 probe,
//      这条只是保持组合总是可判定;
//   ③ file item 按 key 前缀路由:`agent--*` → agentFileProbe(#358),其余 → seedPluginFileProbe(#359)。
// 两个 file 探针对各自方案外的 key 都 **fail-closed**(同一句 "no typed probe for file item …"),
// 因此新增 file 消费方必须在此显式登记探针,绝不会静默放行。

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { isExtensionName } from "../shared/extension-name"
import { agentFileProbe } from "./ext-agent-install"
import { skillGenerationProbe } from "./ext-skill-generations"
import type { HealthProbe } from "./ext-transaction"

/** 严格的 plugin 载荷 item key 形状(review r2 Minor:前后缀宽匹配会放行非法名/内嵌 "--" 的 key):
 *  plugin--<name>--f<i>,name 过 extension name 且不含 "--"(与 installSeedPlugin 的名称拒绝对齐)。 */
function isSeedPluginItemKey(key: string): boolean {
  const m = /^plugin--(.+)--f\d+$/.exec(key)
  const name = m?.[1]
  return typeof name === "string" && isExtensionName(name) && !name.includes("--")
}

/** plugin 载荷 file item 的类型化探测(#359;对标 agentFileProbe 的 generic 形态):digest 走引擎
 *  透传的 journal 真源(fileDigest)。非本方案 key 的 file item = fail-closed 不健康(与 #358
 *  agentFileProbe 同纪律:file 消费方必须自带探针,绝不静默放行)。 */
export function seedPluginFileProbe(): HealthProbe {
  return (input) => {
    if (input.action !== "file") return { healthy: true }
    if (!isSeedPluginItemKey(input.key))
      return { healthy: false, reason: `no typed probe for file item "${input.key}" — refusing (fail closed)` }
    const p = input.phase === "pre-switch" ? input.stagedFile : input.fileTarget
    if (!p) return { healthy: false, reason: `plugin payload probe: path missing from probe input (${input.key})` }
    let data: Buffer
    try {
      data = readFileSync(p)
    } catch {
      return { healthy: false, reason: `plugin payload file not readable (${input.key})` }
    }
    if (input.fileDigest && createHash("sha256").update(data).digest("hex") !== input.fileDigest)
      return { healthy: false, reason: `plugin payload digest mismatch (${input.key})` }
    return { healthy: true }
  }
}

/**
 * 一次事务的唯一 typed probe(安装 + 恢复共用)。`root` 只喂 agentFileProbe —— agent 的 config 叶
 * 落点由 root 派生(调用方无路径通道)。
 */
export function extensionHealthProbeRouter(root: string): HealthProbe {
  const agentProbe = agentFileProbe(root)
  const pluginProbe = seedPluginFileProbe()
  return async (input) => {
    const gen = await skillGenerationProbe(input)
    if (!gen.healthy) return gen
    if (input.action !== "file") return { healthy: true }
    return input.key.startsWith("agent--") ? agentProbe(input) : pluginProbe(input)
  }
}
