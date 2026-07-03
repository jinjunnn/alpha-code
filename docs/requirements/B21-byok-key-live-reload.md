---
id: B21
title: BYOK 改键/删键即时生效(不达 sidecar 修复)
type: bug
priority: P1
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §7b
---

## 背景/证据
`setByokKey` 只写钥匙串(`provider-ipc.ts:20`),不重注 env、不 respawn → picker 显「已配置」(读钥匙串)但模型读 `process.env`(`alpha-models.ts:54`)仍空 → 401 至重启;删键同样留陈旧 env。A8(PR #29)已给 respawn 重导地基,但改键动作本身不触发。

## 验收标准
1. 改键/删键后**无需重启**即生效(触发重注 env + respawn,或运行时转发);
2. picker 显示状态与 sidecar 实际可用状态一致(改键后立即发消息成功);
3. 删键后模型立即不可用且有明确提示(非静默 401);
4. 并发保护复用 B5 的 respawn 互斥。

## 关联
A8(地基)、B2(同域)、B5(互斥)、REQ-002(联调实测场)。
