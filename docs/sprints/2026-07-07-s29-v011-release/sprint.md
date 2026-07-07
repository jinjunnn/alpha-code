# S29 — v0.1.1 发版 + γ 桶真机走查

> 开批:2026-07-07(用户拍板:「同时开 S29 + 放行 γ 桶」)。
> 目标:首个**真实自动更新**发版(v0.1.0 → v0.1.1),就地收 B9 更新链 + REQ-052 迁移;随后在 0.1.1 上跑矩阵 γ 桶走查。
> 安全边界(C16 事故后新规,REQ-050):UI 走查**只读+截图,零确认框驱动**;破坏性用例(C17 DB 超前、清除流程)一律留用户在场。

## 抽取 IDs

| ID | 角色 |
|---|---|
| B9 | 更新链完整性 —— 本次真实发版即其 verified 条件(装机 0.1.0 检测→下载→重启升 0.1.1) |
| REQ-052 | 出厂技能两跳桥 —— 唯一不在装机包内的 shipped 项;新包首启验迁移 |
| B7 | 发版流水线制度化(release-time 三项)—— 顺带推进(ready→按本次实操回填) |
| γ 桶 ~14 项 | REQ-036/037/038/028/029/043/033/032/B11/B20/B21/B12/B23/REQ-002/REQ-025(A 侧)/REQ-016 残单(冷重启往返)—— 见 [qa/矩阵](../../qa/2026-07-07-shipped-verification-matrix.md) |

## Task 表

| # | 任务 | 状态 |
|---|---|---|
| T1 | runbook ⓪:锚点契约测试绿(5/5 ✓);⓪b 视觉基线 = S27 场次二截图批(7-6,同树;此后仅 REQ-052 主进程改动,零 renderer diff)+ γ 桶走查将再截关键屏 | ✅ |
| T2 | runbook ①′:catalog 快照刷新(2026-07-06.4,28 条,无变化 ✓) | ✅ |
| T3 | runbook ①:版本 0.1.0 → 0.1.1 + CHANGELOG 定版 [0.1.1] | ☐ |
| T4 | runbook ②③:签名+公证打包 + stapler/spctl 验证 | ☐ |
| T5 | runbook ④⑤:GitHub Release v0.1.1 + feed 200 | ☐ |
| T6 | **B9 verified**:装机 0.1.0 updater 检测→下载→重启 = 0.1.1(main.log 状态机全程留痕) | ☐ |
| T7 | **REQ-052 verified**:首启 main.log `legacy direct links migrated` + `~/.opencode/skill` 旧链消失 + `~/.alpha/skills` 真源就位 + 会话技能可用 | ☐ |
| T8 | γ 桶走查(0.1.1 上,CDP 截图取证,证据落 audits/2026-07-07-s29-verify/) | ☐ |
| T9 | 回写:BACKLOG 翻状态 + 矩阵更新 + CHANGELOG 已随 T3 + 本表勾选 | ☐ |

## Gates

- 打 tag 前:alpha-check 三关绿 + 锚点契约绿(T1 ✓)。
- 产物必须 stapler validate + spctl accepted 双过才许 release。
- verified 只按验收标准实测翻;γ 桶证据 = 截图/日志,落 audits。

## 结果(收尾时回填)

(待回填)
