// #395(Codex r11 pivot → 主权注入):把全局账本 disabled 的 mcp/agent 覆盖写进 sidecar 注入的
// OPENCODE_CONFIG_CONTENT。该 env 在引擎加载序 step 6(所有 in-scope 源之后:XDG / ~/.opencode /
// agent-md·plugin-script 自动发现目录 / 项目)。mergeDeep later-wins 使 alpha 的 `enabled:false`/
// `disable:true` **压过一切 in-scope 源** —— disabled 扩展永不被引擎加载,无需逐源探测(探测器无底洞
// 由此消除)。引擎 schema 显式允许 lone `{enabled:false}` mcp 叶(core/v1/config/config.ts:114)与
// disable-only agent 叶(全 optional)。plugin 是 union 无覆盖面,靠 alpha.jsonc 移除(无用户 = 无他源);
// cloud/skill 无此面。仅 global scope。best-effort:账本不可读 → 跳过(alpha.jsonc 投影仍在)。

import { alphaGlobalRoot } from "./alpha-installs"
import { readLedgerV2 } from "./ext-receipt-v2"

export function injectDisabledOverrides(config: { mcp?: Record<string, unknown>; agent?: Record<string, unknown>; mode?: Record<string, unknown> }): void {
  try {
    const { records } = readLedgerV2(alphaGlobalRoot())
    const setLeaf = (bucket: "mcp" | "agent" | "mode", name: string, field: string, value: unknown) => {
      const map = config[bucket]
      const cur = map && typeof map[name] === "object" && map[name] ? (map[name] as Record<string, unknown>) : {}
      config[bucket] = { ...(map ?? {}), [name]: { ...cur, [field]: value } }
    }
    for (const r of records) {
      if (r.scope.kind !== "global" || r.desiredState !== "disabled") continue
      if (r.kind === "mcp") setLeaf("mcp", r.name, "enabled", false)
      else if (r.kind === "agent") {
        setLeaf("agent", r.name, "disable", true)
        // Codex r12 B1:引擎在合并末尾把 deprecated `mode[name]` 折叠回 `agent[name]`(config.ts:536-542,
        // 在 step 6 之后)—— 若项目 `mode[name].disable=false` 会覆盖注入的 agent.disable。故 mode 面也
        // 注入 disable:true(step 6 是最后的 mode 源,折叠时压过);两面齐才真权威。
        setLeaf("mode", r.name, "disable", true)
      }
    }
  } catch (error) {
    console.warn("[req395] disabled-override injection skipped (ledger unreadable)", error)
  }
}
