---
id: ADR-002
title: 后端走 plugin/tool/MCP/sidecar,绝不 fork server 路由
status: accepted
date: 2026-06-14
related: [ADR-006]
---

## 背景
opencode `server` 路由编译期静态组装,插件层无挂路由口子;新增 HTTP 接口要改 upstream(高 churn,升级必冲突)。而 tool/hooks/MCP 是零-fork 接缝。

## 决策
- 自有后端 = `@alpha-code/ext`(server plugin + 自定义 tool)+ 必要时 MCP,经 `.opencode/opencode.jsonc` 的 `plugin[]` / `mcp` 引用。
- 自有 UI 要的新 HTTP 接口 → 自有 sidecar(Hono/Bun),内部用 `@opencode-ai/sdk` 调 opencode。
- 仅当确需同端口/同鉴权的 `/api/*` 时,才走 `patches/`(见 [[ADR-004]] 例外)。

## 后果
- ✅ 后端定制零改 upstream 源码。
- ⚠️ 上下文注入目前只有 `experimental.chat.{system,messages}.transform`(按 NON_GOALS#4 标注风险使用)。
