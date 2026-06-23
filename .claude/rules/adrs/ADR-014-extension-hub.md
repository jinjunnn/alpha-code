---
id: ADR-014
title: 定制中心 — Skills/MCP/Plugins 可视化市场,采用 Claude 三分法 + alpha 自建套件,零-fork 安装
status: trial
date: 2026-06-22
related: [ADR-002, ADR-003, ADR-006, ADR-008, ADR-009]
---

> 配套设计:`docs/designs/2026-06-22-arch-extension-hub.md`(v2,经 /app:design-arch);build:`docs/sprints/2026-06-22-extension-hub/build.md`。
> 状态 `trial`(2026-06-22):design-arch 完成 → 用户选 A→design→C(跳过 plan-review)→ MVP 已实现(Phase ①②③⑤⑥,Plugin 门控)并 typecheck+build 通过。**待 Mac 端像素核验 + Phase ④ 后转 `accepted`。**

## 背景
侧栏「插件」(`ui-mac/.../alpha-sidebar.tsx:494`)只触发 `mcp.toggle`(opencode 的 MCP 开关对话框)—— 名不副实,且不覆盖 skill/agent/command/plugin;「自动化」是死占位。要做"完整成熟的 skill/agent/command/plugin 生态",但源码核实出三条硬约束:① opencode 的 `plugin` 不是能打包多件的"伞",只有 3 个 hook(`core/src/plugin.ts:23-48`);② 全平台无任何内置 marketplace/registry;③ MCP 的 `POST /mcp` 只在内存生效、不落盘(只有 CLI 写 config)。

## 决策(全部落 alpha 自有文件,零改 upstream)
1. **IA 采用 Claude 三分法**:技能(Skill)/ 连接器(MCP)/ 插件(Plugin),1:1 映射 opencode 三原语;侧栏「插件」改名 **「定制中心」**,内含三分 tab + **套件** + **已安装(可启停)** + **创建/导入**。术语按中国区本地化(连接器/套件/已安装)。
2. **"套件(bundle)" = alpha 自建 manifest**(非 opencode plugin),安装时**扇出**成多个原子安装 —— 因为 opencode plugin 不能 bundle 其它类型(约束①)。
3. **目录(catalog)自备**:内置进 app 一份 `catalog.json`(离线优先,躲中国区 npm/pip/GitHub egress),可选从 alpha-web(C)增量刷新 —— 因为无内置 registry(约束②)。
4. **零自建引擎 — live SDK + 薄 IPC 持久化**:经 Round2 对抗推翻"需自建安装引擎"假设(F3 证实 SDK 有 `mcp.add`,持久化仅需复用 CLI `addMcpToConfig` ~30 行)。新增唯一 IPC 方法 `window.api.ext.persistMcp()`(主进程写用户 opencode.jsonc 的 mcp[name])+ SDK `mcp.add`/`connect`(当场生效,免重启)。**已安装真相 = SDK 源**(mcp.status),UI 偏好用既有 window.api.store(非另起 electron-store)。出厂预设经既有 F8 的 `injectAlphaConfig`(`OPENCODE_CONFIG_CONTENT` merge)注入,`ALPHA_EXT_PRESET_DISABLE` 逃生开关。
5. **Office/PDF 做成「办公套件」、以 MCP 为主**(markitdown 读 + openpyxl 系 Excel-MCP 写 + 自写引导技能),**不裸搬 Anthropic 文档技能**(源码可见、禁止再分发,且依赖 LibreOffice/pandoc 太重)。可再分发的:Anthropic Apache-2.0 example-skills、官方 MCP、markitdown(MIT)、飞书/钉钉/语雀官方 MCP。
6. **create/import 要做**(分期):创建技能/Agent(表单,可接 `skill-creator`)、导入 folder/git-url/npm。
7. **运行时依赖预检** — MCP 装前检 `which uv` / `which python`,缺失诚实提示(不装);MVP 优先 remote-command/sse 可假定运行时的 MCP,避免本地工具链鸿沟。
8. **IPC 安全边界(防逃逸+配置注入)**:写路径白名单(仅 ~/.opencode,realpath 防符号链接)、字段白名单(仅 mcp[*] 白名单字段)、命令白名单(uv/node/python/bun + /opt/homebrew/bin/*)、URL 白名单(仅 https,开发模式允许 localhost)、token 不硬编码(走 keychain,占位)。
9. **MVP 收窄为 MCP-first 连接器**:初稿全量(skill/agent/plugin/mcp)被 Round2 指出过度工程(~11 组件+12 实体→冲突薄定制层 <5%);v2 删引擎后 MVP 仅 MCP 楔子(浏览+一键装+持久+toggle+依赖预检,内置 3-5 条);skill/plugin/create/import 整体降级 V1+ roadmap。**先验证"有人用 MCP"再扩**,避免返工。

## 后果
- ✅ 把死胡同入口升级为 MCP 优先的完整扩展楔子;零改 upstream(北极星 = 冲突 0 不破);不靠 `experimental.*`(NON_GOALS#4)、不绕 SDK(#5);属"薄定制层"(从初稿 ~11 组件+12 实体砍到 v2 ~5 组件+3 核心实体)。
- ✅ 复用既有 `injectAlphaConfig` 注入接缝做预设;SDK 真相源(mcp.status)代替持久存储;MCP 一键装可免重启;零新工程成本(IPC+CLI 复用)。
- ✅ **v2 瘦身成果**(经 design-arch Round2):删 electron-store → SDK 真相源;删 InstallJob/queue → UI 临时状态;删自建引擎(C6–C9) → CLI addMcpToConfig 复用;删 skill/plugin/create 进 MVP → 整体降 V1+ roadmap;改全屏 Portal → 覆盖内容区(z 序/focus 冲突化解)。
- ⚠️ "MCP catalog/镜像感知安装"是净新增维护面(对策:先内置 3-5 条、小而精);plugin 装包需重启 + 中国区 egress(对策:内置资源 + V2 npmmirror);新增主进程 IPC 写 config = 新攻击面(对策:§4 的路径/字段/命令/URL 白名单)。
- 🔭 待 plan-review 确认:① MVP 是 MCP-first(本设计)还是全量;② Agent/Command 进市场 tab 否;③ F9 串台默认开关;④ 远程 catalog 是否依赖 alpha-web(C)。
- 修订:2026-06-22 经 design-arch Round1/Round2 瘦身,产出权威设计 `docs/designs/2026-06-22-arch-extension-hub.md`(v2)。
- 修订:2026-06-23 — 核实实现已超本 ADR 所述 MVP:**create skill/agent 表单 + plugin 安装实际已发**(commit `59c0786`,非"降级 V1+ roadmap")。本次补齐 V1+ roadmap 的 **builtin-skill 安装(E1b)**:`resources/skills/<key>` 资产 + electron-builder `extraResources` + 主进程 `installBuiltinSkill`(按 `builtinAssetKey` 复制进用户 scanned skills 目录,白名单+防逃逸)+ IPC/preload/渲染层全链路;种 2 条 alpha 自写 MIT 技能(`alpha-upstream-sync`/`safe-refactor`)。官方 4 条 Apache-2.0 仍待内容打包(现诚实失败,非占位)。详见 `docs/harness-extension-backlog.md` 的 E1b。
