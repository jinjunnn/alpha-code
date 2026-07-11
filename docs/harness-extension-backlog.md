# Harness 扩展清单(Tier-2)

> **📌 冻结声明(2026-07-11 cutover)**:E 系列曾在本地 BACKLOG 对账
> (E2/E5/E6/E8/E10/E11 + 归并 G1→B6、E12→B3、E14→D5、E7→parked)；
> 本文仅保留为接缝盘点与历史证据，不再承载状态、优先级或待办。活跃工作以
> [GitHub Issues](https://github.com/jinjunnn/alpha-code/issues) 与
> [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) 为准。

> 生成:2026-06-23,配套 [[ADR-015]](../.claude/rules/adrs/ADR-015-prompt-optimization-strategy.md) Tier-2 决策。
> 立场:**"提升能力边界"走 harness 接缝(tool/MCP/skill/agent/plugin),不写进提示词。** 见 ADR-002 / ADR-014。
> 来源:对 `.opencode/`、`packages/ext`、`packages/ui-mac` 的接缝盘点 + 关键事实已抽查核实(见末尾)。

## 现状一句话(2026-06-23 核实修订)
零-fork 接缝**主干已通**:2 个自定义 tool(github-triage / github-pr-search,默认关)、2 个自定义 agent(triage / duplicate-pr,带 per-agent system prompt)、8 个 command、effect skill、侧栏。**定制中心(commit `59c0786`+2 fix,已发、已挂载、已 i18n、typecheck 通过)实际覆盖面远超初稿所述**:MCP 浏览/装/启停、bundle 扇出、plugin 安装、**create skill / create agent 表单全部已实现并提交**(非"coming soon")。`@alpha-code/ext` 插件已构建(`dist/plugin.js` 410KB)但**未装进 .app**(G1 阻塞)。
> ⚠️ 更正:本清单初版把 E1/E3/E4 写成"UI 已挡"系采信了一次**失真的 harness survey**;对照源码+git 后确认它们**已发**。下表已据此重排。

## 优先级清单

### P0 — 实况(大部分已发,剩一处真空)
| # | 扩展 | 状态 | 真正剩余 |
|---|---|---|---|
| E3 | Plugin 安装流(`onAdd`→`installPlugin`→`persistPlugin` 写 `plugin[]` + 重启提示) | ✅ 已发(`59c0786`) | 无 |
| E4 | Agent 创建表单(写 `~/.config/opencode/agent/<name>.md`) | ✅ 已发 | 可选增强:tools 勾选 / mode 选择 / client 端 name 校验 |
| E1a | Create *用户* skill(写 `skills/<name>/SKILL.md`) | ✅ 已发 | 无 |
| **E1b** | **Install *目录* skill**(builtin 资产复制进用户配置目录) | ✅ **已建机制 + 种 2 条真技能**(2026-06-23) | 见下「已完成」 |
| G1 | 装载 `@alpha-code/ext`(`dist/plugin.js`→resources→注入 `plugin[]`) | ❌ 未做 | 跨实例 zod 路径校验(ADR-006);1–2d |

> **E1b 已完成(机制 + 内容种子)**:
> - ① 资产打包:`packages/ui-mac/resources/skills/<key>/SKILL.md` + electron-builder `extraResources` 加 `resources/skills→skills/`;
> - ② 主进程 `ext-fs-installer.installBuiltinSkill(key,name)`:按 `builtinAssetKey` 解析(dev=repo resources / packaged=`process.resourcesPath`,镜像 windows.ts)→ `fs.cpSync` 进 `~/.config/opencode/skills/<name>/`,带 name/key 白名单 + safeResolve 防逃逸;
> - ③ IPC `ext-install-builtin-skill` + preload 桥 + 渲染层 `installSkill` 传 key;
> - ④ 种 2 条 **alpha 自写 MIT** 真技能:`alpha-upstream-sync`(操作化 ADR-015 合并验证)、`safe-refactor`。typecheck 通过 + 安装逻辑单测通过(复制/honest-fail/防逃逸)。
> - **剩余(非阻塞)**:(a) 官方 4 条 Anthropic Apache-2.0 内容仍未打包 → 现**诚实失败**("技能内容未随此版本打包"),待抓取核验内容 + 附 NOTICE 后落 `resources/skills/`;(b) 已知 UI 限制:catalog 里 skill 卡片不显示"已安装"(ADR-014 §4:installed 真相只有 MCP/SDK,skill 无真相源),装后按钮仍为"安装"(幂等覆盖);(c) 桌面端点击实测待做([[visual-verify-required]])。

### P1 — MCP 连接器扩充(纯命令型,1d 量级)
| # | 扩展 | 接缝 | 阻塞 | 估时 |
|---|---|---|---|---|
| **E14** | **浏览器自动化 MCP(Playwright)** — agent 导航/点击/填表/截图/跑 JS,补 `webfetch` 抓不动 JS 站点的缺口 | MCP local stdio(`npx -y @playwright/mcp`,Apache-2.0,Microsoft 官方) | 运行时浏览器内核(Chromium ~150MB 下载 / 或 `--browser chrome` 复用系统) | catalog 条目**已加**(`mcp:playwright`,`category:dev`,install-only 不进预设),剩 **A6 桌面实测** |
| E6 | **数据库 MCP**(sqlite/postgres,读 schema + SELECT) | MCP local stdio | 无(命令型,无 OAuth) | 1d |
| E2 | **钉钉 MCP**(补齐飞书/语雀的国产三件套) | MCP local stdio + npmmirror | 核实官方包名/鉴权字段 | 1d |
| E11 | **目录筛选 UI**(category/license 过滤,catalog schema 已带元数据) | 定制中心 UI | 无 | 1d |

> **E14 落地记(2026-06-24)**:回应"app 是否有内置网页浏览器 / 该自己加还是等 opencode"。核实:opencode 仅 `webfetch`(只读 HTTP,无 JS 渲染)+ `websearch`(关键词),**无任何浏览器自动化**,且上游无 roadmap 信号(`agent-browser` 是 dev 自测工具,§19 browser embeddability 自标 `[DRIFT]`)→ 决策**自己加,走 MCP 接缝**(ADR-002/014/015-Tier2,零-fork、北极星不破)。决策:① 本地 `npx` 优先(已带 `-y` 防交互挂死);② 仅定制中心可装,**不**做 `injectAlphaConfig` 出厂预设。包名核实 `@playwright/mcp@0.0.76` 真实存在。**唯一未决/待实测**:首次 navigate 时浏览器内核来源——默认下载 Chromium(中国区 egress 慢)vs `--browser chrome` 复用系统已装 Chrome(免下载但需已装);`runtimeDep` 只 which 到 node,内核非安装期可检 → A6 桌面端拍板。**Phase B(给用户的浏览器面板)单独走定位关(`/app:challenge`)后再开。**

### P2 — 需鉴权扩展(挡 keychain/OAuth UI)
| # | 扩展 | 接缝 | 阻塞 | 估时 |
|---|---|---|---|---|
| E5 | 日历 MCP(Google / macOS Calendar) | MCP + OAuth | IPC 目前只查运行时依赖,缺 OAuth/凭据存储(ADR-014 §8 keychain TODO) | 标 "coming soon" |
| E8 | Slack/Teams MCP | MCP + token | 同上(token 入 keychain) | 标 "coming soon" |
| E10 | catalog 远程增量同步(alpha-web C) | HTTP fetch | C 仓 catalog 端点未建 | roadmap |

### P3 — 云线(出本仓范围,挂 alpha-platform B)
| # | 扩展 | 阻塞 |
|---|---|---|
| E12 | 云作业派发(G4:task contract → Tier-1 执行 → 结果回流) | 需 alpha-platform 仓;`cloud.*` MCP 接缝本仓已就绪 |
| E13 | 团队协作多端 workspace 同步 | 需 alpha-platform + NON_GOALS#1「待补」未定 |
| E7 | 把 ADR-009 直连 websearch 收编成 MCP | 与云端 websearch 撞车,待 E12 后 |

## 建议起手
**P0 的 E1+E4+E3** 三连:它们共享"表单→IPC→写盘"骨架,后端 handler 已就绪,是把"定制中心 MVP(只 MCP)"补成"完整 skill/agent/plugin 楔子"的最短路径,直接兑现 ADR-014 的 V1+ roadmap;且**全程零碰上游、零碰提示词**——纯 harness 扩能力。

## 抽查核实(2026-06-23)
- ✅ `ext-ipc.ts` 实有 handler:`ext-persist-mcp / ext-remove-mcp / ext-check-runtime / ext-write-skill / ext-write-agent / ext-install-plugin`。
- ✅ `packages/ext/dist/plugin.js`(410KB)已构建、未装进 .app。
- ✅ catalog 8 条 MCP(markitdown/filesystem/fetch/**playwright**/git/github/feishu/yuque)+ skills/plugins/bundles。
- ✅ `.opencode/tool/{github-triage,github-pr-search}.ts`、`.opencode/agent/{triage,duplicate-pr}.md`(后者带 per-agent system prompt,正是 ADR-015 Tier-3 的 per-agent 调优落点)。
