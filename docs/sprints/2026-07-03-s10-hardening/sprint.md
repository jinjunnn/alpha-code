# Sprint 2026-07-03 s10-hardening

**目标**:5 个最难需求(S9 + 前端批)收官后的高价值加固批——G1 主接缝装载、更新链完整性、respawn/改键卫生、启动性能、SSE 健壮。
**抽取**:B6(=G1)、B9、B5+B21、B1、REQ-003(BACKLOG 已翻 in-sprint)。**排序 = 用户 2026-07-03 指令**:「先继续推下一个 tasks,推完再真机验证」——S9/S10 的 verified 统一在收尾真机批执行。
**前置事实**:B1 与 A6 的 server.ts 撞车已解除(A6 已合);respawn 触发面刚因 B2/登录/登出扩大,B5 互斥优先级上调。

| Task | 内容 | 对应 ID | 状态 |
|---|---|---|---|
| T1 | ext bundle 进 app resources + StartCommand 传路径 + injectAlphaConfig 合并 V1 `plugin` 数组;ALPHA_EXT_DISABLE 逃生;缺文件 loud warn;运行时 alpha_ping 证明 → 真机批 | B6(=G1) | ✅ shipped(PR #46;runtime 证明待真机批) |
| T2 | electron-updater 关 allowDowngrade + feed/产物完整性核查记录 | B9 | ✅ shipped(PR #47;真机更新实测随下个发版) |
| T3 | respawnSidecar 互斥/合并(多路触发防竞态)+ BYOK 改键/删键即时重注 respawn | B5+B21 | ✅ shipped(PR #48;B5 崩溃自愈半边留 ready) |
| T4 | preferAppEnv shell 探测异步化 + userData 缓存(启动不等 login shell) | B1 | ✅ shipped(PR #49) |
| T5 | 网关流式转发 + A 侧 cloud SSE 健壮性审查加固(退避/重连/终态/subs 泄漏,收编 C23) | REQ-003 | ☐ |

**Gates**:typecheck ☑ · bun test ☑(逐 PR) · 北极星守卫 ☑ · 真机批(S9+S10 合场)☐
**回写**:BACKLOG 逐 PR · CHANGELOG 逐 PR · verify 记录随真机批
