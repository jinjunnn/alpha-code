---
id: C12
title: CORS 过宽(上游)处置:先撤 alpha 自注入 ACAO:*
type: security
priority: P2
status: registered
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.3 / R2(上游归属)
---

## 背景/证据
上游 `server/src/cors.ts:11-28`:localhost/127.0.0.1/`*.opencode.ai`/无 Origin 全放行(非 PTY 路由有 Basic 密码兜底)——上游归属,不可改(R2)。**alpha 反在 `windows.ts:161-171` 主动注入 `ACAO:*` 放大**(核查 §3d)——先撤这个,执行并入 C24。

## 验收标准
1. alpha 侧 `ACAO:*` 注入撤除(→ 随 C24 落地,回归验证 renderer 正常);
2. 上游 CORS 行为风险评估 + 「接受(有 Basic 兜底)」决策记录;
3. 若上游后续收紧(PR 见 upstream),sync 时复核本条可关闭。

## 关联
C24(执行载体)、R2 归属纪律。
