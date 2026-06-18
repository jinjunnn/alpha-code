---
id: ADR-006
title: 两个运行时世界(bun 源码 vs Electron-Node bundle)— 自有 ext 必须预 bundle
status: accepted
date: 2026-06-15
related: [ADR-002, ADR-003]
---

## 背景
桌面端每条 prompt 服务端 Die:`ERR_MODULE_NOT_FOUND … '/packages/plugin/src/tool.js'`。根因:opencode 有两个运行时世界——server 运行时**动态加载**的生 TS(`.opencode/tool/*.ts`)在 Electron-Node 下 `./tool.js`→`.ts` 不会被重写 → 崩;同一批文件 bun CLI 能跑。

## 决策
1. 心智:构建 / CLI / `bun run dev` 任务运行器 = **bun**;打包后桌面运行时 = **Electron-Node**(跑预编译 node bundle)。
2. **自有 ext(`@alpha-code/ext`、自有 `.opencode/{tool,plugin}`)必须先打包成自包含 ESM JS**(依赖内联),禁止运行时解析生 TS / `.js`→`.ts`。
3. 不把 sidecar 改成独立 bun 进程(会丢 Electron `utilityProcess` 的 IPC/生命周期集成)。
4. 别把 fork / opencode 仓库本身当工作项目打开(带 upstream 维护者的生 TS 工具会 crash)。

## 后果
- ✅ ext 走 bundle 即可桌面加载,且只约束自己产物形态,零改 upstream。
- ⚠️ ext 多一道 build 步(进 predev/prebuild/CI);upstream 工具在桌面崩是其运行时特性,靠"别开该仓库"规避,不写 patch。
