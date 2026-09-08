---
title: openai/codex 与本仓 harness 的对照(哪些机制值得吸收,哪些结构上不能换)
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-08
review_after: 2027-03-08
---

# openai/codex 与本仓 harness 的对照

本文是一份**对照物**:记录 2026-08-22/23 对 [`openai/codex`](https://github.com/openai/codex)
与本仓 harness 的逐层比较,以及由此得出的「能不能换底座 / 哪些机制值得吸收」。它存在的目的是
让后续 review 有一份可对照的地面真相,而不是每轮重新推导。

**读法**:第 1–4 节是 2026-08-22 的实测对照,除非另有标注,坐标是当时的读数;第 5 节是可吸收
机制的清单,每条**附今日的归属票**;第 6 节记录此后已经发生变化的事实。**本文不承载状态、
优先级或排期** —— 那些只在 Issues 与 Alpha Delivery 里。

## 1. 先把「本仓的 harness」说准

| 层 | 归属 | 规模(2026-08-22 实测) |
|---|---|---|
| 引擎 / session / context / provider | 上游 `anomalyco/opencode`(当时 v1.18.19) | ~800K 行 TS,948 测试文件 / ~7,127 用例 |
| `packages/ext` | Alpha(进程内 TS plugin + 自定义 tool) | 3.6K 行 |
| `packages/ui-mac` | Alpha(Electron 外壳 + 品牌 + 扩展中枢) | main 50K(非测试)/ renderer 77K |
| 云 | `alpha-platform`(网关、计量、多租户) | 独立仓 |

关键耦合:`ui-mac/src/renderer` 有 **135 处** `@opencode-ai/*` import(`app` 69 · `sdk` 37 ·
`ui` 15 · `session-ui` 11 · `core` 3)。**renderer 不是一个独立 UI,是套在上游 `AppInterface`
外面的壳** —— 这一条决定了第 3 节的结论。

真正的自有资产集中在 `ui-mac/src/main`:`ext-install-planner` · `ext-transaction` ·
`ext-receipt-v2` · `artifact-service` · `package-admission` · `ext-package-ledger-v3` ·
`catalog-channels` · `alpha-auth` · `claude-plugin-intake`。**这批是 Extension Hub,与底下是
哪个引擎基本正交。**

## 2. 结构对照

| 维度 | openai/codex | opencode(本仓底座) |
|---|---|---|
| 语言/构建 | Rust,~90 crates,1.46M 行,Cargo + Bazel | TS/Bun,33 包,~800K 行,turbo |
| 开源 UI | **只有 TUI**(ratatui,272K 行) | `app` + `ui` + `session-ui` + `desktop` + `tui` |
| 桌面 App | **闭源**(`codex app` 下载 `Codex.dmg`) | 开源,本仓正在用 |
| 嵌入契约 | `app-server` JSON-RPC 2.0,thread/turn/item 三原语,类型生成 TS + JSON Schema | `@opencode-ai/sdk` + HTTP server |
| 扩展模型 | 进程外:hooks、MCP、skills、plugin 包 + marketplace | **进程内 JS plugin**(可换 provider、改 params/headers、transform context) |
| 模型供应商 | **只有 Responses wire** | Vercel AI SDK 全家桶 + models.dev |
| 沙箱 | seatbelt / landlock / bwrap / windows-sandbox-rs + `execpolicy` DSL + network-proxy | 当时**无**(grep 零命中) |
| 权限 | 审批策略 **+ 内核级围栏 + 违规检测** | `permission/`(489 行)询问式规则 |
| 模型化风控 | Guardian(sync_reviewer + async_scorer + 风险分类法) | 无 |
| 许可证 | Apache-2.0 | MIT |

## 3. 不能换底座 —— 四个阻断

1. **没有开源 GUI。** codex 开源部分只给 TUI。换过去等于 renderer 那 77K 行连同 135 处上游
   import 全部作废。
2. **只讲 Responses wire。** `WireApi` 只剩一个变体,`"chat"` 被显式删除并报
   `CHAT_WIRE_API_REMOVED_ERROR`;全仓 `chat/completions` 零命中。而本 portfolio 的网关要路由
   Claude 模型,cache-write 桶跨 wire 恒不等且 openai-wire 结构上禁止声明该字段 —— **这层语义
   不是加个 shim 能抹平的**。
3. **没有进程内扩展点。** `packages/ext` 这个模型在 codex 里不存在:要么写 in-tree Rust(单体
   仓,没有 workspace 成员叠加位,零上游编辑的北极星当场失效),要么退到进程外 hook(能力面窄
   一大截)。
4. **整套验证体系换语言。** `alpha-check.sh`、`bun test`、`tsgo`、`worktree-bootstrap.sh`、
   `local-gate-parity.test.ts` 全部是 TS/Bun 形态;连本机验证陷阱那一册也要重攒。

**「换底座」没有潜力,「换角色」有**:`app-server` 是设计得不错的嵌入接口,技术上 Electron
可以驱动它。但前置条件是先在 `ui-mac` 与引擎之间有一层引擎抽象 —— 而**那件事即使永远不接
codex 也是划算的**。这条路径至今未被采纳,记录在此仅作备选。

## 4. codex 明确更强的四项

- **运行时安全** —— 这是当时的断层:codex 把「审批」和「围栏」分成两层,命令即使被批准仍跑在
  seatbelt/landlock 里,越界记为 violation。本仓当时只有第一层。
- **协议契约工程化** —— schema 从类型生成,fixture 被测试反查,`#[experimental]` 门控实验字段。
- **上下文预算的结构化约束** —— 五条硬规则(不重写历史 / 避免频繁改动导致 cache miss / 注入项
  必须有硬上限 / 单项 ≤10K token / >1K 的新项标 P0 复审),且所有注入片段必须是实现
  `ContextualUserFragment` 的 struct。**把上下文卫生从散文变成类型。**
- **测试基建** —— `ResponseMock` 断言的是出站 `/responses` POST body,即真正发出去的字节流。

opencode 明确更强的三项:**模型广度**(决定性)、**进程内扩展面**、**GUI**(决定性)。

## 5. 可吸收的机制,及其今日归属票

| 机制 | 归属票 |
|---|---|
| OS 级沙箱(seatbelt profile 作配方参考) | `#1073` REQ-137 · `#1074` REQ-138(**已交付**,C1 wrapper shell,darwin-only) |
| 派生进程的完整覆盖(MCP stdio / LSP) | [`#1286`](https://github.com/jinjunnn/alpha-code/issues/1286) REQ-159 |
| 上下文注入的预算契约(`ContextualUserFragment` 的对应物) | [`#1284`](https://github.com/jinjunnn/alpha-code/issues/1284) REQ-157 |
| 风险分类法前置到授权(**只借分类法,不借模型评分**) | [`#1285`](https://github.com/jinjunnn/alpha-code/issues/1285) REQ-158 |
| 插件 manifest 的 interface 段(上架展示字段表) | [`#1287`](https://github.com/jinjunnn/alpha-code/issues/1287) REQ-160 |
| 收编面的可测量度量(总量 / 对齐年龄) | [`#1288`](https://github.com/jinjunnn/alpha-code/issues/1288) |
| 反重力规则(模块体积上限 + 点名高频文件) | [`#1289`](https://github.com/jinjunnn/alpha-code/issues/1289) |
| 破坏性变更面清单 | [`#1290`](https://github.com/jinjunnn/alpha-code/issues/1290) |
| hooks fail-closed + 托管层 | [`#1291`](https://github.com/jinjunnn/alpha-code/issues/1291)(**先裁决**:ADR-040 禁止代码型 payload) |

**明确不吸收**:Bazel · 任何形式的 Rust 重写 · 把 codex 当引擎 · codex 的 marketplace 治理机制
(本仓的准入/事务/账本/grant digest 更严)。

## 6. 2026-08-23 之后已经变化的事实

本节是本文的**自我订正区**。对照本文做 review 时,先读这一节。

- **OS 级沙箱不再是缺口。** REQ-138 已交付 `packages/ext/src/shell-sandbox.ts`(`cfg.shell`
  wrapper → `sandbox-exec -f <profile>`,收编上游 0 行,darwin-only)。因此第 2 节表格里
  「沙箱:无」与第 4 节「这是断层」只对 2026-08-22 成立。**残留缺口是派生面**,见 `#1286`。
- **契约 schema fixture 的机器化已经闭合。** 当时记的「差 schema 从类型生成、fixture 被测试
  反查」在 2026-09-08 实读下不成立:`host-extension-package-contract/generate-artifact.ts`
  提供 `--check`,且 `host-extension-package-artifact.test.ts:323` 有一条测试实跑它并检测漂移。
  **该条不再建票。**
- **上游同步债务已追平。** 当时记的 merge-base 30 天 / 375 commits 未合,已由 REQ-156 `#1248`
  清掉。`#1288` 只承接「度量」那一半,不含同步本身。
- **`hooks` 在签名包里没有表达位。** envelope schema 无 `hooks` 字段,`CONTRACT.md:73` 的
  ADR-040 禁止 payload 为引擎自行求值的代码 ⇒ 托管 hook 是**裁决题**而非实现题(`#1291`)。

## 来源

2026-08-22/23 的对照分析(owner 提问:「它与我的 alpha-code 的 harness 的异同、是否可以直接
替换、哪些值得吸收」)。第 1–4 节的读数为当时实测;第 5–6 节的坐标为 2026-09-08 重新实读。
