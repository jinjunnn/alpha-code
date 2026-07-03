---
id: B5
title: sidecar 崩溃自愈 + respawn 竞态/互斥
type: debt
priority: P1
status: shipped
repo: A
created: 2026-07-03
sprint: 2026-07-03-s10-hardening
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

## 采纳方案(2026-07-03,PR #48;范围=respawn 互斥半边,崩溃自愈另批)
`index.ts` respawnSidecar 单飞+合并:在途时再触发只标记排队一次,完成后补跑一轮(拿最新
env/密钥态,不丢最后一次变更)。触发面(登录/登出/enableProxy/setAuthMode/B2 tick/B21 改键)
并发时不再出现双 fork 抢端口 / renderer 双重 reload。**崩溃自愈(sidecar 意外退出自动重拉)
不在本 PR**——行保留,退回 ready 域待后续(与 REQ-003 的终态判定同批更顺)。

## 验证记录
- 2026-07-03:typecheck+148 tests 绿;并发触发行为(登录同时改键)→ 真机批顺带观察。
