---
id: REQ-104
title: 扩展准入与精选 Pack：固定来源/许可/SBOM/能力分层 + 原子 Bundle
type: feature
github_issue: https://github.com/jinjunnn/alpha-work/issues/6
repo: X
created: 2026-07-10
source: 2026-07-10 产品能力与路由/扩展所有权专项审计；用户要求拆为独立 REQ
---

## 背景

值得引入的 Agent Skill、Claude marketplace 内容和 MCP 很多，但 Marketplace 收录不等于安全或可再分发。Alpha 需要可重复的准入流水线和 Default/预缓存/按需/Labs 分层，而不是按 stars 或“awesome”列表自动安装。

## 目标与交付

1. 建立 intake：固定 source commit/version → license/NOTICE → 静态内容与脚本/Hook diff → dependency lock/SBOM → capability/network/secret 提取 → sandbox smoke → 人工 review → signed channel。
2. 定义四级：最小第一方默认核心、可预缓存默认关闭、按需 Connector、Labs；每项都有 reviewedAt、upstream status、support tier 和复审期限。
3. 首批候选评审范围：精选 Anthropic/Vercel/Superpowers/Trail of Bits Skills，GitHub/Playwright/Chrome DevTools/Cloudflare/Context7/Docker MCP；逐项核验许可证和再分发权。
4. Bundle child 固定 digest、权限汇总、体积/依赖图、可选项和 smoke；安装复用 REQ-100 原子事务。
5. 自动巡检上游归档、advisory、license change、unmaintained、digest drift，并生成下架/隔离候选。
6. 禁止 `@latest`、未固定 branch、首次使用静默拉取可执行依赖、默认 Hook/Monitor/bin、跨项目全局记忆和多套浏览器栈同时默认启用。

## 验收标准

1. 给定同一 source/ref，两次 intake 得到相同 manifest/blob digest 与 provenance。
2. 许可证缺失、不可再分发、脚本未声明、网络域漂移、高危 advisory 或归档项目不能进入 stable/precache。
3. 每个 Pack 展示总权限、下载大小、运行时、secret、支持等级；任一 required child 失败不产生半装态。
4. Default 层除最小第一方核心外无第三方自动启用；Labs 必须逐会话授权并可独立卸载。
5. 自动巡检 fixture 能发现 archived Word/PPT MCP、已知 Excel advisory 和 source digest 漂移。
6. React-specific 能力不会被推荐给 Solid desktop；远程 SaaS 只分发连接描述，不冒充开源 payload。

## 非目标

- 不承诺一次性引入全部候选项目。
- 不镜像整个 Claude marketplace、skills.sh 或 awesome 列表。
- 不把 Anthropic Office source-available Skills 复制或衍生进 Alpha。

## 依赖与激活条件

- 依赖 REQ-100、101、102、103。
- REQ-105 是不等待本项的紧急 Catalog 纠偏；本项负责把相同风险变成长期自动门禁。
