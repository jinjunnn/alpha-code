# 术语表(GLOSSARY)

> 防 AI 幻觉术语。领域特有 / 项目内部 / 英文缩写 / 易引歧义的词都写这里。

## 业务域术语
- **alpha-code** — 本项目。基于 opencode 的 Mac 编码 agent 产品(面向多用户 + 云多租户);**后端**薄定制层 + **前端**全面接管(ADR-016)、opencode 上游源码只读,云平台为独立运行时(见 ADR-010/011)。
- **opencode** — 上游基座(`anomalyco/opencode`),Bun+TS+Effect+SolidJS 的 AI 编码工具 monorepo(27 包)。本仓库是其 **fork**(非 submodule;ADR-005),经 `merge dev → alpha` 追平上游、无 pinned commit。
- **隔离接缝(isolation seam)** — opencode 官方提供、可在不改源码下扩展的入口:plugin hooks、`.opencode/*` 文件、MCP、SDK 驱动的前端。
- **定制中心(Extension Hub)** — alpha 自有的扩展管理界面(`ui-mac` renderer),浏览/安装/管理五类扩展:连接器(MCP)/技能(skill)/Agent/插件(plugin)/套件(bundle),外加云能力与自动化(REQ-020/021,规划中)。v3 起全类型通用化(ADR-014 v3 / REQ-018)。
- **插件(plugin) vs 套件(bundle)**(易混,D4 拍板澄清)— **插件** = opencode 引擎插件(hooks + 自定义工具的 JS 模块),**装不了** skill/agent;**套件** = alpha 自定义的组合安装清单(可含 MCP+skill+plugin+agent,安装时扇出)。与 Claude Code「plugin=大礼包」心智不同,勿混。
- **安装账本(install receipts)** — `~/.alpha/installs.json`(全局)/ `<项目>/.alpha/installs.json`(项目)记录 alpha 装了什么(id/type/scope/version/files/configKey)。定制中心「已安装」真相 = **receipts ⨝ SDK**(receipts 说装了什么、SDK 说引擎认了什么);差集 = 待重载态。见 `alpha-installs.ts`。
- **免重启生效(dispose 重载)** — 安装/卸载 skill/agent/plugin 后,调上游 `POST /instance|global/dispose` 使引擎实例惰性重建重扫,**当前会话下一条消息即可用**,无需重启 app(引擎无文件监听,写盘 ≠ 生效;dispose 是唯一免重启接缝)。见 ADR-014 v3。
- **`.opencode` 桥(symlink bridge)** — `.alpha` 是 alpha 安装物真源,引擎不扫 `.alpha`,故在引擎原生扫描的 `.opencode/<类>` 放 symlink 指回 `.alpha`;用户视角一切在 `.alpha`,引擎照常发现。REQ-004 实证。见 `alpha-bridge.ts`。
- **薄定制层** — **仅指后端**:alpha 后端自有代码应远小于 opencode 体量(目标 < 5%),只经接缝叠加、不改上游源码。**前端不再适用**——ADR-016 起前端由 alpha 全面接管(厚定制层),见 [[前端接管]]。

## 技术栈术语(opencode 侧,会在设计/实现里频繁出现)
- **`@opencode-ai/sdk`** — 由 server OpenAPI 生成的 HTTP/SSE 客户端(v1 `/…` + v2 `/api/*`)。**前端与外部客户端访问后端的唯一稳定契约**。公开 MIT。
- **`@opencode-ai/plugin`** — 插件/hook 类型契约包。server 插件签名 `(input, options) => Hooks`。公开 MIT。
- **`.opencode/`** — 项目级扩展目录:`tool/`、`plugin(s)/`、`agent/`、`command/`、`skill/`、`theme/`、`opencode.jsonc`。运行时自动发现。
- **Hooks** — 插件可挂的回调:稳定的 `tool/event/config/auth/provider/chat.*/permission.ask/tool.execute.*/tool.definition/shell.env`,以及 unstable 的 `experimental.*`。
- **`AppInterface`** — `packages/app/src/app.tsx` 导出的渲染器挂载入口(props:`defaultServer/servers/router/...`)。B 方案的接入点。
- **`Platform`** — `packages/app/src/context/platform.tsx` 的 host 能力接口(~40 方法:通知/选择器/更新器/存储/剪贴板/fetch…)。自有外壳实现它即可。
- **sidecar** — 自有的独立 HTTP 进程(Hono/Bun),用于提供 opencode server 没有的接口;内部经 SDK 调 opencode。也指 desktop 内嵌 opencode server 的子进程。**桌面单机下 Electron main-IPC(`*-ipc.ts` + `window.api`)即其等价物**(承载 alpha 自有 HTTP/RPC 能力的进程边界,免本地端口/鉴权);真 HTTP sidecar 仅在出现非 renderer 客户端需求时才建(见 ADR-002 修订 C8)。
- **System Context** — opencode 注入给模型的结构化上下文(见 `opencode/CONTEXT.md`);其 registry 不对外开放,自定义注入走 `experimental.chat.*.transform`。
- **~~submodule pin~~**(已废,ADR-005 fork pivot)— 原"钉死 opencode commit"概念;fork 模型下升级 = `git merge dev`,**无 pin**。

## 缩写
- **ADR** — Architecture Decision Record(架构决策记录,见 DECISIONS.md)。
- **SSE** — Server-Sent Events;opencode 的实时事件单条流 `GET /api/event`。
- **PTY** — 伪终端;opencode 唯一用裸 WS 的地方(每终端一条)。
- **B+A** — 前端方案:复用 AppInterface(B)+ token 换肤(A)。

## 避免使用的词
- **~~用户~~** → 用具体画像("power user 终端 / **非技术用户(小白)** / 租户 / 平台运营者");pivot 后不再特指"作者本人"。小白自 2026-07-05(REQ-008 D3)为正式画像,分期服务(文档先行 → REQ-026)。
- **~~改 opencode~~** → 必须明确是"改 `.opencode/` 配置(可)"还是"改 `opencode/packages` 源码(禁)"。

## 外部术语
- Effect (v4) — opencode 内部的 TS 函数式运行时框架。见 github.com/Effect-TS/effect-smol。
