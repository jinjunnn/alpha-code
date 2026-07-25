---
title: 冷启动模型可用性 + token 轮换正确性 方案基线
kind: design
status: draft-pending-owner-approval
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-24
review_after: 2026-10-23
---

# 冷启动模型可用性 + token 轮换正确性(方案基线)

服务 REQ-109(冷启动即用)与 REQ-110(token 轮换正确性)。地面真相来自
2026-07-23 真机取证(冷启动探针、引擎日志时序)+ Codex 只读对抗轮
(thread 019f9216,结论全文见本文引用处)。

## ① 只读勘破(已实测)

启动关键路径与实测值(packaged,alpha=5cdc1d796):

1. **窗口在 sidecar ready 之后才出现**(main 等 sidecar `ready` IPC,renderer
   `awaitInitialization()`,上游 ConnectionGate 等 health)。用户感知的
   「打开后等 5–15 秒」发生在窗口出现**之前与之后各一段**。
2. **fork 前阻塞续期**:access token TTL = 15 分钟(平台契约),停机 >15 分钟
   的冷启动必触发 `isStoredTokenExpired() → await ensureFreshToken()`
   (fetch 10s 封顶,经本机代理方差大)。`ensureFreshToken(): void`
   丢弃结果——产品层无从区分 refreshed/失败,失败后带旧 token fork。
3. **sidecar 本体快**:fork→server ready ~0.8–1.6s;v2 `/api/model` 实测
   **不等 v1 实例 bootstrap、不依赖平台 bearer**(冷启动 t=2.3s 两个
   location 均 200,32 模型;探针记录 2026-07-23)。
4. **首页模型链串行门控**:首页(alpha-composer.tsx 模型链,固定 1s×20 重试)
   **先等 account summary(远端网络)成功才调 model.list** ——本地目录被远端
   账户查询人为串行;弹窗路径另有 1/2/4/8s 盲退避,两者都不消费「sidecar
   generation 恢复」信号。瞬态失败被映射成「当前不可用」而非 loading。
5. **v1 实例 bootstrap 方差**:恢复的 N 个项目 tab 并发建 N 个 location 实例
   (实测一次 10 个);实例 bootstrap await MCP spawn(单服务器默认 30s 超时
   ×3 重试)。用户全局 `~/.config/opencode/opencode.jsonc`(opencode CLI
   配置,非 alpha 治理面)带 3 个本地 MCP(fetch/markitdown/github,
   uvx/npx 冷缓存走网络解析;markitdown 装不上必败),实测把 alpha-code
   大仓实例 bootstrap 拖到 29s(热路径 1.6s)。会话页等实例就绪。
6. **token 轮换正确性缺陷(REQ-110 主体)**:注释/测试/调度按 ~7 天 token
   假设设计,main 每小时 tick 才检查「快过期 → 静默 respawn 换血」;真实
   TTL 15 分钟 ⇒ 运行中的 sidecar 可携带过期 token 数十分钟。account
   summary 401 触发的续期只更新 main 内存,不换已 fork sidecar 的静态
   `{file:}` 密钥;token-only respawn 现状执行 `webContents.reload()` 整页
   重载。「首页闪一下」**已由 T1 真机插桩定案**(#530,证据
   docs/verification/2026-07-24-req109-t1-startup-timelines.md):冷启动可见闪
   = AlphaHome default→真实项目 workspace 切换(链路全量重跑);热启动可见闪
   = 三候选之外的第四机制 —— surface admission(`resolvedSurfaces.latest`)随
   引擎 init 迟到收敛变化导致路由树重建、composer 全量 remount(非 reload、
   非 epoch);auth_epoch 首次 publish 固定 +1 是链双跑开销,非可见闪主因。
   第四机制的治理归属(并入 T3 或另开票)待 owner 裁定。

## ② 选定方案与被否决的替代

选定组合(Codex 裁决 + 双方独立收敛一致):

- **A′ 有界续期**:过期时立即发起单次续期,宽限 ~1–1.5s(总预算 ≤2s);
  宽限内成功 → 单次 fork;超时 → 先 fork(本地目录/BYOK 即可用,平台态
  显式「登录恢复中」),后台续期成功 → 至多一次换血。续期结果显式建模
  (refreshed / still-valid / transient-failure / invalid-grant),失败不得
  用同一旧 token 循环 respawn。
- **目录/账户并行解耦**:directory SDK 可用即调 model.list,account summary
  并行恢复;账户只门控平台 entitlement 与发送准入,不门控本地 catalog。
- **B′ 恢复信号 + 状态语义**:新增 sidecar generation `recovering → ready`
  通知;generation ready / SSE 重连 / account 恢复时取消退避残余、立即单飞
  重试(弹窗与首页两条链都覆盖);瞬态 transport 失败只进 loading/recovering,
  不映射「当前不可用」;短暂恢复期保留已有行内容并标注同步中。
- **token-only 换血去整页 reload**:依靠同 URL/password 的 SDK/SSE 重连 +
  generation 通知;客户端不能自愈处定向重建连接,renderer mount 保持 1 次。
- **TTL 调度修正**:按实际 `expiresAt/refreshDueAt` 排下一次续期(成功刷新/
  系统唤醒/登录变化后重排),废除小时轮询;一切成功续期(含 account 401
  重试路径)汇入同一换血入口。
- **G1 MCP 主权隔离**:fork 时枚举用户全局 opencode 配置的 mcp 键,不在
  alpha 治理集(alpha.jsonc 显式安装 + cloud MCP)内的经既有
  `injectDisabledOverrides` 通道注入 `enabled:false`(merge 终序必胜);
  **G2**:治理集 local MCP 统一 mcp 连接超时防御值(~5s)。
  实现期修正(#535,2026-07-24 勘破):①CONTENT 注入面放不下 G2 ——
  v1 schema 的 mcp 值 = `Union([完整定义(必带 type), {enabled:Boolean}])`,
  孤立 `{timeout}` 叶会让整份 CONTENT 校验 throw(实例配置全灭);整叶拷贝
  进静态 CONTENT 又会遮蔽 alpha.jsonc 热编辑/复活已卸载 server。故 G2 落在
  main 侧 boot reconcile,把 `timeout:5000` 写进 alpha.jsonc 的完整 local
  定义内(schema 合法、热编辑语义保留、单写者)。②per-server `timeout`
  同时约束连接与工具请求(上游无 connect-only 旋钮)—— remote(含 cloud)
  豁免,避免掐断合法长工具调用;显式 timeout 一律尊重。外部生态只经
  consent 导入(与 REQ-063/ADR-024 意图一致)。

被否决的替代(与理由):

- **D main 本地 bearer 中继**(token 轮换彻底脱离 respawn):架构上正确且与
  A6 不冲突,但把流式反代/背压/abort/header 清洗拉进关键数据面,main 成为
  推理热路径单点——**另立架构需求评估,不在本轮**。若 15 分钟 TTL 长期不变
  且换血频率被证实影响活动会话,D 升格。
- **E 跨启动 LKG 模型表持久化**:目录受 account/edition/workspace/BYOK 多因子
  影响,缓存跨账号/跨项目陈旧会产生错误授权观感;收益仅视觉占位,否。
- **F 总是立即 fork + 续期必 respawn**:每次过期冷启动必两次 fork + 现状整页
  reload,劣于 A′,否。
- **XDG_CONFIG_HOME 重定向隔离**(对比 G1):经 sidecar env 继承污染 agent
  shell 内 git 等一切 XDG 感知工具,爆炸半径不可控,否。
- **改上游实例 bootstrap 为 MCP 异步**:上游代码,零改上游红线,否——由 G1/G2
  控制进入配置面的集合达成同等效果。

## ③ 安全面:整类边界与实现必须守住的不变量

- token 永不进入 sidecar env / renderer / IPC payload / 日志(A6 不变);
  换血只经 `{file:}` 物化 + respawn/换血入口。
- **不得为视觉目标把未验证的过期平台 token 标成可用**;平台项在续期完成前
  显式「恢复中」。
- 续期失败分类处理:invalid-grant → 登出语义,不 respawn;transient →
  降级保持,禁循环 respawn(防 respawn 风暴,呼应 2026-07-23 refresh/publish
  风暴教训)。
- G1 注入只作用于**用户全局 opencode 配置来源**的 mcp 键;alpha.jsonc 显式
  安装与 cloud MCP 不受影响;project scope 面本轮不动(项目信任流另管)。
- 换血期间活动流式生成的处理必须验证(中断则需安全边界)。

## ④ 子票切分(基线批准后才切 CODE)

| 子票 | 内容 | 级别 |
| --- | --- | --- |
| T1 CODE | 启动时序插桩(app ready/refresh 起止与结果/fork/ready/window show/首次 model.list/account 起止/generation ready/reload 计数;单调时间戳,禁 token)+ 真机基线采集,定案「闪」归因 | S |
| T2 CODE | A′ 有界续期 + 续期结果建模 + 单一换血入口 | M |
| T3 CODE | 目录/账户并行解耦 + B′ 信号与状态语义(弹窗+首页两链) | M |
| T4 CODE | token-only 换血去 webContents.reload | S/M |
| T5 CODE | TTL 调度修正(expiresAt 驱动) | S |
| T6 CODE | G1 MCP 主权隔离 + G2 超时防御值 | S/M |
| T7 VERIFY | 验证矩阵:续期 50ms/1.5s/3s/10s、超时/5xx、invalid-grant、热启动、登出/BYOK-only、跨两个 TTL 周期长会话、换血遇活动流、Clash 代理真机 packaged | — |

核心断言(验收基准):冷启动 catalog 可操作 P95 ≤2s;瞬态不出现「不可用」;
generation ready 后 ~100ms 内重试;快续期单 fork,慢续期 ≤1 fork+1 换血;
token-only 换血 renderer mount 保持 1;account 续期成功后 sidecar 不再用旧
token;UI 恢复后的首次平台推理不得 401;续期失败无 respawn 循环。

T6 独立可交付,不依赖 T2–T5 排序。

## rev2(2026-07-24):T3/T4 落地事故 + BYOK 主权裁决

本轮修订由一次真机事故驱动:**T3/T4(PR #556)交付后,打包版冷启动 100%
不可用** —— 全部模型(含 BYOK)显示「正在同步…」,横幅「正在连接引擎(可能正在
重启)」常驻,「立即重试」无效,发送被禁;重新登录可恢复,冷启动必复发。
本节把新勘破写进基线,并记录 owner 对 BYOK 主权的裁决。

### ①′ 新增勘破(2026-07-24 真机取证,打包版 built 10:47:02 / 基线 `7281627ed`)

取证法:`~/Library/Application Support/ai.opencode.desktop.dev/logs/<session>/startup-timeline.log`
逐 session 普查(T1 插桩 #530 的直接回报)。**最近 14 次冷启动 100% 复现**,
分界 session `20260724T052444`(正常)→ `20260724T064451`(损坏),
窜入提交 `4128368ee`(合并 `151614f93` / PR #556)在损坏前 2 分钟。

7. **`Effect.forkChild` 启动死区**:启动装载体
   `Effect.gen(...).pipe(..., Effect.forkChild)`(`main/index.ts:1013`)是 `main`
   fiber 的**被监督**子 fiber;effect@4.0.0-beta.83 的 forkChild = auto
   supervision(父终止即杀子,`effect.d.ts:15769-15773`)。父 fiber 在
   `index.ts:1021` 从 `Deferred.await(serverReady)` 醒来后**到结束没有任何
   `yield*`**(建窗口/菜单/scheduler 全同步),毫秒级终止 → 子 fiber 停在
   `index.ts:1000-1008` 等健康探测(引擎健康需秒级)时被 interrupt。
   ⇒ `index.ts:1009` 的 `publishSidecarGeneration({status:"ready",reason:"boot"})`
   **永不执行**;30s 兜底同 fiber 一起死。铁证:47 个 session 中
   `index.ts:1010`/`1012` 两行日志**出现次数 0**,而同函数早期 `index.ts:956`
   的 `spawning sidecar` 每次都在。
   死区自初始 clone `55e91db59` 即存在,长期只损失两行日志无人察觉;
   **T4 把 ready 发布搬进死区,潜伏缺陷变产品事故**。
   → **教训入基线不变量**:见 ③′-1。
8. **消费侧 fail-closed 无兜底**:`renderer/sidebar/use-projects.ts:508-512`
   收到 `recovering` 即 `client = undefined`;`:525-527` **唯一**重建路径是收到
   `ready`;`:530-534` 的 1s 兜底只在「从未收到任何 generation 状态」时武装
   —— 冷启动经 preload 回放(`preload/index.ts:33-35` → `ipc.ts:76` 返回
   `sidecarGeneration.get()`)拿到的那颗 `recovering` 恰好把兜底**永久解除武装**。
   client 为空时 `alpha-ui/model-contract.ts:19-20` **同步 throw**,请求不上网络
   —— 日志 `model_list.end` 耗时 0.1–0.2ms 的 `error:request` 即此。
   ⇒ **「订阅前先读一次当前值」已经实现,但它忠实回放了坏状态** ——
   光靠订阅纪律修不了,producer 必须保证终态可达 + consumer 必须超时自证。
9. **B′ 的重试预算变成新悬崖**:`alpha-ui/alpha-composer.tsx:925-952` 的
   20 次 × 1s 耗尽后 `:954-957` 直接 return,**不再安排任何定时器**
   (注释 "Remain recovering until auth/generation/SSE or a manual retry")。
   三个唤醒源全死路:generation-ready 永不来(勘破 7);SSE 重连不可能
   (`use-projects.ts:433-435` client 为空时 `subscribe()` 直接 return,
   事件流根本不存在);account-recovered 要求 summary 曾 recovering 过
   (`:903-904`)。原基线「取消退避残余、立即单飞重试」只覆盖了**有信号**的情形,
   没覆盖**信号永不到达**。
10. **「立即重试」不覆盖卡住的那一层**:`alpha-composer-model.tsx:250-253` 的
    `retryAll` 重试 **fetch 层**,而卡死在 **client 构造层**;按钮不触碰
    use-projects、不重读 generation ⇒ 原地同步失败。
11. **BYOK 与代理共用单一 `listState` 闸门(一刀切)**:
    `alpha-ui/model-picker-core.ts:118-135` 对 key 已配置的 BYOK 行仍写
    `if (input.listState !== "ready")` → `alpha.model.syncing`;`:141-153` 即使
    `listState==="ready"` 也要求引擎清单存在 `<id>-byok:<modelID>` 且 enabled
    —— **可用性最终裁判是引擎回报,本地 key + 本地目录不算数**。点击层
    `alpha-composer-model.tsx:341-345` 的 `selectionBlocked` 含
    `listState() !== "ready"`,BYOK 行同样被禁点。
    ⇒ 原基线「账户只门控平台 entitlement,不门控本地 catalog」**已落实于账户维度**
    (`model-picker-core.ts:198-216`,BYOK 分支从不读 accountState),
    **但漏了引擎清单维度** —— 引擎一病,BYOK 陪葬。
12. **分离可行性(已勘破:可行)**:BYOK 渲染所需三样今天已全部走 main IPC、
    不经引擎 —— 本地目录 `alpha-models.json` 的 `byokProviders[].models`、
    `models-catalog` IPC(`main/models-ipc.ts:11` → `main/alpha-platform-models.ts:83-104`)、
    `providers-key-status` IPC(`main/provider-ipc.ts:20`)。
    密钥层亦**已**与登录解耦(登出只摘 `ALPHA_*`;注入门是 `hasSecretFile`,
    `main/alpha-models.ts:66`;key 状态判据全本地,`main/alpha-provider-status.ts:25-43`)。
    硬约束(物理下限):会话内换模型走 v2 `session.switchModel`
    (`model-contract.ts:40-47`)与推理本身需活引擎;但 home 模式选择只是内存写
    (`alpha-composer.tsx:778`),**不需要引擎**。

### ②′ 方案修订

- **T4 修订(→ #577)**:把「等健康 → 发 ready」移出被监督 fiber(普通 promise 链,
  与 `doRespawnSidecar` 同构;或 `forkDetach`/`forkIn`)。**健康失败/超时也必须发
  终态**(如 `status:"failed"`),让 consumer 有事实可依而非永远等下一个事件。
- **T3 修订(→ #594)**:consumer 侧一律改为「不依赖某个事件一定到达」——
  `recovering` 后有界兜底自探;重试改无上限封顶退避(复用
  `alpha-ui/model-picker-logic.ts:8-10`)或耗尽后降频续跑;「立即重试」必须
  重读 generation 并重建 client。
- **BYOK 可用性从 `listState` 摘出(→ #595)**:key 已配置的 BYOK 行恒渲染本地目录
  model id;`listState !== "ready"` 时行内状态为「引擎重启中·可先选择」而非
  「正在同步」;`selectionBlocked` 对 BYOK 豁免(session 模式把 `switchModel`
  延后到 ready);发送仍需活引擎(物理下限,不得假装)。
- **owner 裁决(2026-07-24):撤掉平台 live allowlist 对 BYOK 目录的收窄** ——
  `main/alpha-models.ts:56-57` 的 `byokAllowed` 与
  `main/alpha-platform-models.ts:95-96` 的目录收窄一并移除。BYOK 目录**只由本地
  `alpha-models.json` 决定,平台不得远程干预**。这推翻 2026-07-03「目录跟随
  edition」的一半(平台侧模型目录仍跟随 edition;BYOK 段不再跟随)。
- **新增契约 `docs/contracts/byok-availability.md`**(随 #595 落地):
  BYOK 可用性的合法输入 = {本地钥匙串, 本地目录, 引擎 liveness};
  **登录态、账户额度、平台连通、live allowlist 一律不得进入判据。**
  立契约的理由是结构性的:设计稿早有明文两处
  (`docs/design/2026-06-27-model-picker-redesign/spec.md:139`、
  `docs/design/2026-06-29-llm-auth-routing/design.md:23,48,105`),
  但 `docs/contracts/` 无一条钉住 ⇒ 设计明文挡不住实现漂移,契约才挡得住。

被否决的替代(本轮新增):

- **只修 producer(仅 #577)不动 consumer**:能让今天这条路复通,但任何未来的
  ready 丢失都会再次永久闩死;`use-projects.ts:530-534` 已证明「唯一事件源」
  假设的脆弱性,否。
- **给 BYOK 单开一条并行 model.list 通道**:徒增第二套取数路径与两套陈旧语义;
  本地目录已经在 renderer 手上(勘破 12),只需改判据不需改通道,否。
- **把 BYOK 行标为「可用」但点击时才报错**:视觉可用性造假,违反 ③-2 既有不变量
  (「不得为视觉目标把未验证的态标成可用」),否。

### ③′ 安全面:本轮新增不变量

1. **禁止在启动装载体 `serverReady` 之后的位置发布任何状态或终态。** 该位置在
   `Effect.forkChild` 的死区内,父 fiber 终止即杀。要发布就用普通 promise 链或
   `forkDetach`/`forkIn`。**指纹**:同一函数内早期日志有、后段日志 0 次。
2. **任何 fail-closed 的消费侧都必须有有界自证路径**,不得把可用性无限期押在
   「某个事件一定会到达」上。回放当前值不算兜底(它会忠实回放坏状态)。
3. **任何重试预算耗尽后不得进入无定时器终局**;要么无上限封顶退避,要么降频续跑。
4. **BYOK 可用性判据的输入集是封闭的**:{本地钥匙串, 本地目录, 引擎 liveness}。
   新增任何输入(登录、账户、平台、allowlist)即为契约违反。
5. 撤销 allowlist 收窄后,BYOK 目录不再有远程 kill-switch —— **本地目录即权威**,
   这是有意的主权选择(呼应 ②「让本系统成为权威、让外部无从覆盖」),
   代价是错误的本地目录条目只能靠发版修正,不能远程摘除。owner 已接受。

### ④′ 子票切分修订

| 子票 | 内容 | 级别 |
| --- | --- | --- |
| #577 CODE | T4 修订:ready 出死区 + 健康失败发终态 | M |
| #594 CODE | T3 修订:consumer 三闩死点改为不依赖事件必达 | M |
| #595 CODE | BYOK 判据脱离 listState + 撤平台收窄 + 落契约 | M |

新增核心断言(补充既有验收基准):

- 冷启动 startup-timeline **必须**在 N 秒内出现
  `main.sidecar.generation.emit … phase:"ready"`(进 L3 打包冒烟清单,防同类回归
  逃逸到真机)。
- `ready` 永不到达而引擎实际可达时,client 必须在有界时间内重建。
- 未登录 / 平台不可达 / 引擎 recovering 三种情况下,已配置 key 的 BYOK 行均可选。
- live allowlist 不含某 BYOK 供应商(或平台不可达)时,该供应商仍在目录中。

**不修(已定性)**:respawn 发出 ready 后首拉那次 ~5ms 失败不是闩死(下一次 attempt
大概率成功,只是整页 reload 先到),最可能是连接池复用死 socket,历史在案于
`alpha-ui/model-picker-logic.ts:12-20`。

**哑弹(归 B 侧)**:live 清单 `models[].provider` 写 `"zhipu"` 而目录 id 是
`"zhipuai"`;该字段在 alpha-code 无任何消费方(`main/alpha-models.ts:94-96`、
`main/alpha-platform-models.ts:90-93` 只用 `m.id`),今天不炸,但谁拿它 join
`byokProviders` 就静默零匹配 → alpha-platform registry 命名空间统一低优票。
