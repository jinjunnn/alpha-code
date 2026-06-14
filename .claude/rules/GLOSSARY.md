# 术语表(GLOSSARY)

> 防 AI 幻觉术语。领域特有 / 项目内部 / 英文缩写 / 易引歧义的词都写这里。

## 业务域术语
- **alpha-code** — 本项目。基于 opencode 的个人定制 Mac 编码 agent;薄定制层,opencode 只读。
- **opencode** — 上游基座(`anomalyco/opencode`),Bun+TS+Effect+SolidJS 的 AI 编码工具 monorepo(27 包)。本仓库以 submodule 钉死 `7efade2` 引入。
- **隔离接缝(isolation seam)** — opencode 官方提供、可在不改源码下扩展的入口:plugin hooks、`.opencode/*` 文件、MCP、SDK 驱动的前端。
- **薄定制层** — alpha-code 自有代码应远小于 opencode 体量(目标 < 5%);凡需大改源码即偏离定位。

## 技术栈术语(opencode 侧,会在设计/实现里频繁出现)
- **`@opencode-ai/sdk`** — 由 server OpenAPI 生成的 HTTP/SSE 客户端(v1 `/…` + v2 `/api/*`)。**前端与外部客户端访问后端的唯一稳定契约**。公开 MIT。
- **`@opencode-ai/plugin`** — 插件/hook 类型契约包。server 插件签名 `(input, options) => Hooks`。公开 MIT。
- **`.opencode/`** — 项目级扩展目录:`tool/`、`plugin(s)/`、`agent/`、`command/`、`skill/`、`theme/`、`opencode.jsonc`。运行时自动发现。
- **Hooks** — 插件可挂的回调:稳定的 `tool/event/config/auth/provider/chat.*/permission.ask/tool.execute.*/tool.definition/shell.env`,以及 unstable 的 `experimental.*`。
- **`AppInterface`** — `packages/app/src/app.tsx` 导出的渲染器挂载入口(props:`defaultServer/servers/router/...`)。B 方案的接入点。
- **`Platform`** — `packages/app/src/context/platform.tsx` 的 host 能力接口(~40 方法:通知/选择器/更新器/存储/剪贴板/fetch…)。自有外壳实现它即可。
- **sidecar** — 自有的独立 HTTP 进程(Hono/Bun),用于提供 opencode server 没有的接口;内部经 SDK 调 opencode。也指 desktop 内嵌 opencode server 的子进程。
- **System Context** — opencode 注入给模型的结构化上下文(见 `opencode/CONTEXT.md`);其 registry 不对外开放,自定义注入走 `experimental.chat.*.transform`。
- **submodule pin** — `opencode/` 钉死的 commit;升级即换 pin。

## 缩写
- **ADR** — Architecture Decision Record(架构决策记录,见 DECISIONS.md)。
- **SSE** — Server-Sent Events;opencode 的实时事件单条流 `GET /api/event`。
- **PTY** — 伪终端;opencode 唯一用裸 WS 的地方(每终端一条)。
- **B+A** — 前端方案:复用 AppInterface(B)+ token 换肤(A)。

## 避免使用的词
- **~~用户~~** → 用具体画像("个人 power user / 作者本人")。
- **~~改 opencode~~** → 必须明确是"改 `.opencode/` 配置(可)"还是"改 `opencode/packages` 源码(禁)"。

## 外部术语
- Effect (v4) — opencode 内部的 TS 函数式运行时框架。见 github.com/Effect-TS/effect-smol。
