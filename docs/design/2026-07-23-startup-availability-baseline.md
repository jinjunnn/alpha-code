---
title: 冷启动模型可用性 + token 轮换正确性 方案基线
kind: design
status: draft-pending-owner-approval
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-23
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
   重载。「首页闪一下」的候选:AlphaHome provisional workspace 切真实项目 /
   composer epoch 重建 /(慢路径)respawn 整页 reload——由 T1 计时插桩定案。

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
