# S39 — REQ-083 模型选择框 respawn 竞态修复(2026-07-10)

> 契约(ADR-018):目标 / 抽取 IDs / task 表 / gates / 结果 / 回写清单。

## 目标

修掉模型选择框在 sidecar respawn 窗口内的三个叠加缺陷:取数静默失败(BYOK 消失 + 代理全灰)、点灰行无条件触发 respawn(自续循环)、respawn 后无自愈。根因复盘见 BACKLOG REQ-083 行内(用户报障 2026-07-10,v0.1.2 真机日志定案)。

## 抽取

| ID | 状态入 | 状态出 |
|---|---|---|
| REQ-083 | ready | shipped |

## Tasks

- [x] T1 取数诚实 + 自愈:ModelPickPop 引擎模型表改 load 状态机(`engineReady`/`engineStalled`)+ 退避重试(sdk 未就绪/fetch 失败均可重试,弹窗存活期间自动恢复);stalled 态顶置「正在连接引擎」note,已配置 BYOK 供应商渲染占位行(不再整体消失,反 C28 placebo;健康路径 ~ms 级首拉不闪占位)
- [x] T2 点灰行不再火上浇油:locked 行点击动作抽纯函数 `lockedPickAction`(login/recharge/activate/none)——member/balance 态仅当**引擎在线且代理节点确实缺席**才调 `enableProxy()`;引擎不可达一律 no-op,杜绝「点灰行 → respawn → reload → 再点」循环(`enableProxy` 唯一调用点在此,main 侧零改动)
- [x] T3 respawn 后自动恢复:T1 重试循环覆盖(弹窗不需重开,实测同一弹窗就地补全);key 保存后 3s 补拉保留
- [x] 单测:`model-picker-logic.test.ts` 6 例(lockedPickAction 全分支 + 退避节奏);全量 673 全绿
- [x] 真机验证(dev + CDP,证据 [audits/s39](../../audits/2026-07-10-s39-req083/verify.md)):① 拦截取数 + 真杀 sidecar 两场景 = note + BYOK 占位 ×2 + 点灰行**零 respawn**(main.log 复核全场仅 1 次主动恢复 respawn);② 解除故障 → 同一弹窗不重开自动恢复(19 BYOK 行 + 0 locked);③ 基线不回归(30 行可选)

## Gates

- [x] alpha-check(北极星守卫 + typecheck + 单测)全绿
- [x] 零改上游文件
- [ ] UI PR 用户亲验门(训示 2026-07-09):自验后 dev 留可用态交用户 GO 才合并 —— **dev 已留可用态,待 GO**

## 回写清单

- [ ] BACKLOG REQ-083 → shipped(PR 号)
- [x] CHANGELOG [Unreleased] 用户可见条目
- [x] 证据:audits/2026-07-10-s39-req083/(5 png + verify.md)
