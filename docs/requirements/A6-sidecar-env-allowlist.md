---
id: A6
title: sidecar env 白名单:阻断秘钥继承给第三方 MCP/LSP 子进程
type: security
priority: P0
status: ready
repo: A
created: 2026-07-03
sprint: 2026-07-03-s9-proxy-e2e
source: 册 §6.1 / R2 / R3
---

## 背景/证据
sidecar 全量 `process.env`(含 `ALPHA_API_KEY` 计费 JWT、全部 BYOK 密钥、`ALPHA_CLOUD_TOKEN`、`EXA_API_KEY`)被每个本地 MCP/LSP 子进程原样继承——任何用户安装的 npx/uvx MCP 包可窃取租户计费身份 + 全部模型密钥。泄漏 site 在上游(`mcp/index.ts:334-344`、`lsp/lsp.ts:176-179` 的 `...process.env` 展开,不可改);**唯一 in-rule 修点 = alpha 的 `createSidecarEnv`(`ui-mac/src/main/server.ts:220`)改白名单透传**(T3.4)。发布短名单 #2,唯一剩余硬阻断。

## 验收标准
1. `createSidecarEnv` 改为白名单透传(替代全量拷贝),白名单显式列出 sidecar 自用必需项;
2. 实测第三方 MCP 子进程的 env dump:无 `ALPHA_API_KEY` / BYOK 密钥 / `ALPHA_CLOUD_TOKEN` / `EXA_API_KEY`;
3. 登录态 E2E 功能回归:平台代理、BYOK、websearch、cloud MCP 全部正常(deferred 原因即此,随 REQ-002 联调环境完成);
4. 落地后在 BACKLOG 记录 R3 门控解除(解锁 A2b、E2/E6 上架)。

## 边界
不改上游 spawn 展开;单测补进 ui-mac test(延续 T7.4 安全路径优先)。

## 关联
REQ-002(验证环境)、A2(被门控)、C2(供应链同伞)、册 §7g deferred 记录。
