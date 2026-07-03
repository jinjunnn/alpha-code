---
id: D4
title: 定制中心 skill 卡片「已安装」态
type: ux
priority: P3
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P3 / T5.4 / E 册 E1b 剩余(b)
---

## 背景/证据
ADR-014 §4:installed 真相源只有 MCP(SDK mcp.status);skill 无真相源 → 装后按钮仍显「安装」(幂等覆盖)。文件系统即真相:用户 skills 目录存在同名目录 = 已安装。

## 验收标准
1. skill 卡片按文件系统真相显示「已安装」;
2. 已安装再点 = 「重新安装/覆盖」明示(不再无提示幂等);
3. 卸载入口(删目录,带确认)——顺带补 B8 生命周期一角。

## 关联
B8(三要素之状态)、D3(内容打包后可验证)、ADR-014。
