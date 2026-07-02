# alpha-code Mac App 启动性能与全面审计(2026-07-02)

> 触发:用户反馈"每次启动后很久 session 才加载完成",并问 plugins 是否应随 app 预置缓存。
> 方法:真机日志取证(`main.log` / `opencode.log` 145MB)+ 四路代码级追踪(主进程 / sidecar+server 内核 / 渲染层瀑布 / 运行时下载清单)。
> 结论先行:**慢的不是 sidecar 本身(fork→健康检查 ≈ 600ms),而是 ① 窗口被健康检查阻塞、② 启动即拉起全部 MCP(npx/uvx 未钉版本,国内网络反复失败 8–13s)、③ 渲染层双份全量取数、④ 每目录 Instance 引导附带 git/skills/watcher/npm 开销(含注定失败的 `@opencode-ai/plugin@local` 安装)。**

## 一、真机实测时间线(packaged,2026-06-30 19:35 冷启动)

| 时刻 | 事件 | 耗时 |
|---|---|---|
| 51.490 | app starting | — |
| 51.757 | 登录 shell env 探测完成(`spawnSync zsh -il`,本机 51 vars) | +267ms(重 dotfiles 用户可到 5–10s,同步阻塞) |
| 51.824 | spawning sidecar | — |
| 52.422 | sidecar ready + `/global/health` 通过("loading task finished") | **+598ms** ← server 本体很快 |
| 52.42+ | `createMainWindow()`(此前无任何窗口) | — |
| 55.936 | 渲染层 bundle 加载完、IPC `awaitInitialization` | **+3.5s**(另一次实测 +300ms,冷热差异大) |
| 55.98–56.9 | server 按 sidebar 请求逐目录建 Instance ×9(含 `/`、`~`、`~/Documents`) | ~0.9s |
| 58.3–36:06 | **MCP "server unavailable" 风暴**(yuque/feishu-lark/markitdown/cloud 反复失败) | **~8–13s** |
| 36:02.5 | `@opencode-ai/plugin@local` 后台 npm install 失败(每次启动必现) | ~6.5s(并行,但 `plugin_origins` 非空的目录会被 `waitForDependencies` join → 阻塞该目录首个请求) |
| 36:01–03 | location services + fs-events watcher + skills 扫描(×9 instance,duplicate-skill 告警 ×9) | ~1.5s |

历史累计:`server unavailable` ×1283、`background dependency install failed` ×152、`Failed to fetch models.dev`(TimeoutError,后台)×15。

## 二、发现清单

### P0(直接造成"session 加载很久")

**P0-1 窗口创建被 sidecar 健康检查阻塞** — `ui-mac/src/main/index.ts:409-411`:`Fiber.await(loadingTask)` 在 `createMainWindow()` 之前,loadingTask 含 spawn(60s stall 上限)+ `/global/health` 轮询(30s 上限)。健康前**连窗口都没有**。矛盾点:`serverReady` deferred 在 spawn 后立刻 resolve(`:387`),渲染层的 `awaitInitialization` 本就支持"先开窗、后连接"(renderer/index.tsx:323-324),该早启动通路被顺序废掉。附:健康轮询先 sleep 100ms 再首查(server.ts:160-168),白加 ≥100ms。

**P0-2 启动即拉起全部 MCP + 未钉版本 npx/uvx 反复失败** — 引擎本身是 lazy 的(MCP 只在首次 `tools()/status()` 时 per-directory 连接,`opencode/src/mcp/index.ts:473-538`,timeout 30s),但:
- 定制中心 `useExtensions` 在 `<Show when={open}>` 之外调用(extension-hub.tsx:173 vs :480)→ 面板从未打开也会在启动时 `mcp.status()` + 第 3 条 SSE;
- 上游 `bootstrapDirectory` 也查 `mcp.status`(bootstrap.ts:312);
- MCP state 按目录 Instance 隔离 → 多目录多套进程;`mcp.*` 事件又触发 status refetch(use-extensions.ts:233)。
用户配置 5 个本地 MCP 全部 `npx -y` / `uvx` **未钉版本**(`~/.config/opencode/opencode.jsonc`:fetch/markitdown/feishu-lark/yuque/github)→ 每次拉起都向 npm/PyPI 解析 latest,国内网络失败/超时 → 8–13s 风暴。alpha 注入的 `cloud` 远程 MCP(sidecar.ts:187-200)登录后也每次 `status=failed`(原因待查:token/URL/网络)。

**P0-3 渲染层双份全量取数** — `AlphaSidebar` 与 `AlphaHome` 各自实例化 `useAlphaProjects`(alpha-sidebar.tsx:124、AlphaHome.tsx:34,AlphaHome 无条件挂载):
- `project.list` ×2;`session.list` ×2N(`use-projects.ts:172` 无并发上限、`:121` 无 `limit`/`roots:true`,含子 session 客户端丢弃;上游自己只取 50 roots);
- `/global/event` SSE ×4(sidebar+home+hub+上游);
- 每个 `project.updated` 事件 → 2×`project.list` + 2N×`session.list` 重取风暴(use-projects.ts:363-369)。
启动请求总量 ≈ **2N + ~20 HTTP + 4 SSE**,全部打在单线程 sidecar 上,与 Instance 引导互相排队。

**P0-4 `@opencode-ai/plugin@local` 注定失败的安装** — 打包 app 的 `InstallationVersion` 是 `local`,npm 无此版本 → 任何有 `.opencode` 的项目每次启动后台 install 失败(~6.5s;历史 152 次);`plugin_origins` 非空时 `plugin.init → config.waitForDependencies()`(opencode/src/plugin/index.ts:180)会 join 失败 fiber → **阻塞该目录首个 session/请求**。本机触发源 = 把 fork 仓库当项目打开(`.opencode/plugins/*` 是上游自带);**分发用户任何带 `.opencode` 插件的项目同样必中** → 产品级缺陷,不只是本机习惯问题。

### P1(放大延迟 / 每用户都会踩)

- **P1-1 同步登录 shell 探测**:`preferAppEnv → spawnSync(shell,"-il")`,5s 超时,失败再试 `-l` 5s(shell-env.ts:36-93),发生在 `app.whenReady()` 之前的黑屏期。
- **P1-2 巨型目录被当项目建 Instance**:`/`、`/Users/tide`、`~/Documents` 各挂 fs-events watcher、git spawn、skills 扫描。home instance 来自 SDK 调用未带 `directory` 时回落 `cwd`(main 已 `chdir(homedir)`,index.ts:130);`/` 是全局约定 worktree,但 `useAlphaProjects.loadSessions` 对它照样取数(alpha-sidebar.tsx:506 只是渲染层 skip)。归档项目 = 客户端 hide,同样照常取数。
- **P1-3 skills 每 Instance 重复扫描**:9 目录 ×15-16 个 skill,duplicate-skill 告警 ×9 组(纯浪费 + 日志噪音)。
- **P1-4 models.dev 后台刷新**:非阻塞(磁盘缓存 → 内置 snapshot 兜底,`core/src/models-dev.ts:199-213`),但每次启动即刷 + 每 60min 刷,国内 10s×3 超时报 ERROR 噪音、无意义 egress。可 `OPENCODE_DISABLE_MODELS_FETCH=1`。
- **P1-5 sidecar 无崩溃自愈**:exit 只记日志(index.ts:261-263);`respawnSidecar` 仅供 auth 流程用。sidecar 挂 = 全 app 死等用户手动重启。
- **P1-6 opencode.log 145MB 无轮转**(`~/.local/share/opencode/log/`);userData 每次启动新建 log 目录(现 90+,7 天龄清理)+ 每次启动 20MB netlog 抓包常开。

### P2(健壮性 / 安全 / 一致性)

- **P2-1 IPC 无 sender 校验**;无 `setWindowOpenHandler`/`will-navigate` 约束;`store-get/set/...` 接受任意 store name(ipc.ts:91-117)。缓解项已有:contextIsolation+sandbox+CORS 钉 `oc://renderer`。
- **P2-2 `ext.persistMcp` 白名单缺口**:仅校验 `command[0]`,后续 args / `environment` / `headers` 值不受约束(ext-config.ts)。
- **P2-3 refresh token 存而不用**(alpha-auth.ts:270 存,全 repo 无刷新调用)→ 过期后平台/账户/cloud 全部静默 401。
- **P2-4 respawn 竞态**:20s race 超时后即 reload 渲染层,可能连上未就绪 server(index.ts:432-433)。
- **P2-5 版本号 `0.0.0`**:updater `currentVersion 0.0.0` + `InstallationVersion=local`(即 P0-4 根因)→ 发版元数据链路要一并修。
- **P2-6 `/v1/models` 云目录同步是死代码**:`fetchPlatformModels` 无渲染层调用方(models-ipc.ts:11 / preload:166)。
- **P2-7 全量 `process.env` 透传 sidecar**(server.ts:220-232)。

## 三、"插件/MCP 是否应随 app 预置缓存"专项(回答原始问题)

**结论:该预置的不是 opencode "plugin" 一种,而是四类运行时下载物;其中两类真正值得随 app 分发,两类靠钉版本+开关即可。**

| 下载物 | 现状 | 触发 | 建议 |
|---|---|---|---|
| `@opencode-ai/plugin`(+28 传递依赖,~61MB) | **未随 app 打包**,运行时经 arborist 从 npm 装进 `~/.config/opencode/node_modules` 与各项目 `.opencode/node_modules`;打包版本号 `local` → **必失败** | 每 config 目录一次(node_modules 缺失/脏时) | **随 app extraResources 预置** + 首启复制种子(复用 ADR-014 E1b `installBuiltinSkill` 拷贝模式);同时修版本注入,使 dirty-check 短路 |
| MCP servers(npx/uvx) | 用户级配置 5 个,**全部未钉版本** → 每次拉起都查 registry;缓存已 767MB `_npx` + 6.5GB uv | 每次启动(被 status 查询触发) | catalog 命令**钉精确版本**(`pkg@X` / `pkg==X`,缓存命中即离线);中国镜像 env 已有先例;长期可改"App 管理的运行时"(alpha 自下载 server 包到 app 缓存,node 直跑) |
| models.json(2.4MB) | 有内置 snapshot 兜底,磁盘缓存优先;但每次启动+每 60min 网络刷新 | 后台 | 预 seed `~/.cache/opencode/models.json` + `OPENCODE_DISABLE_MODELS_FETCH=1`;snapshot 随每次 app 发版更新 |
| ripgrep 15.1.0 / LSP servers | rg 从 GitHub releases 下载(国内难);LSP 多为浮动 latest,按语言首次触发 | 首次 grep / 首次开对应语言文件 | rg 预置进 `~/.cache/opencode/bin`;LSP 视产品定位:`OPENCODE_DISABLE_LSP_DOWNLOAD=1` 或按需预热 |

已无需担心:AI provider SDK 全部 bundled(anthropic/openai-compatible 等);`@alpha-code/ext` 已预 bundle(尚未接线);websearch 是远程 MCP 无安装。

## 四、优化方案

### Phase 1 速赢(全部落 alpha 自有文件,零改 upstream;预计把"可交互"从 5–15s 压到 <2s)

1. **窗口先行**:`createMainWindow()` 提到 IPC 注册之后立即执行;`loadingTask` 保持 fork 不 `Fiber.await`(渲染层 splash + `awaitInitialization` + ConnectionGate 本就能等)。→ `index.ts`
2. **shell env 探测移出关键路径**:改异步 spawn + userData 缓存上次结果(启动先用缓存、后台刷新差异再注入 respawn 链路),或至少缩短超时。→ `server.ts` / `shell-env.ts`
3. **`useAlphaProjects` 单例化**(共享 store/context,sidebar+home 共用)→ 请求减半、SSE 4→3;`session.list` 加 `limit` + `roots:true`;SSE 事件重取加 debounce;跳过 `worktree==="/"` 与已隐藏项目的取数。→ `use-projects.ts` 等
4. **定制中心惰性化**:`useExtensions` 移入 `<Show when={open}>`,不打开面板不查 `mcp.status`、不拉起 MCP。→ `extension-hub.tsx`
5. **MCP 钉版本**:`alpha-catalog.json` 全部命令钉精确版本;对存量用户在定制中心提供"一键钉版本迁移"(写回 opencode.jsonc,走既有 persistMcp 白名单)。
6. **cloud MCP 修失败**:排查 status=failed 根因(token/URL);未修复前注入时 `enabled:false`,首次真实使用再 enable。→ `sidecar.ts`
7. **修 `InstallationVersion=local`**:打包时注入真实语义化版本(对齐上游 npm 存在的 plugin 版本),或预置 node_modules 种子使安装短路;文档化 `OPENCODE_PURE` 逃生开关。→ 打包脚本
8. **models.dev 静音**:`preferAppEnv` 默认 `OPENCODE_DISABLE_MODELS_FETCH=1`(留 env 覆盖)+ 首启 seed models.json。→ `server.ts` + extraResources

### Phase 2 中期

9. 预置包体:`@opencode-ai/plugin` tarball、rg、models.json 进 `extraResources`,首启种子化(复用 installBuiltinSkill 拷贝白名单纪律)。
10. sidecar 崩溃自愈:接 `onExit` → 带退避的 `respawnSidecar`;修 20s respawn 竞态(健康未过不 reload)。
11. refresh token 刷新链路(401 拦截 + 静默续期 + 失败才弹登录)。
12. IPC 加 sender 校验 + `setWindowOpenHandler`/`will-navigate` 收紧 + store name 白名单;persistMcp 校验全部 args/env/headers。
13. 日志治理:app 启动时对 `~/.local/share/opencode/log` 做体积上限归档(alpha 侧维护逻辑);netlog 改 opt-in(`ALPHA_NETLOG=1`)。
14. 清理死代码:`/v1/models` 平台目录同步要么接线(模型菜单增量更新),要么删。

### Phase 3 结构性

15. **启动打点纪律**:`ALPHA_STARTUP_TRACE` — T_window(→首窗)/ T_sessions(→侧栏会话可见)/ T_chat_ready(→可发消息)三指标写日志,发版回归守卫。目标:T_window <400ms、T_sessions <1.5s。
16. 项目取数策略:真归档(不取数)、默认只取最近 K 个项目会话,其余展开再取。
17. 可选"常驻预热":关窗不退 sidecar / login item,二次启动近零等待。
18. "App 管理的 MCP 运行时":alpha 自行下载/校验 MCP server 包到 app 缓存目录,`node` 直跑,彻底摆脱 npx/uvx 在线解析(呼应本次预置缓存诉求)。

## 五、ADR 合规

全部方案落 `packages/ui-mac/**`、`alpha-catalog.json`、打包脚本与 env 注入接缝:零改 upstream 文件(ADR-002/005 后端纪律 ✅;前端自由 per ADR-016);预置种子写用户目录复用 ADR-014 §8 白名单;env 开关沿用 ADR-009/015 模式(均带逃生开关)。
