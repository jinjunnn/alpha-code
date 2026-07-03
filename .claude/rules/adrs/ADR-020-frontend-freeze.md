---
id: ADR-020
title: 前端冻结:packages/{app,ui} 钉在 frontend-freeze-base,只同步引擎层
status: accepted
date: 2026-07-03
related: ADR-016, ADR-004, ADR-005
---

## 背景
546-commit 上游同步静默打断 reskin(证据:`docs/audits/2026-07-03-frontend-reskin-regression.md` 及其修正节);
用户诉求「不可能它改一次我跟一次」= 要**免疫**上游前端 churn,非警报(REQ-013)。ADR-016 已**放弃**白嫖上游
前端升级——继续每日合并其 2.5 万行级 churn 近乎纯负担。E 可行性 spike(2026-07-03)实测:前端钉在 546 前 +
引擎用当日 HEAD,`bun install`+typecheck+完整 vite build **全绿**,唯一适配点是 alpha 自己 3 行 WSL 代码
——前端↔引擎耦合被实证为松(546 commits 偏斜仅 1 处适配)。用户拍板:**E 冻结 @ 546 前**。

## 决策
1. **冻结基点** = tag `frontend-freeze-base`(`3b638e4a^1`,2026-06-30 reskin 验证通过的上游状态)。
   `packages/app` 与 `packages/ui` 恒等于该 tag 内容,**不再随上游同步**;alpha 的 reskin/组件即为
   其配套(6/30 验证态整体恢复,REQ-010 的名字级断裂随之蒸发)。
2. **每日 sync 只进引擎**:`sync-upstream.yml` 合并后执行 `restore_frozen_frontend`(rm+checkout tag,
   连上游新增文件一并清除);app/ui 路径的合并冲突为**预期内**,取 ours 后由还原步给出精确冻结态;
   其余路径冲突照旧 = 只增不改纪律破坏,失败。
3. **北极星守卫范围修订(修 ADR-004)**:`alpha-ci.yml` 的 `UPSTREAM_PATHS` 移除 `app`/`ui`——它们
   相对 origin/dev 的 diff 是冻结的本意。引擎/契约包(opencode/core/server/tui/sdk/session-ui 等)
   照旧零改动红线。**升级隔离北极星语义不变**:衡量的是「引擎升级零冲突」,前端已按 ADR-016 退出。
4. **alpha 对冻结包的纪律**:冻结 ≠ 可随意编辑——app/ui 仍**保持只读**(改 UI 走 ui-mac 自有文件,
   ADR-016 接管路径不变);唯一允许写 app/ui 的操作 = re-freeze(见 §5)。防止冻结包演化成第二个
   修改面、让 re-freeze 变 rebase 地狱。
5. **Re-freeze 流程**(将来想吃上游前端改进时,受控升级替代每日盲盒):
   ① 选新基点 ref → ② 临时树 `rm -rf app ui && checkout <新ref> -- app ui` → ③ `bun install` +
   typecheck + build + **锚点契约测试**(REQ-012,红名单即迁移工单)→ ④ CDP 关键屏视觉复验
   ([[visual-verify-required]])→ ⑤ 移动 tag(或建 `frontend-freeze-base-N`)+ 修订本 ADR。
6. **配套语义**:REQ-012 锚点守卫保留——冻结后上游 app/ui 不漂移,其角色转为 **re-freeze 工具**
   (体检新基点)+ 防 alpha 侧误改;`WSL probeAddable` 适配(9d1de37a)随冻结回退(该契约属 546 后
   前端);已知盲区:动态拼接的 data-* 值字面量匹配不到(4 个 knownDead 实为运行时活,树冻结故无害)。

## 后果
- ✅ 上游前端 churn **永不波及** alpha UI(用户核心诉求);6/30 验证过的 UI 整体回归;每日 sync 风险面
  收窄为引擎/契约(本就有 retro/契约 diff 纪律)。
- ✅ 最便宜的免疫路径:零重建;C→D(重灾区 SDK 化)保留为将来 re-freeze 失败时的根治备选。
- ⚠️ **主动放弃上游前端新特性/修复**(ADR-016 已放弃,本 ADR 使其物理化);前端安全修复也不再自动
  进入——re-freeze 是唯一吸收通道,安全公告需人工关注。
- ⚠️ 冻结前端 ↔ 新引擎的**运行时**契约漂移(HTTP/SSE)理论上仍可能(typecheck 测不全);546 偏斜
  实测仅 1 处适配,且 SDK codegen diff 高声;真机冒烟(runbook ⓪)兜底。
- ⚠️ `bun.lock`/catalog 随上游走,冻结包的依赖解析可能在某次 sync 后偏斜(spike 中 install 零变化;
  若发生 → 按 re-freeze ③ 的体检路径处理)。
- 🔭 待办:首个冻结态真机视觉核验(→ S9 真机批,兼 REQ-010 验收);sync 首跑观察 restore 步。
