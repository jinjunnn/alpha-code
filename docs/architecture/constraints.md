---
title: Architecture constraints and known deviations
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-10-30
review_after: 2027-04-30
---

# 架构约束与已知偏离

只记事实:约束一句话,偏离写清位置、偏离了哪条、碰到它的票。不写优先级,排期在 GitHub Issues。

## 约束

- **K1 运行权限档位只有一个权威,且执行判定的那一层读得到它。** 「哪些 agent 是档位载体(全部批准 / 请求审批 / 只读)」只定义一次,做委派与审批判定的引擎能据此区分「用户选的档位」与「助手自带规则」,不在别处另写一份名单。
- **K2 一个概念只有一个权威,其余地方消费它。** 同一段判定或投影只实现一次;别处需要时调用它、读它给出的结果,不另写一份实现,也不手写它的替身。

## 已知偏离

| 位置 | 偏离 | 事实 | 碰到它的票 |
| --- | --- | --- | --- |
| `packages/ui-mac/src/main/alpha-builtin-policy.ts`(`ALPHA_INJECTED_AGENTS`)、`packages/ui-mac/src/main/alpha-config-injection.ts`(载体的规则表) | K1 | 档位载体名单只在 ui-mac 主进程一份;引擎(`packages/opencode/src/session/prompt.ts` 的委派判定)只拿得到当前 agent 的规则集,区分不了档位限制与助手自带规则 —— 例如「全部批准」档手选计划助手时,计划助手自带的 `task: {general: "deny"}` 对用户点名 `@general` 同样生效。 | `alpha-code#1573` |
| `packages/opencode/src/tool/code-mode.ts:195-203` | K2 | Code Mode 子调用把 MCP 结果的 `isError` 投影成错误的那段,是 `packages/opencode/src/mcp/catalog.ts:68-74`(`McpCatalog.convertTool` 的 execute)的刻意镜像,同一概念两份;`catalog.ts` 是未接管的上游文件,放不进一份共用实现。 | `alpha-code#1563` |
| `packages/ui-mac/src/renderer/extensions/use-extensions.ts:463-484` | K2 | MCP 状态的种类以引擎 `MCP.Status`(SDK `McpStatus` 判别联合)为准,而定制中心对状态词做子串匹配(`connected` / `disabled` 用 `includes`,`needs_auth` / `pending` 判等),不消费引擎给出的状态种类。 | `alpha-code#1563` |
| `packages/ui-mac/test-visual/main.tsx:32-70` | K2 | 视觉 harness 手抄了一份两段目录投影(平台段:V3 producer 行 → 模型行;BYOK 段:随包首启引导 × 适配器表 → provider 行)。生产投影在 `packages/ui-mac/src/main/alpha-live-allowlist.ts`(`projectPlatformModels`)与 `packages/ui-mac/src/main/alpha-models.ts`(`projectByokProviders`),两个模块引了含 `node:fs` 的依赖,浏览器 bundle 引不了。 | `alpha-code#1556` |
