---
id: D10
title: ui-mac package.json license/author 元数据补全
type: docs
priority: P3
status: verified
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.4
---

## 背景/证据
`ui-mac/package.json` 无 license/author 字段;electron-builder `copyright` 已加(PR #27 随 B15);index.ts:82 注释 Electron 版本过期(实际 42.3.3 / Node 24.15.0)。

## 验收标准
1. package.json 补 license(与发布策略一致)/ author;
2. 过期版本注释更正;
3. 与 B15/C18 的品牌/许可信息一致性复核。

## 关联
B15、C18(均已修,一致性核对)。
