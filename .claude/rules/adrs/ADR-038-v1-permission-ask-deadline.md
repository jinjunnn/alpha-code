---
id: ADR-038
title: v1 审批请求的应答期限 —— packages/opencode/src/permission/index.ts 进入 ADR-033 的 L3 接管集
status: accepted
date: 2026-07-28
related: [ADR-029, ADR-033, ADR-036, ADR-037]
issue: https://github.com/jinjunnn/alpha-code/issues/668
---

> 本 ADR 只做一件事:把**一个文件**(`packages/opencode/src/permission/index.ts`)按
> [[ADR-029]] §3 的要件从上游同步集移到 **L3 冻结接管**,理由是 [#668](https://github.com/jinjunnn/alpha-code/issues/668)
> 的 owner 裁决(半场 E)要求给 v1 `Permission.ask` 加应答期限,而这个能力在 L0–L2 都表达不出来。
> 它不改变哪条链路走哪代引擎(那归 [[ADR-036]]),也不新增任何放行路径。

## 触发需求

[#668](https://github.com/jinjunnn/alpha-code/issues/668) 实测:`packages/opencode/src/permission/index.ts`
的 `Deferred.await(deferred)` **无超时**。[[ADR-036]] 把会话发送退回 v1 之后,v1 的三个内置
`ask` 门(`external_directory` / `read *.env*` / `doom_loop`)与用户自配的任何 `ask` 一旦触发,
在没有应答者时会让工具回合**无限期挂起**:无 toast、无系统通知、无时间线条目,用户唯一的逃生口
是手动中止。

owner 2026-07-28 裁决(#668):**加期限 + 具名失败**,并明确约束 **不得做成「到点自动放行」**——
那是把一个可用性缺陷换成安全缺陷。

## 决策

### 1. 被接管表面(退出上游同步集,alpha 全所有权 → L3)

- `packages/opencode/src/permission/index.ts`

仅此一个文件。同目录的 `arity.ts` 等**不**接管;`packages/opencode/src/session/tools.ts`、
`processor.ts` 一行不改(期限的失败值刻意继承 `PermissionV1.RejectedError`,好让 processor 既有的
blocked 分支照常生效 —— 见下)。新增的闸门测试落在 alpha 自有的
`packages/opencode/test/permission/alpha-ask-deadline.test.ts`(新增文件对 `--diff-filter=DMR`
天然不触发,不需要 exclude),上游的 `test/permission/next.test.ts` 继续受守卫看着。

### 2. 为何 L0–L2 不够用(§3 要件:低级别不可行的勘探证据)

| 级别 | 能不能承载「无人应答就在期限内具名失败」 | 证据 |
| --- | --- | --- |
| L0 接缝 | **不能** | v1 的 permission 接缝只有 plugin hook `permission.ask`(`packages/plugin/src/index.ts` 的 `"permission.ask"?: (input, output: { status: "ask"｜"deny"｜"allow" })`)。它只能改**判定**,改不了「判定为 ask 之后等多久」。而且它连改判定都做不到本票要的事 —— 把 ask 改成 allow 就是 owner 已否决的候选 D。 |
| L0 壳侧看门狗 | **不能(且有害)** | 由 `packages/ui-mac/src/main` 轮询 `GET /permission` 再 `POST .../reply` 超时的请求,一是只在打包壳里存在(CLI/其它宿主无期限),二是 v1 `reply(reject)` 会**连带拒绝同会话其余全部 pending**(`permission/index.ts` reply 分支),把一次超时放大成一片拒绝。 |
| L1 变换 | **不能** | 本仓的 L1 只有渲染进程 bundle 的 vite transform(`packages/ui-mac/scripts/patch-upstream.ts`)与品牌 i18n;引擎 sidecar 不经该管道。 |
| L2 构建期补丁 | **不能(会烂在暗处)** | 现存最接近的机器是 `scripts/patch-server-version.ts`——对**构建产物** `dist/node/node.js` 做字符串替换,且未命中时只 `warn`。用它承载一条安全语义(fail-closed 期限)意味着:dev 与 `bun test` 里期限根本不存在、上游改写一行文字期限就静默消失。ADR-029 明写「L2 失效必须 loud-fail」,而这条改动无法用字符串替换 loud-fail 地表达(要新增一个错误类 + 一层 `Effect.timeoutOrElse`)。 |

⇒ L3 是唯一能承载它的级别。接管面刻意压到一个文件、一处调用点。

### 3. 守卫形态

与 [[ADR-033]] 同机制:`alpha-ci.yml` 的 north-star guard 与 `scripts/alpha-check.sh` 各加一条
`:(exclude)packages/opencode/src/permission/index.ts`,并在注释里指回本 ADR。两处必须逐条对齐
(`scripts/alpha-check.sh` 的抬头已经写明这条纪律:两边漂移比没有守卫更坏)。

### 4. 行为约束(本 ADR 的实体内容)

1. **期限到达 ⇒ 失败,永不成功。** 实现上 `Effect.timeoutOrElse` 的 `orElse` 分支返回类型里
   没有成功分支,「到点自动 allow」在类型层面就写不出来。
2. **失败是具名的**:`Permission.UnansweredError`,`message` 里写清「没有放行」「是哪一个请求」
   「常见原因」「下一步能做什么」。它会经 `session/processor.ts` 的 `failToolCall` 写进工具调用的
   error 态,是用户在时间线上真正读到的那句话。
3. **它 `extends PermissionV1.RejectedError`**,因此 `processor.ts` 的
   `error instanceof PermissionV1.RejectedError → ctx.blocked` 照常生效。若另起一个无关 tag,
   模型会拿着工具错误继续重试同一个需要审批的动作,把一次静默挂起变成一串静默挂起。
4. **期限到达时广播一条 `permission.replied{reply:"reject"}`**,呈现面据此收回那张卡。
5. **默认 300 秒**,`ALPHA_PERMISSION_ASK_TIMEOUT_MS` 可覆盖(正整数毫秒);非法值一律回落默认,
   **不得回落成「无期限」**。默认值与回落规则本身有独立断言,防「把默认调成极大值让期限等于不存在」。

### 5. 判据(按 [[ADR-037]] 决策 4)

`packages/opencode/test/permission/alpha-ask-deadline.test.ts`:挂载生产
`Permission.node + EventV2Bridge.node + InstanceStore.node`,调生产 `permission.ask`
(与 `session/tools.ts` 给工具的 `ctx.ask` 同一服务同一方法),断言 **Exit 是 failure**(成功退出
= 工具会继续执行 = 自动放行)、失败值的身份与文案、事件总线上的 reject 回执、pending 表清空。
反向验证已实跑:把 `Effect.timeoutOrElse(...)` 换回裸 `Deferred.await(deferred)` ⇒ 两条行为用例
转红(一条 5s 超时、一条断言未收到 replied)。该文件登记在 `scripts/gate-files.tsv`。

### 6. 回退方案

用某上游 ref 覆盖 `packages/opencode/src/permission/index.ts` + 从两处守卫 pathspec 移除 exclude +
删除 `alpha-ask-deadline.test.ts` 及其登记行。代价 = 回到「无人应答即无限期挂起」,即 #668 的原状。

### 7. 放弃白嫖范围声明(L3 专属要件,单向门)

`packages/opencode/src/permission/index.ts` 的上游 churn 与安全修复**不再自动进入 alpha**。
吸收上游对该文件改进的唯一通道 = 受控 re-freeze(逐案评估)。范围极小(一个文件、约 230 行,
且 v1 permission 服务在上游已是低 churn 面),这是接管面刻意压到单文件的原因。

## 后果

- ✅ v1 审批不再无声挂死;失败诚实且可操作。
- ✅ 不新增任何自动放行路径 —— 期限的唯一出口是失败(owner 对候选 D 的裁决被机制保住,不靠自觉)。
- ⚠️ **单向门**:该文件脱离上游同步(含安全修复)。
- ⚠️ 接管集从 ADR-033 的 permission **v2** 内核扩大到 v1 服务的这一个文件;两处守卫 exclude 必须
  同时维护,漂移即恒假红/恒假绿。
