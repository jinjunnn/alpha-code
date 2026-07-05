# REQ-037 验收记录 —— 上游能力治理层(S18 T3)

> 2026-07-05。验证组合:10 项治理单测(校验/物化/apply-reset 端到端)+ **裸引擎实测**(隔离
> OPENCODE_TEST_HOME + ALPHA_OPENCODE_HOME,applyGovernance 物化 → workspace 源码 serve 读取)。

## 逐条结果

| # | 验收标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | 禁用 explore:选择器消失/task 优雅报错;恢复回归;dispose 热生效 | ✅ 机制 PASS | 裸引擎:`GET /agent` 列表**无 explore**(disable=从列表删除,上游 agent.ts:267);恢复 = reapply 清 stale 叶子(单测);dispose 链 = 既有 refreshEngine(REQ-016 已验);task 委派报错需会话 →真机批 |
| 2 | 隐藏 build:UI 消失、引擎不破 | ✅ 机制 PASS | 裸引擎:`build hidden:true`(引擎保留,冻结前端两处选择器过滤 !hidden);general/plan 照常在列 |
| 3 | 保护名单:compaction disable 被拒(loud) | ✅ PASS(单测) | validateGovernance:compaction/title/summary 拒 disable;**alpha 注入 agent 拒 disable+hide(S18 X2)**;build disable 需 confirm |
| 4 | deny customize-opencode:执行被拒 + 斜杠占位诚实 | ◐ 物化 PASS,执行拒需会话 | 裸引擎:`permission.skill` 物化("*" allow 打底 + 按名 deny,append 序保证 findLast 命中)+ `/command` 返回同名占位模板(「已在 alpha 治理中禁用…不要尝试其它方式执行」);system prompt 剔除/执行 DeniedError 为上游既证机制(REQ-037 档 file:line),会话级实拍 →真机批 |
| 5 | 重写 /init:走 alpha 模板 | ✅ PASS | 裸引擎:`/command` 的 init.template = alpha 模板(同名 config command 覆盖内置,上游 command/index.ts:70-103) |
| 6 | 治理写入不破坏用户 jsonc;重置净除 | ✅ PASS(单测) | **叶子键事务**(agent.<n>.hidden 而非整个 agent.<n>):用户同名 agent 的兄弟字段(temperature)与无关顶键(theme)保留;`_materialized` 记账 → 重放清 stale、reset 全量净除;**空壳剪枝**(command.<n>: {} 缺 template 会被引擎整份硬拒 → 删叶后剪空父) |
| 7 | allowlist 模式:未列名隐藏,保护豁免,切回恢复 | ✅ PASS(单测) | materializeEdits:allowlist 下可见未列名 → hidden;compaction/alpha-automation 豁免;切回 denylist = stale 清除;UI 切入 allowlist 时预填现状全允许(防一键全隐) |
| 8 | 零改上游;sync 机制回归纪律 | ✅ PASS | 全部 alpha 自有文件(alpha-governance.ts / ext-config 治理事务 writer / governance-panel.tsx);sync 触碰 agent.ts/permission/command/index.ts 时 retro 复核(挂 ADR-015 同类纪律,本档已注) |

## 实现落点
- `main/alpha-governance.ts`:真源 `~/.alpha/governance.json` + 保护名单硬校验 + 物化叶子计算 + apply/reset(`governance-materialized.json` 记账);10 单测
- `main/ext-config.ts`:`applyGovernanceEdits` 叶子键事务(独立路径白名单 agent/permission.skill/command 三域;原子写+回滚+空壳剪枝)
- IPC `gov-read/apply/reset` + preload `ext.govRead/govApply/govReset`(AlphaGovernance 共享类型)
- hub「已安装 → 内置(上游)」分组:agent 隐藏/禁用/重写(prompt)、skill deny(泄漏诚实注记)、command 重写编辑器、denylist/allowlist 切换、重置治理;保护项灰显+原因(C28)

## 残单(→ 真机批)
- hub 治理分组像素([[visual-verify-required]])
- 会话级:deny 后执行被拒实拍、task 委派 explore 优雅报错、dispose 热生效当会话验证
