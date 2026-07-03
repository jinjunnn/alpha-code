---
id: REQ-005
title: 前端接管收尾核验:重型引擎换肤完成度 + timeline 验收尾项
type: ux
priority: P2
status: ready
repo: A
created: 2026-07-03
sprint: —
---

## 背景(为什么)
ADR-016 待办② build order 四步中,composer(06-25 redesign)、会话页 MessageTimeline(06-28 overhaul,tasks.md 40 项全勾)、设置/模型选择弹窗(PR #14–#20)均已发;但:
1. **重型引擎换肤**(终端 ghostty-web / diff·代码视图 / 权限流 的 `data-slot` CSS 换肤)完成度**无证据**——ADR-016 决策②承诺「复用 + 重新换肤」,现状未核验;
2. **timeline dev-plan 验收尾项未走完**(`docs/designs/2026-06-28-timeline-overhaul/dev-plan.md:98-100`):40 条深浅色 CDP 回归截图归档、`timeline-reskin.css` 顶部 COUPLING 清单更新(~36 组选择器,供 upstream sync 重指——直接关系 C14 耦合面管理)、`ship:mac` 真机验收。

## 验收标准(可验证,逐条)
1. 重型引擎三件(终端/diff/权限流)换肤完成度矩阵:真机截图取证([[visual-verify-required]]);缺口逐条拆行入 BACKLOG;
2. dev-plan 98-100 三步补齐并回勾(截图归档到 `screenshots/`、COUPLING 清单更新、真机验收);
3. ADR-016 待办② 更新:全绿则勾掉,有缺口则改指新登记的行。

## 非目标
- 不重写引擎(ADR-016 决策②:复用 + CSS-only);
- 不在本项内做 C14 薄 re-export 层(独立条目)。

## 方案 / 关联
关联:C14(COUPLING 清单是其管理面)、C20/C21(S8 同屏顺带)、ADR-016。

## 验证记录
_verify 时补。_
