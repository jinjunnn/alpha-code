---
id: B5
title: sidecar 崩溃自愈 + respawn 竞态/互斥
type: debt
priority: P1
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P1 / T2.4 / NEW-4
---

## 背景/证据
sidecar exit 仅记日志无自愈(`index.ts:261-263`);respawn 有 20s 竞态(未健康也 reload,`:432-433`);另 `respawnSidecar` 无互斥(NEW-4,`index.ts:418-438`)——双「启用代理」按钮或登录+改模式并发 → 双 kill 后端口竞争 bind 失败。

## 验收标准
1. kill sidecar 后 10s 内自愈(指数退避 respawn,防 crash-loop 风暴);
2. 未健康不 reload(竞态修复);
3. respawn 互斥(并发触发只跑一次,后到者等待/合并);
4. 回归:A8 的 respawn 重导 env 行为不破。

## 关联
A8、C23(respawn 邻接)、B11(自愈失败要呈现)。
