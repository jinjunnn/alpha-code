---
id: REQ-070
title: endpoints/baseURL 迁移到 custom domain(workers.dev → tidelabs.click)
type: feature
priority: P1
repo: X
created: 2026-07-08
sprint: S32(2026-07-08)
status: shipped
source: alpha-platform 2026-07-08 审计 #3
---

# REQ-070 — endpoints/baseURL 迁移到 custom domain(workers.dev → tidelabs.click)

> 来源:alpha-platform 2026-07-08 审计 #3(B 侧 PR #20 已合并、双域已 live)。
> 交付形式:跨仓需求文档(不走 GH issue,用户约定)。
> **改号说明(2026-07-08)**:本档原自编 REQ-067,与 BACKLOG 既有 REQ-067(出厂治理内置化,已 archived)撞号;按 ADR-018「ID 永不复用」改号 REQ-070。

## 背景(B 侧已就绪,双域并行)

| 面 | 新(规范) | 旧(兼容期保留) |
|---|---|---|
| 模型 gateway | `https://alpha-gateway.tidelabs.click` | `https://alpha-gateway.jinjunnm.workers.dev` |
| cloud jobs API / MCP | `https://alpha-cloud.tidelabs.click` | `https://alpha-cloud.jinjunnm.workers.dev` |

动机:`*.workers.dev` 在大陆有广泛报告的 DNS 污染/TLS reset,custom domain 可达性更好,且解锁 B 侧 zone 级 WAF/限流(PA-21「大陆可达性上量前实测」前置)。

**兼容承诺**:旧域保持在线直到本需求完成并确认;B 收到确认后才关闭 gateway/cloud 的 workers.dev(B 侧内部 worker 已关)。

## 改动点(已定位)

1. `packages/ui-mac/src/shared/alpha-config.ts:21` — `platform` 默认值 → `https://alpha-gateway.tidelabs.click`
2. `packages/ui-mac/src/shared/alpha-config.ts:27` — `cloud` 默认值 → `https://alpha-cloud.tidelabs.click`(MCP URL 从 `${ep.cloud}/mcp` 派生,自动跟随)
3. `packages/ui-mac/src/main/alpha-endpoints.ts:9` — 注释里的旧域说明顺带更新
4. `account` 端点**不动**(境内 `alphacodeone.com` 直连,与本迁移正交,B 仓 ADR-017)

## 连带(同 owner)

- **alpha-code-plugin 仓**:`.mcp.json:5`(cloud MCP URL)+ `README.md:23`(`ANTHROPIC_BASE_URL` 示例)→ 同步换新域
- **alpha-web(C)协调点**:若 token 响应的 `endpoints{platform,cloud,...}` 下发了旧域,需同步改(A 的默认值只是 fallback);未下发则跳过

## 验收

- [ ] 桌面端经新域完成一次登录 + 模型调用(流式)+ 一次 cloud dispatch → completed
- [ ] MCP 工具(`cloud_*`,现 8 个)经 `https://alpha-cloud.tidelabs.click/mcp` 可用
- [ ] 完成后通知 B 侧(alpha-platform),关闭 gateway/cloud 的 workers.dev
