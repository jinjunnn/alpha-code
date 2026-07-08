---
id: B8
title: 扩展物运行时生命周期:版本/健康/更新三要素
type: feature
priority: P1
status: dup
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P1 / T5.4 / T5.6
---

## 背景/证据
装得上、管不了:MCP 无版本钉(A2a 已解 catalog 侧)/健康面板/更新通道,skill 无已安装态(D4),plugin 无升级路径。系统性条目,症状=A2。终态 = 定制中心从「商店」进化为「运行时管理器」;远期「App 管理的 MCP 运行时」(alpha 自下载 server 包、node 直跑,摆脱 npx/uvx 在线解析)。

## 验收标准(T5.6 聚合验收)
1. 定制中心 MCP 健康面板:状态/版本/重连(T5.4);
2. 每类扩展物(MCP/skill/plugin)「版本(钉住)/ 状态(健康)/ 更新(通道)」三要素矩阵可视;
3. 缺失项立 roadmap 条目(「App 管理的 MCP 运行时」若立 → ADR proposed);
4. B8 从「缺失」降级为「roadmap 中」。

## 关联
A2(症状)、D4(skill 已安装态)、E10(catalog 远程同步)、ADR-014。
