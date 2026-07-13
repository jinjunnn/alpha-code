# 理解 opencode(为 alpha-code 制图)

> 产出方式:克隆 `anomalyco/opencode@7efade2` → 10-agent 并行 cartography 工作流(读全部 27 包,105 万 token)+ 主 Claude 独立复核关键文件。
> ⚠️ 本图谱产出于 `7efade2` 快照;本仓现为 **fork** 并已 `merge dev` 追平上游(ADR-005),下文「submodule / 源码构建依赖」措辞按 fork 理解。分层/接缝模型仍有效。
> 视觉总图:`docs/architecture/diagrams/opencode-codegraph.svg`(D2 源 `opencode-codegraph.d2`)。

## 一张图看懂:5 层 + 一根脊柱
```
扩展层  @opencode-ai/plugin (server+TUI hooks, tool())   .opencode/*(agents/cmds/tools/skills/themes)
契约层  @opencode-ai/sdk(生成的 HTTP/SSE 客户端 v1/v2) ← 前端与外部客户端访问后端的唯一入口
后端    core(Effect 运行时:会话/工具/上下文/catalog) → server(Effect HttpApi /api/*) → opencode(运行时+CLI,plugin loader,内嵌 server) ; llm
前端    ui(SolidJS 组件+token 主题) → app(渲染器:路由/store/SSE/WS) → desktop(Electron 外壳,sidecar 内嵌 opencode)
基础设施  effect-*-sqlite + http-recorder
```
**结论**:整个系统只有两个契约会影响 alpha-code —— `@opencode-ai/sdk`(前后端唯一通道)与 `@opencode-ai/plugin`(扩展契约)。盯住这两个版本,其余随便升。

## 关键包职责(cartography 摘要)
| 包 | 角色 | 与 alpha-code 关系 |
|---|---|---|
| `@opencode-ai/core` | Effect-TS、Location 作用域运行时:durable 会话、System Context、Tool Registry、config、catalog、3-hook PluginV2 引擎。**不依赖任何其它 opencode app 包**,真正地基 | 只读,经 SDK/插件间接用 |
| `@opencode-ai/server` | 声明式 Effect `HttpApi`(`/api/*` 路由组),是库不是二进制 | 禁改;新接口走 sidecar |
| `opencode`(运行时+CLI) | 组合根:CLI 分发、config 解析、plugin 加载、进程内托管 server、启动 TUI | submodule 源码构建依赖 |
| `@opencode-ai/sdk` | 由 OpenAPI 生成的 HTTP/SSE 客户端(v1+v2)。前端/外部客户端唯一通道 | **核心契约**,前端依赖它 |
| `@opencode-ai/plugin` | 插件/hook 类型契约。`opencode` 运行时加载并调用 | **核心契约**,后端扩展依赖它 |
| `@opencode-ai/app` | 唯一 SolidJS 渲染器:路由、store、SSE 事件流、PTY WS。只经 SDK 通信 | B 方案复用对象 |
| `@opencode-ai/ui` | 共享 SolidJS 组件库 + token/主题引擎(零硬编码色) | 复用 + token 换肤 |
| `@opencode-ai/desktop` | Electron 外壳 + sidecar;**构建期**内嵌编译后的 opencode(`virtual:opencode-server`) | 复用其外壳模式 |
| `@opencode-ai/tui` | OpenTUI 终端客户端 | 不涉及(只做 Mac desktop) |

cartography 复核出的两个易错点:
1. **desktop→opencode 不是 package.json 依赖**,是**构建期**边界:`electron.vite.config.ts` 把 `virtual:opencode-server` 解析到 `../opencode/dist/node/node.js`,`scripts/prebuild.ts` 先 `cd ../opencode && bun script/build-node.ts`。即 desktop 把编译后的 opencode 当 Electron utilityProcess sidecar 内嵌。
2. **`@opencode-ai/core` 不依赖任何其它 opencode app 包**(只 llm + 三个 infra/storage 包),是真正的下沉地基。

## code-graph 技能(graphify)说明 —— 诚实记录
- 已安装 `graphify`(`safishamsi/graphify`),`/graphify` 已注册到 `~/.claude/skills/`。
- 直接对 opencode 跑 AST 图**效果很弱**:5108 节点只连出 **173 条边**(161 references / 11 inherits / 1 implements),近乎全是孤点。原因:opencode 重度用 Effect + 动态 import + 禁 star/alias import,tree-sitter 静态分析连不出 import/call 图;且其节点 ID 还把包前缀抹掉(`src_account_id`)。
- 因此**本仓库的可靠 code-graph 来自 cartography 工作流,不是 graphify AST**。
- graphify 的真正强项是对**文档**做语义抽取——若要一张 opencode**领域概念图**(基于 `CONTEXT.md` + `.opencode/glossary/` + `specs/`),可后续单独跑 graphify 语义模式,这才是它该用的地方。
- graphify 原始产物在 `graphify-out/`(已 gitignore,可重生)。

## 下一步指向
- 隔离/扩展怎么落地 → `docs/architecture/extension-seams.md`
- 项目目标与硬约束 → `.claude/rules/*`
