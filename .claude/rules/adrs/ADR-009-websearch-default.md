---
id: ADR-009
title: web search 默认策略 —— 登出/BYOK keyless 放开;登录态云优先权威 + 逃生开关跨本地/云
status: amended
date: 2026-06-18
amended: 2026-07-22
related: [ADR-002, ADR-005, ADR-006, ADR-018]
supersedes_premise: "2026-06-18 的『桌面默认对所有 provider 放开 keyless websearch』现被登录态门控收窄为登出/BYOK 兜底"
---

## 背景
opencode `websearch`(Exa/Parallel)默认只给官方 `opencode`(Zen)provider(`packages/opencode/src/tool/registry.ts` 的 `webSearchEnabled()` 闸门)。第三方 provider(DeepSeek 等)只有 `webfetch`。该工具由 sidecar **直连** Exa/Parallel、不带 opencode 鉴权,key 为可选(仅避公共端点限流)。

2026-07 平台把 `web_search` 做成 host-tool 端点族首员(key 恒在 gateway,per-call 计费归租户),并经 `cloud` MCP 薄壳暴露给已登录桌面端。E7(alpha-code#223)据此把 web search 主权从「一律 keyless 放开」收窄为「登录态门控 + 云优先」。本 ADR 因此从**单一决策**扩为**两态决策**,并登记 kill-switch 与失败诚实的类语义。E7 的完整勘破与替代否决见 `docs/design/2026-07-22-e7-cloud-web-search-baseline.md`。

## 决策 A(2026-06-18,原始,现降级为登出/BYOK 兜底)

> 全部落 alpha 自有文件,零改 upstream。以下四条**仍成立**,但其适用面被决策 B 收窄到**登出 / BYOK** 一态。

1. **默认放开(登出/BYOK 态)**:`ui-mac/src/main/server.ts` 的 `preferAppEnv()` 注入 `OPENCODE_ENABLE_EXA`(默认 `"1"`,set-if-unset)→ 经 sidecar env 继承 → 对**任意 provider** 放开。**不改 `registry.ts` 闸门**。
2. **不做前端 key 入口**:终端用户默认拿 keyless + 限流的 websearch。
3. **秘钥基础设施**:`alpha-secrets.ts` 启动把 `alpha.env`(`KEY=VALUE`)灌进 `process.env`,**不覆盖已有**(shell 优先);`alpha.env` 已 gitignore。
4. **逃生开关**:`ALPHA_WEBSEARCH_DISABLE=1`(语义见决策 B §B2)。

## 决策 B(2026-07-22,E7 收编:登录态云优先 + kill-switch 语义)

已交付实现:cloud-first 选路 **#488**(PR#504)、kill-switch force-off + 云收敛 **#490**(PR#507)、caps 事实 **#491**(PR#510)。失败诚实 **#489 暂缓**(见「后果 · 未竟」)。

### B1. 登录态门控选择(云优先),抑制靠本地主权 force-off

- **已登录 / 平台付费**(`ALPHA_CLOUD_MCP_URL` + `ALPHA_CLOUD_TOKEN` 密钥文件同在):`cloud_web_search` 为**权威**;`preferAppEnv` 的 `forceOffKeylessWebSearch()` **覆盖写 `"0"`**(非 `??`,压过用户 shell export)到 4 个 keyless flag —— `OPENCODE_ENABLE_EXA` / `OPENCODE_EXPERIMENTAL_EXA` / `OPENCODE_ENABLE_PARALLEL` / `OPENCODE_EXPERIMENTAL_PARALLEL`。模型面上只剩一个 web search 工具。
- **登出 / BYOK**:云暗(`sidecar.ts` 云 MCP 仅在上述密钥齐备时注册);仅 keyless 本地(决策 A 照常,4 flag 回到 set-if-unset 默认)。
- **权威判据**:登录态由 alpha-code **本地推导**(`alpha-auth.ts §③`),选路是本地开关的函数。**否决**任何「需 platform 回声选路状态」的方案(REQ-097 式跨仓无底洞)、以及「重排/改名远端工具」「description 引导」等非主权手段。

### B2. `ALPHA_WEBSEARCH_DISABLE` = 一开关一具名能力(web_search),跨本地 + 云,不误伤兄弟

- 置位 → 与登录态无关,同样 `forceOffKeylessWebSearch()` 覆盖写 4 个 keyless flag 为 `"0"`(压过 shell export)。
- 同时收敛云 `cloud_web_search`(见裁决 (a)),但**保留**兄弟云工具(`cloud_dispatch` / `status` / `await` / `artifacts` / `schedule*`)。
- **不变量**:关闭后**不得留下任何活的 web_search**(本地或云);且**不得**顺带暗掉同一 `cloud` server 的兄弟工具,也**不得**顺带关掉 `OPENCODE_EXPERIMENTAL` umbrella 下的其它实验能力。

### 登记的裁决与残留

- **(a) 远端逐工具禁用机制裁决(#490)**:引擎 `ConfigMCPV1.Remote` 只支持**整 server** enable/disable,**不支持** remote MCP 的逐工具 allow/deny。选定实现 = 不动上游、不整 server 关(会误伤兄弟),改用引擎**全局 permission 层**按工具 ID 过滤:`cloud-web-search.ts` 在 `OPENCODE_CONFIG_CONTENT` 注入 `permission["cloud_web_search"] = "deny"`,把该 ID 从普通 + code-mode 模型工具集剔除,**保留** cloud server 与兄弟工具。**残留(loud,已留 TODO)**:远端 catalog 的 `listTools` **仍列**该工具,仅模型工具集不含它;真正的 remote-MCP 逐工具 deny 待引擎暴露该能力后替换。**禁**静默整 `cloud` server 关。
- **(b) `OPENCODE_EXPERIMENTAL` umbrella 只收口 web_search 路径、不盲目 force-0(#490)**:umbrella 是 references / background-subagents / lsp-tool / plan-mode / code-mode / event-system / workspaces / oxfmt 等**全部**实验能力的总开关,盲目 force-0 会连带关掉它们(违反「一开关一具名能力」)。故交付实现**只** force-0 上列 4 个 keyless 专用 flag,**不碰** umbrella。**残留(open)**:`webSearchEnabled = providerID==="opencode" || enableExa || enableParallel`,其中 `enableExa = OPENCODE_EXPERIMENTAL || OPENCODE_ENABLE_EXA || OPENCODE_EXPERIMENTAL_EXA`——用户若显式 `export OPENCODE_EXPERIMENTAL=1`,该 OR 项在 env 层**压不掉**,本地 web_search 仍可复活。该闸(`registry.ts`)在 `UPSTREAM_PATHS`(north-star 守卫),**alpha 不可直接 patch**。收口该残留的两条路,择一另立票:**(i) alpha 可达**——对本地 web_search 工具 ID 也走 permission 层 `deny`(镜像 (a) 的云做法,零改上游);**(ii) 需 alpha-patch 机制**——patch `webSearchEnabled` 的 umbrella→enableExa 路径(与 **#489 共用**尚未落地的 alpha-patch 依赖)。当前状态:**接受该残留**为已知项(显式 `OPENCODE_EXPERIMENTAL=1` 属高级用户自陷),不阻断 E7 交付。
- **(c) `providerID==="opencode"` Zen 分支打包端不可达**:产品不发布 `opencode`/Zen provider,`webSearchEnabled` 的该 OR 分支恒为死码。以**禁用 provider 棘轮**(forbidden-provider ratchet:断言打包端 provider 目录不含 `opencode`)守死,**无需**为它 patch 上游闸。
- **(d) host-tool 无 402 / 余额门为现状;per-call 余额门归 `alpha-platform#37`**:`POST /v1/tools/web_search`(`packages/gateway/src/worker.ts`)**无 `accountPreauth`**、计费为**事后 settle**(失败入 `SETTLE_Q` 死信,非静默吞),故余额不足在该路径**今天不产生任何 per-call 失败(无 402 面)**。这是 ADR-018(「未登记的收费入口不得运行」)下 `web_search` 唯一仍 settle-only 的 billable egress;补齐(reserve-then-settle 入册)归 `alpha-platform#37`(AC1/AC5)。E7 侧仅在 #37 web_search 切片落地后,把随之出现的 insufficient-funds decline 当作**又一个 LOUD 失败状态**消费,**不**在 alpha-code author 该切片。

### B3. caps 事实(#491)
`sidecar.ts` / `buildAlphaCapabilities` 的 `websearch` 事实在「云工具在场且本地被抑制」时仍为真,与实际可见工具一致(参照 `cloudDispatch` 事实写法)。修正了「登录 + force-off keyless → 误报 websearch=false」的旧 bug。

## 后果

- ✅ **登出/BYOK**:第三方 provider 开箱即有 keyless websearch,零配置;零改 upstream(决策 A 保留为兜底,**非删除**)。
- ✅ **登录/平台付费**:`cloud_web_search` 为唯一权威 web search,本地 keyless 被主权 force-off 抑制,计费经 gateway 归租户;主权点全在本地(`preferAppEnv` + permission 注入),外部无法覆盖、零 platform 回声。
- ✅ **kill-switch**:`ALPHA_WEBSEARCH_DISABLE=1` 跨本地 + 云关掉 web_search,保留兄弟云工具与其它实验能力;override 压过 shell export。
- ⚠️ **残留(a)**:云工具 catalog `listTools` 仍列 `cloud_web_search`,仅模型工具集不含——待引擎 remote 逐工具 deny。
- ⚠️ **残留(b)**:显式 `export OPENCODE_EXPERIMENTAL=1` 可在 env 层绕过本地抑制(上游闸不可达);接受为已知项,收口择 (i) 本地 permission-deny 或 (ii) alpha-patch。
- ⚠️ **未竟 · #489(失败诚实,暂缓)**:`packages/opencode/src/tool/websearch.ts:140` 的 `Effect.orDie` 把一切错误塌成 defect(无可辨错误 / 无状态区分),`:136` 把空结果伪装成成功串——**尚未**替换为区分 `401`/`403-scope_forbidden`/`400`/`502`/任何非 2xx→LOUD 的可辨错误。该修复须改 `packages/opencode`(UPSTREAM_PATHS,north-star 守卫),依赖 alpha-patch 机制,**已暂缓**(PR#506 草稿)。E7 失败诚实不变量(禁伪成功、唯一回退=模型自带 search、云失败禁静默切 keyless)**记录在案但机械化强制待 #489**。
- 🔭 **前提受制于 LIVE-PATH GATE**:整份云优先设计以「`cloud_web_search` 在部署实例 `listTools` 真实可见 + 一次真调返回 `{query,results}`」为前提,须运行时探针复验(REQ-097 教训:代码存在 ≠ 链路在跑)。证伪则本决策 B 作废、退回纯 keyless。
- **无向后兼容**:portfolio 无真实用户/租户,契约可直接 breaking,fail-closed;不为旧行为建 shim。
