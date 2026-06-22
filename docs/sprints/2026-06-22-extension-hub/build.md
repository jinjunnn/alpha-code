# Build:定制中心(Extension Hub)MVP — 2026-06-22

> /app:build 产物。设计依据:`docs/designs/2026-06-22-arch-extension-hub.md`(v2)+ [[ADR-014]]。
> 范围:用户选定「全量」。本次实现 Phase ①②③⑤⑥;Phase ④(plugin 装包)按计划门控。

## 实现概况
侧栏死胡同「插件」入口升级为「定制中心」覆盖面板:浏览内置 catalog(技能/连接器/插件/套件)、一键安装、创建/导入、已安装管理。精益地基:已安装真相走 SDK(不另起 electron-store),MCP 持久复用 CLI `addMcpToConfig` 思路,零改 opencode 源码。

## 阶段完成度
| 阶段 | 内容 | 状态 |
|---|---|---|
| ① 骨架 | 侧栏正名、移除自动化死占位、i18n(en+zh)、Portal 覆盖面板(ESC/focus)、6 tab、搜索、来源 chip、catalog 读、已安装只读 | ✅ |
| ② MCP 纵切 | 浏览→运行时预检(which uv/node)→`sdk.mcp.add`+`connect`(实时)→主进程写用户 `opencode.jsonc`(原子+.bak+白名单)→toggle/remove | ✅ |
| ③ 技能 | 目录技能安装(写 SKILL.md)+ 创建技能表单 + 导入(写 `~/.config/opencode/skills`) | ✅ |
| ⑤ 套件 | alpha manifest 扇出(MCP+技能项),必选失败计数、可选不计 | ✅ |
| ⑥ 创建 | 创建技能 / 创建 Agent 表单(写 `~/.config/opencode/{skills,agent}`) | ✅ |
| ④ 插件 | npm 装包 + 重启;配置键(plugin/plugins)+ 网络 + 重启待核 | ⏸ 门控「即将推出」 |

## 改动文件
**新增**(全 alpha 自有):
- `src/renderer/extensions/{catalog-types.ts, ext-hub-state.ts, use-extensions.ts, extension-hub.tsx, extension-hub.css, alpha-catalog.json}`
- `src/main/{ext-config.ts, ext-ipc.ts, ext-fs-installer.ts}`

**修改**(全 alpha 自有文件,非 upstream):
- `src/renderer/sidebar/alpha-sidebar.tsx`(入口正名+拆死占位)、`src/renderer/index.tsx`(挂载 `<ExtensionHub>`)
- `src/renderer/i18n/{en,zh}.ts`(`alpha.ext.*` 键)、`src/preload/{index,types}.ts`(`window.api.ext`)
- `src/main/index.ts`(注册 ext IPC)、`package.json`(+`jsonc-parser` 3.3.1)

## 验证
- ✅ **typecheck**:`tsgo -b`(ui-mac)0 错误。
- ✅ **build**:`electron-vite build` 成功(渲染+主+preload 全 bundle;Vite 解析 catalog JSON/CSS、主进程 bundle jsonc-parser)。
- ✅ **北极星**:`git diff opencode/core|server|app|sdk|ui|plugin|tui` = 空(源码零改动)。
- ⬜ **像素截图**:本沙箱无显示捕获 + 无现成 CDP 助手,未做。**未声称视觉已确认**(遵 [[visual-verify-required]])。需在 Mac 上 `bun --cwd packages/ui-mac run dev` 人工核验:① 侧栏显「定制中心」、无「自动化」行;② 点击弹出面板(侧栏保持可见、ESC 关闭);③ 连接器 tab 装 markitdown(装好 uv 时)→「已安装」可见并可 toggle;④ 创建 tab 写技能/Agent。

## DRIFT(后审,内联)
0 🔴。全部落 `packages/ui-mac/*`(ADR-005 只增不改)、读写只走 SDK + 用户 config 文件(ADR-002,无新 server 路由)、IPC 非 HTTP、无 `experimental.*`、安全白名单(ADR-014 §8)。与 v2 设计一致,无新偏离。

## 下一步
- 人工 CDP 截图核验(上)。
- Phase ④ plugin:核 config 键 + npm 镜像 + 重启流程后接线。
- 资产:Apache-2.0 example-skills 真正文打包进 app(当前目录技能安装写的是 frontmatter+指针 stub)。
- 钉钉 MCP / Excel-MCP 选型补入 catalog(去掉 `_verify`)。
- `/app:review` + `/app:qa`。
