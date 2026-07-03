---
id: REQ-002
title: 平台 ↔ alpha-code 代理联调:E2E 打通并计量出数
type: feature
priority: P1
status: shipped
repo: X
created: 2026-07-03
sprint: 2026-07-03-s9-proxy-e2e
---

## 背景(为什么)
代理链路各环节已分别修复(A8 respawn 重导 / logout 清 token、JWKS ES256 上线、feed owner 修正…),但**「一次真实的 A→B 模型调用、流式回包、计量出数」从未被整体验证**——核查报告 §5 明确批评:「从未有一次 A→B→A 闭环被证明」。用户要求本轮完成联调,实现代理通畅。

## 目标(做什么)
在真机(打包版或等价登录态环境)完成平台代理全链路联调,并把发现的断点逐一登记 BACKLOG 修复。

## 验收标准(可验证,逐条)
1. 登录 → platform 模式激活(memory [[alpha-proxy-activation-chain]]:mode==="platform" 是唯一闸)→ sidecar env 注入正确;
2. 选平台 provider 的**真实模型**发 prompt → 经网关流式回包、渲染正常(无卡顿 / 乱序;联动 REQ-003);
3. 网关侧计量出数:`/v1/account/summary` 的 `usageSeries` 当日累加(`docs/platform-integration.md` 待办①②③闭环);
4. logout 后代理停止、不串台(A8 复验);token 过期路径行为明确(暴露 B2 则按 B2 修);
5. 每个失败点有用户可见反馈,不静默(B11 纪律);
6. 联调结论(通 / 断点清单)落 `docs/audits/` 或 sprint 记录,断点入 BACKLOG。

## 非目标
- 不含云任务派发闭环(那是 B3/G4,单独验收);
- 不含计费 / 充值 UI(C 仓)。

## 方案 / 关联
- **联调环境同时用于 A6 落地验证**:A6(sidecar env 白名单)一直 deferred 的原因就是「需登录态端到端验证」(register §7g)——本需求提供该环境,应同 sprint 完成 A6 并复验代理不破;
- 同域顺带:B2(refresh 续期)、B21(BYOK 改键即时生效);
- 前置事实:workers.dev 是唯一路由 `/v1` 的 host,**勿切端点**(R1)。

## 验证记录
- **2026-07-03 核心链 verified**:登录 → platform → 真实模型流式回包 → 计量出数(4 次调用一致累加);
  修 3 断点:BP-1 网关流式计量 waitUntil(B `6fe49f3` prod)· BP-2 冷启动登录态(PR #36)· BP-3 →
  REQ-014。证据:[audits/2026-07-03-req002](../audits/2026-07-03-req002-proxy-e2e.md)。
- **④ token 过期 / logout 路径(2026-07-03 补)**:过期路径由 **B2 落地成型**(7d 寿命 + 自动续期 +
  invalid_grant 降级登出,见 [B2](B2-refresh-token.md) 采纳方案);logout 链已具备(logout → 清 env →
  respawn → A6 syncSecretFiles 删密钥文件 = 吊销)。**运行时复验**(短 TTL 实测三场景 + logout 不串台)
  随真机批执行,通过后本档翻 verified。
