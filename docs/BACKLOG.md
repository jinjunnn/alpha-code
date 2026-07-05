# BACKLOG — 工作项单一真源

> **状态只在本文件翻转**;流程与模板见 [`PROCESS.md`](PROCESS.md)(权威决策 ADR-018)。
> 状态:`registered / ready / in-sprint / shipped / verified / archived`;旁路 `parked / rejected / dup`。
> 类:feature / bug / debt / security / perf / ux / docs / spike。仓:A=alpha-code · B=alpha-platform · C=alpha-web · X=跨仓。
> 证据文档:**册** = [`plans/2026-07-02-problem-register-sprints-review.md`](plans/2026-07-02-problem-register-sprints-review.md)(71 项 + R1-R7 修正 + §7f-7j 实施日志);**核查** = [`audits/2026-07-02-register-verification.md`](audits/2026-07-02-register-verification.md);**E 册** = [`harness-extension-backlog.md`](harness-extension-backlog.md)。
> 下一个新需求编号:**REQ-030**(新需求一律 REQ-NNN;A/B/C/D/E 为历史审计系列保留原号,用户 2026-07-03 确认)。
> **需求文件全覆盖(2026-07-03)**:全部开放的 A/B/C/D 条目已逐条建档 `requirements/<ID>-<slug>.md`(含验收标准),行内备注为摘要、**文件为验收真源**;E 系列以冻结 E 册为分析文档;parked/dup 项不建档。

## 发布短名单(launch-blockers,册 §6.8)

| # | 项 | 现状 |
|---|---|---|
| 1 | A7 签名/公证 | ✅ verified(v0.1.0) |
| 2 | **A6 秘钥继承给第三方 MCP/LSP** | ✅ **verified(2026-07-05,R3 解除)** |
| 3 | B19 sync + B18 CI + B10 北极星守卫 | ✅ verified |
| 4 | B15 NOTICE + C18 品牌 | ✅ shipped / verified |
| 5 | B16 云派发 PIPL 同意门 | ⏸️ parked(用户搁置) |
| 6 | B11 系统性静默失败 | ✅ shipped(统一呈现底座 PR #60 + 复扫 20 项);verified 待视觉批;余项随 B20(2026-07-05 retro 修正陈旧行) |
| 7 | B9 更新链完整性 | ✅ shipped(PR #47:降级闸关闭 + 完整性链文档化);verified 待下个真实发版实测(2026-07-05 retro 修正陈旧行) |

## ⚖️ 待拍板队列(需用户方案决策 —— 非 blocked,开工提案时必须附上提醒)

| 决策点 | 载体 | 影响 |
|---|---|---|
| B16 PIPL 同意门重启时机(现 parked;云派发/公开分发前必须) | B16 | 合规,发布节奏 |

> 拍板即从队列划掉、结论写进对应需求文件;执行中撞到未拍板点 = 停下来问,不代替决策。
> **S17 已拍板划掉(2026-07-05)**:T1 = REQ-008 五连拍 + REQ-011 预留位([debates/req008](debates/2026-07-05-req008-positioning-briefs.md));T4 = C28 控件三选一(只读移除/effort 改文案,[debates/c28-brief](debates/2026-07-05-c28-honest-controls-brief.md));T5 = B12 filewatcher(默认开+可关,拍板入档)。**B16 提醒**:非技术用户入画像 + 云派发已实际可用 → 重启条件临近,维持 parked 等用户拍重启时机。

## Active — P0

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| A2 | catalog MCP 全部钉精确版本 + 存量配置一键钉版本(T1.5) | security/perf | A | shipped | **S12 完成**:catalog 全条目钉版本(2026-07-03)+ **存量一键钉迁移随 T3 迁移引擎落地(PR #71)**——迁移复用 catalog 已钉版本重装,旧位净除。**verified 待真机迁移开门演练**(`ALPHA_MIGRATE_ENABLE=1`,随 A6 R3 解锁,REQ-016 同场)。R3 澄清:catalog 钉版本≠推广安装、不扩 A6 面 |

## Active — P1

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| REQ-002 | 平台↔alpha-code 代理联调:E2E 打通并计量出数 | feature | X | shipped | **S9;核心链路 verified**(登录→platform→真实模型流式→计量出数,4 次调用一致累加);修 3 断点:BP-1 网关流式计量 waitUntil 缺位(B,`6fe49f3` prod 部署)· BP-2 冷启动登录态丢失(A,待重打包 verify ④)· BP-3→REQ-014;证据 [audits/2026-07-03-req002](audits/2026-07-03-req002-proxy-e2e.md);④ token 过期(B2)/logout 复验未做 |
| REQ-003 | 网关 SSE 流式健壮性:卡顿/断连/重连/心跳审查与加固 | debt | X | shipped | **PR #50**;审查报告 [audits/2026-07-03-req003](audits/2026-07-03-req003-sse-robustness.md)(链路1 B 侧已健壮,2 建议项留档;链路2 C23 四病灶全修+90s 悬挂回收,7 单测);**C23 随本批关闭**;弱网 UI 呈现 → 真机批+B11;详见 [requirements/REQ-003](requirements/REQ-003-gateway-sse-robustness.md) |
| REQ-012 | 上游同步前端回归防护:锚点契约测试 + sync tripwire + post-sync 视觉冒烟 gate | debt | A | shipped | **PR #44**;范围拍板=锚点存在性 only(像素基线不做);清单 195 alive/4 dead + 5 用例契约测试 + sync tripwire + 发版 runbook ⓪ 步;**首跑即修正原审计:94 死→真死 4(session-ui 搬包)+ v0.1.0 回放 0 名字级死→结构性断裂假说上位**(审计修正节);详见 [requirements/REQ-012](requirements/REQ-012-frontend-sync-regression-guard.md) |
| B2 | refresh token 续期 + 401 拦截 + 失败降级 BYOK/登出(T3.1 剩余) | feature | A | shipped | **PR #42 + alpha-web `a1d4d8a`**;寿命拍板 7*24h(env 可调短测试)+ 提前量续期(整点 tick)+ 401 拦截重试 + invalid_grant 降级登出(明确 UI)+ 冻结 token 快死备胎 respawn;REQ-002④ 过期路径就此成型;134 tests 绿;**verified 待真机**(短 TTL 实测 过期→续期/撤销→降级/logout 不串台);详见 [requirements/B2](requirements/B2-refresh-token.md) |
| B3 | 云协同最后一公里:cloud MCP 健康 → dispatch → 进度 → artifact 回流(=G4、E12;T4.1-4.3) | feature | X | shipped | **S11 T2(PR #55+#58)**:回流全链落地——主进程 `alpha-workdir.ts`(`.alpha/runs/<runId>/`,防逃逸/消毒/体积帽)+ `cloud-save-run` IPC(#55);renderer `CloudRunWatcher`(firehose tool-part 终态检测 → saveRun → toast,worktree 映射,纯解析核 10 单测)+ i18n(#58);呈现=会话内工具调用(验收④,引擎原生);**verified 待真机**:登录态 in-app dispatch 冒烟(兼 REQ-004 verified);配额预估 UI(验收⑥后半)→ T4/B11 账户 banner 一并;**R1:勿切端点** |
| B4 | 巨型目录当项目(`/`、`~`、`~/Documents` 建 Instance)治理 | perf | A | shipped | **S17 T5 shipped(2026-07-05)**:数据层过滤(`worktree-filter.ts` 谓词+11 单测)——"/"+macOS home 根默认不纳入、hidden(归档)零请求(不 fetch→引擎不建 Instance);归档即时生效;会话事件循环守卫;~/Documents 级留手动归档;已知限制 unhide 无 UI(记档);**verified 待**冷启动日志复核+watcher 数实测(→真机批);详见 [requirements/B4](requirements/B4-giant-dir-projects.md) |
| B6 | 装载 `@alpha-code/ext` 主接缝(=G1;T5.1-5.2) | feature | A | shipped | **PR #46**;extraResources alpha-ext/ + StartCommand 传路径 + injectAlphaConfig 合并 V1 `plugin` 数组;ALPHA_EXT_DISABLE 逃生;**bundle 打包态加载已核(2026-07-05,REQ-016 S16)**:main.log `alpha-ext: loading plugin bundle` from Resources/alpha-ext/plugin.js(410KB);**verified 待** alpha_ping in-session 执行(G1 成功条件,残余);详见 [requirements/B6](requirements/B6-ext-seam-activation.md) |
| B7 | 发布流水线制度化:CI 断言版本/种子资产/断网首启 smoke(T2.6 剩余) | debt | A | ready | **验收② shipped(PR #85)**:`scripts/assert-seed-assets.sh` + advisory `seed-assets` job 断言 extraResources 源资产(vendored agent/plugin·skills·NOTICE.txt/B15·签名)存在,静默删除即红;①版本断言(release-time)③断网首启 smoke⑤注入 0.0.0 验证 = 需 build+launch → 真机批;DISTRIBUTION.md 已写 |
| B8 | 扩展物运行时生命周期:版本/健康/更新三要素(T5.4/T5.6) | feature | A | registered | 系统性条目,症状=A2;终态=定制中心从商店→运行时管理器;**具体实现路径已立 = REQ-018(账本/生效)+ REQ-019(详情/更新),B8 保留为终态验收视角** |
| B9 | 更新链完整性:关 `allowDowngrade` + feed 完整性校验 | security | A | shipped | **PR #47**(→ [S10](sprints/2026-07-03-s10-hardening/sprint.md));降级闸关闭(理由入注释:单 prod 渠道无跨渠道降级需求;旧版逃生=手动 dmg);完整性链文档化(yml sha512 → zip → 签名同 identity → 降级闸);**verified 待下个真实发版**(自动更新实测 + 篡改 yml 拒装用例);详见 [requirements/B9](requirements/B9-update-chain-integrity.md) |
| B11 | 统一错误/健康呈现面 + 账户 banner(S8 底座) | ux | A | shipped | **S11 T4(PR #60)**:Banner 基元 + pushToast 唯一出口(hub 私有 toast 收编)+ 首页/hub store.error banner + 账户 error 判别式(#1 误显根治,picker error 态+重试;侧栏会员行不装「未订阅」)+ **B23 configHealth**(语法错/未知顶键 → warning banner,5 单测)+ splash 状态行(B20);复扫矩阵 20 项:✅10/🆗6/⏭4([audits/rescan](audits/2026-07-04-silent-failure-rescan.md));⏭4(会话操作 toast/登录链事件/骨架/连崩呈现)留行内追;**verified 待视觉批**(banner/toast 截图) |
| B12 | Instance 不驱逐 + 递归 watcher 常驻 | perf | A | shipped | **S17 T5 拍板+落地(2026-07-05)**:影响清单代码实证(watcher 只供外部变更感知;agent 自身修改不受影响)→ 拍板=默认开+可关——实验 flag 改 set-if-unset(`export =false` 即关,修硬覆盖矛盾);内存主治=B4 减 Instance;上游本体接受(R2);**verified 待**长时内存/watcher 数实测(→真机批);详见 [requirements/B12](requirements/B12-instance-eviction.md) |
| B13 | DB 跨进程并发(SQLITE_BUSY → orDie) | debt | A | registered | 上游归属(R2);R6 降级:busy_timeout=5000 已缓解;alpha 无直接修点 |
| B14 | 会话 DB 备份/导出(损坏恢复) | feature | A | shipped | **S17 T3 shipped(2026-07-05)**:备份引擎=readonly `VACUUM INTO`+必验(验不过即删,反 placebo——实证 `-readonly .backup` 静默假成功)+滚动保 5;自动触发=pre-migration 时点;手动入口=「数据」菜单(备份/导出…/打开文件夹,dev 置灰);损坏启动指向最近备份恢复(WAL 残件连带隔离);④ 同屏入口随 C16;**verified 待真机**(菜单实操+原生对话框);设计 [designs/db-safety-belt](designs/2026-07-05-db-safety-belt.md);详见 [requirements/B14](requirements/B14-db-backup-export.md) |
| B20 | 弱网降级 UX:超时/重试/splash 状态/真骨架/websearch 优雅降级(S8) | ux | A | ready | **S11 已收尾,余项转回 ready**;S11 T4 部分随 PR #60(splash 状态行 + banner/重试底座);余项=真骨架(Skeleton 死代码去留)/promptAsync 超时(豁免记录)/websearch(上游 R2 豁免),见 [audits/rescan](audits/2026-07-04-silent-failure-rescan.md) ⏭/🆗 行 |
| B21 | BYOK 改键/删键即时生效(触发重注 env/respawn) | bug | A | shipped | **PR #48**;根因=env 桥 set-if-unset 滞留旧 key;修=自有注入权威覆盖/清除(用户值永不动,纯逻辑 5 单测)+ 改键回调触发重注+respawn;删键即时吊销;**verified 待真机**(改键→picker 即时反映→新 key 出账);详见 [requirements/B21](requirements/B21-byok-key-live-reload.md) |
| B22 | message-timeline.tsx:481 会话时间线崩溃 | bug | A | ready | **代码复验完成(/loop 2026-07-04)**::481 现为 `virtualItemByKey` memo,上游 546-sync 已变现症或已异;疑源收敛=`timeline-inject.decorateDirOutput`(隐藏 Solid 子节点最可疑)>`decorateTurns` divider;**真机复现是修复前置**(崩溃类必须能复现才能证明修好)→ 真机批;详见 [requirements/B22](requirements/B22-timeline-crash.md) |
| B23 | strict-key 配置致瘫:全局 jsonc 解析失败 → 整份配置静默清零 | bug | A | shipped | **S11 T4(PR #60)呈现半边落地**:`configHealth()`(语法错 + 未知顶层 key 双病灶,V1 顶键集自引擎 schema;5 单测)→ AlphaHome warning banner + 打开配置;写前校验(C2)继续挡 alpha 自写;上游清零行为本体不可改(R2);**verified 待视觉批**(故意写坏配置截图) |
| REQ-016 | 真机验证收尾批:原 4 项 + S12–S15 全部真机递延 | spike | X | shipped | **主体 shipped(2026-07-05,S16)**:重 ship 签名包 → A6(解 R3)/REQ-018/019/020/021/023/006/011/001/B1/D1/B6 逐项翻 verified;**ADR-014 v3 + ADR-022 转 accepted**;修 P1 卸载静默失败 bug。**残余(留用户批 / 下批)**:B2 短TTL、logout、迁移开门(需 flag 重启)、回流 saveRun、卸 uv 像素、git 真克隆、dispose 打断、B22/REQ-014 复现、banner 冷启动、B6 alpha_ping in-session。证据 [audits/2026-07-05-req016](audits/2026-07-05-req016-realmachine-batch/verify.md);详见 [requirements/REQ-016](requirements/REQ-016-realmachine-verify-batch.md) |
| REQ-027 | typecheck 关双假绿:`bun --cwd X run Y` 在 bun 1.3.x 打印 usage 后静默退出 0、不执行脚本(alpha-check + alpha-ci 同写法) | bug | A | shipped | **S17 T2 证据纪律顺带发现+同 PR 修复(2026-07-05)**:hook 全量输出暴露 usage dump → 探针实证(植入型错 `--cwd…run` exit 0 vs `cd…run` exit 2;不存在脚本亦 0)+ CI 日志同 dump(run 28733810318);修=flag 移 `run` 后 ×(alpha-check.sh 两处 / alpha-ci.yml 三处 / CLAUDE.md dev 命令);verified=红绿探针在册 + 本 PR CI 日志无 dump 复核;快车道无档 |

## Active — P2(债务)

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| REQ-004 | `.alpha` 项目工作目录:桥接验证 + 回填 ADR-019 | spike | A | shipped | **S11 T1 完成(PR #54)**:config 注入 CONFIRMED(生产在用)+ symlink 桥 CONFIRMED(引擎同款 glob fixture 6/6,整目录链/多跳链均通,one-hop 假说证伪);双写回退不启用;schema/gitignore 已回填 ADR-019 修订;证据 [audits/req004-spike](audits/2026-07-03-req004-alpha-bridge-spike.md);**verified 待 B3 T2 打包态 in-app 冒烟**;详见 [requirements/REQ-004](requirements/REQ-004-alpha-workdir-spike.md) |
| REQ-014 | 悬空会话路由致「Not found」白屏 → 路由恢复前校验会话存在 | bug | A | ready | **复现达成(2026-07-05,S17 T4 顺带活捉)**:变体形态 B——旧格式 `tabs.recent`(无 dir 段)→ route.dir=undefined → 上游 titlebar 崩 → **整屏** ErrorPage 循环;整屏态 alpha 子组件全不挂 → 方案①守卫无效、**方案② main 预清实证可达**(删 global store 毒键即愈);证据+建议 [audits/s17-t4 §2](audits/2026-07-05-s17-t4-c28/verify.md)、档内复现记录;修法拍板就绪。历史:REQ-002 联调 BP-3;`tabs.recent` 指向已删会话 → 冷启动整屏 Not found 无恢复入口;**(/loop 2026-07-04 调查·deferred)**:原设「alpha 恢复层」杠杆不存在——恢复由上游冻结 `tabs.tsx` 主理;修法 renderer 守卫①vs main 预清 store② 需拍板,取决于 Not found 整屏/布局内(须真机复现)+ ② 触碰 base64 路由编码耦合(ADR-008);→ 并入 [[REQ-016]] 真机复现后定夺;详见 [requirements/REQ-014](requirements/REQ-014-dangling-session-blank-screen.md) 调查记录 |
| REQ-005 | 前端接管收尾核验:重型引擎换肤(终端/diff/权限流)完成度 + timeline 验收尾项(截图归档/COUPLING 清单/真机验收) | ux | A | ready | ADR-016 待办②;tasks.md 40 项全勾但 dev-plan:98-100 未走完;COUPLING 清单关系 C14;详见 [requirements/REQ-005](requirements/REQ-005-frontend-takeover-closeout.md) |
| REQ-009 | alpha-ci 提速:guard partial clone + bun 依赖缓存 | debt | A | shipped | **PR #85(bun 缓存半)**:typecheck/test 两 job 加 `actions/cache`(key=`bun.lock`)→ 复用全局模块缓存,miss 回退全装零风险。**partial-clone 半递延**:`filter:blob:none` 有静默削弱 north-star guard 之虞,须验收③回归用例在真 CI run 确认仍拦上游改动,不可无人值守验;≤2min 实测(验收④)同待真 CI;详见 [requirements/REQ-009](requirements/REQ-009-alpha-ci-speedup.md) |
| REQ-024 | 自动化 A2 增强:standard 可写档 + LLM 辅助解析 + 连败熔断 + 立即运行 + 预算/历史 UI | feature | A | registered | 自 REQ-021 A2 拆出(2026-07-05);前置 = REQ-021 A1 verified(REQ-016 E 组);详见 [requirements/REQ-024](requirements/REQ-024-automations-a2-enhancements.md) |
| REQ-025 | 自动化 A3 云档位:execution:cloud 注册到 B + 开机拉回 + 数据边界提示 | feature | X | registered | 自 REQ-021 A3 拆出(2026-07-05);**B 侧硬阻塞**:REQ-022/PA-28 proposed 未实现 + PA-27 三 P0(AR-1/2/3)in-progress + B16 parked;激活条件 = REQ-022 shipped;详见 [requirements/REQ-025](requirements/REQ-025-automations-a3-cloud.md) |
| REQ-026 | 面向非技术用户的规范文档(D3 下沉拍板分期第一步:安装→登录→对话 + 常见错误 FAQ) | docs | X | registered | 自 REQ-008 D3 拍板(2026-07-05):小白正式入画像,当前只做文档、新手引导/支持面暂缓;落点(in-app 帮助 vs alpha-web)待 C 仓进度定;详见 [requirements/REQ-026](requirements/REQ-026-nontech-user-docs.md) |
| REQ-028 | composer 真只读档:引擎 plan agent 通道 + 切换 UX | feature | A | registered | 自 C28 拍板拆出(2026-07-05):假只读已移除;通道=agent.cycle 循环+观察(脆,customAgents 门控)或 config 注入 readonly agent,sync 时复查上游有无直设命令;详见 [requirements/REQ-028](requirements/REQ-028-composer-true-readonly.md) |
| REQ-029 | composer effort 接入 model variants:逐模型参数档 + B 侧透传核实 + chip 驱动 | feature | X | registered | 自 C28 拍板拆出(2026-07-05):chip 已改文案保留;引擎通道实证(llm/request.ts variants merge + model.variant.cycle 命令),缺口=alpha 模型 config 无 variants 定义 + B 侧 thinking 参数透传待核(硬前置);详见 [requirements/REQ-029](requirements/REQ-029-effort-model-variants.md) |
| REQ-022 | 云端定时执行(B 侧):CF cron trigger + schedule registry + 到期 dispatch + A 拉回契约 | feature | B | registered | **用户拍板 2026-07-04 立项 B 仓**;B 侧真源 = alpha-platform `designs/2026-07-04-cloud-scheduled-automations.md`(PA-28 proposed);前置 PA-27 P0 整改 + REQ-020 T1;详见 [requirements/REQ-022](requirements/REQ-022-cloud-schedules-platform.md) |
| C3 | 日志治理:opencode.log 145MB 轮转 + netlog 改 opt-in(T2.5) | debt | A | shipped | **PR #35**(→ [s9b](sprints/2026-07-03-s9b-hygiene/sprint.md));`logging.ts`:netlog opt-in(`ALPHA_NETLOG=1` 默认关)+ opencode.log 启动期超限归档(25MB,留最近 3 份);typecheck+97 tests 绿,轮转逻辑合成文件 E2E 6/6 过;**verified 待**运行期首次打包启动真机轮转 |
| C5 | skills 每 Instance 重复扫描 | perf | A | registered | 上游(R2);杠杆=减 Instance 数(B4/B12) |
| C8 | ADR-002 sidecar 语义修订:承认 main-IPC 为桌面等价物(T6.4) | docs | A | shipped | **(/loop 2026-07-04)** ADR-002 追加修订(main-IPC = 桌面 sidecar 等价物 + 真 HTTP sidecar 触发条件 YAGNI)+ GLOSSARY sidecar 词条同步 + ARCHITECTURE 硬约束③措辞复核(依旧成立,无需改);详见 [requirements/C8](requirements/C8-adr002-sidecar-semantics.md) |
| C9 | 代码上云数据边界 mini-ADR:diff-only/secrets 过滤/consent/体积上限(T4.5) | security | X | shipped | **S11 T3 完成(PR #56)= [ADR-021](../.claude/rules/adrs/ADR-021-cloud-data-boundary.md)**:显式通道 diff-only+1MB 帽+secrets 拒发(落点 dispatchCloudJob,待实现随 B3 记账)· 隐式通道=告知+BYOK 逃生(不装过滤)· consent 双挂钩留 B16 拍时机;与 B16 分工写明,B16 重启零返工 |
| C14 | 升级静默破坏面:232 选择器 / 23 处 `as any`;薄 re-export 收敛层(ADR-016 待办①) | debt | A | shipped | **S11 T8(PR #62)**:① `alpha-ui/providers.ts` 薄层建立(组件不得直 import @opencode-ai/app,复核 grep 在册)③ as any 清点 23 处=同一类 SDK codegen 偏斜,双文件契约锚(逐处手写类型不做=第二耦合面)④ brand/patch transform 默认 strict(打偏 build 红,`ALPHA_PATCH_LENIENT=1` 逃生)② 选择器载体=REQ-012 锚点+重指时机收敛到 re-freeze(ADR-020 §5);data-alpha-* 全量重打点不做(冻结使收益消失);详录 [audits/c14](audits/2026-07-04-c14-coupling-convergence.md) |
| C15 | 运行时 SSE/DOM 浪费:firehose 裸遍历 + body 全子树 MutationObserver 收窄 | perf | A | ready | R6:有去抖,影响弱于字面;含 A3 尾项:`session.idle` 全量 session.list 去抖(册 §7g deferred);**(/loop 2026-07-04 defer)** 触多注入组件+漏更新回归风险,验收④需真机 CPU 对比,ROI 低 → 性能专项,详见档 |
| C16 | 卸载残留 ≈0.8GB 含凭证:清理方案 + app 内数据清除入口 | debt | A | ready | |
| C17 | schema 版本兼容守卫(旧 app × 新 DB) | debt | A | shipped | **S17 T3 shipped(2026-07-05)**:初次 spawn 前预检——DB 超前(未知迁移)→ 阻断对话框〔退出推荐/备份后继续/直接继续〕,不静默继续;将前进 → pre-migration 自动备份;守卫故障 fail-open;支持面清单=构建期派生 JSON 进包(零运行时 import core,硬约束②);34 单测含真 sqlite3 降级场景 fixture;**verified 待打包态演练**(原生对话框 → 真机批);详见 [requirements/C17](requirements/C17-schema-version-guard.md) |
| C20 | alpha-ui i18n 断裂:9 组件硬编码简中 + 每语种 OpenCode 残留(zh:19/en:30)(S8) | ux | A | ready | R7:爆炸半径大于初报;**(/loop 2026-07-04 defer)** 体量大(9 组件)+ 需双语视觉核验(离线不可做)→ i18n 专项;可先拆 brand-i18n 残留 grep 清零子任务,详见档 |
| C21 | 无障碍:focus-trap/键盘/Escape/对比度/reduced-motion(S8) | ux | A | ready | |
| C22 | 依赖漏洞:bun audit 158(2 crit/45 high),多在 dev 工具链 | debt | A | registered | **复扫(/loop 2026-07-04)**:进发布产物的高危面 = 单一包 DOMPurify 3.3.1(moderate/low XSS),在**冻结 `packages/ui`+上游 `session-ui`** → **改不了**(破 ADR-020/北极星);唯一通道=re-freeze 或接受;可利用性推测偏低未证实;定期复扫挂 B7;详见 [requirements/C22](requirements/C22-dep-vulns.md) |
| C23 | 云 SSE 退避/重连/终态判定/`subs` 泄漏(NEW-2/3/4) | debt | A | dup | **→ REQ-003 已修全部四病灶(PR #50)**;respawn 互斥(NEW-4)已随 B5(PR #48) |
| C25 | `open-path` + `ext-install-plugin` exec 触达面收紧 | security | A | shipped | **S11 T7(PR #61)**:`open -a` 收紧为编辑器/查看器白名单(白名单外降级系统默认打开,Terminal 类 exec 原语关闭);plugin 半边核实 SAFE_PACKAGE 已挡 URL/路径(无需改);verified 随打包走查 |
| C28 | placebo 控件诚实化(composer 只读/effort)+ 崩溃屏接管设计 | ux | A | shipped | **S17 T4 shipped(2026-07-05)**:①控件拍板+实施——只读档移除(与 ask 引擎行为完全相同,真只读→REQ-028)/ effort 改文案保留(「预设·暂未接入」,真接入→REQ-029);②AlphaBoundary 下沉边界紧裹 10 注入件(alpha 崩溃=右下浮条局部降级+重载此区域,B22 降落伞);③throw 实测 PASS(dev CDP:浮条命中+app 存活+上游 ErrorPage 未出,截图在册);`__alphaCrashProbe` 探针常驻;brief+拍板 [debates/c28-brief](debates/2026-07-05-c28-honest-controls-brief.md),证据 [audits/s17-t4](audits/2026-07-05-s17-t4-c28/verify.md);**verified 待打包态复验**(→真机批) |

## Active — P3(卫生)

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| REQ-007 | ADR-015 待办①③:per-agent prompt 优化清单 + Tier-3 回答长度校准桌面实测 | docs | A | registered | 待办②(sync tripwire)已随 S7 完成;**(/loop 2026-07-04 defer)** ① 属 Tier-3 行为判断需拍板、③ 需桌面真机实测 → 并入真机批,详见档 |
| D2 | `/v1/models` live 同步死代码 | debt | A | dup | **→ 并入 REQ-001**(接进 picker 按白名单装配) |
| D3 | 官方 4 条 Anthropic skills 内容打包 + NOTICE(T5.3) | feature | A | dup | **→ 并入 REQ-018**(T7 官方 skill 资产打包);原状:现诚实失败,非占位 |
| D4 | 定制中心 skill 卡片「已安装」态(T5.4) | ux | A | dup | **→ 并入 REQ-018**(安装账本 receipts ⨝ SDK 真相,全类型已装态一并解决) |
| D5 | playwright MCP 浏览器内核来源实测拍板(=E14 遗留;T5.5) | spike | A | ready | 关 ADR-014 `_verify` |
| D6 | userData 每启动新建 log 目录 | debt | A | registered | **机制核实(/loop 2026-07-04)**:per-run 目录=有意设计(运行日志隔离),7 天扫除(`logging.ts:126`)已有界,无干净可改点(合并=破隔离);验收「观察≥7天」是真实使用任务,离线不可代跑;详见 [requirements/D6](requirements/D6-userdata-log-dirs.md) |
| D8 | DB WAL 周期 TRUNCATE | debt | A | registered | 上游(R2) |
| D9 | 分支命名 DB 累积 | debt | A | registered | R6:仅 dev 机器关切,prod 单库 |
| D10 | ui-mac package.json license/author 补全 | docs | A | shipped | **PR #35**(→ [s9b](sprints/2026-07-03-s9b-hygiene/sprint.md));package.json 补 license:MIT/author/repository(jinjunnn/alpha-code),gates 绿;**index.ts:82 陈旧注释子项未做**(与 S9/REQ-002 deep-link 同文件避撞)→ 该子项待 S9 收尾后另修,行保留 |

## Active — Harness 扩展(E 系列,证据见 E 册)

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| E2 | 钉钉 MCP(补齐飞书/语雀国产三件套) | feature | A | ready | 核实官方包名/鉴权字段;~~R3 门控~~ **已解锁(2026-07-05,A6 verified)** |
| E6 | 数据库 MCP(sqlite/postgres 读 schema + SELECT) | feature | A | ready | 命令型,无 OAuth;~~R3 门控~~ **已解锁(2026-07-05,A6 verified)** |
| E11 | 定制中心目录筛选 UI(category/license) | ux | A | dup | **→ 并入 REQ-019**(hub 左栏 IA + 筛选,T7);catalog schema 已带元数据 |
| E5 | 日历 MCP(Google/macOS) | feature | A | registered | 阻塞:OAuth/凭据存储(keychain TODO,ADR-014 §8) |
| E8 | Slack/Teams MCP | feature | A | registered | 阻塞同 E5 |
| E10 | catalog 远程增量同步(alpha-web 端点) | feature | X | registered | C 仓 catalog 端点未建 |

> 别名/归并:G1 → B6;E12 → B3;E14 → D5(剩实测);E1/E1b/E3/E4 已发(见 E 册);C10 → dup(A6);D7/E7/E13 → Parked;D11 → Done(⊂C1)。

## Parked(搁置,含激活条件)

| ID | 标题 | 搁置原因 | 激活条件 |
|---|---|---|---|
| B16 | 云派发 PIPL 同意/告知门 | 用户主动搁置(2026-07-03) | **面向公众分发前 / 云派发上线前必须重启**(R7:登录默认 platform-pays = 每条 prompt 持续出境,近硬阻断) |
| C19 | Sentry opt-out + 告知 | R6:dormant(`VITE_SENTRY_DSN` 全仓无赋值,从不 init) | 发布流水线注入 DSN 时 |
| D7 | safeStorage 明文兜底告警 | R6:macOS-only 下死分支(钥匙串恒可用) | 跨平台时 |
| E7 | websearch 收编为自有 MCP | 与云端 websearch 撞车 | B3/E12 云线落地后 |
| E13 | 团队协作多端 workspace 同步 | **rejected(2026-07-05,REQ-008 D1:不做共享 workspace/会话)** | 重开 = 真实付费团队需求 + 上游多用户原语 |

## 当前 sprint → **S17 深度决策与设计批 —— 已收尾(2026-07-05)**

> **T1–T6 全完成**(PR #88–#93):⚖️ 队列全清(定位五连拍 / 预留位 / C28 控件 / B12 filewatcher;另划过期 ADR-014 行)· REQ-015+REQ-027 本地门根治(hooksPath 重置 + typecheck 双假绿两层事故)· C17+B14 DB 安全带 · C28 控件诚实化 + AlphaBoundary(throw 实测 PASS,顺带活捉 REQ-014 复现翻 ready)· B4+B12 治理 · retro+21 项归档。stretch(C16 / REQ-024 设计)未抽,如实留册。契约与结果:[sprints/2026-07-05-s17-deep-decisions](sprints/2026-07-05-s17-deep-decisions/sprint.md);retro:[retros/2026-07-05-s12-s17-arc](retros/2026-07-05-s12-s17-arc.md)。
> **S18 候选(未开,待抽取)**:真机批 vNext(S17 攒的残单:C17/B14 对话框演练、C28 打包复验、B4 冷启动日志、B2 短TTL、logout、迁移开门、B22 复现〔现有降落伞〕)· REQ-014 ②修法实施(复现+可达性已实证)· REQ-024(自动化 A2,headline 候选)· REQ-028/029(composer 真实现双子)· C16(数据清除)· REQ-026(小白文档)· E2/E6(R3 已解锁)。

## 上一 sprint → **S16 已收尾(2026-07-05,真机验证收尾批)**(历史)

> 12 项翻 verified(A6 解 R3/REQ-018/019/020/021/023/006/011/001/B1/D1/B6 部分)+ **ADR-014 v3 / ADR-022 转 accepted** + 修 P1 卸载静默失败 bug(PR #87)。残余(B2 短TTL/logout/迁移开门/saveRun/复现类/真断网真睡眠)= 用户批残单在 [REQ-016 档](requirements/REQ-016-realmachine-verify-batch.md)。契约见 [sprints/2026-07-05-s16-realmachine-batch](sprints/2026-07-05-s16-realmachine-batch/sprint.md)。

## 上一 sprint → **S13–S15 已收尾(2026-07-04,定制中心 v3-M2/M3/M4)**(历史)

> S13(REQ-019+REQ-023,PR #74-#77)· S14(REQ-020,PR #80)· S15(REQ-021 A1,PR #81)相继收尾;各自真机递延项 2026-07-05 已并入 REQ-016(范围刷新)。契约见 [sprints/2026-07-04-s13-ext-hub-m2](sprints/2026-07-04-s13-ext-hub-m2/sprint.md) / [s14](sprints/2026-07-04-s14-ext-hub-m3/sprint.md) / [s15](sprints/2026-07-04-s15-automations-a1/sprint.md)。

## 上一 sprint → **S12 已收尾(2026-07-04,定制中心 v3-M1)**

> **抽取**:REQ-018(headline)· 顺带:REQ-006(ADR-014 转正,T8 同场)· A2 尾项(钉版迁移,放行门=A6 R3)· REQ-016 之 A6 真机子项。契约见 [sprints/2026-07-04-s12-ext-hub-m1](sprints/2026-07-04-s12-ext-hub-m1/sprint.md)。**收尾**:T1–T7 shipped(PR #66–#71),修 P0×4;**引擎级四步端到端 PASS**([audits/s12-verify](audits/2026-07-04-s12-ext-hub-m1-verify.md));266 单测;安全后随修 skill-creator XSS(PR #73)。真机批(in-app 四步/A6 env dump/迁移开门)→ REQ-016。

## 上一 sprint → **S11 已收尾(2026-07-04)**(历史)

> **抽取**:B3+REQ-004+C9(A 云线闭环,headline)· B11+B20+B23(B 呈现底座)· C24+C27+C25(C 安全纵深)· C14(D 破坏面收敛);B5 尾项顺带。契约见 [sprints/2026-07-03-s11-cloud-loop](sprints/2026-07-03-s11-cloud-loop/sprint.md)。批准:用户「就按照你刚才的几个」+「abcd」(四 track)。**收尾**:T1–T8 全完成,12 PR(#53–#64)+ 两轮签名公证 ship + CDP 走查;C24/C27/B5 verified;残余真机项并入 REQ-016。

## 上一轮建议(2026-07-03 拟)→ **S9 已开工(核心链)**(历史)

> **2026-07-03 抽取**:核心链 REQ-002→A6→REQ-001 已进 [sprints/2026-07-03-s9-proxy-e2e](sprints/2026-07-03-s9-proxy-e2e/sprint.md)(用户只批核心链);同域顺带与简单批**未抽取**、留 ready,由用户人工分派并发 session(不设任务锁)。⚠️ B1 与 A6 同文件(server.ts),未分派前勿动。

**S9「代理联调 + 网关白名单 + SSE 健壮」(≈1.5w,跨仓)**
- **核心(按序)**:REQ-002(搭真实登录+代理联调环境)→ **A6**(在该环境中落 env 白名单并复验代理不破——A6 deferred 的「需登录态验证」条件由 REQ-002 满足)→ REQ-001(白名单接口 + picker 装配)。
- **同域顺带**:REQ-003(SSE 审查+C23)、B2(refresh)、B21(BYOK 改键)。
- **解锁**:A6 落地后 A2(版本钉)按 R3 解锁,可尾随或下一批。
- 理由:5 条新需求中 3 条在此域;A6 是唯一 launch-blocker,正需要这个环境安全验证。

## Archived(retro 归档;验证明细以需求档为真源)

| ID | 标题 | 落点 | 验证 |
|---|---|---|---|
| A6 | sidecar env 白名单:阻断平台 JWT / BYOK 密钥 / EXA key 继承给第三方 MCP/LSP 子进程 | 详见需求档 | archived(2026-07-05 retro) |
| REQ-001 | 网关 allowed-providers/models 白名单接口 + 客户端按版本显隐(国内版 DeepSeek 系 / 国际版世界模型) | 详见需求档 | archived(2026-07-05 retro) |
| REQ-010 | alpha-ui 视觉 + 注入/路由回归修复批(546-sync 后 reskin 耦合面失效,图1–图9) | 详见需求档 | archived(2026-07-05 retro) |
| REQ-013 | 前端脱耦策略:让 alpha UI 免疫上游前端 churn(选定并落地) | 详见需求档 | archived(2026-07-05 retro) |
| REQ-018 | 定制中心 v3-M1 通用化地基:安装账本 + 全类型卸载 + **免重启生效(dispose)** + `.alpha` 双层落盘迁移 + MCP 密钥 file 化 + Agent tab | 详见需求档 | archived(2026-07-05 retro) |
| B1 | 登录 shell 同步探测黑屏 → 异步化 + 缓存(T1.2) | 详见需求档 | archived(2026-07-05 retro) |
| B5 | sidecar 崩溃自愈 + respawn 竞态/互斥(T2.4 + NEW-4) | 详见需求档 | archived(2026-07-05 retro) |
| REQ-015 | 冻结前端 typecheck 偏斜:session-ui(546 后新增)依赖新版 ui API 与冻结 ui 不兼容 | 详见需求档 | archived(2026-07-05 retro) |
| REQ-006 | ADR-014 转正收尾:桌面端验收用例(装 markitdown→免重启可用→卸载→依赖预检)+ 4 个 plan-review 未决项拍板 → trial 转 accepted | 详见需求档 | archived(2026-07-05 retro) |
| REQ-008 | 产品定位〔待补〕决策批:团队协作/企业租户/用户下沉/前 2-3 具体功能/G4 优先级,一次收口 | 详见需求档 | archived(2026-07-05 retro) |
| REQ-011 | 首页 composer 下方项目/会话 chips 移除 → 预留后续功能入口位 | 详见需求档 | archived(2026-07-05 retro) |
| REQ-019 | 定制中心 v3-M2:hub **横向 tab** IA(2026-07-04 拍板,否决左栏)+ 逐类型详情页(数据边界/实时依赖检测)+ 「添加」三档分流 + 更新通道 + 导入 folder/git | 详见需求档 | archived(2026-07-05 retro) |
| REQ-020 | 定制中心 v3-M3:云能力进 hub(登录门控+pipeline 条目)+ **ADR-021 §2 三校验落地** | 详见需求档 | archived(2026-07-05 retro) |
| REQ-021 | 自动化(定时任务)A1 本地只读 MVP(A2/A3 已拆 → REQ-024/REQ-025) | 详见需求档 | archived(2026-07-05 retro) |
| REQ-023 | 扩展安装供给链:官方扩展全配置化 + 离线资产通道(vendored plugin/agent,绝对路径写 plugin[] 绕 npm 下载)+ 安装管线状态机 | 详见需求档 | archived(2026-07-05 retro) |
| C12 | CORS 过宽(localhost/无 Origin 放行) | 详见需求档 | archived(2026-07-05 retro) |
| C24 | CSP 落地 + 撤 alpha 自注入 `ACAO:*`(exfil 通道) | 详见需求档 | archived(2026-07-05 retro) |
| C27 | Electron fuses(关 RunAsNode)+ asar-integrity + entitlements 收紧 | 详见需求档 | archived(2026-07-05 retro) |
| D1 | 健康轮询先 sleep 100ms 再首查 | 详见需求档 | archived(2026-07-05 retro) |
| REQ-017 | `alpha-check.sh` 北极星守卫未跟 ADR-020(仍扫 packages/app → 本地自检恒假红,与 alpha-ci 不再 1:1) | 详见需求档 | archived(2026-07-05 retro) |
| D12 | CI 卫生:上游 cron workflow 在 fork 误触 + lint gate + e2e 范围 | 详见需求档 | archived(2026-07-05 retro) |
| A1 | 窗口先行(启动不再被健康检查阻塞) | PR #23 | verified(隔离 dev+CDP) |
| A3 | 双份取数 → 共享 store(+roots:true/跳过全局 worktree) | PR #26(+#23) | verified(boot 无回归) |
| A4 | `InstallationVersion` local→1.17.13(patch-server-version) | PR #33 | verified(v0.1.0 打包实测) |
| A5 | 发版元数据链(0.1.0 + C18 + install-local 渠道化) | PR #32 等 | verified(v0.1.0) |
| A7 | 签名+公证流水线(Developer ID + 公证) | v0.1.0 | verified(stapler+spctl 双过) |
| A8 | 鉴权生命周期(respawn 重导 env + logout 清 token) | PR #29 | verified(登录态 live) |
| B10 | 北极星 CI 守卫(alpha-ci.yml)+ alpha 分支保护 | S7 批7/批8 | verified(guard PASS + protection on) |
| B15 | MIT NOTICE + 关于面板 | PR #27 | shipped(v0.1.0 含;包内逐项复验未做) |
| B17 | alpha 测试 0→97(安全路径优先) | PR #33(71→97) | verified(97 pass) |
| B18 | alpha CI gating(typecheck/test 随 PR) | alpha-ci.yml | verified(PR 实跑) |
| B19 | sync-upstream 自愈(SYNC_TOKEN) | 2026-07-03 | verified(实测绿灯 + 10 commits 合入) |
| C1 | IPC 导航/store 硬化(setWindowOpenHandler/will-navigate/name 守卫) | PR #25 | shipped |
| C2 | persistMcp args/env/headers 值校验(反配置期 RCE) | PR #22 + T7.4 单测 | verified(单测) |
| C4 | models.dev 关闸 + snapshot 兜底 | PR #22 | verified(冒烟) |
| C6 | 文档去漂移(rules 前端表述 + submodule 陈述修订) | 2026-07-03 | shipped |
| C7 | 跨仓 ADR 引用规范 | ADR-018 §8 钉死 | shipped(存量文档改写随用随改) |
| C11 | 深链日志脱敏(授权码不入 log) | PR #22 | shipped |
| C13 | open-link scheme 白名单 | PR #22 | shipped |
| C18 | prod 品牌/appId(com.tide.alphacode)/install-local 渠道化 | PR #32 | verified(v0.1.0) |
| C26 | 端点 https/host 守卫 | PR #22 + 单测 | verified(单测) |
| C29 | 上游崩溃屏去 OpenCode(brand-i18n 覆盖) | 批8 | shipped |
| D11 | store name 路径穿越守卫 | PR #25(⊂C1) | shipped |
| — | T1.7 models fetch 关闸 / T7.1-T7.5(S7 全套)等 task 级条目 | 册 §7f-7j | 随所属 ID 记账,不单列 |
