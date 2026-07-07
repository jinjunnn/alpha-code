---
id: A2
title: MCP 版本钉死收尾:存量配置一键钉迁移(A2b)
type: security
priority: P0
status: archived
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P0 / T1.5 / R3
---

## 背景/证据
A2 原体 = MCP 启动风暴(未钉版本 npx/uvx 每次在线解析,冷启动 8-13s server unavailable)。已完成:定制中心惰性化(PR #23)+ **A2a catalog 全条目钉精确版本(2026-07-03,PR #34)**。剩余 = **A2b:存量用户配置迁移**——用户 `opencode.jsonc` 里已装的 MCP 仍是未钉版本。

## 验收标准
1. 一键迁移:检测用户配置中 catalog 已知的未钉版本 MCP,更新为 catalog 钉住版本(经 `persistMcp` 白名单写入,幂等);
2. 迁移有用户可见确认(不静默改配置);
3. 启动 60s 内 server unavailable = 0(册 T1.5 验收);
4. **前置:A6 落地**(R3 门控:迁移=主动触达用户安装面)。

## 关联
A6(门控)、B8(生命周期管理的版本要素)、A2a(PR #34)。
