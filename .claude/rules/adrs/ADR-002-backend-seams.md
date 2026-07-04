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

## 修订(2026-07-04,C8 —— 承认 main-IPC 为桌面形态的 sidecar 等价物)
落地实况:决策②的「自有独立 HTTP 进程(Hono/Bun)」**从未建成**;alpha 自有后端能力(account / cloud 派发 / ext 安装 / 自动化…)全部经 **Electron main 进程 IPC**(`ui-mac/src/main/*-ipc.ts` + preload + `window.api`)暴露给 renderer,内部仍只经 `@opencode-ai/sdk` 调 opencode(ADR 精神不变)。
- **语义澄清**:桌面单机场景下,**main-IPC 即 sidecar 的等价物**——两者都是「opencode server 之外、承载 alpha 自有 HTTP/RPC 能力的进程边界」,只是 IPC 通道免去本地 HTTP 端口/鉴权开销、契合 Electron 生命周期(见 [[ADR-006]] 两个运行时世界)。**ARCHITECTURE 硬约束③「新增 HTTP 接口走自有 sidecar、不改 `@opencode-ai/server`」依旧成立**——main-IPC 是其桌面实现,零改上游 server 路由的初衷未变。
- **真 HTTP sidecar 的触发条件(YAGNI,出现即立)**:仅当出现**非 renderer 客户端**(CLI / 外部进程 / 跨机)需访问 alpha account/cloud 能力时,才把对应 IPC 能力升为独立 HTTP sidecar;当前无此需求,不预建。
- 配套:GLOSSARY「sidecar」词条同步本澄清;[[C8]] 收尾。
