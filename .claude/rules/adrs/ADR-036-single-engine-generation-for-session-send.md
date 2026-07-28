---
id: ADR-036
title: 会话发送保持单一引擎代次:全部走 v1 promptAsync,v2 durable 迁移推迟到上游补齐 MCP 运行时与插件钩子
status: accepted
date: 2026-07-28
related: [ADR-002, ADR-029, ADR-033]
issue: https://github.com/jinjunnn/alpha-code/issues/652
---

> **状态:accepted(owner 2026-07-28 拍板)。** 本 ADR 记录的是一个**方向裁决**,不是一次实现细节:
> alpha 的会话发送在**任何入口**都只使用一个引擎代次;今天那个代次是 v1
> (`packages/opencode` 的 `session.promptAsync`)。什么时候可以换代次,判据写在 §决策 3。

## 背景

1. **REQ-125 C7(`5bf362ffa`,2026-07-24)把会话页的后续消息改路由到 v2 durable 输入队列**
   (`c.v2.session.prompt`),而首页新会话入口(`use-projects.startChat`)仍走 v1
   `session.promptAsync`。同一个会话因此**跨了两个引擎代次**:第一条 v1、第二条起 v2。
2. **结果是主交互回路断裂**([#652](https://github.com/jinjunnn/alpha-code/issues/652),P0,打包版实测):
   v2 的 POST 回 200 并受理(`{"admittedSeq":…,"delivery":"steer"}`),随即 2 毫秒内
   `session.next.step.failed`,`Provider request failed with HTTP 401`。**全库统计:v2 受理 8 次、
   started 8 次、failed 8 次,零成功。** 且 alpha 的 store 里没有任何 `session.next.*` 的 reducer,
   两代消息表(v1 `message`/`part` 与 v2 `session_message`)互不投影 —— 于是失败**一个字都不显示**,
   用户看到的是「输入框清空,此后再无任何反应」。
3. **两代不对称是既有事实,已立契约**:
   [`docs/contracts/engine-config-channels.md`](../../../docs/contracts/engine-config-channels.md)
   记的正是「v2 不读 `OPENCODE_CONFIG_CONTENT`/`OPENCODE_CONFIG`」这条断层。#652 的 401 是这条
   断层在**凭证面**上的又一次现形(`alpha-config-injection.ts:413` 逐 provider 剥掉 apiKey,
   其 `:393-395` 的前提注释被 REQ-125 C7 作废而未跟改)。
4. **决定性事实:alpha 的主权层整个建在 v1 上。**
   - **MCP 运行时只在 `packages/opencode`**;`packages/core`(v2)全仓零 MCP 客户端命中。
   - **alpha ext 插件的钩子挂载点只在 v1**:`tool.execute.before` / `tool.execute.after` /
     `experimental.chat.system.transform` 在 v2 的插件面**不存在**。
   - 建在这些钩子上的能力:云搜索(ADR-035)、kill switch、prompt 接管、工厂拒绝、skill 注入。
   换句话说:**即使把 #652 的 401 修好,走 v2 的那些回合也是一个没有 alpha 主权层的 alpha。**

## 决策

1. **会话发送在任何入口都只用一个引擎代次,今天是 v1。** 会话页 composer 与时间线「继续生成」
   都改回 `session.promptAsync` —— 与首页 `startChat` 同一条。档位(plan / 只读 / 默认)随
   **每条消息**走 v1 `SessionPrompt.PromptInput.agent`,不再经会话级 `v2.session.switchAgent`
   落档;随之退役的还有发送前的「权威读会话档 + CAS 回滚 + 本地推送账本」那一整套协议
   (它只为「v2 无 per-prompt agent」而存在,且每一跳都是一个新的发送拦截点)。
2. **REQ-125 的 UI 成果全部保留。** 直挂 AlphaComposer、审批停靠区、任务清单卡、上下文用量 ring、
   斜杠命令登记与整条 alpha 时间线**与引擎代次无关**,一行不动。本 ADR 撤回的是**发送与档位的
   代次选择**,不是那一批 UI 主权。
3. **迁移到 v2 的准入判据(三条,全满足才重新提案)**:
   ① 上游 `packages/core` 具备 **MCP 运行时**;
   ② v2 插件面具备 alpha 主权层所需的**钩子挂载点**(至少 `tool.execute.before/after` 与
   系统提示变换的等价物);
   ③ v2 的**凭证面**与 alpha 的注入通道对齐(或经一条自己的 ADR 收编 `packages/core/src/config.ts`
   使其具备 `{file:}` 解析,该文件在 `UPSTREAM_PATHS` 内,按 [[ADR-029]] §3 需要自己的收编 ADR)。
   在三条齐备之前,**不得**再把任何发送入口指向 v2 —— 半代次迁移是本次事故的成因本身。
4. **v2 的读侧不受本 ADR 限制。** 模型目录 / `v2.session.switchModel` / `v2.session.get` /
   PermissionV2 feed 继续用 v2(它们本来就在 v2 上工作,且 v2 `switchModel` 写的是与 v1 共享的
   `session` 表,v1 `SessionPrompt.currentModel` 读得到)。本 ADR 只约束**发送**这条写路径。
5. **`OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG` 通道不动。** 权限、agent、MCP 治理的语义面
   继续由 v1 通道承载;不做任何语义迁移。

## 后果

- ✅ #652 的主交互回路恢复:同一会话连发任意条,每条都由带完整 alpha 主权层的 v1 引擎执行。
- ✅ 「引擎 v1/v2 断层」这一类缺陷在**发送路径**上被单点消除 —— 该类此前已现形四次
  (picker 走 v2 / 推理走 v1;配置信道不通;websearch 工具双份注册;本次发送双代次)。
- ✅ 发送前的往返从「读会话档 → 切会话档 → 提交」三跳降为一跳,少了两个新增的失败拦截点。
- ⚠️ **v2 的 durable 语义随之失去**:引擎侧持久输入队列、`admittedSeq` 回执、`delivery` 档位
  (`steer`/`queue`)在 v1 上没有对应物。v1 的等价形态是
  `SessionRunState.ensureRunning` —— 新用户消息写入后并进**正在跑的那个 loop**,在下一个 step
  边界被读到。行为上更接近 `steer` 而非严格的 `queue`,且存在一个已知窄窗:若 loop 恰好已判定
  退出、消息才落库,这条消息要等下一次发送才被消费。这一条**保留登记**,不在本 ADR 解决。
- ⚠️ **审批停靠区与独立 Permission surface 消费的是 `permission.v2.asked`**;v1 引擎的工具审批发的是
  `permission.asked`(`packages/schema/src/v1/permission.ts`)。回到 v1 后,alpha 侧那条 v2 审批
  feed 对本地工具回合**不会点亮**。本轮不改(owner 明确要求 REQ-125 的 UI 一行不动),
  **作为已知缺口交 owner 判断**,见 #652 的交付报告。
- ⚠️ v2 durable 表 `session_message` 里已有的 8 条失败记录成为孤儿数据。不做处置(老数据处置
  已被 owner 排除在本轮范围外)。
- 🔭 待办:①「超过 10 分钟的回合被 token 刷新重启 sidecar 杀掉」是独立缺陷,单独开票;
  ② §决策 3 三条判据齐备后,由一条新 ADR(supersede 本 ADR)重新提案 v2 迁移。

## 附:同批交付的独立安全修复(与引擎代次无关)

`packages/llm/src/route/` 的 auth 默认从 `Auth.none` 改为 fail-closed 的 `Auth.unset`:
**「拿不到凭证」不得降级为「发一个无鉴权请求」**。此前未声明 auth 的 route 会把没有
`Authorization` 头的请求照常发出去,由对端回 401 —— 失败点被推到远端、失败原因被字符串化,
**整类凭证通道变暗都表现为「远端拒绝」**。改后:未声明 = 发送前即拒,失败具名
(`MissingCredentialError` → `AuthenticationReason{kind:"missing"}`);只有 provider **显式**
声明 `Auth.none` 才允许无头发出(本地无鉴权 provider 必须显式声明,代价已知并接受)。
该修复对两代引擎都成立,不依赖本 ADR 的代次选择。
