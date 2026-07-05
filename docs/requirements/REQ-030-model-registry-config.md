---
id: REQ-030
title: 模型清单单一真源配置化 + 海内外版本收口生效(registry 抽配置文件 / prod EDITION_CONFIG 落地 / 最新代策展)
type: feature
priority: P1
status: registered
repo: X
created: 2026-07-05
---

## 背景(为什么)

2026-07-05 现状核查(三线勘探,证据见文内 file:line):用户实测 alpha-code picker **海内外代理模型混出**(claude-*/gpt-5.4-*/deepseek-* 全量可见),与「国内版只出国内模型」预期不符。根因**不是机制缺失而是配置缺口**:

1. **edition 机制已建成(REQ-001,archived)**:B 侧 `GET /v1/models` 按租户 edition(cn/intl)收窄 + A 侧 live allowlist 文件桥收窄 picker,全链在用。但 **prod 网关从未设置 `EDITION_CONFIG` 环境变量**,代码内默认 `DEFAULT_EDITION_CONFIG.default = "intl"` = 全量放行(alpha-platform `packages/gateway/src/registry.ts:170-180`);REQ-001 验证记录里 prod curl 即为 `edition:intl, 11 models`,cn 收窄只在 dev server 实测过。
2. **模型清单真源是硬编码 TS 常量**:`registry.ts:22-144` 的 `REGISTRY`(11 条,含 upstreamModel/baseURL/wire/pricing/minPlan)。**不是配置文件、不是 DB**(ER 图中 ModelEntry 明注 in-memory)。增删模型 = 改代码 + **同时重部署 gateway(CF Worker)与 account 服务(阿里云 ECS Node)**——account 的 `/v1/settle`、`/v1/preauth` 用同一份 `REGISTRY[model]` 查价(`account-server.ts:118,132`),不同步则新模型计费 `unknown model` 400。
3. **无「只保留最新一代」策展政策**:DeepSeek 旧代(`deepseek-chat`/`deepseek-reasoner`)与 v4 两档(`deepseek-v4-flash`/`deepseek-v4-pro`)并存。
4. A 侧无需大改:`alpha-models.json` 只是 snapshot 兜底,picker 以 live allowlist 为准(`alpha-platform-models.ts:78-98`),B 侧收口后客户端自动跟随。

用户诉求(2026-07-05):① 国内版只出国内模型、后续调整可直接配置;② 配置**优先用配置文件**(问:是否该上 alpha-platform 数据库);③ 默认只提供各家最新一代模型(如 DeepSeek 出 v4 则只保留 v4 两档)。

## 目标(做什么)

1. **B / 配置文件化**:`REGISTRY` 从 TS 常量抽成独立配置文件(如 `packages/gateway/src/models.config.json`),`registry.ts` 只做加载 + schema 校验(启动 loud-fail,防坏配置静默);gateway 与 account **同源 import 同一文件**,加/改模型 = 改一个 JSON + 两处部署(wrangler 秒级 + account 发布),不改代码。为 REQ-031 的 `routes[]`(多上游候选链)预留同文件承载。
2. **B / prod edition 收口**:`EDITION_CONFIG` 在 prod 正式落地,按下方决策记录配置。操作 runbook 写入 alpha-platform 文档(改 var 即生效,无需发码)。
3. **B / 最新代策展**:配置文件只保留各家当代模型(DeepSeek 仅 v4 两档,旧代删除或 `enabled:false`);可选 `deprecated`/`sunset` 字段,客户端可据此提示迁移。存量默认模型指向旧代时降级到同家当代对应档,不炸会话。
4. **A / 跟随核验**:预期零代码改动(live allowlist 既有);同步刷新一次 `alpha-models.json` snapshot 与策展一致;真机核验 picker 跟随收窄。

## 验收标准(可验证,逐条)

1. cn 租户 `GET /v1/models` 只返回国内模型;真机 picker 截图核验只显国内组([[visual-verify-required]]);
2. intl(或运营者映射)租户不受影响,全量可见;
3. 端到端「加一个新模型」= 只改 models.config.json + 部署,gateway 出流 + account 计费(settle 不 400)同时认识;
4. DeepSeek 旧代按策展政策下架/禁用后,存量默认模型/会话不报错(降级路径实测);
5. 配置文件 schema 校验:构造一个坏字段,gateway 启动/部署 loud-fail 而非静默吞;
6. edition 切换全程不发 alpha-code 版(REQ-001 验收③ 在 prod 复现)。

## 非目标

- **不上数据库(SQLite/RDS/D1/KV)**:配置文件 + git 版本化 + 秒级部署已满足「方便更新」;`EDITION_CONFIG` env 保留为热改层。将来若出现「不经部署改全量清单」的真实需求,走 KV + admin 端点另立项,不用 SQL 表(账户库在境内 ECS,Worker 每请求跨境查库不可取)。
- 不做按 IP/geo 的自动路由——edition 是产品显隐白名单,非地理判定(现状语义保留)。
- 不做多上游 failover(→ [[REQ-031]],同一配置文件分期承载)。

## 决策记录(用户 2026-07-05 拍板)

**prod 默认 edition = `cn`,运营者自己的租户经 `config.tenants` 映射 `intl`**(保留自用全量,含 claude/gpt 代理模型)。⚖️ 队列该行已划掉。实施注意:先确认运营者租户 id 再上 var,避免自锁;`EDITION_CONFIG` 解析 fail-open 回代码默认(intl),故 var JSON 写坏不会误伤,但要在验收①里核实 var 真正生效而非静默回退。

## 方案 / 关联

- 底座 = REQ-001(archived:edition 机制 + live allowlist 全链);本档是其 prod 收口 + 真源治理续篇。
- [[REQ-031]](gateway 多上游路由与欠费 failover)共用同一配置文件,建议同 sprint 相邻排期、配置 schema 一次定型。
- B 侧实现细节落 alpha-platform 仓(ADR-018 §8:本档为产品级登记,`仓=X`)。
- 关联 memory:[[alpha-proxy-activation-chain]]、[[alpha-byok-key-model]]。
