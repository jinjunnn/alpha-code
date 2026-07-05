---
id: REQ-006
title: ADR-014 转正收尾:桌面验收用例 + 未决项拍板 → trial 转 accepted
type: docs
priority: P2
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-04-s12-ext-hub-m1(T8 真机批同场)
source: ADR-014 / designs/2026-06-22-arch-extension-hub.md 验收段
---

## 背景/证据
ADR-014 状态 trial,转正前提「Mac 端像素核验 + Phase ④」。事实核查:Phase ④(plugin 装包)**实际已发**(E 册,commit `59c0786`)→ 前提已满足一半;设计文档 §C1-C5 组件 checklist 未勾系**文档滞后**(组件均已存在)。真正开着的 = 桌面端验收用例(设计文档 691-694 行)+ 4 个 plan-review 未决项。

## 验收标准
1. 桌面真机 4 用例([[visual-verify-required]]):装 markitdown → `opencode.jsonc` 有 `mcp.markitdown`;装后免重启会话内可用;toggle off → tool 消失;无 uv 时依赖预检诚实提示;
2. 4 个未决项拍板并记入 ADR 修订:① MVP 范围(实际已超 MCP-first,如实改述)② Agent/Command 进市场 tab 否 ③ F9 串台默认开关 ④ 远程 catalog 是否依赖 alpha-web(关联 E10);
3. 设计文档 checklist 按事实回勾;
4. ADR-014 状态 trial → accepted(修订记录)。

## 关联
D5(playwright 实测同场)、E10、E 册(冻结证据)。
