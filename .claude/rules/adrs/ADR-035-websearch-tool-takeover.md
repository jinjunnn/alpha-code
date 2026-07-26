---
id: ADR-035
title: web search 工具失败面接管:websearch.ts / mcp-websearch.ts 两文件走 L3 冻结接管
status: accepted
date: 2026-07-25
related: [ADR-004, ADR-009, ADR-029, ADR-033]
issue: https://github.com/jinjunnn/alpha-code/issues/489
---

> **状态:accepted(owner 2026-07-25 拍板「走 ADR-029 L3 文件级 exclude」,#489 单向门决策)。**
> 本 ADR 按 [[ADR-029]] §3 把两个**文件**从上游同步集移出,交给 alpha 全所有权,让 E7
> (`alpha-code#223`)的「失败诚实」不变量可以真正落到打包端跑的那份代码上。范围仅这两个文件,
> 不扩到 `packages/opencode` 其它任何表面。

## 背景

1. **E7 要求 web search 失败诚实**(设计基线
   [`docs/design/2026-07-22-e7-cloud-web-search-baseline.md`](../../../docs/design/2026-07-22-e7-cloud-web-search-baseline.md),
   决策见 [[ADR-009]] 决策 B):禁伪成功、任何非 2xx 一律 LOUD、云失败不静默切回 keyless。
2. **打包端真正挂载的是 opencode 副本**。sidecar 服 `virtual:opencode-server` →
   `packages/opencode/dist`(`ui-mac/electron.vite.config.ts`、`sidecar.ts`),`packages/core`
   的 v2 builtin websearch **永不挂载**。所以失败诚实必须改
   `packages/opencode/src/tool/websearch.ts` 与它唯一的传输实现
   `packages/opencode/src/tool/mcp-websearch.ts`,别处改了都是死码。
3. **这两个文件当时的行为是两处失守**:`websearch.ts` 用
   `output: result ?? "No search results found…"` 把空/坏响应伪装成成功串;末尾
   `.pipe(Effect.orDie)` 把一切错误塌成匿名 defect(无类别、无状态、表现为工具崩溃)。
   `mcp-websearch.ts` 用 `HttpClient.filterStatusOk` 把每个非 2xx 压成同一个 StatusError,
   状态码与上游 body 都拿不回来,`parseResponse` 找不到结果时返回 `undefined`(伪成功的来源)。
4. **`packages/opencode` 在 north-star 守卫的 `UPSTREAM_PATHS` 内**,守卫用
   `--diff-filter=DMR`:改既有文件必红。#489 因此在 2026-07-22 被暂缓(草稿 PR#506),
   [[ADR-009]] 把它登记为「未竟」。

## 决策

**按 [[ADR-029]] L3 冻结接管以下两个文件**(逐要件登记):

### 1. 被接管表面(退出上游同步集,alpha 全所有权 → L3)

- `packages/opencode/src/tool/websearch.ts` —— 工具定义、provider 选路、失败结算。
- `packages/opencode/src/tool/mcp-websearch.ts` —— MCP over HTTP 的请求/响应/失败映射。
- 对应的上游测试(随源,同 [[ADR-033]] §1 末条):`packages/opencode/test/tool/websearch.test.ts`。

**刻意不接管**:`packages/opencode/src/mcp/catalog.ts` 与
`packages/opencode/src/tool/code-mode.ts`。云 `cloud_web_search` 走的是这两处,而它们在
`result.isError` 时**已经**抛出带 body 的 `Error`(已 loud)。为了给云失败加一层分类前缀而把两个
高 churn 通用文件也收编,代价(放弃白嫖面 + 守卫盲区)远大于收益。云侧的可辨性由平台契约的
`error.code` 与 HTTP 状态在 body 里透传保证。

### 2. 为何 L0–L2 不够用(§3 要件:低级别不可行的勘探证据)

- **L0 接缝**:opencode 没有「工具执行结果后处理」接缝。`plugin` 的
  `tool.execute.after` 只在**成功**路径触发(`session/tools.ts`),拿不到失败;而问题正是
  「失败被塌成 defect / 被伪装成成功」。把 web search 整个换成 alpha 自有工具(L0)则等于
  重写 provider 选路 + 传输 + 权限流程,并要压掉上游同名工具(`registry.ts` 闸在守卫内,
  见 [[ADR-009]] 裁决 (b)),比接管两文件大一个量级。
- **L1 变换**:失败语义不是文本/品牌层面的替换,是控制流(错误通道类型 + 状态分支)。
  build-time transform 表达不了,运行时 transform 无处挂。
- **L2 补丁**:技术上可行,但 alpha 至今**没有** patch 施加机制(ADR-004 只为 `/api/*`
  预留了通道,从未建成),#489 暂缓的原因就是等这台机器。为两个文件新建一台 L2 机器
  (施加步 + loud-fail + CI 集成 + 上游漂移维护面),成本高于把两个低 churn 文件冻结。
  这两个文件在上游属低频变更的叶子(工具实现,无人依赖其内部),L3 的代价在此最小。

### 3. 守卫形态(§3 要件)

沿用 [[ADR-033]] 的**文件级 `:(exclude)`** 机制(不是 ADR-020 的整包移出——`packages/opencode`
其余部分仍是高频同步面,必须继续被守着)。两处 exclude 清单同步加这两条,且必须保持一致:

- `.github/workflows/alpha-ci.yml` 的 `upstream-guard` job(CI 强制面)。
- `scripts/alpha-check.sh` 的 `[1/3] north-star guard`(本地先手面,`.githooks/pre-push` 走它)。

> **顺带修复的既有漂移**:`scripts/alpha-check.sh` 此前**完全没有** exclude 清单,`UPSTREAM_PATHS`
> 也停在 ADR-033 之前的五个包 —— 即本地守卫自 ADR-033 起对 16 个被接管/生成文件恒报假红,
> 与 CI 早已不是 1:1。本 ADR 落地时把它与 `alpha-ci.yml` 恢复逐条对齐,否则「本地先跑守卫」
> 这条纪律拿到的永远是噪声。

北极星指标(升级 sync 后冲突文件数 = 0)语义不变;衡量对象缩为「真正零改的上游」。

### 4. 回退方案(§3 要件)

撤销接管走 L3 唯一写通道 = 受控 re-freeze:用某上游 ref 覆盖这两个文件 + 从两处 exclude 清单
移除对应两行 + 把失败诚实需求降级重表达(等 L2 patch 机制建成后改走 L2)。代价 = 回退本次
失败映射,回到「一切错误塌成 defect」。

### 5. 放弃白嫖范围声明(§3 的 L3 专属要件,单向门)

这两个文件的**上游 churn 与安全修复不再自动进入 alpha**。具体放弃的白嫖面:上游对 Exa /
Parallel 端点、MCP 请求形状、provider 选路策略的后续改动,以及这两个文件里的任何上游安全修复。
吸收上游改进的唯一通道 = 受控 re-freeze(逐案评估)。**owner 2026-07-25 明示接受。**

风险与缓解:端点/请求形状漂移的表现是**运行时失败**而非编译红。缓解 = 本次接管把失败改成
LOUD 且带上游 body —— 端点变了会直接以可辨失败暴露,而不是像接管前那样塌成一个没有信息的
defect。这是本决策自带的 tripwire。

## 后果

- ✅ #489(E7 失败诚实)解锁并交付:失败集覆盖 `401` / `403`(带 `error.code`,
  `action_forbidden` 与 `job_not_enforceable` 可区分)/ `400` / `402`(preauth 拒绝、per-job
  超预算)/ `502` / 其余非 2xx 一律 LOUD;空结果不再伪装成成功;传输层 defect 收进同一可辨类型。
- ✅ 本地 `scripts/alpha-check.sh` 的 north-star 守卫与 CI 恢复 1:1,不再恒报假红。
- ⚠️ **单向门**:两个文件脱离上游同步(含安全修复),re-freeze 是唯一吸收通道。
- ⚠️ 接管面每多一处,「北极星」衡量的分母就小一点。本 ADR 的自限是**只收两个文件**:云路径
  (`catalog.ts` / `code-mode.ts`)明确不收,理由已在 §1 记录,后续若要收须自己的 ADR。
- ✅ [[ADR-009]] 的「未竟 · #489」条目随本次交付关闭并更正(同 PR)。
