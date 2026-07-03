---
id: B2
title: refresh token 续期 + 401 拦截 + 失败降级
type: feature
priority: P1
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P1 / T3.1 / platform-integration §C
---

## 背景/证据
`alpha-auth.ts:270` 存 refresh token 但全仓无刷新调用——过期后平台/账户/cloud 全部 401。A8(PR #29)已修 respawn 重导 env 与 logout 清 token(重登可恢复),但**无感续期本体仍缺**;platform-integration §C 既定设计「续期失败降级 BYOK」未实现。

## 验收标准
1. access 过期前/401 时自动用 refresh 续期,用户无感;
2. 续期失败 → 降级 BYOK 或登出,**有明确 UI**(不静默 401);
3. 续期成功后新 token 达 sidecar(复用 A8 的 respawn 重导/或运行时转发);
4. 联调(REQ-002)中实测过期路径。

## 关联
A8(已修地基)、B21(同域 key 生效)、REQ-002(联调同域)、B11(失败呈现)。
