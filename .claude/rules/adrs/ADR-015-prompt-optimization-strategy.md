---
id: ADR-015
title: 提示词优化策略:上游底座只读 + 能力感知 identity + Tier-3 行为层(含合并验证)
status: accepted
date: 2026-06-23
related: [ADR-002, ADR-004, ADR-005, ADR-007, ADR-009, ADR-014]
---

## 背景
1. **误用源**:`docs/CLAUDE-FABLE-5.md` 被当成"Claude Code 的提示词"想照搬来增强 alpha-code。核实后它是 **claude.ai 消费级聊天助手(Fable 5)** 的系统提示词(章节为 artifacts / computer_use / mcp_app_suggestions / image·places·recipe·weather 工具 / 版权合规 / user_wellbeing,Identity Preamble 明示运行在 claude.ai),**不是 agentic 编码 agent 的提示词** → 照搬 = 范畴错误,会注入大量无关甚至有害约束。真正的编码 agent 提示词形态见上游 `anthropic.txt`(第 1 行 `You are OpenCode...`)。
2. **真实装配**(已核 `packages/opencode/src/session/prompt.ts:1309-1325`):一条 prompt 的 `system[]` = **① 按模型 ID 选中的 provider `.txt` 底座(~70%,`anthropic/beast/gemini/gpt/kimi/...txt`,上游只读)** + ② 环境块(`system.ts:environment`) + ③ 指令文件(`instruction.ts`:AGENTS.md/CLAUDE.md/config.instructions) + ④ skills + ⑤ 结构化输出指令。**alpha 唯一的 prompt 接缝 = 经 `OPENCODE_CONFIG_CONTENT.instructions[]` 注入的指令文件**(ADR-007),现仅 `alpha-identity.md`(6 行)。
3. **关键区分**:"能力边界 / harness 能力" ≠ 提示词。能力由**工具/MCP/skill/agent**(零-fork 接缝)创造;提示词只能**描述**已存在的能力,不能创造能力。
4. **痛点**:底座对"终端简洁/最小化 token"约束很强,导致 explain/analyze/compare 类回答**过短**。

## 决策(全部落 alpha 自有文件,零改 upstream)
分四级,各级边界明确:

- **Tier 0 — 明确不做**:① 不移植 `CLAUDE-FABLE-5.md`;② 不改任何上游 `packages/opencode/src/session/prompt/*.txt` 底座或 `agent/*` 上游 prompt(改即 fork 冲突,破北极星 ADR-005/NON_GOALS#3);③ 不往 identity 层塞编码行为覆盖(会与上游底座**静默打架**)。

- **Tier 1 — identity 能力感知(已实现)**:`alpha-identity.ts` 从"只报产品名"升级为 `buildAlphaIdentity(caps)`,按 session 追加**事实型**能力行——websearch 对所有 provider 放开(ADR-009)、cloud dispatch 网关已连(ADR-002 派发接缝)。**behavior-neutral**:只陈述"X 可用",不指导如何写代码。`sidecar.ts:injectAlphaConfig` 按 env 探测能力(`OPENCODE_ENABLE_EXA`/`ALPHA_WEBSEARCH_DISABLE`、`ALPHA_CLOUD_MCP_URL`+`ALPHA_CLOUD_TOKEN`)。

- **Tier 2 — 能力扩展只走 harness**:任何"让 agent 会做更多事"的诉求**一律走零-fork 接缝**(`.opencode/tool`、MCP `mcp.servers`、`.opencode/skill`、`.opencode/agent`;见 ADR-002/ADR-014),**不写进提示词**。这是"提升能力边界"的真正出口。配套产出 harness 扩展清单 `docs/harness-extension-backlog.md`(随 ADR-014 定制中心推进)。

- **Tier 3 — 提示词行为有限调优(新接缝,本 ADR 引入)**:允许在 **alpha 自有指令层**有限地调优 agent 行为,两条通道:
  - **全局行为层** `alpha-behavior.ts` → `alpha-behavior.md`:**与 identity 物理分离**、独立可关(`ALPHA_BEHAVIOR_DISABLE`)。首个实例(2026-06-23):"按问题实质校准回答长度"修复回答过短——routine 操作保持简洁,explain/analyze/design 类给出完整推理与取舍,且**不许 filler**。
  - **per-agent prompt**:`.opencode/agent/*.md` 各自的 system prompt(alpha 自有 agent),针对子 agent 局部调优,**不动全局底座**。
  - **硬约束**:Tier-3 必须**小、叠加、不硬覆盖底座规则**——校准底座,而非对抗它。

- **合并验证(关键纪律,本 ADR 强制)**:Tier-3 的漂移**不产生 git 冲突**(都是净新增 alpha 文件),北极星的 file-diff 守卫(ADR-004)**测不出**这种"行为矛盾"。因此:
  1. 每次 upstream sync **触碰** `packages/opencode/src/session/prompt/*.txt` 或 `packages/opencode/src/agent/*`,**或**每次改 Tier-3 层,必须跑验证:
     ```
     git diff <old-dev>..<new-dev> -- packages/opencode/src/session/prompt packages/opencode/src/agent
     ```
  2. 若底座/上游 agent prompt 有变 → **人工复核** `alpha-behavior.ts`、`alpha-identity.ts`、`.opencode/agent/*.md` 是否与新底座矛盾(语义,非字节)。
  3. 结论记入 `docs/retros/`;在 `.github/workflows/sync-upstream.yml` 加 tripwire:当 sync 改动 `prompt/*.txt` 时打标签/留言要求人工复核(待办,见下)。

## 后果
- ✅ **能力扩展与升级隔离解耦**:提示词底座继续白嫖上游升级;能力扩展走接缝;北极星(冲突文件数=0)不破。
- ✅ identity(事实)与 behavior(调优)**分层、各自可关**;回答过短有了**合规修复路径**,不碰上游一字节。
- ✅ 纠正 FABLE-5 范畴误用并留档,防止以后再被当编码提示词照搬。
- ✅ Tier-1/Tier-3 已落地并 `tsgo` 通过;逃生开关 `ALPHA_IDENTITY_DISABLE` / `ALPHA_BEHAVIOR_DISABLE` 各自独立。
- ⚠️ **Tier-3 是新增漂移面**:行为矛盾绕过 file-diff 守卫(对策:层保持小 + 合并验证清单 + sync tripwire)。
- ⚠️ per-agent 调优需**逐个**随升级验证;identity 的能力探测依赖 env 时序(`OPENCODE_ENABLE_EXA` 默认 "1",keyless 仍报"可用"= 与运行时一致,可接受)。
- 🔭 **待办**:① per-agent prompt 优化的具体清单(随 Tier-2 harness 清单一并排期);② 把合并验证接进 `sync-upstream.yml`(prompt/*.txt 变更 tripwire)——**已完成(REQ-012,2026-07-07 真实 sync 实跑)**;③ Tier-3 首个实例上线后做一次桌面端实测(回答长度是否如期校准,见 [[visual-verify-required]] 纪律)。

## 修订(2026-07-08,GOALS G6「去 opencode 化」—— 路线A 品牌转写获批,路线B 受控替换列为演进)

用户拍板:项目层级尽量去 opencode,系统提示词由 alpha 承载,先路线A 后评估路线B。源码核查(2026-07-08,证据 = 本日提示词面盘点):**8 个 provider 底座 .txt 首行全部自称 OpenCode**(`anthropic.txt:1` "You are OpenCode, the best coding agent on the planet.",anthropic/default 还带 opencode.ai 文档与 GitHub 仓库指引);instructions 是**纯叠加**语义(`config.ts:47` 并集;`request.ts:58-66` 底座在前同条 system message)→ identity 的 "call yourself alpha-code" 只能软压制,不保证赢;且 `alpha-identity.md` 自己写了 "built on opencode" 一句,是「自称 alpha-code (opencode)」的另一半根因。修订如下:

1. **路线A(批准,[[REQ-062]])= 运行时品牌转写**:`@alpha-code/ext` 挂 `experimental.chat.system.transform`(`packages/plugin/src/index.ts:291-296`,`output.system: string[]` 可原地改写;`request.ts:69` 触发,**唯一能触及底座与 environment 的零-fork 接缝**),对 system 段做精选子串转写:OpenCode 自指 → alpha-code、剔除 opencode.ai / GitHub 指引行。定位 = [[ADR-007]] brand-i18n 的提示词版:**底座的工程内容(工具使用/风格/简洁性,~70% 体量,逐模型调优)照旧白嫖,只转写自指**。Tier 0 ②(不改上游 .txt 文件)**不变**——转写发生在请求时内存中,磁盘一字节不动,北极星无涉。
   - **NON_GOALS#4 风险标注(强制)**:`experimental.*` hook;逃生开关 `ALPHA_PROMPT_REBRAND_DISABLE`;回退方案 = hook 签名漂移/失效时**最坏退化为品牌未转写**(外观级回退,不伤任何功能);本 ADR 既有合并验证清单 + sync tripwire(已接线)天然覆盖底座变更时的转写子串复核。
   - **配套五件**(同属 REQ-062):`alpha-identity.md` 删 "built on opencode" 措辞;`/init` `/review` 经 config `command.init/review` 同名覆盖换 alpha 模板(上游 schema 无 disable 字段,换芯即接管——`initialize.txt` 含 3 处 OpenCode 自指);已禁的 customize-opencode 坑位补 **customize-alpha** skill(教 `.alpha/alpha.jsonc`/治理/定制中心约定,接管「定制引导」心智);**general/explore 子 agent 同名 prompt 重写为 alpha 自写**(用户 2026-07-08 追加拍板;`agent.ts:283` config 优先,同名接管保 task 委托接线;单一任务型 prompt 无逐模型负担,故进 A 期不等 B);`tool/lsp.txt:22` 一处经稳定 hook `tool.definition` 顺带转写(量级小,lsp 工具默认实验关闭,可后置)。
2. **路线B(演进方向,[[REQ-064]] parked)= config `agent.<name>.prompt` 受控替换底座 + 内置 agent 内容全面接管**:`request.ts:60` 实证 agent.prompt 与底座是**二选一**——config 赋 `agent.build.prompt` / `agent.plan.prompt` 即整体替换,纯 config 接缝零改上游;compaction/title/summary 内部机件 prompt 同名覆盖按质量评估纳入(引擎与治理层均允许覆盖,HARD_PROTECTED 只拦 disable/hide)。至此全部内置 agent 内容层由 alpha 承载(用户 2026-07-08 拍板方向);**接管姿势一律同名覆盖、不走禁用+另建**(build/plan/内部三件的引擎接线按名字焊死)。启动硬前置 = 路线A 稳定运行 + alpha 自有 prompt 逐模型质量评估过关 + **本 ADR 再修订**(Tier 0 精神中的「不硬覆盖底座」在路线B 下正式退役——等同前端 ADR-016/020「接管即放弃白嫖」的抉择,接管后 prompt 质量维护面归 alpha)。
3. **不变项**:Tier 0 ①(不移植 FABLE-5)、③(identity 不塞行为覆盖)不变;Tier 1/2/3 分层不变——路线A 归类为 Tier-3 的**机制升级**(instructions 叠加 → transform 转写),Tier-3「小、克制」的精神对转写子串清单同样适用(精确子串 + 漏改 warn,ADR-007 同款纪律)。
4. **关联**:外部生态继承 default-deny + consent 导入门同日拍板,独立成 [[ADR-024]](REQ-063)。
