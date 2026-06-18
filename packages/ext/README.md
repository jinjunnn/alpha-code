# @alpha-code/ext

alpha-code 的**后端隔离扩展**:零改 opencode 源码的 server plugin + 自定义 tools(`alpha_echo` / `alpha_ping` + event hook)。对应 GOALS#G1。

## 为什么必须 bundle(ADR-006)

桌面端的 opencode server 跑在 **Electron 的 Node** 里。Node 能 type-strip `.ts`,但**不会**把源码里的 `./tool.js` 重映射到 `./tool.ts`。而 `@opencode-ai/plugin` 只发 TS 源、且内部用 `.js` 写法 —— 直接交给 Node 加载会 `ERR_MODULE_NOT_FOUND` 崩溃。

所以本包**必须先打包成自包含的 ESM**(把 `@opencode-ai/plugin` 和它带的 zod 内联进一个 `.js`),运行时只交给 Node 一个已解析完的 JS。详见 `.claude/rules/DECISIONS.md` 的 **ADR-006**。

- 源码:`src/plugin.ts`(用 `@opencode-ai/plugin` 的 `tool()` 写工具,`workspace:*` 解析)
- 产物:`dist/plugin.js`(`bun build --target node --format esm`,见 `scripts/build.ts`)
- `package.json` 的 `exports`:`types` 走源码、`default`(运行时)走 `dist/plugin.js`

## 构建

```bash
bun run build          # → dist/plugin.js(自包含)
```

`ui-mac` 的 `predev` / `prebuild` 已自动先跑本包的 `build`,所以 `bun --cwd packages/ui-mac run dev`(或 `package:mac`)时 `dist/` 总是最新的。

## 怎么加载(G1,尚未接线)

opencode 的 `plugin[]` 配置吃**本地绝对路径 / `file://`**(见 `packages/opencode/src/config/plugin.ts`),且支持用 `OPENCODE_CONFIG_CONTENT` 环境变量整段注入配置(见 `config/config.ts`)。两条路:

1. **临时手测**:在全局 `~/.config/opencode/opencode.jsonc` 加(不进仓库、不碰 upstream):
   ```jsonc
   { "plugin": ["/Users/tide/app/alpha-code/packages/ext/dist/plugin.js"] }
   ```
2. **目标(G1)**:`ui-mac` 的 `sidecar.ts` 在启动时注入
   `OPENCODE_CONFIG_CONTENT='{"plugin":["<dist/plugin.js 的绝对路径>"]}'`,从而对**每个项目**生效、零改 opencode 的 `.opencode/`。

### G1 还需补的两件事(本骨架未做)

- **打包进 app**:`electron-builder.config.ts` 当前只收 `out/**` 与 `resources/**`,没收 `packages/ext/dist`。要在 `.app` 里运行,需把 `dist/plugin.js` 复制进 `resources/`(或 `extraResources`),并让注入的路径指向 app 内的实际位置。
- **校验 zod 跨实例**:server bundle 自带一份 zod,本插件 schema 是**另一份实例**。接线后必须验证:加载 ext → `alpha_ping` 出现在工具列表**且能 execute**。若 opencode 的工具摄取对 schema 做了 `instanceof` 判定,可能需要换 schema 表达方式。

## 纪律

只新增本包文件 + `ui-mac` 自有文件,**零改 opencode 源码**;`dist/` 是构建产物(`.gitignore`)。
