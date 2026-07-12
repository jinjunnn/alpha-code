---
id: REQ-005
title: 前端接管收尾核验:重型引擎换肤完成度 + timeline 验收尾项
type: ux
github_issue: https://github.com/jinjunnn/alpha-code/issues/214
repo: A
created: 2026-07-03
---

## 背景(为什么)
ADR-016 待办② build order 四步中,composer(06-25 redesign)、会话页 MessageTimeline(06-28 overhaul,tasks.md 40 项全勾)、设置/模型选择弹窗(PR #14–#20)均已发;但:
1. **重型引擎换肤**(终端 ghostty-web / diff·代码视图 / 权限流 的 `data-slot` CSS 换肤)完成度**无证据**——ADR-016 决策②承诺「复用 + 重新换肤」,现状未核验;
2. **timeline dev-plan 验收尾项未走完**(`docs/designs/2026-06-28-timeline-overhaul/dev-plan.md:98-100`):40 条深浅色 CDP 回归截图归档、`timeline-reskin.css` 顶部 COUPLING 清单更新(~36 组选择器,供 upstream sync 重指——直接关系 C14 耦合面管理)、`ship:mac` 真机验收。

> 2026-07-10 范围校正：本项只建立 legacy 重型界面/时间线的 characterization baseline，**不能代表页面、路由或运行时所有权完成**，也不得继续扩大 CSS/DOM takeover。新接管路线见 REQ-084～091；本项证据作为 REQ-087 adapter spike 的输入。

## 验收标准(可验证,逐条)
1. 重型引擎三件(终端/diff/权限流)换肤完成度矩阵:真机截图取证([[visual-verify-required]]);缺口逐条回写到关联 GitHub Issue;
2. dev-plan 98-100 三步补齐并回勾(截图归档到 `screenshots/`、COUPLING 清单更新、真机验收);
3. ADR-016 待办② 更新:全绿则勾掉,有缺口则改指新登记的行。
4. 输出 legacy 依赖清单：timeline/diff/terminal/permission 分别依赖的 provider、滚动、focus、layout 与 DOM anchor，供 REQ-087 可行性验证；不把“截图通过”误记为 route ownership。

## 非目标
- 不重写引擎(ADR-016 决策②:复用 + CSS-only);
- 不在本项内做 C14 薄 re-export 层(独立条目)。
- 不新增 selector、MutationObserver、Portal 或构建期 UI patch；新结构接管进入 REQ-084～091。

## 方案 / 关联
关联:C14(COUPLING 清单是其管理面)、C20/C21(S8 同屏顺带)、ADR-016、REQ-087(legacy adapter spike)。

## 验证记录
_verify 时补。_
