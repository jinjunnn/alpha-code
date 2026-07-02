# 问题分级册 · Sprint 拆分 · 宏观方案审查(2026-07-02)

> 输入:`docs/audits/2026-07-02-startup-perf-audit.md`(启动审计)+ 本轮对 `.claude/rules/*`、alpha-platform `DECISIONS.md`(PA-1~26)、`docs/{harness-extension-backlog,platform-integration}.md` 的对照审查。
> 范围:① 统一问题分级;② sprint/task 拆分;③ rules/GOALS 宏观合理性;④ 云协同愿景评估;⑤ 本地 harness 集成方式评估。

---

## 一、统一问题分级册

等级定义:**P0** = 所有用户可感的核心体验缺陷或分发阻断;**P1** = 分发后必踩 / 愿景关键链路断点;**P2** = 债务(安全/健壮/治理);**P3** = 卫生。

### P0

| ID | 问题 | 维度 | 证据/根因 |
|---|---|---|---|
| A1 | 主窗口创建被 sidecar 健康检查阻塞,健康前无任何窗口 | 性能 | `index.ts:409-411`;serverReady 早已 resolve(`:387`)但早启动通路被顺序废掉 |
| A2 | MCP 启动风暴:定制中心非惰性(`extension-hub.tsx:173` 在 `<Show when={open}>` 外)+ 用户 5 个 MCP 全部未钉版本 npx/uvx + 每目录 Instance 各一套 | 性能/产品 | 冷启动后 8–13s "server unavailable"(日志累计 1283 次) |
| A3 | 渲染层双份全量取数:sidebar+home 各一套 `useAlphaProjects`(project.list ×2、session.list ×2N 无 limit/roots、SSE ×4、事件重取 ×2 放大) | 性能 | `alpha-sidebar.tsx:124` / `AlphaHome.tsx:34` / `use-projects.ts:121,172,363-369` |
| A4 | `@opencode-ai/plugin@local` 必败安装:打包版本号 `local` 在 npm 不存在;`plugin_origins` 非空的项目首个请求被 `waitForDependencies` 阻塞 | 正确性/分发 | 日志 152 次;**任何带 `.opencode` 插件的用户项目必中** |
| A5 | 发版元数据链断裂:app 版本 0.0.0、`InstallationVersion=local`(A4 根因)、prod 渠道 productName 仍 "OpenCode"、install-local 写死 dev(ADR-012 已知矛盾未决) | 分发 | `electron-builder.config.ts` / ADR-012 待办;updater `currentVersion 0.0.0` |

### P1

| ID | 问题 | 维度 | 证据/根因 |
|---|---|---|---|
| B1 | 登录 shell 同步探测最坏 ~10s 黑屏(`spawnSync -il` 5s + `-l` 5s,whenReady 前) | 性能 | `shell-env.ts:36-93`;本机 267ms,重 dotfiles 用户必踩 |
| B2 | refresh token 存而不刷:过期后平台/账户/cloud 全部静默 401;"续期失败降级 BYOK"既定设计(platform-integration.md §C)未实现 | 产品/多租户 | `alpha-auth.ts:270` 存,全仓无刷新调用 |
| B3 | **云协同最后一公里未通**:① `shared/alpha-config.ts` 默认端点 gateway/cloud 仍 `*.jinjunnm.workers.dev`(大陆不可达,违反 platform ADR-017/PA-26"客户端直连走公网 alphacodeone.com")→ cloud MCP 每启动 status=failed 的头号嫌疑;② `window.api.cloud.*` preload 桥完整但渲染层零调用;③ `/v1/models` live 同步 IPC 无调用方;④ dispatch skill(task contract,G4)未建 | 产品/愿景 | preload/index.ts:151-160;alpha-config.ts;审计 MCP failed 日志 |
| B4 | 巨型目录被当项目建 Instance(`/`、`~`、`~/Documents` 各挂 fs watcher/git/skills 扫描);归档=UI 隐藏但照常取数 | 性能 | opencode.log bootstrap 记录;`alpha-sidebar.tsx:506` 仅渲染层 skip |
| B5 | sidecar 无崩溃自愈(exit 仅记日志);respawn 有 20s 竞态(未健康也 reload) | 健壮 | `index.ts:261-263,432-433` |
| B6 | ext 主接缝休眠(G1 未完成):`packages/ext/dist/plugin.js`(410KB)已构建未装 .app,alpha 自有 tool 实际为 0,Tier-2"能力扩展走 harness"无载体 | 产品/架构 | `sidecar.ts:140-142`;harness-extension-backlog G1 |
| B7 | **发布流水线未制度化(系统性)**:「预 bundle + 种子预置 + 真实版本注入 + 断网首启验收」没有固化为 ship 流水线标准步骤与 CI 守卫。A4/A5 是其当前实例;ADR-006"两个运行时世界"已咬人 3 次(raw-TS crash、`@local` 必败安装、resolve hook 补丁),每次都是逐案救火。**验收 = 制度存在(发版 checklist + CI 断言),而非单点修复** | 流程/架构 | 本条修复后,新增任何运行时下载物(新 LSP/MCP/依赖)自动被守卫捕获 |
| B8 | **扩展物运行时生命周期管理缺失(系统性)**:装得上、管不了——MCP 无版本钉/健康/更新通道,skill 无已安装态,plugin 无升级路径。A2 是其症状;T1.5/T5.4/D4 是首批任务。终态 = 定制中心从"商店"进化为"运行时管理器",远期"App 管理的 MCP 运行时"(alpha 自下载 server 包、node 直跑,摆脱 npx/uvx 在线解析) | 产品/架构 | 定制中心现状仅"浏览+安装+启停";catalog 全部未钉版本 |

### P2

| ID | 问题 | 维度 |
|---|---|---|
| C1 | IPC 无 sender/frame 校验;无 `will-navigate`/`setWindowOpenHandler` 守卫;store IPC 可按任意 name 读写 electron-store 文件(`ipc.ts:91-117`) | 安全 |
| C2 | `persistMcp` 白名单只查 `command[0]`,args/`environment`/`headers` 不受约束(ext-config.ts) | 安全 |
| C3 | 日志治理:`opencode.log` 145MB 无轮转(上游侧,alpha 可在 app 启动时做体积治理);netlog 20MB 每次启动常开 | 卫生/健壮 |
| C4 | models.dev 周期刷新在大陆超时报 ERROR(非阻塞;有内置 snapshot 兜底)→ 应 `OPENCODE_DISABLE_MODELS_FETCH=1` + seed | 性能/噪音 |
| C5 | skills 每 Instance 重复扫描 ×9 + duplicate 告警(上游行为;靠减少 Instance 数缓解) | 性能 |
| C6 | 文档漂移:ARCHITECTURE"薄定制层<5%"、NON_GOALS"不追求自定义代码总量"与 ADR-016 前端接管矛盾(ADR-016 待办③未做);GOALS 停在 Sprint 1(06-14 起、结束日待补),G4 状态严重滞后(platform 侧 research/code-review pipeline 已 live,A 侧 plumbing 阶段一~三已 merge);POSITIONING〔待补〕项(团队协作、用户下沉)仍开放 | 治理 |
| C7 | ADR 编号跨仓冲突:本仓 ADR-016(前端接管)vs platform ADR-016(A↔B 契约);commits "(ADR-016)" 实指后者 → 需跨仓引用规范(建议 `B/ADR-016` 或 `PA-25`) | 治理 |
| C8 | "sidecar"语义漂移:ADR-002 的"自有独立 HTTP 进程(Hono)"从未建成,自有后端能力全走 Electron main IPC(桌面场景合理,但与 ADR 文字不符;IPC-only 使未来非 renderer 客户端无法访问 account/cloud 能力) | 治理/架构 |
| C9 | 代码上云的数据边界(PIPL/secrets 过滤/consent)A 侧无设计——code-review pipeline(PA-22 已 live)必然要传代码;platform PA-7 已 flag 数据出境,A 侧无对应 | 产品/合规 |
| C10 | 全量 `process.env` 透传 sidecar(`server.ts:220-232`);**且待核实:MCP 子进程(npx/uvx 第三方代码)是否继承该 env——若继承,ALPHA_API_KEY/BYOK keys/EXA key 对所有第三方 MCP 进程可见**(升级为安全审计首查项) | 安全/卫生 |
| C11 | 授权码写入日志:`open-url` deep link 整条 URL(含 `?code=...&state=...`)原样记入 main.log(`index.ts:240`),`exportDebugLogs` 会把它导出给用户/支持渠道;PKCE code 虽短命一次性,仍应脱敏 | 安全 |

### P3

| ID | 问题 |
|---|---|
| D1 | 健康轮询先 sleep 100ms 再首查(白加 ≥100ms) |
| D2 | `/v1/models` 平台模型 live 同步 IPC 死代码(静态 catalog `alpha-models.json` 已可用)→ 接进 picker 或删,需决策 |
| D3 | 官方 4 条 Anthropic skills 内容未打包(现诚实失败) |
| D4 | 定制中心 skill 卡片无"已安装"态 |
| D5 | playwright MCP 浏览器内核来源未实测(E14 A6 拍板项) |
| D6 | userData 每启动新建 log 目录(7 天清理已有,可观察) |

---

## 二、Sprint 拆分

节奏:S0 半周,其余每个约 1 周;S6 全程并行。依赖:S0→S1→S2;S3/S4 可并行;S5 在 S2 后。

### S0「打点与止血」(0.5w)
| Task | 内容 | 落点 | 验收 |
|---|---|---|---|
| T0.1 | `ALPHA_STARTUP_TRACE` 三指标:T_window(启动→首窗)/ T_sessions(→侧栏会话可见)/ T_chat_ready(→可发消息),写 main.log | `index.ts`/`windows.ts`/renderer 上报 IPC | 每次启动日志输出三指标 |
| T0.2 | 用户侧零代码止血:钉 5 个 MCP 版本、移除 `/Users/tide`、`Documents` 等非项目、不把 fork 仓当项目打开 | 操作,不改码 | 启动无 server unavailable 风暴 |

### S1「启动性能」(1w)→ A1 A2 A3 B1 B4
| Task | 内容 | 落点 | 验收 |
|---|---|---|---|
| T1.1 | 窗口先行:`createMainWindow()` 提前至 IPC 注册后;loadingTask 只 fork 不 `Fiber.await` | `index.ts` | T_window < 400ms |
| T1.2 | shell env 探测异步化 + userData 缓存上次结果(启动先用缓存,后台刷新) | `server.ts`/`shell-env.ts` | 黑屏期无 spawnSync |
| T1.3 | `useAlphaProjects` 单例化(sidebar+home 共享);`session.list` 加 `limit`+`roots:true`;SSE 事件重取 debounce;跳过 `worktree==="/"` 与隐藏项目 | `use-projects.ts` 等 | 启动请求 ≈ 减半;T_sessions < 1.5s(9 项目) |
| T1.4 | ExtensionHub 惰性化:`useExtensions` 移入 open 门内 | `extension-hub.tsx` | 不开面板不触发 mcp.status |
| T1.5 | catalog MCP 全部钉精确版本 + 存量配置"一键钉版本"迁移 | `alpha-catalog.json`/`use-extensions.ts` | 启动 60s 内 server unavailable = 0 |
| T1.6 | ⚠️**[§七 R1:勿切端点]** cloud MCP 连接修复——~~默认端点切 `alphacodeone.com` 域~~(**已撤回**:workers.dev 是唯一路由 `/v1` 的 host,切域打到 404)→ 改查 token 注入时序 + workers.dev GFW 可达性;+ 未健康前注入 `enabled:false` | `shared/alpha-config.ts`/`sidecar.ts` | 登录后 cloud MCP status=connected |
| T1.7 | `OPENCODE_DISABLE_MODELS_FETCH=1` 默认(env 可覆盖)+ 首启 seed models.json | `server.ts` + extraResources | 启动无 models.dev ERROR |

### S2「分发就绪:版本/打包/自愈」(1w)→ A4 A5 B5 C3
| Task | 内容 | 落点 | 验收 |
|---|---|---|---|
| T2.1 | 版本链修复:真实 semver 贯穿 app 版本 / updater / `InstallationVersion`(消灭 `@local`) | 打包脚本/electron-builder | 无 npm install 失败日志 |
| T2.2 | ⚠️**[§七 R4/R5]** ADR-012 决断:①prod 渠道 rebrand + install-local 按渠道解析,或 ②修订 ADR 承认 dev 渠道为发布渠道 —— **改 appId/渠道前必须先做数据迁移(R4)+ 同步改 updater feed 指自有仓/禁更新器(R5)** | `electron-builder.config.ts`/`install-local.ts`/ADR-012 | ship 一次成功且命名一致;**旧 userData+旧后缀 DB 一次性迁移(或明确提示接受丢失);updater feed 不再指 anomalyco/opencode** |
| T2.3 | 预置种子:`@opencode-ai/plugin` 依赖树 + rg + models.json 进 extraResources,首启复制(复用 E1b 白名单拷贝模式) | resources/ + `ext-fs-installer.ts` 模式 | 全新 Mac 断网首启可用(BYOK) |
| T2.4 | sidecar 崩溃自愈(exit→退避 respawn)+ respawn 竞态修复(未健康不 reload) | `index.ts`/`server.ts` | kill sidecar 10s 内自愈 |
| T2.5 | 日志治理:opencode.log 体积上限归档(app 启动时);netlog 改 `ALPHA_NETLOG=1` opt-in | `logging.ts` + 新维护逻辑 | 日志总量有界 |
| T2.6 | **发布流水线制度化(B7)**:发版 checklist + CI 守卫——①断言打包产物版本号非 `local`/`0.0.0`;②断言种子资产(plugin 依赖树/rg/models.json/skills)在 extraResources 中完整;③断网环境首启 smoke(CI 或发版手册步骤);④新增运行时下载物必须过"预置或钉版本"评审 | `.github/workflows/` + `docs/` 发版手册 | CI 红灯能拦住"裸奔的运行时下载物";T2.1–T2.3 成为其首批实例 |

### S3「多租户地基:auth/安全」(1w)→ B2 C1 C2 C10
| Task | 内容 | 验收 |
|---|---|---|
| T3.1 | refresh token 续期 + 401 拦截 + 失败降级 BYOK/登出(platform-integration §C 既定设计) | token 过期无感续期;掉线有明确 UI |
| T3.2 | IPC sender 校验 + `will-navigate`/`setWindowOpenHandler` + store name 白名单 | 安全用例通过 |
| T3.3 | persistMcp:校验全部 args/environment/headers | 注入用例被拒 |
| T3.4 | sidecar env 白名单透传(替代全量拷贝) | 功能回归通过 |

### S4「云协同最后一公里」(1–2w)→ B3 C9 D2
| Task | 内容 | 验收 |
|---|---|---|
| T4.1 | 平台模式 E2E:登录 → cloud MCP 健康 → 会话内经 `cloud.*` 工具发一次 research dispatch → SSE 进度 → artifact 回流(= GOALS G4 验收) | 真实任务端到端返回结构化结果 |
| T4.2 | 云任务会话内 UX:进度事件呈现为消息流;轻量 job 状态(通知/badge),不做重管理器 | 可视进度 + 完成通知 |
| T4.3 | dispatch skill(task contract 产出) | schema 硬校验拒残缺契约 |
| T4.4 | `/v1/models` live 同步:接进 picker 做增量刷新,或删除(决策) | 无死代码 |
| T4.5 | code-review 上云数据边界 mini-ADR:diff-only 优先、secrets 过滤、consent 弹窗、体积上限 | ADR 落 `.claude/rules/adrs/` |

### S5「harness 能力线」(1w)→ B6 D3 D4 D5
| Task | 内容 | 验收 |
|---|---|---|
| T5.1 | G1:装载 `@alpha-code/ext`(dist→resources→注入 `plugin[]`,ADR-006 跨实例 zod 路径校验) | 自定义 tool 出现在 agent 工具列表并执行成功 |
| T5.2 | 首批 alpha 自有 tool(候选:cloud dispatch 快捷 tool / 本地实用 tool) | 至少 1 个 tool 实用化 |
| T5.3 | 官方 4 skills 内容打包 + NOTICE;skill"已安装"态 | 安装成功率 100% |
| T5.4 | 定制中心 MCP 健康面板(状态/版本/重连) | 状态可视 |
| T5.5 | E14 playwright 内核来源实测拍板(Chromium 下载 vs `--browser chrome`) | ADR-014 `_verify` 关闭 |
| T5.6 | **运行时管理器聚合验收(B8)**:每类扩展物(MCP/skill/plugin)在定制中心具备「版本(钉住)/ 状态(健康)/ 更新(通道)」三要素;缺失项立 roadmap 条目(如"App 管理的 MCP 运行时"立 ADR proposed) | 三要素矩阵可视;B8 从"缺失"降级为"roadmap 中" |

### S6「文档与治理」(并行 0.5w)→ C6 C7 C8
| Task | 内容 |
|---|---|
| T6.1 | 按 ADR-016 待办③修订 ARCHITECTURE/GOALS/NON_GOALS 前端表述;北极星拆分:后端"升级隔离健康度"保留,新增"分发健康度"(版本/更新/首启可用)与"云闭环健康度"(dispatch 成功率) |
| T6.2 | GOALS 刷新:sprint 序列写入,G4 状态同步(platform 已 live 的部分如实记录) |
| T6.3 | 跨仓 ADR 引用规范(`B/ADR-xxx` 或 PA 号) |
| T6.4 | ADR-002 sidecar 语义修订(承认 main-IPC 为桌面等价物;真 HTTP sidecar 按需再立,YAGNI) |
| T6.5 | ADR-015 待办②:prompt/*.txt 变更 tripwire 接进 sync-upstream.yml(可选) |

---

## 三、宏观方案审查(对照 rules/GOALS/ADR)

**结论:方向不需要改。** 用户愿景(多租户 + BYOK/订阅双轨 + 本地 harness × 云 pipeline/沙盒协同)与既有决策**完全一致且已决策到位**:
- 双轨密钥:BYOK 纯本地直连不入身份体系(PA-8);**云端无 BYOK**(ADR-013)→ 云任务一律平台计费,边界干净。
- 订阅/购买:PA-11(钱包+订阅)/PA-12(月卡)/PA-4(per-token+per-tool),购买 UI 在 alpha-web(C),enforcement 在 B。
- 云 pipeline:PA-22(research/code-review/docs Tier-1 已 live)、PA-24(tier×autonomy 正交)、PA-18(编码=Claude Code in CF Sandbox / 非编码=Agents SDK)、PA-17(CF Workflows+Sandbox)。
- A↔B 契约:PA-25 = HTTP/SSE jobs API 真相源 + MCP facade,拒"只认 MCP" —— 这个决策质量很高(agent 把云当工具、UI 把云当 API、模型把云当 provider,三通道各司其职)。

**真正的问题是执行进度不均 + 文档滞后**:platform 侧跑得快(PA-22/25/26 已 accepted+live),A 侧"最后一公里"断着(B3),`.claude/rules` 里 GOALS/ARCHITECTURE/NON_GOALS 落后于 ADR-016 与云线现实(C6/C7)。风险不在方案,在"文档说的、代码做的、平台有的"三者漂移——按 S6 收敛即可。

## 四、云协同愿景评估(合理?优雅?)

**合理性:成立。** 分工判据清晰(ADR-010 litmus:步骤能否写死):交互式编码 = 本地 harness(低延迟、上下文在本地、BYOK 可用);research/审计/长时程/需隔离 = 云 pipeline/沙盒(平台计费、可并行、可复现)。这正是"agency 留本地、确定性上云"。

**优雅度:取决于交互形态,当前架构支持优雅解。** 建议铁律:**云任务永远呈现为会话内的一次工具调用 + 流式进度消息**,UI 只做轻量状态(通知/badge/artifact 链接),不建"第二个大脑"式的任务管理中心。MCP facade + SSE 事件流天然支持这个形态。

**需要补的四块**(已入 sprint):
1. 可达性:客户端默认端点必须全部走 `alphacodeone.com` 公网域(B3①,platform ADR-17 的 A 侧对齐);
2. 数据边界:code-review 上云 = 代码出境,diff-only 优先 + secrets 过滤 + consent(T4.5,呼应 PA-7 PIPL);
3. 失败/重试语义:云任务失败回到会话内可重试;
4. 成本护栏 UX:dispatch 前预估、配额可见(account IPC 已有,差 UI)。

## 五、本地 harness 集成方式评估(plugins/commands/skills/agents/tools × sidecar)

**接缝选型:正确,纪律成立。** 零-fork 至今保持(ADR-004 可机械验证);tools/plugins/skills/agents/commands 全部走官方接缝;identity/behavior 分层注入(ADR-015)且各有逃生开关;定制中心实际覆盖面超出 ADR-014 初稿(MCP 装/启停、skill/agent 创建表单、plugin 安装、builtin skill 种子均已发)。

**三个系统性短板**(比"再加几个扩展"更重要):
1. **载体缺位**(B6):`@alpha-code/ext` 是设计中的主接缝却休眠 —— alpha 自有后端能力目前全靠 env/config 注入,没有一个"活的"自有 tool/plugin。G1 接线是 harness 线第一优先。
2. **打包流水线未制度化**:ADR-006"两个运行时世界"已真实咬人 3 次(raw-TS crash、`@local` 必败安装、resolve hook 补丁)。应把「预 bundle + 种子预置(plugin 依赖树/rg/models.json)+ 真实版本注入」固化为 ship 流水线的标准步骤(S2),而不是逐案救火。
3. **运行时生命周期管理缺失**:装得上、管不了 —— MCP 无版本钉/健康面板/更新通道,skill 无已安装态。定制中心应从"商店"进化为"运行时管理器"(S1 钉版本 + S5 健康面板;远期"App 管理的 MCP 运行时":alpha 自下载 server 包、node 直跑、彻底摆脱 npx/uvx 在线解析)。

**sidecar 形态**:内嵌 `utilityProcess` 是对的(生命周期/崩溃/IPC 集成都比独立进程简单);"自有 HTTP sidecar"未建但目前无真实需求 —— 建议修订 ADR-002 语义(C8)而非为了合规硬建,等出现"非 renderer 客户端要调 alpha 能力"的需求再立。

> 入册映射(2026-07-02 补):短板 1 = **B6**(S5/T5.1-T5.2);短板 2 = **B7**(系统性条目,实例 A4/A5,任务 T2.6 + T2.1-T2.3);短板 3 = **B8**(系统性条目,症状 A2,任务 T1.5/T5.4/D4 + 聚合验收 T5.6);sidecar 语义 = **C8**(T6.4)。

---

# 六、第二轮审计(8 方向,2026-07-02)—— 新发现入册

> 方法:8 个只读 agent 并行审计 安全/秘钥、升级隔离、静默失败、运行时性能、数据持久化、许可合规、测试依赖、i18n·无障碍·弱网。全部 file:line 取证。标 **[确认]**=代码坐实,**[疑]**=待复核。延续 A(P0)/B(P1)/C(P2)/D(P3) 编号。

## 6.1 新增 P0(发布/安全硬阻断)

| ID | 问题 | 证据 | 状态 |
|---|---|---|---|
| **A6** | **秘钥泄漏给第三方子进程**:sidecar 全量 `process.env`(含 `ALPHA_API_KEY` 平台计费 JWT、全部 BYOK 密钥、`ALPHA_CLOUD_TOKEN`、`EXA_API_KEY`)被每个本地 MCP/LSP 子进程原样继承 → **任何用户装的 npx/uvx MCP 包(或被劫持的版本)都能窃取租户计费身份 + 所有模型密钥** | `mcp/index.ts:334-344` `env:{...process.env,...}`;`lsp/lsp.ts:176-179` 同;env 由 `server.ts:220-232` 全量透传;密钥由 `alpha-auth.ts:142-148`/`alpha-byok-keys.ts:121-126` 注入 | [确认] 取代 C10"待核实" |
| **A7** | **ui-mac 无签名/公证流水线** → 只能本机 ad-hoc 签名,分发到别的 Mac 必被 Gatekeeper 拦("已损坏")→ 多租户商业分发无法进行 | `electron-builder.config.ts:81-83` `identity: isCI?undefined:null` + `notarize:isCI`;`.github/workflows/` 无任何 ui-mac 打包 job(publish.yml 只签上游 desktop,用 anomalyco 的 Apple 证书) | [确认] |

## 6.2 新增 P1

| ID | 问题 | 证据 | 状态 |
|---|---|---|---|
| **B9** | **更新链无完整性校验**:electron-updater 盲信 GitHub `latest-mac.yml` feed(无 pinned key/detached-sig,只靠 zip-vs-yml SHA + macOS 签名),且 `allowDowngrade=true`(可降级攻击);本机 ad-hoc 构建连签名兜底都没有 | `updater.ts:14-18`;`updater-controller.ts:45-55`;feed=`anomalyco/opencode`(`electron-builder.config.ts:142,152`) | [确认] |
| **B10** | **升级隔离北极星根本没被强制**:ADR-004/GOALS 说的 "CI 守卫 `git diff opencode/packages` 为空" 全仓无实现;`alpha` 分支上无任何 CI;只有 sync-upstream.yml 一个更弱的"合并冲突"启发式(上游没碰、alpha 单方改上游文件会干净合并、永不报警);`.gitignore` 已有一处越界修改;ADR-015 prompt tripwire 仍缺 | 全仓 grep 仅 sync-upstream.yml:7 一条注释;typecheck 只在可 `--no-verify` 的 pre-push | [确认] |
| **B11** | **系统性静默失败**:无统一错误/健康呈现面;`AlphaProjectsStore.error`/`ExtensionsStore.error` 两个 error 标志在任何界面都没渲染;全渲染层仅 1 对 toast → 32 个失败点 22 个(~69%)对用户零反馈。最刺眼:账户读取失败→错误显示"钱包按量扣费"(#1)、project.list 失败→侧栏空白(#4)、首条消息发送失败→落进空会话消失(#6)、登录整链失败静默(#12) | `model-picker-inject.tsx:58-70`;`use-projects.ts:149-151,267-271`;`alpha-auth.ts:239` | [确认] |
| **B12** | **Instance 永不驱逐 + 递归 watcher 常驻**:`instance-store.ts:43` Map 无 TTL/LRU/idle,只在删项目/关进程时释放;`/`、`~`、`~/Documents` 各成常驻 Instance,各带一个递归 fs-events watcher 永不解绑 → 运行时内存增长头号来源 | `instance-store.ts:43,108-124`;`core/src/filesystem/watcher.ts:115-118`;`server.ts:58` 强开 filewatcher | [确认] |
| **B13** | **DB 无跨进程锁 + 崩溃式并发**:WAL 使并发不损坏,但 dev/packaged-alpha 不撞库纯靠"渠道归一同 appId + 单实例锁"的巧合;packaged beta/prod 同分支、独立 opencode CLI、孤儿 sidecar 都能绕过 → 真并发写 `SQLITE_BUSY` → 整层 `Effect.orDie` 硬崩(无退避) | `database.ts:27-36`(orDie);`migration.ts:11` 仅进程内 semaphore;`instance/index` appId 归一 | [确认] |
| **B14** | **无损坏恢复 / 无会话备份导出**:整个 DB 层 orDie,无 `integrity_check`、无隔离重建、无备份副本 → DB 损坏 = "服务启动失败",只能用户手删文件;无任何会话 export/import | `database.ts:36`;全仓无 backup/export 路径 | [确认] |
| **B15** | **MIT 声明义务未满足**:opencode 是 MIT(**闭源+改名+商用转售完全合法**),但唯一条件"保留版权+许可声明"在发布 app 里无处满足——无 NOTICE 文件、无关于页、无致谢屏 | `LICENSE`(MIT);全仓无 NOTICE/THIRD-PARTY;`ui-mac/src` 无 aboutPanel | [确认] 利好但需修 |
| **B16** | **云派发无 PIPL 同意/告知门**:首启 onboarding 无隐私政策/数据用途/ToS;登录只授权计费路由,不等于告知"你的代码/文件将上传云端分析";cloud dispatch 管道已存在(渲染层暂未调用) | `AlphaOnboarding.tsx:36-74`;`cloud-ipc.ts:16-20`+`alpha-cloud-jobs.ts:47-48`;i18n 无 privacy/consent 键 | [确认] 与 C9 互补(C9=技术边界,B16=法律同意) |
| **B17** | **alpha 代码零自动化测试**:ui-mac 13,420 行 + ext 59 行覆盖率 0;`ext-config.ts` persistMcp 安全校验、`ext-fs-installer.ts` 防逃逸、`alpha-auth.ts` PKCE 全无测试;文档称"安装逻辑单测通过"在 git 历史查无此文件(不可复现) | `find *.test.ts`=0;`harness-extension-backlog.md:26` 声称 vs `git log --all` 空 | [确认] |
| **B18** | **CI 未 gating**:`typecheck.yml` 触发条件是 `dev` 分支但所有 PR 合进 `alpha` → **从未运行过一次**;`test.yml` 不覆盖 ui-mac/ext(无 test script/turbo task);`alpha`/`dev` 均无分支保护;近 14 次合并 CI 全 cancelled/queued 从未变绿 | `typecheck.yml:4-7`;`gh run list` 空;`gh api .../branches/alpha/protection`=404 | [确认] |
| **B19** | **sync-upstream 定时任务当前已坏**:从 06-22 起连续失败 10/10(bot token 缺 `workflows` 权限,推不动上游新增的 workflow 文件)→ dev 镜像冻结在 13 天前 → 升级继承价值当前实际中断 | `gh run list --workflow=sync-upstream.yml` 10 连败;`run view --log-failed`=refusing…without 'workflows' permission | [确认] 可立即修 |
| **B20** | **弱网降级 UX(中国区核心)**:首条消息 send 无超时 + 无 spinner,卡住只能重启(`use-projects.ts:256-277`);model/tool 错误(含 401 过期)只显示原始红卡无重试/重登 CTA;websearch keyless 被限流时 `Effect.orDie` 硬失败而非静默降级;60s splash 无任何状态文字;`Skeleton.tsx` 死代码,catalog 慢加载时 picker 误显"无匹配模型 + 加自定义端点" | `mcp-websearch.ts:89-93`+`websearch.ts:140` orDie;`renderer/index.tsx:359-369`;`model-picker-inject.tsx:120` | [确认] 部分与 B11 重叠 |

## 6.3 新增 P2

| ID | 问题 | 证据 |
|---|---|---|
| **C12** | CORS 实际未 pin 到 `oc://renderer`:localhost/127.0.0.1/`*.opencode.ai`/无 Origin 请求全放行(非 PTY 路由仍有 Basic 密码兜底) | `server/src/cors.ts:11-28` |
| **C13** | `open-link` IPC 把渲染层传来的 URL 直接 `shell.openExternal`,无 scheme 白名单 | `ipc.ts:184-185` |
| **C14** | **升级静默破坏面(file-diff 守卫看不见)**:40+ 个耦合上游 DOM 的 CSS 选择器 + 3 个 warn-only 构建期子串补丁(打偏照发)+ base64 路由复刻 + `/global/event` 事件字符串 + `command.trigger` 自由字符串 ID + `use-projects.ts` `as any` 抹掉的 SDK `scope` 契约;ADR-016 todo①(收敛借用为薄 re-export 层)未建 | `patch-upstream.ts:19-45`;`brand-i18n.ts:26-67`;`use-projects.ts:121,240,260`;`route.ts:4-15` |
| **C15** | 运行时 SSE/DOM 浪费:3 个 alpha SSE 消费者裸遍历整条 firehose、对 token 增量无合并(上游自身有 coalesce);流式期间 3 个 `document.body` 全子树 MutationObserver,timeline 那个每宏任务跑 7 次全文 `querySelectorAll` | `use-projects.ts:346-371`;`timeline-inject.tsx:376-387,416` |
| **C16** | 卸载残留 ≈0.8GB 含凭证零清理:拖 app 进废纸篓只删 bundle,5 个分支 DB(全量会话)+ `auth.json`/`alpha-auth.json`(token)+ `alpha-byok-keys.json` + 145M 日志 + 61M node_modules 全留存;无卸载 hook / 无 app 内数据清除 | `du -sh` 五处;无 afterRemove |
| **C17** | schema 无降级/版本兼容守卫:旧 app 打开被新 dev 迁移过的 DB 无检测,新 `NOT NULL` 列破坏旧写入;无 app↔DB 版本校验 | `migration.ts:43-80` applyOnly |
| **C18** | 品牌/商标外泄:`copy-metainfo.ts:20-22` 把 "Anomaly Innovations Inc." + opencode.ai/github 硬编码进所有渠道发布元数据;bundle ID 仍 `ai.opencode.desktop*`、协议名仍 "OpenCode";致命错误屏 i18n "报告给 OpenCode 团队" 未改写;prod 渠道产物竟名为 "OpenCode"(ADR-012 已知) | `copy-metainfo.ts:20-36`;`electron-builder.config.ts:41-44,91-93` |
| **C19** | Sentry 遥测已在渲染层接线,仅靠构建期 `VITE_SENTRY_DSN` 开关,无用户 opt-out/无告知 → 面向中国区跨境数据风险 | `renderer/index.tsx:65-74` |
| **C20** | alpha-ui i18n 断裂:14 个 .tsx 里 9 个零 i18n(Home/Onboarding/composer 工具条/两个 picker 全硬编码简中);繁中(zht)18 处 "OpenCode" 全未改写;原生崩溃对话框英文硬编码 → 切换语言对主力界面无效,非中文用户永久中文 UI | `brand-i18n.ts:29-67`;`AlphaHome.tsx`/`AlphaOnboarding.tsx`/`composer-controls.tsx`;`windows.ts:375-404` |
| **C21** | 无障碍缺口(alpha-ui):Dialog 无 focus-trap/焦点恢复;model-picker-add 无键盘/Escape、两个 toggle 与删除键 click-only;model picker 非 listbox 无方向键;三个菜单无 Escape;composer-controls 零 aria;reduced-motion 被硬编码时长绕过;主输入框 focus 环对比 1.52:1、`--a-text-tertiary` 正文 4.09/4.12:1 均 < AA | `Dialog.tsx:21-28`;`model-picker-add.tsx:234-315`;`tokens.css:15,157`;`home.css:296-298` |
| **C22** | 依赖漏洞:`bun audit` 全仓 158(2 critical/45 high),多数在 docs/云-dev 工具链;发布相关的少数中,vite dev-server 系列 ui-mac 是消费者(仅 `bun run dev` 期暴露,打包 app 不触发) | `bun audit`;audit-full.txt |

## 6.4 新增 P3

| ID | 问题 |
|---|---|
| **D7** | safeStorage 无钥匙串时明文兜底(headless/Linux 风险);`alpha.env` 与 `alpha-pkce.json` 明文落盘(后者短命一次性) |
| **D8** | DB WAL 仅在 open 时 PASSIVE checkpoint,无周期 TRUNCATE(长会话 WAL 常驻 ~4MB) |
| **D9** | 分支命名 DB 累积(dev 机器):`opencode-<branch>.db` 每个开发分支各一份,含完整会话历史,无清理(feat-ui-redesign 6.4M 等孤儿) |
| **D10** | `ui-mac/package.json` 无 license/author、electron-builder 无 copyright;index.ts:82 注释 Electron 41.2 已过期(实际 42.3.3 / Node 24.15.0) |

## 6.5 对既有条目的更新

- **C10** → 由 A6 取代(从"疑"升为"确认"):env 确实继承到 MCP/LSP 子进程。
- **C11**(授权码写日志)→ [确认]:`index.ts:238-241` 整条 deep-link URL(含 code/state)入 main.log,且 `exportDebugLogs` 会打包导出。
- **C1**(IPC 无 sender 校验)→ 安全审计确认并扩充:高权限 handler 清单(spawn/fs/store/密钥写/relaunch)全无 origin 校验 + 无 `setWindowOpenHandler`/`will-navigate`。
- **C2**(persistMcp 只校验 command[0])→ 确认,并补:catalog 条目本身无 hash/签名/钉版本(供应链完整性缺失,放大 A6)。
- **A3**(双份 useAlphaProjects)→ 补运行时维度:每回合 `session.idle` 触发全量 `session.list` × 2、2 条 SSE 全程常驻。

## 6.6 已验证的"非问题"(免除排查)

opencode 是 MIT,**闭源改名商用合法**(B15 只是补声明);流式 markdown 不逐 token 重解析(块级缓存);respawn 无 SSE/client/listener 泄漏(reload 整realm 丢弃);ghostty 懒加载;crash reporter 本地不上传;LGPL(sharp/libvips)只在 docs/云-dev 工具链、被 electron-builder files 白名单挡在发布产物外;catalog 纪律(effect/solid-js 走 catalog:)守得好;PTY WS 有 ticket+origin 或 Basic 鉴权;第三方 MCP 走 npx 运行时拉取不算再分发。

## 6.7 Sprint 更新

新增一个 sprint,其余新条目就近并入:

### S7「工程健康与升级守卫」(1w,可与 S1 并行)→ B10 B17 B18 B19
| Task | 内容 | 验收 |
|---|---|---|
| T7.1 | 修 `sync-upstream.yml`(给 bot `workflows` 权限或调整 token/PAT),恢复 dev 镜像同步 | 定时任务连续绿;dev 追平上游 |
| T7.2 | CI 触发对齐 `alpha`:typecheck.yml/test.yml 加 `alpha` base;给 ui-mac/ext 加 turbo test task | 每个 alpha PR 都跑 typecheck |
| T7.3 | 落 ADR-004 真守卫:CI job 跑 `git diff --diff-filter=DMR dev alpha -- packages/{opencode,app,ui,tui,sdk}` 非空即红 + `alpha`/`dev` 开分支保护(required checks) | 上游文件被改必红灯 |
| T7.4 | alpha 首批测试:ext-config persistMcp 白名单、ext-fs-installer 防逃逸、alpha-endpoints 解析、alpha-models 装配(安全敏感路径优先) | 关键路径有可复现单测 |
| T7.5 | ADR-015 prompt tripwire 接进 sync-upstream(prompt/*.txt 或 agent/* 变更打标签要求人工复核) | 底座变更有提醒 |

### 就近并入现有 sprint
- **S1(启动性能)**:+ B12(Instance 驱逐 + `/`~`` 不建 Instance)、C15(SSE 过滤 + 收窄 timeline observer)。
- **S2(分发就绪)**:+ A7(签名/公证流水线)、B9(更新链完整性 + 关 allowDowngrade)、C16(卸载清理 + app 内数据清除)、C17(schema 版本守卫)、C18(品牌/bundleID/协议名 rebrand)、B15(NOTICE + 关于页)、D9(分支 DB 清理)。**A7 是分发硬阻断,应置 S2 首位。**
- **S3(多租户地基/安全)**:+ **A6(env 白名单透传给子进程——安全首查项)**、C12(CORS pin)、C13(openExternal 白名单)、D7(safeStorage 明文兜底告警)。
- **S4(云协同)**:+ B16(PIPL 同意/隐私政策门)、C19(Sentry opt-out + 告知)。
- **S5(harness)**:+ B14 的 DB 备份/导出可挂此线的"运行时管理器"。
- **新 S8「UX 完整性」(0.5–1w)**:B11(统一错误/健康呈现面 + 渲染 store.error + toast 体系)、B20(弱网:超时/重试/splash 状态/真骨架/websearch 优雅降级)、C20(alpha-ui i18n 补全 + 语言切换生效)、C21(无障碍:focus-trap/键盘/对比度/reduced-motion)。B11 是 B20/C20/C21 的公共底座,先做。

## 6.8 发布前必清(launch-blocker 短名单)

按"上线拦截强度"排序,以下不清不能面向多租户分发:
1. **A7** 签名/公证(否则装不到别人机器)
2. **A6** 秘钥继承给第三方 MCP/LSP(否则任何装的 MCP 偷计费 JWT + 密钥)
3. **B19** sync 已坏 + **B18** CI 从不 gating + **B10** 北极星无守卫(升级继承价值当前实际是断的)
4. **B15** MIT NOTICE/关于页 + **C18** 品牌外泄(合规 + 商标)
5. **B16** 云派发 PIPL 同意门(代码出境前)
6. **B11** 系统性静默失败(用户遇错全程无感,分发后=大量"卡住/白屏"投诉)
7. **B9** 更新链完整性(分发后的 RCE 面)

## 6.9 更新后的分级册规模

P0 = 7(A1-A7);P1 = 20(B1-B20);P2 = 22(C1-C22);P3 = 10(D1-D10)。合计 59 条。

---

# 七、核查修订(audit-of-the-audit,2026-07-02)

> 来源:`docs/audits/2026-07-02-register-verification.md`(9 路只读 agent 逐条 file:line 核实 + 独立扫漏)。
> 纪律:原文(§一~§六)一字不删;本节承载"会改变执行"的修正 + 扫漏新增,**冲突以本节为准**。
> 一句话:59 条无一虚报,但有 **1 处误诊**(B3①)、**1 个整类盲区**(运行时鉴权生命周期)、**系统性归属缺失**——以下逐条落地。

## 7a 修正(改变执行,勿按原文盲跑)

- **R1〔撤回 T1.6 的端点替换〕** — B3① 的"默认端点 `*.workers.dev` 违反 ADR-017、应切 `alphacodeone.com`"**被推翻**:`alpha-config.ts:16-27` 自证 gateway 无自定义域、workers.dev 是唯一实测 `/health`+`/v1/models` 200 的 host,旧 `api.tidelabs.click` 404 所有 /v1。**切域会把模型代理打到不路由 /v1 的 host = 越修越坏。** T1.6 改为:查 token 注入时序(见 A8)+ `*.workers.dev` GFW 可达性(平台治理缺口,非 alpha 决策违规)。web/account 已正确落 `alphacodeone.com`(原报告未认可这点)。旁证:JWKS/ES256 已上线(`alphacodeone.com/api/jwks` 返 ES256),老代理 401 blocker 已解 → 对已登录用户,endpoint 很可能**不是** cloud MCP failed 的头号嫌疑。
- **R2〔归属标注,防破北极星〕** — 以下条目在**上游**(`packages/opencode|core|server`),照 sprint 直接改即破 ADR-005/NON_GOALS#3。只走 alpha 侧杠杆或"接受":
  - **B12** → 停在 `ui-mac/src/main/server.ts:58` 强开 `OPENCODE_EXPERIMENTAL_FILEWATCHER`;+ 删 `/`、`~` 垃圾项目、不取数
  - **B13/B14/C17/D8**(DB 层)→ 恢复本体改不了;备份/导出/版本预检可在 ui-mac main 做纯文件操作落 alpha
  - **C5**(skills 扫描)→ 减少 Instance 数缓解
  - **C12**(CORS)→ 改不了;**且先撤 alpha 自己在 `windows.ts:161-171` 注入的 `ACAO:*`(见 C24)**
  - **A6 泄漏 SITE**(`mcp/index.ts`/`lsp/lsp.ts` 的 `...process.env`)→ 唯一 in-rule 修点 = `createSidecarEnv`(`server.ts:220`)env 白名单(= T3.4)
  - **B20 websearch orDie**(实为 `core/websearch.ts:244`,非报告 :140)→ ADR-009 keyless-for-all 是放大器;env 关闸或自建 tool 替代
- **R3〔A6 提前门控 S1〕** — A6(密钥继承给任意本地 MCP/LSP 子进程)现排 S3,但 S1/T1.4-T1.5 先鼓励装/钉 MCP = 在 env 白名单落地前扩大 A6 攻击面。**T3.4(sidecar env 白名单)提前为 S1 前置**,先于任何 MCP 安装推广。
- **R4〔T2.2 补数据迁移验收〕** — userData 键在 appId(`index.ts:153-155`)、SQLite 键在 InstallationChannel(`database.ts:48-54`)。改 appId/切渠道 → auth/keys 孤儿 + 钥匙串解密失效(ADR-017 先例)+ 开全新 `opencode.db`(既有会话全"消失")。**T2.2 验收追加:旧 userData 与旧后缀 DB 一次性迁移,或明确提示接受丢失。**(已内联进 T2.2 行)
- **R5〔B9 拆行:wrong-owner feed〕** — B9 真尖角不是"缺签名",是**更新 feed owner 错**:prod `publish.owner:"anomalyco",repo:"opencode"`(beta 同)。落 ADR-012"发布走 prod"后:`0.0.0<上游` + `allowDowngrade=true` + 启动即 `updater.start()` → **自动下载上游 OpenCode 覆盖 alpha-code**(第三方控制 payload,alpha 自身无 feed)。**T2.2/T2.1 必须同步改 feed 指自有仓或禁更新器。** 现出货 dev 渠道 `UPDATER_ENABLED=false`,故 prod 前休眠。
- **R6〔降级:dormant / 重复计数〕**(低风险,漏看只是多花力气)— C10 = A6 可信一半(重复计数);C11 泄一次性 PKCE 码非 token;**C19 当前休眠**(`VITE_SENTRY_DSN` 全仓无赋值 → Sentry 从不 init);D7 明文兜底在 macOS-only 是死分支;B13 有 `busy_timeout=5000` 缓解;B1 `-il` 超时短路 → 最坏 ~5s 非 10s;C15 有去抖 + 逐 token no-op;D9 按渠道(prod 单库无累积)。
- **R7〔升级:被低估〕** — **C2** 真尖角是 `args` 不校验 = **配置期 RCE**(非 env/headers),与 A6 同级;**B16** 因登录默认 platform-pays → **每条 prompt 持续出境**,近硬阻断(PIPL);**C14** 实为 232 选择器 / 16 `as any`(非 40+/3),耦合面 ~5-6×;**C20** 残留 "OpenCode" 遍布每语种(zh:19/en:30),非仅繁中。

## 7b 新增条目(核查扫漏,续编号)

**P0**
- **A8** 运行时鉴权/凭证生命周期:env 一次性派生、`respawnSidecar`(`index.ts:418-438`)不重导 → **(a) 过期重登永不恢复代理**(`applyAuthEnv` `alpha-auth.ts:142` 的 `if(!ALPHA_API_KEY)` 保留旧 token;无 refresh 故必踩,B2 隐含的"重登即恢复"无效);**(b) 跨账号 token 串台**(`logout()` `:302-323` 不清 `ALPHA_API_KEY` → 登录 B 后代理仍用 A token 计费)。修:respawn 前重跑派生 + logout 清 token/停代理(扩 T3.1)。

**P1**
- **B21** BYOK 改键/删键不达 sidecar:`setByokKey` 只写钥匙串(`provider-ipc.ts:20`)不 respawn/不重注 env → picker 显"已配置"但模型读 `process.env`(`alpha-models.ts:54`)仍空 → 401 至重启;logout 亦不停运行中 sidecar 的代理/计费。
- **B22** `message-timeline.tsx:481` 崩溃仍开放(06-30 flag,PR#18/19/20 未涉):上游 virtualizer memo,疑被 alpha `timeline-inject` DOM 注入扰动 → 会话主界面崩溃。
- **B23** strict-key 配置致瘫:`config/parse.ts:40-53` 未知 top-level key 硬抛 → 全局 `opencode.jsonc` 失败时 `config.ts:281-289` `orElseSucceed({})` **整份全局配置(MCP/模型/plugin)静默清零**,仅一行 log;B11 的 32 失败点未含此,且 alpha `persistMcp` 持续写同文件叠加风险。

**P2**
- **C23** 云路径潜伏(S4 接线即引爆):SSE 无退避重连循环 + 脆弱 Last-Event-ID(`alpha-cloud-events.ts:37-77`);job 终态后 re-subscribe 永久空转 + `subs` 泄漏(`cloud-ipc.ts:23-33`);`respawnSidecar` 无互斥端口竞争(`index.ts:418-438`,异于 B5)。
- **C24** 无 CSP(`renderer/index.html` + `onHeadersReceived`)**叠加 alpha 强制 `ACAO:*`(`windows.ts:161-171`)** → 即便 `nodeIntegration:false` 挡 RCE,token/会话 exfil 通道仍开;是 C12 的渲染侧对偶。
- **C25** `open-path`(`ipc.ts:188-195`)+ `ext-install-plugin`(`ext-ipc.ts:48` 任意 npm 包入 `plugin[]` 下次启动执行)= C2 同类配置期/exec 触达面,渲染层可达。
- **C26** `alpha-endpoints.ts` 对 discovered/pinned 端点无 https/host 校验(`strip()` 仅去尾斜杠)→ 被篡改响应可把带 bearer 的流量导向 http/攻击 host。
- **C27** 无 Electron fuses/asar-integrity(`RunAsNode` 常开)+ entitlements 过宽(`disable-library-validation`+`allow-dyld-environment-variables` = dylib 注入组合);邻接 A7。
- **C28** placebo 控件 + 无 ErrorBoundary:composer 只读→autoaccept-off(无运行时只读)、effort 可能不改推理;overlay 树一处 throw 静默白屏。

**P3**
- **D11** `store` IPC 的 `name` 未净化 → `../` 可在 userData 外读写(C1 伞下具体穿越)。
- **D12** CI 卫生:合并冲突守卫当前不可达(sync 早死于 dev-push);~20+ 继承上游 cron workflow 在 fork 误触(Actions 分钟燃烧 + 潜在误发布);无 lint gate;e2e 仅 `packages/app`。

## 7c 证据分类(方法论)

以下 `[确认]` 实为**单机遥测**、不可从仓库复现,与代码级 `[确认]` 不同类,排期前重测:A2"1283 次"、A4"152 次"、B1"267ms"、C3"145MB"、B19 连败计数(时效敏感,实为 06-21 起 11 连败)。死引用 1 处:A2 子引用 `bootstrap.ts:312 mcp.status`(符号不存在,不影响 A2 主机制)。

## 7d sprint 影响(增量)

- **S1 前置**:R3(A6/T3.4 env 白名单)先于 MCP 安装推广;T1.6 按 R1 改写(勿切端点)。
- **S2**:T2.2 按 R4+R5(迁移验收 + 改 feed);B22/B23 就近并入(崩溃 + 配置致瘫)。
- **S3**:新增 A8/B21(鉴权生命周期)——扩 T3.1(refresh + respawn 重导 env + logout 清 token);A6 已按 R3 提前。
- **S4**:C23(云潜伏)随 T4.1 接线一并修;C26 端点校验。
- **S8/新**:C24(CSP)、C28(ErrorBoundary/placebo)并入 UX 完整性;D11/D12 卫生。
- **归属**:R2 的上游条目排期时只走 alpha 杠杆,不改 `packages/{opencode,core,server}`。

## 7e 更新后规模

原 59 → **+12 = 71**:P0×8(+A8)、P1×23(+B21/B22/B23)、P2×28(+C23-C28)、P3×12(+D11/D12);另修正 7 条(R1-R7,不新增计数)。

## 7f 实施进度(2026-07-02,本会话)

**已落地并验证**(经短命 PR,ADR-005;均只碰 `packages/ui-mac` alpha 自有文件):
- **批 1 — 安全 quick-wins**:C11 深链日志脱敏、C13 open-link scheme 白名单、C2 persistMcp args/env/headers 值校验、C26 端点 https 守卫、T1.7 `OPENCODE_DISABLE_MODELS_FETCH=1` 默认。→ PR #22 / `dda04778`。typecheck 通过 + 隔离 dev 冒烟(运行时 `Loaded models.dev snapshot`、渲染干净、无崩溃)。
- **批 2 — S1 启动性能**:A1 窗口先行(await `serverReady` 而非 health-gated fiber)、A2 `useExtensions` 惰性(门控 hub `open`、首开 latch)、A3 `session.list roots:true` + `loadProjects` 跳过 `/` 全局 worktree。→ PR #23 / `f61fa785`。typecheck + 隔离 dev + CDP 验证(日志 `server ready`;hub 开后 7 tab + catalog 内容;侧栏/首页渲染干净)。

**Deferred / 待办**(未动代码,留 backlog):
- **A3 剩余**:`useAlphaProjects` 单例化(sidebar+home 去重,消 2× 取数)+ `session.idle` 去抖 —— Solid ownership / 状态改动,需单独设计与验证。
- **A6 / A8**(env 白名单 + 鉴权生命周期)—— **需登录态端到端验证**(隔离 `:memory:` 模式覆盖不到 代理/BYOK/计费 路径),错改会破真实代理,故未在不可验证的启动冒烟上落地;待验证方案定后再做。

**归属校验**:本会话改动全在 `packages/ui-mac`;`git diff dev..alpha -- packages/{opencode,core,server,app,ui,tui,sdk}` 仍应为空(唯一既有越界 = 根 `.gitignore` 一行,见 B10)。

## 7g 实施进度续(批 3-6,2026-07-02)

继 §7f,同一会话继续落地(全部经短命 PR、typecheck、隔离 dev±CDP 验证;均只碰 `packages/ui-mac`):
- **批 3 — B11 静默失败呈现面**:侧栏渲染 `store.error` + 重试(新增 `reload`)、首条消息 create 失败 keep-text+toast(不再静默丢失)。→ PR #24 / `6a44a410`。isolated boot 无回归。
- **批 4 — C1 导航/store 硬化**:`setWindowOpenHandler`(deny+externalize)、`will-navigate` 仅同源(复用 `isRendererUrl`)、`getStore` name 路径穿越守卫。→ PR #25 / `5f33c500`。boot 加载自身 origin 正常。
- **批 5 — A3 共享 store**:`useAlphaProjects` 提升到公共父(`index.tsx`),sidebar+home 消费同一实例(消 2× project.list/session.list + 重复 SSE)。→ PR #26 / `e1f7cbd4`。boot 无回归(byte-identical);dedup 结构性保证。
- **批 6 — B15 MIT NOTICE + 关于面板**:`resources/NOTICE.txt`(MIT 全文)+ extraResources 随包发 + `copyright` + `setAboutPanelOptions`。→ PR #27 / `1e3aad60`。config/typecheck 级(打包落地待 `package:mac`)。

**本会话累计**:6 PR merged(#22 安全 quick-wins / #23 S1 启动 / #24 B11 / #25 C1 / #26 A3 / #27 B15)。

**北极星复核(6 批后)**:`git diff dev..alpha -- packages/{opencode,core,server,app,ui,tui,sdk}` = 空;越界上游文件仍只有 `.gitignore`(既有,B10)+ `bun.lock`(allowlist)。**6 批零新增上游改动。**

**仍 deferred / 未做(按需你在场)**:
- **A6 / A8**(env 白名单 + 鉴权生命周期)—— 需登录态端到端验证;A6 真解非简单白名单(密钥是 sidecar 自用、泄漏点在上游 spawn,盲改破真实代理)。**登录后再做。**
- **A3 `session.idle` 去抖**(小);**B11-b 账户 banner 态**(状态联合改动 + 隔离模式够不到 picker)。
- **C18 品牌 rebrand / A5 版本链 / A7 签名公证 / B9 wrong-owner feed** —— 需产品决策 + 打包构建(C18 改 appId/渠道会触发 T2.2 数据迁移陷阱,见 R4)。
- **C24 CSP** —— 风险:可能断 renderer,需仔细 CSP + 充分验证。
- **B16 PIPL 同意 / C9 数据边界** —— 产品/法务决策。
- **B17 测试 / B18 CI gating / B19 sync 修复** —— CI 基建;B19 是一行改但需 bot token `workflows` 权限(仓库设置/PAT,非纯代码),且触发全量 sync = 把 dev 快进 13 天并入 alpha(大动作,撞 C14 耦合面,应你在场再做)。

## 7h 收尾 + 批 7(S7 工程健康与升级守卫,2026-07-02 续会话)

**先补记 §7g 之后已落地(上一轮尾巴,当时 §7g 记为 deferred,实际已发)**:
- **A8 鉴权/凭证生命周期**(§7b 新增 P0):`applyAuthEnv` 权威化 + `respawnSidecar` 前重导 env + `logout()` 清 `ALPHA_API_KEY` 并停代理 → 重登恢复、跨账号不串台。→ **PR #29 / `9c766b6e`**;登录态 live 验证(driving `window.api.auth.logout()` → 日志见 `respawning sidecar (proxy activation)`,基线 respawn=0)。
- **UC 协议门控**:`setAsDefaultProtocolClient` 收敛到 `app.isPackaged`(dev 不抢注 `alpha-code://`)。→ `41c10f42`。
- **docs**:问题分级册(§一~§七)+ 审计 trail 入库。→ PR #28 / `a801cf61`。
- 上一轮合计 **8 PR(#22–#29)+ 1 UC**;北极星复核 = 上游包零改动(唯一越界仍 `.gitignore`/`bun.lock`)。

**本会话批 7 — S7 升级守卫 + 首批测试(全部纯新增 alpha 文件 / alpha 自有 workflow;零改上游源码)**:
- **T7.4 首批安全路径单测(B17)** — `bun test`(ui-mac):`ext-config.test.ts`(persistMcp/persistProvider/persistPlugin 的 C2 配置期-RCE 守卫:字段/命令头白名单、`node -e`/`python -c`/`deno eval` inline-eval flag 拒绝、loopback/https-only URL、`NODE_OPTIONS`/`LD_PRELOAD`/`DYLD_*` 危险 env 拒绝、shell-metachar 包名拒绝)、`alpha-endpoints.test.ts`(C26 `strip()` https/host 守卫:env/pin/discovery 三层精度 + 篡改 http 回退默认)、`ext-fs-installer.test.ts`(路径逃逸:name/asset-key 白名单,electron `app` mock)。**71 pass / 0 fail**。`test` 脚本落 ui-mac `package.json`。
- **T7.3 北极星 CI 守卫(B10)** — 新 `.github/workflows/alpha-ci.yml` job `upstream-guard`:`git diff --diff-filter=DMR origin/dev...HEAD -- packages/{opencode,core,server,app,ui,tui,sdk}` 非空即红。用 merge-base 三点 diff 量"alpha 自身 delta",dev 领先时不误报。**本地实测 clean(guard PASS);仅 `.gitignore`/`bun.lock` 在守卫路径外**。首次机械化守卫 ADR-004 的"冲突文件数=0"。
- **T7.2 alpha CI gating(B18)** — 同 workflow 另两 job:`typecheck`(ui-mac + ext)、`test`(ui-mac bun test),触发 `push`/`pull_request` → `alpha`。**不编辑上游 `test.yml`/`typecheck.yml`**(编辑即破北极星)——新增 alpha 自有 workflow。required-check 需仓库设置(owner 开)。
- **T7.5 ADR-015 prompt tripwire** — `sync-upstream.yml` 加一步:sync 触碰 `packages/opencode/src/session/prompt` 或 `.../agent` 时发 `::warning::` + step summary 要求人工复核 `alpha-behavior`/`alpha-identity`/`.opencode/agent`(不阻断同步)。SHA 均自 `git rev-parse`(无注入面)。
- **C28 全局 ErrorBoundary —— 实测撤回,前提被证伪(重要发现)**:本会话尝试在 alpha 渲染根裹 SolidJS `<ErrorBoundary>`,隔离 dev + CDP 强制注入 throw 核验时发现:**`@opencode-ai/app` 已自带一个更内层的 ErrorBoundary**,先于 alpha 顶层边界捕获 App 树内所有 throw → 我方顶层边界**永不生效**(冗余)。C28 原判"无 ErrorBoundary → throw 静默白屏"**不成立**——上游早有边界、不白屏。故本次**撤回 C28 提交**(`git reset`,零残留),只发 S7。
  - **↳ 新发现(改 C28 的真问题定义)**:上游那块崩溃屏是 **OpenCode 品牌**——"请将此错误报告给 **OpenCode 团队** 在 **Discord** 上",且**版本显示 `0.0.0`**(A5 版本链 bug 的又一暴露面)。**真正的 C28 应改写为**:① 品牌化/覆盖上游崩溃屏(引流去 OpenCode Discord = C18/C20 品牌外泄);② 若要 alpha 分支型崩溃恢复,须把边界下沉到 `AppInterface` 内、紧裹 alpha children(比上游边界更近才会赢)。二者都需设计 + 二次核验,**降级为独立 UX/品牌任务(deferred)**,不塞进本收尾会话。

**验证**:typecheck(ui-mac + ext)+ `bun test` 71 pass + guard 命令本地 PASS + YAML 解析 OK + 隔离 dev + CDP 冒烟(正常引导页渲染、`hasCrashScreen=false`;强制 throw 暴露上游边界 = 上述发现)。**北极星复核**:`git diff --diff-filter=DMR origin/dev...HEAD -- packages/{opencode,core,server,app,ui,tui,sdk}` = 空。

**清掉的 launch-blocker 代码面**:B10(北极星现有机械守卫)、B18(alpha PR 现跑 CI)、B17(0→71 安全路径单测)。**仍需 owner/仓库设置**:开 required-checks(让守卫真拦 merge)、B19 sync 修复(bot `workflows` 权限)、B7 发版流水线 CI 断言(T2.6,待 S2 打包)。
