---
id: B2
title: refresh token 续期 + 401 拦截 + 失败降级
type: feature
priority: P1
status: shipped
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

## 采纳方案(2026-07-03,PR #42;alpha-web `a1d4d8a` 配套)
- **寿命拍板(用户 2026-07-03)**:桌面 access token 1h → **7*24h**(alpha-web `DESKTOP_ACCESS_TTL_SECONDS`,
  env 可覆盖——测试用短 TTL 走真实过期路径)。理由:token 在 sidecar fork 时冻进配置({file:} 加载时
  解析一次),1h 必然撞「超时会话 401 且刷新传不进运行中 sidecar」;备选「本地代理中继」(token 永不进
  sidecar,零 respawn)被否,记为潜在后续演进。
- **刷新时机**(`alpha-auth-clock.ts`,纯逻辑单测):提前量 = min(24h, 寿命/2);整点 tick 保活轮换;
  启动时仅「已过期」才 fork 前 await 续期(未过期不阻塞启动,B1);
- **续期本体**(`alpha-auth.ts refreshTokens`):grant_type=refresh_token + sid,轮换回写 + endpoints
  随续期更新;单飞防并发重复;
- **失败降级分层**:invalid_grant(会话 revoked / refresh 被盗轮换)→ 降级登出(清 env + respawn 停代理
  + 账户面板显示重新登录 = 验收②的明确 UI);网络/5xx → 保留现 token 静默等下轮;
- **401 拦截**(`alpha-account.ts`):续期一次再重试,仍 401 才交 renderer;
- **新 token 达 sidecar(验收③)**:7d 寿命下 fork 天然拿新 token;备胎——运行中 sidecar 冻住的 token
  剩 <30min(连续跑满一个寿命)→ 续期 + 静默 respawn 换血并留日志。

## 验证记录
- **2026-07-03(单测级)**:typecheck + 134 tests 绿(+8 时钟决策:提前量封顶/短 TTL 等比收缩/旧凭证
  补刷/过期边界);A 侧全链 typecheck。
- **待(verified 门槛)**:真机批——web 侧 `DESKTOP_ACCESS_TTL_SECONDS` 调短(如 120s)实测:
  ①过期→自动续期无感 ②撤销会话→降级登出有 UI ③logout 停代理不串台(REQ-002④)。

## 关联
A8(已修地基)、B21(同域 key 生效)、REQ-002(联调同域)、B11(失败呈现)。
