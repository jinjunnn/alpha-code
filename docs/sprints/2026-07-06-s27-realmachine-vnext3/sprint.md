# Sprint 2026-07-06 S27 —— 真机批 vNext-3(S22–S26 递延全量)

> **抽取(2026-07-06,用户「继续推下一个 sprint」)**:按 S26 攒单 [qa/2026-07-06-realmachine-vnext3-plan.md](../../qa/2026-07-06-realmachine-vnext3-plan.md) 开批。上批 S26 已收尾(PR #124),WIP=1 满足。
> **性质**:验证批(同 S16/S20/S21 形态)——逐项证据落 `docs/audits/2026-07-06-realmachine-vnext3/verify.md`,BACKLOG 状态随证据翻 verified;真机发现的新 bug 只登记不内联修(S21 裁决沿用),P0 阻断项例外(快车道)。
> **纪律**:零改上游;[[visual-verify-required]](CDP 截图,不 grep 断言 UI);证据链齐才翻状态。

## Task 表(批前置 + 四组矩阵)

| # | 项 | 验收 | 状态 |
|---|---|---|---|
| T0 | 批前置③:C 侧上架远程 agent `bug-triage`(alpha 自写,只读档,单 .md 约定)→ build → deploy → prod 验签 | REQ-046 演练有对象;catalog 2026-07-06.3 | ✅(alpha-web PR #11,prod 验签 VALID + sha256 MATCH) |
| T1 | 批前置②:A 快照刷新 `sync-catalog-snapshot.mjs`(收录 2026-07-06.3)+ 守卫测试绿 | `alpha-catalog.json` 字节原样 + meta;`alpha-catalog.test.ts` 绿 | ✅(PR #125;REQ-044 守卫断言升级为「仅远程通道」语义,7/7)|
| T2 | 批前置①:签名+公证 prod 包重 ship(含 PR #119/#120/#122/#123/#125 全部 A 侧新码)→ install-local | 公证通过;/Applications 装载新版 | ✅(stapler worked / spctl Notarized;锚点契约 5/5 先行)|
| T3 | M1 定制中心:REQ-045③(三条目刷新可见→安装→账本 origin→会话可用;bundle:design 远程扇出)· REQ-046(远程 agent 安装→会话可用)· REQ-044 迁移开门(自建同名在场排除)· E2/E6 安装+首调用 · REQ-016 残余四小项 | 逐项截图/日志入 verify.md | ◐ M1-1/2/3/4 ✅(REQ-044/045/046 翻 verified);E6 安装链 ✅(SELECT 走查残留);E2 需真实凭证→用户批;M1-6 未开;**新发现 REQ-047(P0)/REQ-048** |
| T4 | M2 数据/凭证:C16 两级清除 · B14/C17 对话框演练 · B2 短TTL · B21 改键 | 同上 | ⬜ |
| T5 | M3 云线:B16 同意门 · B3 dispatch 冒烟+回流 · REQ-024/025 e2e | 同上 | ⬜ |
| T6 | M4 稳定性顺带:B22 复现 · B11 实拍 · B20 弱网 · B4 冷启动 · C3 轮转 · B7 release-time 三项 | 同上 | ⬜ |
| T7 | 收尾回写:verify.md 汇总 + BACKLOG 逐项翻 verified + retro 决定 | 四件套 | ◐(REQ-044/045/046 已翻 + REQ-047/048 登记;余项随后续场次)|

## Gates
- T0–T2 是 T3+ 的硬前置(顺序执行);
- ship gate:公证失败/守卫红 = 停批修复;
- 真机新发现:登记 BACKLOG(REQ-047+),不内联修(P0 阻断除外)。

## 明确不做
- 不在本批修 B22(复现成功即达标,修复另立);
- 不做 B12 长时内存观测(单列)、C15 CPU 对比(性能专项)、REQ-005(独立方向)。

## 中场结果(2026-07-06 场次一回填)

- **批前置 T0–T2 全过**;M1 主链全过 → **REQ-044 / REQ-045 / REQ-046 翻 verified**(证据 [audits/vnext3](../../audits/2026-07-06-realmachine-vnext3/verify.md))。
- **REQ-047(P0,新发现 → 同日快车道修复 PR #127)**:shell-env 探针腌毒缓存 → 安装 placebo 落死目录;确定性复现 ×2 + 机器级消毒;修复=探针净化(minimalProbeEnv)+ 读侧 8 控制键剥离(+5 单测);真机复验(自愈 + 零 9222)归下场次。
- **REQ-048(P3,新发现)**:存量条目缺 per-entry version → 全量误亮更新角标(C 侧补版本即修)。
- **剩余场次需求**:E2 真实凭证、E6 会话级 SELECT/写拒绝、M1-6 四小项、M2 原生对话框(真人)、M3 登录态云线、M4 弱网/复现——多数需真人交互或网络窗口 → 用户批/下场次。
