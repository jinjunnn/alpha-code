# Sprint S32 — 域名迁移 + 未登录模型流程重设计(2026-07-08)

> 用户指令:REQ-070(原自编号 REQ-067,撞号改号)+ REQ-069 作为一个 sprint 直接处理(不走 /app:* 编排,用户 2026-07-08 当场纠偏:命令只在亲自输入时启动)。

## 目标
1. **REQ-070**:endpoints 默认值 workers.dev → tidelabs.click(大陆可达性;B 侧双域已 live);
2. **REQ-069**:未登录不再默认命中 member-only 代理模型、海外 model id 不外显、默认链(上次使用→代理→BYOK→空态)+ 发送 preflight。

## 抽取 IDs
| ID | 类 | 仓 | 结果 |
|---|---|---|---|
| REQ-070 | feature | X(A+C+plugin 仓) | ✅ 三仓代码全改;新域探活 200;A 侧回归锁更新 |
| REQ-069 | ux | A | ✅ 纯核解析链 + 挂起/恢复 + picker 收敛 + preflight;27 项新单测;CDP 真机双场景核验 |

## Task 表
- [x] REQ-070:`alpha-config.ts` platform/cloud 默认值 + 注释modernize;`alpha-endpoints.ts` 注释;回归锁 `alpha-config.test.ts` 语义反转(旧锁「不得 tidelabs」→ 新锁「必须 custom domain,api.tidelabs.click 与 workers.dev 都不得回归」)
- [x] REQ-070 连带:alpha-code-plugin `.mcp.json`/`README.md` 换新域;**alpha-web `lib/endpoints.ts` 下发默认值同步换**(核查证实 token 响应确实下发 endpoints —— 不改则登录用户被 discovery 旧域覆盖,A 改默认白改)
- [x] REQ-069 纯核:`model-default-core.ts`(checkPersistedModel / resolveDefaultModel / preflightBlockReason)
- [x] REQ-069 状态:composer-state 挂起/恢复(不删 localStorage,登录回来还原)
- [x] REQ-069 composer:解析链 effect(auth.subscribe 重跑)+ submit preflight(authKnown 门防早期竞态)
- [x] REQ-069 picker:未登录平台区收敛为登录卡(品牌可提、id 不列)+ 挂起原因如实展示
- [x] 单测:model-default-core 24 例 + composer-state 挂起 3 例(613 全绿)
- [x] CDP 真机核验(隔离 OPENCODE_TEST_ONBOARDING 环境):①全新未登录 → chip 占位、picker 登录卡 + CN 供应商、零 model id 泄漏(截图 req069-effort-picker.png);②登出残留 → 挂起不沿用、localStorage 保留、原因如实(截图 req069-suspended.png)
- [ ] REQ-069 Image #4 UI 细节:**未定位,独立拆单**(用户截图性质未明,按快车道另立)
- [ ] REQ-070 验收①②真机(登录+流式+cloud dispatch 经新域):待 C 仓 PR 部署后用户日常使用即验
- [ ] REQ-070 验收③(通知 B 关旧域):**从本 sprint DoD 剥离** —— 硬前置 = C 仓部署 + 存量 v0.1.x 客户端升级率(旧默认烧进包里,B 关旧域即砖化未升级客户端)

## Gates
- alpha-check(北极星守卫 + typecheck + 613 测试)✅ 全绿
- 新域探活:gateway /health + /v1/models 200,cloud /health 200 ✅

## 决策记录
- 撞号处置:域名迁移档原自编 REQ-067 与既有 REQ-067(出厂治理,archived)冲突,按 ADR-018「ID 永不复用」改号 REQ-070。
- preflight 语义:只拦「未登录 + 平台模型」与「未登录 + 全无可用」;登录后的 entitlement(member-only/余额)由网关最终裁决(A 侧 catalog 无 member-only 标记,不装判得了)。
- summary 网络失败 → 疑罪从无(维持 REQ-056 行为);明确空账户(无会员零余额)才不默认代理。
- 未登录 picker 平台区:收敛为一张登录卡,卡上可提品牌(GPT/Claude)不列 model id —— 兼顾「不外显」拍板与「让用户知道产品支持什么」。

## 回写清单
- [x] BACKLOG:REQ-069/REQ-070 → shipped(PR 号见行内)
- [x] 需求档 frontmatter status 同步
- [x] CHANGELOG [Unreleased] 用户可见条目
- [x] sprint.md(本文件)
