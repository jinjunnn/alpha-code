---
title: 冷启动模型可用性 + token 轮换正确性 方案基线
kind: design
status: approved
approved_by: owner
approved_on: 2026-07-25
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-25
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

1. **boot generation 的终态生产者不得受启动父 fiber 生命周期监督;父 effect 结束后,
   健康结果仍必须恰好发布一个 `ready` 或 `failed`。**
   (rev2b 修正:本条初稿写作「禁止在 `serverReady` 之后的位置发布任何状态」——
   **归因过宽且表述有误**。真正的边界是**监督生命周期**,不是源码词法位置:一个
   detached 的 promise callback 即使写在 `serverReady` 之后也可以安全执行。
   按位置立禁令会误杀安全写法,也守不住真正的失效模式。)
   **强制手段 = 行为断言而非 lint**(自定义 lint 检查源码位置很脆且误杀,不值得):
   ①父 effect 已结束后再 resolve health → 恰好一个 `ready`;
   ②health reject/timeout → 恰好一个 `failed`,且此后不得变 ready。
   **指纹**(排障用,非门控):同一函数内早期日志有、后段日志 0 次。
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

## rev2b(2026-07-24):Codex 开发前问询轮回写

Codex 只读方案质询轮(thread `019f9725-94ad-7892-bcc9-cfc36315f4ce`,
基于 `origin/alpha = f8cd650d1`)判定 **GO WITH REVISIONS**。以下为必须的修订,
已按治理回写基线;此后 review 轮对照本节,不再逐轮重新推导。

### 修订 1:#595 必须拆成两个谓词,且删除一处错误断言

rev2 的「BYOK 可用性」是**混淆概念** —— 它把「可选择性」与「当前可执行性」揉成一个。
正确的最简定义是两个独立谓词:

- **BYOK 本地可选择** = `本地目录存在模型 + 本地 key 已配置`
- **当前可执行** = 引擎已恢复

**登录态、账户额度、平台连通、live allowlist、引擎 `model.list` 内容,
一律不得否定前者。** 契约文件(`docs/contracts/byok-availability.md`)按这两个谓词写,
不再用模糊的「BYOK 可用性」。

具体最小改法(Codex 给出,取代 rev2 ②′ 中相应条目):
- `renderer/alpha-ui/model-picker-core.ts:89` 起:key 已配置即直接从
  `EffectiveCatalog.byokProviders[].models` 生成行,`availability` 表示
  **picker 可选择**而非引擎执行证明;`listState` 最多提供「引擎重启中」**文案**,
  不参与可选判定。**删掉「list ready 后命中 `<id>-byok` 才升级为完全可用」的语义**
  —— 留着它引擎就仍是最终裁判,主权没收回来。
- `renderer/alpha-ui/alpha-composer-model.tsx:341`:gate 改为 **row-aware**。
  home 的 BYOK 行不受 `modelChainReady` / `listState` / `readyListEpoch` 阻断,
  并**跳过 `:364` 的引擎清单 membership 检查**;平台行与 session 模式继续受控。
- `renderer/alpha-ui/alpha-composer.tsx:756` 一带:只允许 **home** 在链恢复中把 BYOK
  写进内存选择。**`canSend` 不需要在 #595 里另做 BYOK 豁免** —— `:742` 的发送门
  留作执行就绪门,待 #594 恢复后自然打开。

**rev2 的一处事实错误(本节更正)**:rev2 ②′ 称「session 模式沿用现有
suspend/`retryImmediately` 机制把 `switchModel` 延后到 ready」——**该机制不存在**。
`renderer/alpha-ui/composer-state.ts:99` 的 suspended 是**挂起已选模型**,不是
pending selection;`retryImmediately` 也只重跑读取链。按错误断言开工会制造一个
未设计的 pending 真值或点击失败。#595 的 recovering 验收据此改为:

> **home 模式可先选择;session 模式展示本地 BYOK 行,但在引擎恢复、`switchModel`
> 确认之前不得伪装成已切换。**

即:不新增任何 session 排队切换状态机。

被否决(本轮新增):**只改 `listState` 的计算方式**——它会同时误放平台代理,
且后面仍有 `selectionBlocked`、membership、父层 `modelChainState` 三道门,否。
**只改分组渲染**——只能"看见"不能"选择",否。把 BYOK 行派生**整体移出引擎清单依赖**
才是正确的第三条路。

### 修订 2:补掉平台契约错误吞掉本地 BYOK 的漏口(新勘破 13)

13. **`main/alpha-platform-models.ts:83` 的 `getEffectiveCatalog()` 在平台目录契约
    不兼容时直接 throw**,导致整个 `models-catalog` IPC 失败 —— **连本地 BYOK 一起阵亡**。
    ⇒ rev2 勘破 12 的推论「BYOK 数据经 main IPC、不经引擎,所以已与平台分离」
    **不成立**:平台侧一个解码错误仍能全灭本地目录。
    #595 必须**隔离这一失败域**:平台契约错误应上报,但不得阻断本地目录返回。

同时更正 rev2 ②′ 的另一处推论:「豁免 `selectionBlocked` 即可选择」**不成立** ——
还有行级 `availability`、引擎清单 membership、父层 model-chain gate 三道门。

### 修订 3:#577 与 #594 必须原子同 PR

`preload/types.ts:64` 的 `SidecarGenerationState` 现只有 `recovering | ready`;
`renderer/alpha-ui/model-recovery.ts:5` 的转换过滤器只接受 `recovering → ready`;
各 consumer 又把「非 recovering」隐式当成 ready。**若 #577 单独发布 `failed`**:
live 事件会被转换过滤器丢弃 / preload 回放到 consumer 时被误当 ready /
client 可能在已知健康失败时重建。

职责据此明确:
- **#577**:producer 生命周期、`failed` 状态联合、**恰好一次终态**(exactly-once:
  不得既发 ready 又发 failed,也不得一个都不发)。
- **#594**:转换过滤器接受 `recovering → failed`;所有 consumer 明确区分 ready/failed;
  failed 下**保持执行面关闭 + 启动自探**。
- **两票同一 PR 原子落地**;#595 单独一 PR,基于前一 PR 合并结果开工。

`#594` 与 `#595` 虽都触碰 `alpha-composer.tsx` / `alpha-composer-model.tsx`,
但触点分别是「重试/重建」与「选择判据」,从已合并基线起分支不会产生实质冲突。
**不要为规避小范围相邻修改而把三个中等风险主题塞进一个 PR。**

### 修订 4:撤收窄的代价清单(Q2 结论:撤销正确,但代价比 rev2 一句话重)

owner 要的是「平台无权覆盖」,就不能同时保留平台远程 kill-switch —— 撤销成立。
真实代价(rev2 只写了一句,此处展开):
- 供应商破坏性修改鉴权 / URL / 协议后,旧客户端持续提供**必失败**条目;
- 模型永久下架或 id 改名后,picker 保留**死入口**;
- 供应商安全事故或数据处理政策恶化时,**无法紧急阻断既有安装**;
- 法务 / 制裁 / 区域合规要求立即下架某供应商时,**只能等发版**;
- 错误 baseURL 或计费语义变化可能让用户**直接承担异常账单**。

这些风险**不推翻** owner 已接受的主权选择(当前无真实用户/租户)。
**不得为它引入新的在线政策面。**
被否决:「签名、只减不增、带 TTL 与 reason 的紧急 denylist」—— 技术可做,
但它仍是外部覆盖,且要治理签发/失效/缓存/误杀,当前不够简单,**不进三票门控**;
若将来出现真实法务紧急摘除要求再评估(OPTIONAL,非门控)。

### 修订 5:撤收窄后区分两个同名概念,停止传播死远程字段

- 本地 `AlphaModelCatalog.byokProviders` 仍是**核心数据**,不是死字段。
- 平台 wire/cache 的 `byok_providers` 撤销后**失去任何策略消费方**,只剩解码、缓存、
  日志与 IPC 类型穿透 = **死配置面**。#595 顺手停止在 alpha-code 的
  `PlatformModelsResult`、`LiveAllowlist`、preload 类型与日志中继续传递该远程字段。
  外部 producer/schema 的完整删除另行处理,不阻塞本票。

### 修订 6:其余不变量的强制手段(③′2–5)

- ③′2 → #594 的「ready 丢失但 health 可达,client 有界重建」**假时钟**测试。
- ③′3 → 「超过原 20 次后仍存在下一次 retry,恢复后回 ready」测试。
- ③′4 → 契约改成两个谓词后,用**未登录 / 平台错误 / list recovering / list 缺行**
  四情形矩阵测试。若日后仍频繁漂移,再考虑把 BYOK 行派生提成**不接收 account/list**
  的小纯函数(当前不作门控)。
- ③′5 → 增加「远程 allowlist 排除供应商」与「平台目录 contract-incompatible」
  两种情况下**本地 BYOK 仍返回**的测试。

## rev2c(2026-07-25):恢复语义所有权模型 + 闸门有效性判据

本节由一天之内在同一子系统查出的**同类缺陷九个实例**与**假闸门十五例**驱动。
它不新增需求,只把「为什么同一类错误会反复发生」写成成文判据,供后续任何人改动
恢复路径 / 认证路径 / 安全判据时对照。rev2/rev2b 是**某次事故的处置**,本节是**该类事故的防线**。

### 母题:反复出现的不是「写错了」,是「依赖了一个没人保证的不变量」

| 实例 | 假定了什么 | 谁本该保证 |
| --- | --- | --- |
| ready 终态发在 forkChild 里 | 子 fiber 能活到健康探测返回 | 无人(父 fiber 终止即杀) |
| consumer 只认 ready 事件 | ready 一定会到 | 无人(producer 可能永不发) |
| 20 次重试悬崖(model / account 两处) | 三个唤醒源总有一个会来 | 无人(三个都可能死路) |
| `wake()` 唤醒已退出的循环 | 循环还在等 | 无人(预算耗尽即退出) |
| `++chainSeq` supersede | 没有别的 owner 在跑 | 无人(账户链可能在跑) |
| 名字型 secret veto | secret 只以变量名出现 | 无人(容器型变量把它装在值里) |
| `Set.has()` 判据 | 键名大小写规范 | 无人(Windows 键不敏感) |
| 空清单让路 | 空清单必定未就绪 | 无人(状态机照样进 ready) |
| 无效 `expires_in` 仍算成功 | 「成功响应」= 「结果可用」 | 无人 |

**假定错不会立刻炸,只在特定时序下炸** —— 这正是它们能带着测试一起合并进主线的原因。

### ③″1 fail-closed 判据必须显式声明所依赖的不变量

**任何 fail-closed 判据(关闭能力、拒绝放行、跳过重试、提前 return)必须在代码注释里
显式列出它依赖的不变量,且每条不变量必须有各自的强制手段**(测试 / 类型 / 状态机结构)。

- 声明不出来的,就是在假定 —— 那是缺陷,不是风格问题。
- **「回放当前值」不算**强制手段:它会忠实回放坏状态(rev2 勘破 8 已实证)。
- **「另一处代码目前恰好这么写」不算**:那是巧合不是契约。
- **「后面还会有人来」不算**(时间性假定的一种)。实证:某实现判「有 6 个消费侧陆续挂载」
  可兜住 seed 失败,对抗方把六个入口全放进同一个 pending 窗口,1.1 秒后 `calls=1, seen=[]`。
- 判据与不变量分处两模块时,**强制手段必须落在判据这一侧**。
- **不变量表本身也要被验**:每条强制手段必须写明「**什么变异会让它转红**」,
  且该变异**必须真跑过一次**。答不出具体变异的那栏视为空栏 ——
  今天有两条声称的强制手段经对抗方实跑后是 GREEN(见 ③″3-8)。
  跑出 GREEN 也可以接受,但必须**如实标注为「非闸门覆盖项」**,不得含糊。

### ③″2 恢复语义的所有权模型

**恢复 owner** = 当前负责把某个能力从 recovering 带回 ready 的执行体
(退避循环 / 自探 timer / latch 重试)。

1. **每个能力在任一时刻至多一个恢复 owner**,且该 owner 必须**可被观察**
   (有状态、有下一次动作,不是「等某个事件」)。
2. **安全 supersede(建立新 replacement owner)**:directory 变化 / authEpoch 变化 /
   session 切换 / 显式 retryAll。这些都会**另起一个 owner**,故可以杀旧的。
3. **禁止 supersede**:任何**用户选择行为**、任何**不建立新 owner 的操作**。
4. **owner 退场只有两种合法方式**:把能力带回 ready,或**移交**给另一个 owner。
   **不得**因预算耗尽、事件未到、条件不满足而**静默退场**。
   ⚠️ 退场路径的枚举**极易漏项**:某实现枚举了三条(带回 ready / 移交 / 无预算耗尽),
   对抗方构造出**第四条** —— 广播时任一 listener 抛错会截断后续 listener,而 owner 已无 timer。
5. **终态生产者恰好发布一个终态**,且**不得受调用它的 fiber/scope 生命周期监督**
   (③′1 的一般化:边界是**监督生命周期**,不是源码词法位置)。
6. **「成功」必须等于「结果可用」**。成功但结果不可用(缺有效期、缺字段、decode 失败、
   健康未通过、**换算后余量不足**)**不得推进代际、不得触发换血、不得让调度器按最小间隔重刷**;
   应进入显式的降级终态并降频。
   ⚠️ 判据必须落在**换算结果**上而非响应字段上:`Number.MIN_VALUE` 是「有限正数」,
   但换算后 `expiresAt === now`。
7. **「尝试过」必须在尝试起手时记账**,不能只在 resolved 结果里记 ——
   否则在途重入与 rejection 两条路都绕过它(实证:0ms timer 风暴)。
8. **所有快照都需要定序,包括自己刚发出的那次读**。把来源分成「外部 vs 我的」是错误的分界:
   真正的分界是**什么时候读的**。异步意味着自读也会过期;
   若状态类型里没有可定序的单调字段,就必须自己建立(seq),并让**任何更新的证据作废在途旧读**。

### ③″3 闸门有效性判据(测试是否真的锁住了它声称锁住的东西)

一天内出现**十五例假闸门**,其中五例是**测试把缺陷锁成了正确行为**。每条都对应真实失效:

1. **禁止镜像**:测试不得自己重写一份「正确接线」再断言它,必须执行**生产 composition**。
   —— 实例:冷启动 ready 测试自建正确接线;account 测试在 mock 内手工 `await rotation.accept()`
   而生产实际 `void` 掉它;「在内存里抽出函数体配替身求值」同样是镜像。
2. **锁行为不锁形状**:源码形状断言(必要时才用)必须同时锁**位置/顺序关系**。
   —— 实例:接线锚可被「保留 detached 调用但挪到 spawn 成功之后」绕过。
3. **共用判据的每个入口各自需要闸门**。—— 实例:按钮与 Enter 共用 preflight,但只有按钮有闸门;
   两条 auth 消费入口共用判据,ratchet 只锁了名字出现过。
4. **变异测试必须变异「唯一承载该行为的那处」**。变异一个**冗余条件**而转红,
   不证明闸门在守护你以为的东西。—— 实例:`props.mode === "home"` 与「session 必有 sessionID」重叠。
5. **不接受空检查**:检查脚本必须证明它**真的检查了东西**(文件数 / 用例数 / 断言数不为零)。
   —— 实例:`scripts/check-doc-links.py` **裸跑扫 0 个文件、退出码 0**(必须显式传文件名);
   `grep -c $'\0'` 在 zsh 里是 `grep -c ''`,数的是全部行数。
6. **交付物不得声称未达成的状态**。CHANGELOG / 契约 / 注释里写「已修复 X」之前,X 必须有闸门。
   —— 实例:CHANGELOG 声称「账号恢复后 sidecar 不再用旧令牌」而该缺陷原样成立;
   源码注释声称某次序「不可调换、变异即红」而作者自己已确认该变异不红。
   **这是最贵的一种**:缺陷从「未发现」变成「已宣称修复」,以后无人再查。
7. **反向闸门**:对「静默吞掉失败」的代码路径(函数级 catch、fail-open 分支),
   必须有一条测试在**该路径被触发时变红**。只测正常路径等于没测。
8. **声称的变异必须真跑过**。—— 实例:两条「变异会转红」的声称经对抗方实跑均为 GREEN
   (boot `health.wait → commit` 删掉后全绿;queue 用例把 commit 提前后全绿)。
9. **相位要穷尽**:闸门覆盖了一个相位不等于覆盖了整条路径。
   —— 实例:退出条件只测了「两次读取都读到 recovering」,把两次读取顺序对调即红。
10. **测试夹具本身会制造假绿**。—— 实例:假桥用 `Set` 存订阅者,同一函数引用被去重,
    变异不露头;faithful 序列写错(让凭证从头就过期),第一次尝试自己把账记上。

### ③″4 安全判据的额外四条

1. **判据的匹配语义必须与运行平台一致**:同一文件里不得并存两套强度不同的匹配
   (`/i` 正则 vs 大小写敏感 `Set.has()`)—— 攻击者挑弱的那条走。
2. **DENY 与 ALLOW 不对称**:DENY 侧收紧永远安全;ALLOW 侧收紧只是少放行(fail-closed);
   ALLOW 侧**放宽**则是扩大攻击面。**安全票里不得顺手放宽 ALLOW。**
3. **基于名字的判据管不住容器型值**。凡「一整份配置 / JSON / 序列化对象」类变量,
   名字清白不代表值清白;正确处置是**整体丢弃**外部来源,而非解析值
   (解析可被嵌套引用与改名字段绕过)。
4. **修 fail-closed 极易修成 fail-open**(本轮出现三次)。把闸门从「太严」调到「太松」时,
   所有测试都在验「不该拦的没拦」,**没人验「该拦的还拦不拦」**。
   ⇒ 改 fail-closed 判据必须**同时**给出反向闸门,证明未引入反向误判。
   —— 实例:撤销引擎对 BYOK 的否决后发送门错误开启;auth 自探修好后迟到旧读把 recovering
   覆盖成 ready。

### 适用范围与执行

本节适用于 `packages/ui-mac` 的启动、认证、模型可用性、sidecar 生命周期与 env 组装面。
**新增或修改上述任一面的 PR,review 时对照本节逐条检查**;
与本节冲突的实现即为缺陷,**不以「既有写法如此」为由豁免**。

**「今天不可达」不是论证。** 本轮有两条「不可达」被对抗方构造出可达序列;
若某条无法在不做预防性设计的前提下闭合,应**明说并给出最小可接受的残留**,
而非以不可达搪塞。

由本轮产生、尚未闭合的相关票:**#605**(`SECRETISH` 词边界)、**#606**(死逃生开关)、
**#607**(注入执行级闸门 + 反向闸门)。
