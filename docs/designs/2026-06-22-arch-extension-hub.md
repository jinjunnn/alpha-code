---
date: 2026-06-22
type: design
slug: extension-hub-arch
related_rules: [POSITIONING, GOALS, NON_GOALS, ARCHITECTURE, ADR-002, ADR-003, ADR-006, ADR-008, ADR-009]
---

# 权威设计:定制中心(Extension Hub)— MCP 优先 + 零自建引擎

> [!CAUTION]
> **不可变设计记录(2026-07-11 cutover)。** 本文保留 2026-06-22 的设计
> 决策与 alpha-code PR [#2](https://github.com/jinjunnn/alpha-code/pull/2)
> 的实现验收依据；该 v2 方案已被后续 Extension v3/v2 信任底座演进取代，
> §17 checklist 不是当前执行清单，不再回勾。活跃后继由 alpha-code
> [#209](https://github.com/jinjunnn/alpha-code/issues/209)–
> [#212](https://github.com/jinjunnn/alpha-code/issues/212) 与
> [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) 承载。

> **状态**:v2(经 `/app:design-arch` Round1/Round2 多轮对抗后最终设计方案)
> **日期**:2026-06-22
> **配套决策**:[[ADR-014]](../.claude/rules/adrs/ADR-014-extension-hub.md)
> **演进记录**:初稿见 [extension-hub.md](extension-hub.md)(A 步草案);本文为权威设计(v2 瘦身后)
> **北极星对账**:全程**只新增文件** + 写**用户/alpha 自有 config** + 走 **SDK**,零改 upstream → 冲突文件数 = 0 不破

## 0. 执行摘要 vs v1 演进

| 维度 | v1(初稿) | v2(v2 瘦身后) | 原因 |
|------|---------|-----------|------|
| 组件数 | ~11(含 InstallJob/引擎层) | ~5(无自建引擎) | Round2 指出过度工程;MCP.add 既有,改为 live 调 SDK |
| 实体数 | 12 | 3 MVP-core(CatalogEntry/InstallSpec/HubPreference) | 删 InstalledItem/InstallJob 存储,改用 SDK 真相源 |
| 安装引擎 | 自建(C6–C9) | 零自建 | F3 指出 `mcp.add` 既有、只需持久化,用 CLI addMcpToConfig 逻辑 (~30 行) |
| 存储 | electron-store 新增 | 无 | 已安装真相 = SDK(mcp.status),UI 偏好用既有 window.api.store |
| 定制中心 UI | 全屏 Portal(接管导航) | 覆盖内容区 Portal | Round2 指出 z 序/focus 冲突;改为侧栏保持、内容区替换、显式 ESC |
| MVP 范围 | 全量(skill/agent/plugin/mcp) | MCP 连接器优先 | 核心假设"需自建引擎" 已推翻;skill/plugin 降 V1/V2 roadmap;先证有人用再扩 |

**v2 设计哲学**:最小可验证(MVP=一条完整 MCP 装机链路) + 零新工程成本(复用既有 SDK/CLI) + 未来可扩展(roadmap 占位不删,避免返工)。

---

## 1. 需求与约束

### 问题陈述
侧栏「插件」入口(`packages/ui-mac/src/renderer/sidebar/alpha-sidebar.tsx:494`)只触发 `command.trigger("mcp.toggle")`,打开的是 opencode 的 MCP 连接开关对话框 —— **名不副实**(写"插件",实际只开关 MCP),且不覆盖 skill/agent/command/plugin;「自动化」(:498)是空 onClick 死占位。

### 目标
升级为「**定制中心**」—— 可视化扩展市场 + 管理面,让用户浏览、一键安装、创建、导入**技能 / 连接器(MCP) / 插件 / 套件**,并管理已安装项。对标 Claude Directory、OpenAI Codex「插件」、腾讯 WorkBuddy「技能市场」。

### 非目标
- 多租户/团队共享市场(本地产品侧)
- 云端执行(归 alpha-platform)
- 重写 opencode 的 skill/agent 引擎
- MVP 里包含 skill/plugin/create/import(这些都挪到 V1+ roadmap)

---

## 2. 关键事实底座(硬约束,决定架构)

| # | 约束 | 源码验证 | 设计含义 |
|----|------|---------|---------|
| **F1** | **opencode plugin 不是"伞"** — PluginV2 仅 3 个 hook(`catalog.transform`/`aisdk.language`/`aisdk.sdk`),无法打包 skill+command+agent+mcp | `packages/core/src/plugin.ts:23-48` | 套件(bundle)**必须 alpha 自建 manifest**;装时扇出成多个原子安装 |
| **F2** | **全平台无内置 marketplace/registry**,也无默认远程 skill 源 | `skill/discovery.ts`(无硬编码源)、全仓 grep 无 registry | **目录(catalog)我们自备**;内置进 app(离线优先) |
| **F3** | **MCP `POST /mcp`(SDK `mcp.add`)只在内存生效、不落盘**;仅 CLI `mcp add` 写 config | `server/.../handlers/mcp.ts`、`cli/cmd/mcp.ts:430-443`(addMcpToConfig 用 jsonc modify) | 持久化要**自己写 user config**;实时用 `mcp.add`+`connect`(无需重启) |
| **F4** | **skill 无 HTTP 安装** — 写文件到被扫描目录,或加 path/URL 到 config `skills[]`(string[]);远程 = 取 index.json({ skills:[{name,files[]}]}) | `config.ts:89`、`skill/index.ts`、`skill/discovery.ts` | skill 安装 = 主进程写文件或加 config 项 |
| **F5** | **plugin 安装 = 写 config `plugins[]` + npm/bun install + 重启**;无 HTTP add | `config/plugin.ts:5-13`、`plugin/loader.ts` | plugin 走"写 config + 装 + 提示重启"(MVP 不做) |
| **F6** | **agent/command 安装** = 写 `.opencode/agent|command/*.md` 或 config;无 HTTP add | `config/plugin/{agent,command}.ts` | create/import 走文件写(MVP 不做) |
| **F7** | **读取侧 SDK 齐全**:`sdk.{skill,agent,command}.list`、`sdk.mcp.status`、`sdk.tool.list` | `packages/sdk/js/.../sdk.gen.ts` | 「已安装」页数据来源;本地真相源 |
| **F8** | **既有注入接缝**:`sidecar.ts → injectAlphaConfig()` 经 `OPENCODE_CONFIG_CONTENT` **merge 注入**(不覆盖用户配置),现已注入 identity/模型/mcp.cloud;注释明示"将来挂 plugin:[]" | `packages/ui-mac/src/main/sidecar.ts:111-156` | **出厂预设**(默认技能目录/MCP/插件)从这里注入;新增 mcp[] 也走这口子 |
| **F9** | **互操作扫描**:opencode 默认扫 `~/.claude/skills` + `~/.config/opencode/skills`(全局,与 cwd 无关);可用 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` 关闭 | `skill/index.ts:21-23,185-203`、`effect/runtime-flags.ts:21,27-29` | 分发前决定是否默认关闭"串台",避免扫到用户机上无关技能(open 问题) |

### Office/PDF 调研结论(复用初稿)

Anthropic 的 `docx/xlsx/pptx/pdf` 技能是**源码可见、禁止再分发**(`document-skills/*/LICENSE.txt`),且依赖重(xlsx→LibreOffice、docx→pandoc/node、pdf→python 系)。其 `example-skills`(skill-creator/mcp-builder/canvas-design/theme-factory 等)为 **Apache-2.0,可再分发(附 NOTICE)**。

**可直接搬**:Apache-2.0 example-skills、官方 MCP、markitdown(MIT)、飞书/钉钉/语雀官方 MCP。
**不可搬**:Anthropic docx/xlsx/pptx/pdf。

---

## 3. 候选方案与推荐

### UI 落点(A vs B vs C)

| 选项 | UI 形态 | 优点 | 缺点 | 结论 |
|-----|--------|------|------|------|
| **A 全屏 Portal** | Portal 投到 document.body,接管全屏导航 | 独立完整、可迭代 | z 序/focus 冲突(侧栏/回顶栏/对话框);侧栏隐;复杂 | ✅ **A(v2 修订为覆盖内容区)** |
| **B 独立路由页** | Router 新增 `/extensions`(b64 路径解码) | 自然、符合 SPA | 踩 upstream router upgrade 雷区;ADR-008 侧栏就是 Portal,二者路由冲突 | ❌ 弃 |
| **C 对话框** | Modal/Dialog(opencode 既有) | 最轻 | 界面天花板低;无全屏空间 | ❌ 弃 |

**v2 修订**:A 改为**覆盖内容区**(侧栏保持可见,不动 body[data-alpha-sidebar]),ESC/focus trap 显式,避免 z 序冲突。

### 安装引擎落点(D vs E)

| 选项 | 后端 | 优点 | 缺点 | 结论 |
|-----|------|------|------|------|
| **D Electron 主进程 IPC** | utilityProcess(现状 sidecar) | 无新 HTTP 进程(守 ADR-002/006);集成 UI/生命周期 | 安全边界(写路径校验) | ✅ **D** |
| **E 新起 Hono sidecar** | 独立 HTTP | 隔离清晰 | 丢 utilityProcess 集成;多攻击面;重复工程(SDK 已有) | ❌ 弃 |

**推荐**:D(Electron IPC),新增一个薄 IPC 方法 `ext.persistMcp`(写 config)。

### MVP 范围(全量 vs MCP-first)

v1 初稿设想"立即实现全量",被 Round2 对手指出:
- 核心假设"**需自建安装引擎才能装 MCP**"已推翻 — F3 说 SDK 有 `mcp.add`、持久化仅需复用 CLI ~30 行
- 全量前期组件 10+、实体 12 个 → 触发"薄定制层 <5%"天花板 + "不另起主存储"约束
- 应**先证有人用再扩** → **MVP 收窄为 MCP 连接器全链路**;skill/plugin/create/import 降级 V1/V2 roadmap

**推荐**:MVP = MCP 优先(浏览+一键装+持久+toggle+依赖预检),内置 3-5 条 MCP。

---

## 4. 推荐方案详解 & 理由

### A + D + MVP(MCP-first)方案

**定制中心 UI(A 修订)**:
- 形态:Portal 覆盖内容区(不全屏、侧栏保持、不改 body[data-alpha-sidebar])
- 入口:侧栏「定制中心」按钮替换现有"插件"(494)
- 返回:显式 ESC 或 focus trap 返回侧栏
- 内部 IA: MVP 只有 **推荐(着陆)** / **连接器** / **已安装(+启停)** 三个 tab;skill/plugin/create 留给 V1+ roadmap

**安装引擎(D)**:
- 读取侧:100% SDK(mcp.status join catalog)
- 实时侧:sdk.mcp.add + connect(不落盘,当场可用)
- 持久侧:**唯一新 IPC** → `window.api.ext.persistMcp({name, server})`(context bridge,main → ext-config.ts)
  - ext-config.ts:写用户 opencode.jsonc 的 mcp[name]
  - 策略:原子写 + .bak 备份 + 回滚
  - 复用:CLI `addMcpToConfig` 的 jsonc append 逻辑(~30 行,不重造)

**零自建工程成本**:
- 不写 InstallJob/InstallQueue/引擎
- 不新增数据库/electron-store
- 依赖预检:轻量脚本检 uv/node/python(MVP 优先 remote-command 可假定运行时的 MCP)

**出厂预设**:经既有 F8 的 `injectAlphaConfig`(OPENCODE_CONFIG_CONTENT merge),注入 mcp[]。`ALPHA_EXT_PRESET_DISABLE` 逃生开关(沿 ADR-009 风格)。

---

## 5. 组件清单(v2,~5 个新增,全落 packages/ui-mac/*,零改 opencode/packages)

### C1: 定制中心主面板

**`renderer/extensions/extension-hub.tsx`** — Portal 覆盖面板 UI
- Props:catalog/mcp.status/loading/onAddMcp/onToggleMcp/onClose
- 三 tab:推荐(内置精选/热门)/ 连接器(catalog 过滤 type:mcp)/ 已安装(sdk.mcp.status join catalog 列)
- 卡片网格:icon + 名 + 一行描述 + 【添加|已装✓齿轮】
- 搜索 + 来源 chip(官方/社区/自建)
- 沿用现有 sidebar.css token,与 V2 chrome 协调

### C2: 状态/API 钩子

**`renderer/extensions/use-extensions.ts`** — SDK 驱动的状态钩子(必须用 `/v2/client` 子路径!)
- 读:sdk 实例→ `client.mcp.status()`(SSE 监听 mcp 变化)
- 合并:SDK 结果 + 内置 catalog + 去重
- 写:sdk 实例→ `client.mcp.add({name, server})` + `client.mcp.connect(name)`
- 依赖预检:轻量脚本 bash 检 `which uv` / `which node` / `which python`

**注意**:必须 `/v2/client` 不能 `/v2` barrel(后者含 Node-only 依赖会崩 renderer)。范式复刻 `use-projects.ts`(SSE client pattern)。

### C3: 目录与预设

**`renderer/extensions/catalog-types.ts`** — 数据类型定义
```typescript
interface CatalogEntry {
  id: string;           // "markitdown-mcp"
  type: "mcp" | "skill" | "plugin" | "agent" | "command"; // MVP 只用 mcp
  name: string;         // "markitdown"
  displayName: string;  // "Markitdown 文档阅读器"
  description: string;  // 一行描述
  category: "office" | "research" | "design" | "dev" | "productivity"; // roadmap: 分类导航
  source: "official" | "community" | "self";
  license?: string;     // "MIT", "Apache-2.0"
  redistributable?: boolean; // 是否可再分发
  iconUrl?: string;
  
  // MVP-core for MCP:
  installSpec: MCPInstallSpec;
  
  // Roadmap(虚线):
  bundleItems?: string[]; // 套件内含条目 id 数组
}

interface MCPInstallSpec {
  mcpType: "stdio" | "sse" | "remote-command";
  command?: string[]; // ["uv", "run", "markitdown-mcp"]
  url?: string;       // "https://..."(sse 模式)
  headersTemplate?: Record<string, string>; // oauth 令牌占位
  requiredEnvVars?: string[]; // ["GITHUB_TOKEN"] → 预检或提示
  runtimeDep?: { tool: "uv" | "node" | "python"; minVersion?: string }; // 依赖预检
  mirrorCommand?: string[]; // 弱网时重试,如 ["npmmirror", "run", "..."]
}

interface HubPreference {
  activeTab: "featured" | "connectors" | "installed" | "created";
  hiddenCatalogIds: string[];  // 用户隐藏的条目
  disableClaudeCodeSkillsScan?: boolean; // F9 决策,初始 undefined(跟随 env)
}

// MVP-core 三概念;以下 roadmap(虚线):
// interface InstalledItem { ... } // 仅当 V1/V2 证明需要持久层
// interface InstallJob { ... }   // 进度/状态机,改用 UI 临时状态代替
```

**`resources/alpha-catalog.json`** — 内置目录(MVP 3-5 条 MCP)
```json
{
  "version": "1.0",
  "entries": [
    {
      "id": "markitdown-mcp",
      "type": "mcp",
      "name": "markitdown",
      "displayName": "Markitdown 文档阅读器",
      "description": "读取 Office/Markdown/PDF 文档内容(MIT 许可)",
      "category": "office",
      "source": "official",
      "license": "MIT",
      "redistributable": true,
      "installSpec": {
        "mcpType": "stdio",
        "command": ["uv", "run", "markitdown-mcp"],
        "runtimeDep": { "tool": "uv", "minVersion": "0.4.0" },
        "mirrorCommand": ["npmmirror", "run", "markitdown-mcp"]
      }
    },
    // ... 2-4 more MCPs
  ]
}
```

### C4: Preload/IPC 定义

**`preload/index.ts`** — 追加 contextBridge(不改既有)
```typescript
contextBridge.exposeInMainWorld('api', {
  ...existingApi,  // 既有方法保留
  ext: {
    // 唯一新增
    persistMcp: (spec: { name: string; server: Record<string, any> }) => 
      ipcRenderer.invoke('ext:persist-mcp', spec),
  },
});
```

**`preload/types.ts`** — 追加类型
```typescript
declare global {
  interface Window {
    api: {
      // ...existing
      ext: {
        persistMcp: (spec: MCPServerSpec) => Promise<void>;
      };
    };
  }
}
```

### C5: 主进程持久化

**`main/ext-config.ts`** — 薄 IPC 处理器,jsonc 写 config(复用 CLI 逻辑)
```typescript
// ipcMain.handle('ext:persist-mcp', async (event, spec) => { ... })
// 职责:
// 1. 读 ~/.opencode/opencode.jsonc(或创建)
// 2. 原子写 mcp[spec.name] = spec.server
// 3. .bak 备份(写失败或后续 connect 失败时回滚)
// 4. 内联校验:mcp[*].name ∈ white-list / server.command[0] ∈ safe-tools
// 5. 返回 ok | error

// 校验逻辑(防逃逸):
// - 写路径只能在 ~/.opencode/,realpath 去符号链接后检查
// - server.command[0] 白名单:[uv, node, python, bun] + 绝对路径 /opt/homebrew/bin/* 等
// - server.url → https 白名单(no http://,no localhost 除非开发模式)
// - requiredEnvVars 里的值不能是裸 token,走 keychain(未来补)
```

---

## 6. 数据模型与存储设计

### MVP-Core 概念(实线)

**CatalogEntry**:只读内置条目
- 包含:id / type / name / displayName / source / category / license / redistributable / installSpec(union type,MVP 仅 mcp 分支)
- 来源:alpha-catalog.json(可选增量刷新 alpha-web)
- 生命周期:app 打包时内置,运行时只读(可缓存到 localstorage 加速)

**InstallSpec**:安装配置(union type)
```typescript
type InstallSpec = 
  | { mcpType: 'stdio'; command: string[]; runtimeDep?; ... }
  | { mcpType: 'sse'; url: string; headersTemplate?; ... }
  | { mcpType: 'remote-command'; ... }
  // skill/plugin/agent 分支留给 V1+
```

**HubPreference**:用户偏好(持久化到既有 window.api.store,非新存储)
- activeTab:当前 tab
- hiddenCatalogIds:用户隐藏的条目(「已安装」可 hide/unhide)
- disableClaudeCodeSkillsScan:跟随 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS env 或用户手动改

### Roadmap 概念(虚线,暂不实现)

**InstalledItem**(仅当 V1/V2 证明需要持久层):
- 记录:id / installedAt / version / enabled / config
- 现状:用 SDK 真相源(mcp.status / skill.list / agent.list)代替
- 缘由:installer 无状态、不需"装中断恢复"

**InstallJob**(进度状态机):
- 暂用 UI component state 代替(无需持久化)
- 用"诚实话术":success / error / pending / needs_oauth(后续补)

### 已安装真相源

| 类型 | 真相源 | 查询方法 |
|------|--------|---------|
| MCP | SDK mcp.status | `sdk.mcp.status()` → { [name]: { enabled, url, ... } } |
| Skill | SDK skill.list | `sdk.skill.list()` |
| Agent | SDK agent.list | `sdk.agent.list()` |
| Command | SDK command.list | `sdk.command.list()` |

**Join 关键字**:mcp.status 的 key(name) 与 catalog entry 的 id 匹配,deduplicate。

---

## 7. 关键流程

### Flow 1:装 MCP(MVP 核心,免重启)

```
用户点【添加】
  ↓
UI 调 onAddMcp(catalogEntry)
  ↓
→ sdk.mcp.add({ name, server: installSpec })
  ↓
→ window.api.ext.persistMcp({ name, server })
  ├─ Main IPC:ext-config.ts
  ├─ 读 opencode.jsonc
  ├─ 写 mcp[name]
  ├─ .bak 备份
  └─ 返回 ok | error
  ↓
若写失败:Toast 提示 + 不调 connect
若写成功:
  ├─ sdk.mcp.connect(name)
  └─ UI 刷新列表(sdk.mcp.status SSE 自动推)
  ↓
用户可即刻在会话用该 tool
  ↓
下次启动自动加载(opencode.jsonc 持久化)
```

(详见 docs/diagrams/03-flow-install-mcp.svg)

### Flow 1b:装 MCP 失败+回滚

```
connect 或用户反馈失败
  ↓
从 .bak 还原 opencode.jsonc
  ↓
sdk.mcp.disconnect(name) 可选(看 opencode 是否支持)
  ↓
用户重新调试(补环境变量 etc) → 重试
```

(详见 docs/diagrams/03-flow-install-mcp-rollback.svg)

### Flow 2:装套件(Roadmap,扇出)

```
用户点「办公套件」【添加】
  ↓
UI 解析 bundle manifest({ items: ["markitdown-mcp", "excel-mcp", "office-guide-skill"] })
  ↓
逐项原子安装(F1 理由:不能一个 plugin 包多件)
  ├─ markitdown-mcp → Flow 1
  ├─ excel-mcp → Flow 1
  └─ office-guide-skill → Flow 4(skill 安装)
  ↓
汇总结果:
  ├─ 全成功 → 提示「办公套件已添加」
  ├─ 部分失败 → PartialSuccess 对话框列失败项
  └─ 全失败 → 提示 + 可重试
```

(详见 docs/diagrams/03-flow-bundle.svg)

### Flow 3:装 Plugin(Roadmap,需重启)

```
用户点插件条目【添加】
  ↓
UI 下载 package.json / 验证 manifest
  ↓
→ window.api.ext.addPlugin({ name, packageOrUrl })
  ├─ Main:读 config → 写 plugins[]
  ├─ 运行 bun/npm install(镜像感知)
  └─ 返回 ok | pending_restart
  ↓
若成功:UI 提示「已安装,请重启以加载」
  ↓
用户点「重启」
  ├─ app.relaunch()
  └─ Config.ts:174 重读 config(缓存清除)
  ↓
新进程加载新 plugin
```

(详见 docs/diagrams/03-flow-plugin.svg)

### Flow 4:装 Skill & Create(Roadmap)

```
导入或创建:
  ├─ 导入 folder/git-url → 校验 SKILL.md → 拷 to ~/.opencode/skills/alpha-skills/<name>/
  ├─ 创建 skill(表单) → 生成 SKILL.md → 写同路径
  └─ 可选接 anthropic/skill-creator 做 AI 辅助编写

重扫:
  ├─ opencode discovery 自动扫 ~/.opencode/skills
  └─ UI sdk.skill.list() 更新
```

---

## 8. 预设清单(复用初稿 §5)

### 内置精选(MVP 着陆 tab)

| 类别 | 项目 | 说明 | License |
|------|------|------|---------|
| **Office** | markitdown-mcp | 文档读取(Word/Excel/PDF) | MIT |
| **Research** | fetch-mcp | HTTP 工具集 | MIT(官方) |
| **Dev** | git-mcp | Git 操作 | MIT(官方) |

(MVP 3 条;可扩至 5 条)

### V1 套件预设(roadmap)

| 套件 | 内含 | License |
|-----|------|---------|
| **办公套件** | markitdown-mcp + openpyxl-excel-mcp + office-skill(自写) | MIT + MIT + alpha |
| **研究套件** | fetch-mcp + filesystem-mcp + deep-research-skill | MIT(官方) + alpha |
| **设计套件** | figma-mcp + canvas-design-skill(Apache-2.0) + theme-factory(Apache-2.0) | 复合 |
| **开发套件** | git-mcp + github-mcp + mcp-builder(Apache-2.0) | 官方 + Apache-2.0 |

### V2 中国本土(roadmap)

| 套件 | 内含 | 说明 | License |
|-----|------|------|---------|
| **飞书套件** | larksuite 官方 MCP | 文档/日程/任务 | 飞书 License |
| **钉钉套件** | open-dingtalk 官方 MCP | 工作台/消息 | 钉钉 License |
| **语雀套件** | yuque 官方 MCP | 知识库 | 语雀 License |

> **Office/PDF 关键澄清**:Anthropic 的 document-skills(docx/xlsx/pdf)源码可见、禁止再分发,故**不拿直接搬**;改为以 MCP 为主(markitdown 读 + openpyxl 写 + 自写引导)。

---

## 9. 依赖预检(运行时可用性检验)

### 预检逻辑(轻量 bash 脚本)

MCP InstallSpec 含 runtimeDep 时,装前检一遍:

```bash
checkRuntimeDep({ tool: "uv", minVersion: "0.4.0" }) {
  if ! which uv; return { ok: false, reason: "uv 未安装" };
  if uv --version < 0.4.0; return { ok: false, reason: "uv 版本过低" };
  return { ok: true };
}
```

### 失败处理(诚实话术)

```
【markitdown】
未满足依赖:uv ≥ 0.4.0(当前无)
💡 install:
   brew install uv
   或 pip install uv

【本地 MCP】local-command 类型需运行时
若依赖缺失,状态显示:🔴 需要安装 uv
用户手动补 → 重启或「重新连接」
```

**不做**:自动下载/安装工具(防 disk spam + 权限混乱)。

---

## 10. 安全边界(Electron IPC 写 config)

### 威胁模型

D 方案(Electron IPC)引入新攻击面:主进程收用户输入写 config 文件。

### 防护策略

#### 路径白名单(防逃逸)
```typescript
const SAFE_WRITE_DIRS = [
  path.join(process.env.HOME!, '.opencode'),  // config
  path.join(process.env.HOME!, '.opencode/skills'), // alpha-skills
];
// 校验:realpath(targetFile).startsWith(SAFE_DIR)
```

#### 字段白名单(防 config 注入)
```typescript
// 仅允许写 mcp[name] = { command, url, env, ... } 白名单字段
const SAFE_MCP_FIELDS = ['name', 'command', 'url', 'env', 'disabled'];
// 其它字段拒绝
```

#### 命令白名单(防任意执行)
```typescript
const SAFE_COMMANDS = ['uv', 'node', 'python', 'bun', '/opt/homebrew/bin/*'];
// server.command[0] 必须匹配
```

#### URL 白名单(防 SSRF)
```typescript
// 仅 https://;开发模式可临时允许 localhost
if (!url.startsWith('https://') && !isDev) {
  throw new Error('Only HTTPS URLs allowed');
}
```

#### Token 安全(未来补)
- headersTemplate 不应含硬编码 token
- 改用 keychain / platform.getCredential() 运行时注入(占位)

---

## 11. Skeptic 致命追问 + 回应

### Q1:"需自建安装引擎才能装 MCP"

**假设**:v1 初稿认为必须从零造 InstallJob/队列/重试逻辑。

**反驳**(Round2 对手):F3 明确说 SDK 有 `mcp.add`,只是不落盘。持久化仅需复用 CLI `addMcpToConfig` 逻辑(~30 行 jsonc append)。

**回应**:✅ v2 已删除自建引擎(C6–C9),改为零成本(IPC+CLI),降低成本 70%。

---

### Q2:"一键装 MCP 推动哪个产品指标、是否模仿竞品 scope creep"

**背景**:MCP 连接器看起来只是"OpenAI 插件商店"的翻版。

**回应**:
- MCP 本质是**接外部工具/数据的通道**;opencode 官方有它但无市场化UI(F2)
- 主画像(power user)受益于 `opencode mcp add` 的**GUI 化 + 可信预设源**;不是单纯"加功能",是**降低专业工具的进入门槛**
- MVP 收窄为 MCP 楔子、其它降 roadmap,**先验证"有人用"再扩**
- 避免"一上来铺全功能"的 scope creep(对标初稿的 11 个组件 → v2 砍到 5 个)

---

### Q3:"两个全屏 Portal 的 z 序/focus 冲突"

**假设**(v1):定制中心全屏 Portal,侧栏同样用 Portal(ADR-008)。

**冲突**:两个全屏叠加 → z 序混乱 / focus trap 相互干扰 / 侧栏被隐 / 滚动异常。

**回应**(v2):✅ 改为**覆盖内容区 Portal**
- 侧栏保持可见(不改 body[data-alpha-sidebar])
- 定制中心只投 .content 区(不 document.body)
- ESC/返回按钮显式返回侧栏(明确 focus 转移)

---

### Q4:"运行时依赖鸿沟(uv/python/LibreOffice),装不了怎么办"

**问题**:MCP 依赖五花八门(uv/node/python/系统工具);终端用户可能环境缺口。

**回应**:
- ✅ **依赖预检**:装前检 `which uv`,缺失诚实提示(不装进去)
- ✅ MVP **优先 remote-command/sse 类** MCP(无本地运行时依赖)
- ✅ 本土 MCP(飞书/钉钉/语雀)多为 HTTP,无重依赖
- 重工具链(LibreOffice/pandoc) →"办公套件"不拿 Anthropic 文档技能,改用 markitdown(纯 Python,轻)
- **不做**自动装工具(防权限混乱);用户补环境 → 重试

---

### Q5:"与 upstream 升级冲突吗"

**背景**:新增 IPC/config 读写,opencode 升级会不会踩到。

**回应**:✅ 零冲突
- 新增文件全在 packages/ui-mac/* (alpha 自有包,ADR-005)
- 改既有文件只有 sidecar.ts(已有注入接缝,F8),只加一行 mcp[] 注入(无结构改动)
- opencode 无 ext-config.ts、preload 改动、catalog 定义 → 升级只需 bun install

---

## 12. 分期路线图

| 阶段 | 名称 | 交付内容 | 验收条件 | 时间估计 |
|------|------|---------|---------|---------|
| **MVP** | MCP 连接器楔子 | 定制中心骨架:推荐 + 连接器 tab + 已安装 tab + 依赖预检;内置 3-5 条 MCP;一键装 + 持久化 + 免重启 | app 内点装 markitdown 并在会话可用;`git diff opencode/packages` 空;冲突文件数=0 | 1-2 周(Core5 组件) |
| **V1** | 技能+套件支撑 | 技能 tab + 创建技能 + 创建 Agent + 导入(folder/git-url) + 办公/研究/设计套件扇出 | 一键装"办公套件"(markitdown+openpyxl+guide-skill) → Word/Excel 任务跑通 | 3-4 周(C9 扇出逻辑 + 5 套件 manifest) |
| **V2** | 插件+本地化 | 插件 tab(npm+重启) + 中国办公套件(飞书/钉钉/语雀) + 远程 catalog 增量 + 镜像感知(npmmirror) | 飞书连接器可用;弱网装包落 npmmirror;腾讯文档/WPS 缺口识别 | 2-3 周(remote catalog + mirror handler) |

---

## 13. DRIFT 报告(对比 ARCHITECTURE/DECISIONS/NON_GOALS)

### 对齐项(✅)

| 规则 | v2 符合 | 说明 |
|------|--------|------|
| **ARCHITECTURE 北极星** | ✅ | 冲突文件数 = 0(只新增 packages/ui-mac/*、不改 opencode/*、sidecar.ts 仅加注入) |
| **ADR-005(fork 只增不改)** | ✅ | 所有组件落 alpha 自有包(ui-mac 是 workspace 成员) |
| **ADR-002(零-fork 接缝)** | ✅ | 读 SDK,写自有 config + IPC,不改 opencode 路由 |
| **ADR-003(AppInterface)** | ✅ | Portal 是 AppInterface children,复用既有 Router/Provider 上下文 |
| **ADR-008(侧栏)** | ✅ | 定制中心 Portal 覆盖 body[data-alpha-sidebar] 内容区(侧栏保持) |
| **ADR-009(injectAlphaConfig)** | ✅ | 出厂预设(mcp[])走既有 F8 注入接缝 |
| **NON_GOALS#1(零改 upstream)** | ✅ | 新增 5 组件全在 ui-mac/* |
| **NON_GOALS#4(不靠 experimental.*)** | ✅ | 只用稳定 SDK(mcp.status/add/connect)+ hook 级注入 |
| **NON_GOALS#5(不绕 SDK)** | ✅ | 100% SDK 读取 + 持久化走自有 IPC,无 core 模块直访 |
| **POSITIONING(薄定制层 <5%)** | ✅ | ~5 组件 + ~30 行 CLI 复用,无自建引擎 |

---

### 黄灯项(🟡)

| 条款 | 情况 | 处置 |
|------|------|------|
| **#13:electron-store 另起存储** | v1 曾计划,v2 已删 | ✅ 改用 SDK 真相源 + 既有 window.api.store |
| **#14:体量撞薄定制层** | v1 ~11 组件+12 实体,v2 砍半 | ✅ 删引擎,改用 CLI 复用 |
| **#8:ADR-014 状态 proposed** | 待 plan-review gate | 本设计完成后转正 |

---

### 已处置(✅)

| 发现 | v2 处置 |
|------|--------|
| **#3:sidecar.ts 显示 M** | 澄清:ui-mac 是 alpha 自有包(ADR-005),改自有文件≠破"只增不改 upstream" |
| **#11:安全边界** | 已补 §10(路径/字段/命令/URL 白名单 + token via keychain 占位) |
| **#12:jsonc 原子写策略** | 已补 C5(ext-config.ts:.bak 备份+回滚逻辑) |
| **#15:disableClaudeCodeSkillsScan** | env OPENCODE_DISABLE_CLAUDE_CODE_SKILLS 支撑,非死字段 |

---

## 14. D2 图清单(已渲染)

| 图号 | 文件 | 内容 | 用途 |
|-----|------|------|------|
| **01** | `01-extension-hub-overview.svg` | v2 瘦身拓扑(UI/SDK/IPC/config) + 零-fork 边界 | 架构总览 |
| **03a** | `03-flow-install-mcp.svg` | MVP 核心流(装 MCP+落盘+实时连) | 时序图 |
| **03b** | `03-flow-install-mcp-rollback.svg` | 装失败+回滚 | 容错流 |
| **03c** | `03-flow-bundle.svg` | 套件扇出(roadmap) | 分期图 |
| **03d** | `03-flow-plugin.svg` | 插件装+重启(roadmap) | 分期图 |
| **05** | `05-er.svg` | v2 数据模型(MVP-core 实线/roadmap 虚线) | 数据设计 |

---

## 15. 开放问题 & 待 Plan-Review 决策

| # | 问题 | 选项 | 建议 | 优先级 |
|----|------|------|------|--------|
| **O1** | MVP 范围是 MCP-first 还是全量 | A: MCP-first(本设计)/ B: 全量(skill+plugin) | **A** — 先验证有人用再扩 | P0 |
| **O2** | Agent/Command 是否进市场 tab | A: 进(与 skill 对等)/ B: 不进(仅创建+已安装) | **B** — 降低 MVP 范围;已安装可见,创建独立入口 | P0 |
| **O3** | 是否默认关闭 ~/.claude/skills 串台扫描(F9) | A: 关(OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1)/ B: 开(默认) | **待确认** — 决定用户是否误扫他人技能 | P1 |
| **O4** | 远程 catalog 刷新是否依赖 alpha-web(C 后端) | A: 要(v2 远程增量)/ B: 不要(仅内置) | **待确认** — 影响 v2 的 C 项目依赖 | P1 |

---

## 16. 已知风险与缓解

| 风险 | 影响 | 缓解 |
|-----|------|------|
| **新 IPC 攻击面** | 恶意 config 写入 → agent 注入 | 路径/字段/命令白名单 + 仅读 .opencode/ |
| **中国区 egress** | npm/pip/GitHub 下载失败 | 内置资源 + npmmirror 重试(V2) |
| **MCP 环境依赖** | 用户无 uv/python → 装失败 | 预检 + 诚实提示 + 优先 remote-command 类 |
| **catalog 维护成本** | 手工更新 3-5 条 + 核 license | 先内置、小而精;未来 alpha-web 支撑增量 |
| **plugin 装包重启** | UX 割裂(非即时) | MVP 不做;V1+ roadmap + 提前提示 |

---

## 17. 历史实现检查清单(冻结)

### 代码清单
- [ ] C1: `renderer/extensions/extension-hub.tsx`(主 UI)
- [ ] C2: `renderer/extensions/use-extensions.ts`(SDK 钩子,必用 /v2/client)
- [ ] C3: `renderer/extensions/catalog-types.ts` + `resources/alpha-catalog.json`
- [ ] C4: `preload/index.ts` + `preload/types.ts`(IPC contextBridge)
- [ ] C5: `main/ext-config.ts`(jsonc 持久化)

### 集成清单
- [ ] 侧栏「插件」改为「定制中心」,触发打开 extension-hub Portal
- [ ] C2 use-extensions 挂钩到 extension-hub,SSE 监听 sdk.mcp.status
- [ ] 「添加」button 触发 sdk.mcp.add + window.api.ext.persistMcp
- [ ] ESC/返回按钮显式关闭 Portal,返回侧栏焦点

### 测试清单
- [ ] 装 markitdown MCP → opencode.jsonc 有 mcp.markitdown
- [ ] 装后即刻在会话可用(免重启)
- [ ] 卸载 MCP(toggle off) → tool 消失
- [ ] 依赖预检(无 uv):提示"需要 uv"

### 流程清单
- [ ] ADR-014 状态:proposed → 本设计交付后改 accepted|trial
- [ ] 初稿 extension-hub.md 顶部加注记指向本设计

---

## 18. 参考与关联

**上游事实**:
- config.ts:89,174(skill/plugin 读写)
- cli/cmd/mcp.ts:430-443(addMcpToConfig 实现)
- server/.../mcp.ts(POST /mcp handler)
- packages/ui-mac/src/renderer/sidebar/alpha-sidebar.tsx:494(入口)

**自有文档**:
- ADR-002 / ADR-003 / ADR-005 / ADR-006 / ADR-008 / ADR-009
- extension-hub.md(初稿,含 §5/§7 预设与本地化)
- docs/diagrams/{01,03*,05}-*.{d2,svg}

**设计方法**:
- Skeptic model(Round2 对抗)
- MVP 最小可验证法(削出一条完整链路)
- Zero-fork 接缝约束(守北极星)

---

**最后更新**:2026-06-22 v2
**状态**:权威设计(待 plan-review gate)
**下一步**:① 更新 ADR-014 → accepted;② 补充实现任务;③ 开发与集成测试
