# BACKLOG — 工作项单一真源

> **状态只在本文件翻转**;流程与模板见 [`PROCESS.md`](PROCESS.md)(权威决策 ADR-018)。
> 状态:`registered / ready / in-sprint / shipped / verified / archived`;旁路 `parked / rejected / dup`。
> 类:feature / bug / debt / security / perf / ux / docs / spike。仓:A=alpha-code · B=alpha-platform · C=alpha-web · X=跨仓。
> 证据文档:**册** = [`plans/2026-07-02-problem-register-sprints-review.md`](plans/2026-07-02-problem-register-sprints-review.md)(71 项 + R1-R7 修正 + §7f-7j 实施日志);**核查** = [`audits/2026-07-02-register-verification.md`](audits/2026-07-02-register-verification.md);**E 册** = [`harness-extension-backlog.md`](harness-extension-backlog.md)。
> 下一个新需求编号:**REQ-056**(新需求一律 REQ-NNN;A/B/C/D/E 为历史审计系列保留原号,用户 2026-07-03 确认)。
> **需求文件全覆盖(2026-07-03)**:全部开放的 A/B/C/D 条目已逐条建档 `requirements/<ID>-<slug>.md`(含验收标准),行内备注为摘要、**文件为验收真源**;E 系列以冻结 E 册为分析文档;parked/dup 项不建档。

## 发布短名单(launch-blockers,册 §6.8)

| # | 项 | 现状 |
|---|---|---|
| 1 | A7 签名/公证 | ✅ verified(v0.1.0) |
| 2 | **A6 秘钥继承给第三方 MCP/LSP** | ✅ **verified(2026-07-05,R3 解除)** |
| 3 | B19 sync + B18 CI + B10 北极星守卫 | ✅ verified |
| 4 | B15 NOTICE + C18 品牌 | ✅ shipped / verified |
| 5 | B16 云派发 PIPL 同意门 | ✅ **shipped(2026-07-06,S25,用户 GO)**:显式 per-项目派发同意门(A PR #123)+ 隐式登录告知/隐私政策出境专章(alpha-web PR #9);verified 待真机 |
| 6 | B11 系统性静默失败 | ✅ shipped(统一呈现底座 PR #60 + 复扫 20 项);verified 待视觉批;余项随 B20(2026-07-05 retro 修正陈旧行) |
| 7 | B9 更新链完整性 | ✅ shipped(PR #47:降级闸关闭 + 完整性链文档化);verified 待下个真实发版实测(2026-07-05 retro 修正陈旧行) |

## ⚖️ 待拍板队列(需用户方案决策 —— 非 blocked,开工提案时必须附上提醒)

| 决策点 | 载体 | 影响 |
|---|---|---|
| ~~B16 PIPL 同意门重启时机~~ **已拍板 GO(2026-07-06,S25 落地)** | B16 | ✅ 队列划掉 |

> 拍板即从队列划掉、结论写进对应需求文件;执行中撞到未拍板点 = 停下来问,不代替决策。
> **S17 已拍板划掉(2026-07-05)**:T1 = REQ-008 五连拍 + REQ-011 预留位([debates/req008](debates/2026-07-05-req008-positioning-briefs.md));T4 = C28 控件三选一(只读移除/effort 改文案,[debates/c28-brief](debates/2026-07-05-c28-honest-controls-brief.md));T5 = B12 filewatcher(默认开+可关,拍板入档)。**B16 提醒**:非技术用户入画像 + 云派发已实际可用 → 重启条件临近,维持 parked 等用户拍重启时机。

## Active — P0

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|

## Active — P1

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| REQ-050 | C16 全部级清除:破坏性不可逆动作可被「无最终人工确认」推进到底(自动化/误触即抹) | security | A | registered | **S27 场次二事故发现(2026-07-06)**:全部级清除经原生对话框链(级别选择→备份提示→红色终确认)驱动;红确认默认按钮=取消、销毁按钮 index 0 非默认——**对人工使用防护充分**,但本场用 AppleScript 自动驱动时,进入红确认后销毁被推进到底并 exit(0),抹掉本机登录/`~/.alpha`扩展/引擎会话库+B14 备份(不可恢复;项目文件/`.alpha`/`~/.config/opencode`/仓库未触=边界守住)。**诚实定级**:根因=自动化驱动破坏性流程 + 我方操作失误,现有三段安全带对人工足够 → 硬化为可选(P2/P3 更贴切),用户请求按 P1 追踪。候选硬化:红确认加高摩擦(键入「删除」确认 / 独立「我知道不可逆」勾选 / 销毁按钮延时可点)。证据 [audits/vnext3 场次二](audits/2026-07-06-realmachine-vnext3/verify.md) |
| REQ-051 | REQ-047 剥离留痕走 console.log,打包态 Finder 启动不入 main.log(留痕承诺不可见) | debt | A | registered | **S27 场次二发现**:`shell-env-cache.ts:61` `[req047]` 剥离留痕用 `console.log`,打包态 stdout 不进 main.log → 功能正确但「loud 留痕」在真机不可见(本场以 52 vars 计数差反推证实剥离)。修=改走 logger(注意 shell-env-cache 与 logging 依赖方向);P3 卫生 |
| REQ-052 | 出厂技能绕过 `.alpha` 真源:`~/.opencode/skill/<name>` 直链 app 资源,破「`.opencode` 内 alpha 自有条目只指向 `.alpha`」不变量 | debt | A | verified | **用户点名(2026-07-07)**:环境重建时打开 `~/.opencode` 见 skill-creator/agent-creator 两条直链 app Resources 的 symlink(REQ-036 初版零拷贝捷径,跳过 `.alpha`),质疑 `.alpha` 真源纪律被破——目录安装链路合规,唯此通道漂移。**shipped(同日,快车道,PR #131)**:改**两跳桥**与目录安装同构——`~/.alpha/skills/<name>`(真源 symlink→app 资源,保零拷贝)+ 复用 alpha-bridge 落 `~/.opencode/skills/`(多跳链引擎可见,REQ-004 spike 实测);启动 reconcile 自动迁移旧直链 + 拆空 `~/.opencode/skill/`(仅 `isAlphaFactoryLink` 判我方链才拆,用户内容照旧不碰);异源 bridge item 链前置挡;测试 10→15 例;不变量写入 ADR-019 修订。**verified 待**下个签名包真机:启动日志 `legacy direct links migrated` + `~/.opencode` 内两旧链消失、`~/.alpha/skills` 真源就位、会话内技能仍可用  **verified(2026-07-07,S29 v0.1.1 首启)**:四要件全过——main.log `legacy direct links migrated {skill-creator, agent-creator}`;`~/.opencode/skill` 旧位整目录消失;`~/.alpha/skills/<name>`→app 资源真源就位;`~/.opencode/skills`→`~/.alpha/skills` dir-link 桥;真会话 6s 流式回复确认两技能引擎可见(「skill-creator: 有 / agent-creator: 有」) |
| REQ-053 | C16 清除残留悬空引用 → 引擎 home 实例 bootstrap 死循环(CPU 打满 + 23GB 日志洪泛,项目列表全挂) | bug | A | registered | **P1 真机事故(2026-07-07,证据 [audits/req053](audits/2026-07-07-req053-home-instance-loop.md))**:C16 全部级清除删 `~/.alpha` 与 alpha-mcp-secrets 但**不清 `~/.opencode/opencode.jsonc` 内指向它们的引用**(plugin[] 悬空路径 + dbhub DSN `{file:}` 悬空)→ 事故后首次启动(7-6 21:31)起,引擎对 `/Users/tide` 进入 `fromDirectory→bootstrapping→creating instance` 三行死循环 ~1600 次/秒:烧一夜 = 21GB + 晨间 1.8GB 日志、三进程 CPU 84%/83%/66%、renderer 全线「引擎连接异常」;INFO 级零 error 输出(静默失败)。**现场处置(同日)**:备份后清两条悬空引用 + 重启 → 32 行日志/单次 create/CPU 正常,根因实证。产品侧待修三件:① C16 清除补全——删资产时同步清/修 jsonc 引用(或清除后校验);② 实例创建失败**无退避、无 loud 报错**(上游循环,alpha 侧 B11 呈现 + main 守护接缝评估);③ C3 轮转对运行时增长无效(21GB 单 run,轮转仅在重启时发生)→ C3 verified 时重点复核。**附带教训**:「干净重启」验证清单须含引擎日志尾部 + CPU(7-6 晚验了 shell-env/server-ready 却漏了已在跑的循环) |
| REQ-054 | 首页 composer 对隐藏上游控件的转发在零工作区/切档场景失真:①零工作区模型 chip 死点 ②effort 切档对有档模型不生效且失败不可见 | ux | A | verified | **S29 γ 桶走查发现(2026-07-07,用户报障「effort 和 model 无法点选」,证据 [audits/s29](audits/2026-07-07-s29-verify/verify.md))**:① 零工作区(C16 抹库后/全新安装首启必现)上游 new-session composer 不挂载 → 首页模型 chip 的转发目标 `[data-action=prompt-model]` 不存在、fallback `model.choose` 亦 no-op → **点击静默无反应**(C28 违例;send 按钮同场景已按 REQ-038④ 唤起工作区选择器,模型 chip 漏同款处理);选工作区后即恢复(实测)。② 首页 effort 切档:对 claude-sonnet-4.6(alpha-models.json 明确配 低/中/高)选「高」不生效(上游 variant 控件驻留「默认」),且失败反馈随 popover 关闭即丢 —— in-session 侧 REQ-041 已 verified 不受影响,仅首页驱动隐藏控件路径失真。修法:①模型 chip 复用 send 的零工作区分支;②首页 effort 直走引擎 variant 命令或明确禁用+提示「进入会话后可切」  **shipped(同日,随 REQ-055 根除,PR #137)**:①模型 chip 零工作区走工作区引导分支 ②effort 改本地状态+提交参数,不再驱动隐藏控件(dev 实证秒切);verified 随 REQ-055 真机批  **verified(2026-07-07,随 REQ-055 v0.1.2 真机)**:两缺陷的载体机制已整体退役;零工作区引导与本地档位状态在 dev 端到端 + 真机首页复核通过 |
| REQ-055 | AlphaComposer 单一自建 composer:会话页替换上游注入,SDK 参数化提交(用户拍板「自建、不再集成 opencode、不要止血」) | feature | A | verified | **用户拍板(2026-07-07,S30)**:两套 composer(首页自建 / 会话页上游+三层注入)反复不一致 —— effort 死点、内部 agent 泄漏、焦点肥圈、缺上下文按钮(REQ-054 系)。终局设计:①AlphaComposer 唯一组件+唯一 CSS,home/session 两 mode;②提交/中止全走 SDK(promptAsync 带 model/agent/variant,abort);③状态本地化,**废除 DOM 驱动**(switchVariantTo/switchAgentTo/label 观察链退役);④上游 composer CSS 隐藏,composer-inject/slash-inject 退役;⑤内部 agent(alpha-automation/-standard/alpha-readonly)列表过滤 + config `agent.<n>.hidden` 注入;⑥ring v1 收养/v2 自建;详见 [requirements/REQ-055](requirements/REQ-055-unified-alpha-composer.md);REQ-054 随本项根除  **shipped(同日,S30,PR #137)**:alpha-composer.tsx/.css + composer-state(纯核 10 单测)+ ModelPickPop(自建模型弹层,catalog+SDK providers)+ ComposerTakeover(上游 composer 隐藏);composer-inject/slash-inject/composer-controls/cycle-to/variant-normalize 七文件退役删除;内部 agent config hidden 注入;dev 实例九条验收全 PASS(audits/req055-dev-verify,含「首页选模型→effort 秒切→SDK 带参发送→Sonnet 7s 回复」端到端);**verified 待** v0.1.2 真机  **verified(2026-07-07,v0.1.2 用户真机)**:自动更新 0.1.1→0.1.2 后实测——首页统一 composer 就位(unified 标记 + agent chip)、旧注入零残留;agent 下拉仅「build 默认」(用户报障的 alpha-automation/-standard/alpha-readonly 泄漏消失);会话页 alpha composer 接管、上游 display:none、历史完好;证据 audits/req055-dev-verify(v012-home-realmachine.png) |
| REQ-002 | 平台↔alpha-code 代理联调:E2E 打通并计量出数 | feature | X | shipped | **S9;核心链路 verified**(登录→platform→真实模型流式→计量出数,4 次调用一致累加);修 3 断点:BP-1 网关流式计量 waitUntil 缺位(B,`6fe49f3` prod 部署)· BP-2 冷启动登录态丢失(A,待重打包 verify ④)· BP-3→REQ-014;证据 [audits/2026-07-03-req002](audits/2026-07-03-req002-proxy-e2e.md);④ token 过期(B2)/logout 复验未做 |
| REQ-003 | 网关 SSE 流式健壮性:卡顿/断连/重连/心跳审查与加固 | debt | X | shipped | **PR #50**;审查报告 [audits/2026-07-03-req003](audits/2026-07-03-req003-sse-robustness.md)(链路1 B 侧已健壮,2 建议项留档;链路2 C23 四病灶全修+90s 悬挂回收,7 单测);**C23 随本批关闭**;弱网 UI 呈现 → 真机批+B11;详见 [requirements/REQ-003](requirements/REQ-003-gateway-sse-robustness.md) |
| REQ-012 | 上游同步前端回归防护:锚点契约测试 + sync tripwire + post-sync 视觉冒烟 gate | debt | A | shipped | **PR #44**;范围拍板=锚点存在性 only(像素基线不做);清单 195 alive/4 dead + 5 用例契约测试 + sync tripwire + 发版 runbook ⓪ 步;**首跑即修正原审计:94 死→真死 4(session-ui 搬包)+ v0.1.0 回放 0 名字级死→结构性断裂假说上位**(审计修正节);详见 [requirements/REQ-012](requirements/REQ-012-frontend-sync-regression-guard.md) |
| B2 | refresh token 续期 + 401 拦截 + 失败降级 BYOK/登出(T3.1 剩余) | feature | A | shipped | **PR #42 + alpha-web `a1d4d8a`**;寿命拍板 7*24h(env 可调短测试)+ 提前量续期(整点 tick)+ 401 拦截重试 + invalid_grant 降级登出(明确 UI)+ 冻结 token 快死备胎 respawn;REQ-002④ 过期路径就此成型;134 tests 绿;**verified 待真机**(短 TTL 实测 过期→续期/撤销→降级/logout 不串台);详见 [requirements/B2](requirements/B2-refresh-token.md) |
| B4 | 巨型目录当项目(`/`、`~`、`~/Documents` 建 Instance)治理 | perf | A | shipped | **S17 T5 shipped(2026-07-05)**:数据层过滤(`worktree-filter.ts` 谓词+11 单测)——"/"+macOS home 根默认不纳入、hidden(归档)零请求(不 fetch→引擎不建 Instance);归档即时生效;会话事件循环守卫;~/Documents 级留手动归档;已知限制 unhide 无 UI(记档);**verified 待**冷启动日志复核+watcher 数实测(→真机批;**S20 B3 已验数据层半边**——打包冷启动侧栏仅 3 具体项目、无 "/" 根、home 未纳入,但「零 session.list→引擎零 Instance」深层断言与 watcher 数未取证(info 级 main.log 不记 session.list,留 netlog 专项),**故不翻 verified**);详见 [requirements/B4](requirements/B4-giant-dir-projects.md) |
| B7 | 发布流水线制度化:CI 断言版本/种子资产/断网首启 smoke(T2.6 剩余) | debt | A | ready | **验收② shipped(PR #85)**:`scripts/assert-seed-assets.sh` + advisory `seed-assets` job 断言 extraResources 源资产(vendored agent/plugin·skills·NOTICE.txt/B15·签名)存在,静默删除即红;①版本断言(release-time)③断网首启 smoke⑤注入 0.0.0 验证 = 需 build+launch → 真机批;DISTRIBUTION.md 已写 |
| B8 | 扩展物运行时生命周期:版本/健康/更新三要素(T5.4/T5.6) | feature | A | registered | 系统性条目,症状=A2;终态=定制中心从商店→运行时管理器;**具体实现路径已立 = REQ-018(账本/生效)+ REQ-019(详情/更新),B8 保留为终态验收视角** |
| B9 | 更新链完整性:关 `allowDowngrade` + feed 完整性校验 | security | A | verified | **PR #47**(→ [S10](sprints/2026-07-03-s10-hardening/sprint.md));降级闸关闭(理由入注释:单 prod 渠道无跨渠道降级需求;旧版逃生=手动 dmg);完整性链文档化(yml sha512 → zip → 签名同 identity → 降级闸);**verified 待下个真实发版**(自动更新实测 + 篡改 yml 拒装用例);详见 [requirements/B9](requirements/B9-update-chain-integrity.md)  **verified(2026-07-07,S29 真实发版实测)**:0.1.0(7-6 build)→ v0.1.1 全链走通——updater 10 分钟周期检测 `Found version 0.1.1` → 下载 19s → ready → 确认框 Restart → ShipIt 换包 → 0.1.1 自启;`allowDowngrade:false` 全程留痕;feed 200;证据 [audits/s29](audits/2026-07-07-s29-verify/verify.md) |
| B11 | 统一错误/健康呈现面 + 账户 banner(S8 底座) | ux | A | shipped | **S11 T4(PR #60)**:Banner 基元 + pushToast 唯一出口(hub 私有 toast 收编)+ 首页/hub store.error banner + 账户 error 判别式(#1 误显根治,picker error 态+重试;侧栏会员行不装「未订阅」)+ **B23 configHealth**(语法错/未知顶键 → warning banner,5 单测)+ splash 状态行(B20);复扫矩阵 20 项:✅10/🆗6/⏭4([audits/rescan](audits/2026-07-04-silent-failure-rescan.md));⏭4(会话操作 toast/登录链事件/骨架/连崩呈现)留行内追;**verified 待视觉批**(banner/toast 截图);**S19(2026-07-06)清行13 + 延伸**:会话 rename/share/delete 失败静默→接 pushToast(share 顺带修丢弃 URL 真 bug);**并把同类静默失败补到两大 S18 新面**——治理面板 `apply()`/`govRead()`(REQ-037)、自动化 `save()`/`remove()`(REQ-024/025)的 `void asyncFn()` 缺 catch → 补 catch + toast/err;**S19 两批(2026-07-06,PR #111)⏭ 清零**:行14 createSession 失败 toast + 行16 登录链 auth-error 事件→toast(main 四失败点,冷启动边界留档)+ 行11 残余连崩停手(sidecar-fatal → 侧栏常驻 Banner + 重试 IPC,**dev 真实全链 E2E PASS**)——复扫矩阵 20/20 全反馈或有意降级,B11 可落码面全清;失败态实拍→真机批 |
| B12 | Instance 不驱逐 + 递归 watcher 常驻 | perf | A | shipped | **S17 T5 拍板+落地(2026-07-05)**:影响清单代码实证(watcher 只供外部变更感知;agent 自身修改不受影响)→ 拍板=默认开+可关——实验 flag 改 set-if-unset(`export =false` 即关,修硬覆盖矛盾);内存主治=B4 减 Instance;上游本体接受(R2);**verified 待**长时内存/watcher 数实测(→真机批);详见 [requirements/B12](requirements/B12-instance-eviction.md) |
| B13 | DB 跨进程并发(SQLITE_BUSY → orDie) | debt | A | registered | 上游归属(R2);R6 降级:busy_timeout=5000 已缓解;alpha 无直接修点 |
| B20 | 弱网降级 UX:超时/重试/splash 状态/真骨架/websearch 优雅降级(S8) | ux | A | shipped | **PR #111(S19)收口**:S11 T4 部分随 PR #60(splash 状态行 + banner/重试底座);Skeleton 死代码**删**(零引用实证);promptAsync/websearch 两项 🆗 豁免已记账([audits/rescan](audits/2026-07-04-silent-failure-rescan.md))→ 无剩余可落码工作;**verified 待**弱网真机走查(→真机批) |
| B21 | BYOK 改键/删键即时生效(触发重注 env/respawn) | bug | A | shipped | **PR #48**;根因=env 桥 set-if-unset 滞留旧 key;修=自有注入权威覆盖/清除(用户值永不动,纯逻辑 5 单测)+ 改键回调触发重注+respawn;删键即时吊销;**verified 待真机**(改键→picker 即时反映→新 key 出账);详见 [requirements/B21](requirements/B21-byok-key-live-reload.md) |
| B22 | message-timeline.tsx:481 会话时间线崩溃 | bug | A | ready | **代码复验完成(/loop 2026-07-04)**::481 现为 `virtualItemByKey` memo,上游 546-sync 已变现症或已异;疑源收敛=`timeline-inject.decorateDirOutput`(隐藏 Solid 子节点最可疑)>`decorateTurns` divider;**真机复现是修复前置**(崩溃类必须能复现才能证明修好)→ 真机批;详见 [requirements/B22](requirements/B22-timeline-crash.md) |
| B23 | strict-key 配置致瘫:全局 jsonc 解析失败 → 整份配置静默清零 | bug | A | shipped | **S11 T4(PR #60)呈现半边落地**:`configHealth()`(语法错 + 未知顶层 key 双病灶,V1 顶键集自引擎 schema;5 单测)→ AlphaHome warning banner + 打开配置;写前校验(C2)继续挡 alpha 自写;上游清零行为本体不可改(R2)。**S20 真机批(2026-07-06)verified(未知键支):** 注入未知顶层键 → 引擎**loud 拒绝**(每项目 error toast 精确点名 `Unrecognized key: __alpha_b23_probe__` + 侧栏 error banner),错误如实且更 actionable。**F-3 债务**:原「静默清零」premise 与现引擎「loud 拒绝」行为已不符,configHealth warning banner 在此路径被 loud 错误取代;**语法错**一支(引擎可能真静默)未在本批构造,configHealth 独立价值待「语法错」用例核验(低优先,错误已 loud 非静默) |
| REQ-016 | 真机验证收尾批:原 4 项 + S12–S15 全部真机递延 | spike | X | verified | **主体 shipped(2026-07-05,S16)**:重 ship 签名包 → A6(解 R3)/REQ-018/019/020/021/023/006/011/001/B1/D1/B6 逐项翻 verified;**ADR-014 v3 + ADR-022 转 accepted**;修 P1 卸载静默失败 bug。**残余(留用户批 / 下批)**:B2 短TTL、logout、迁移开门(需 flag 重启)、回流 saveRun、卸 uv 像素、git 真克隆、dispose 打断、B22/REQ-014 复现、banner 冷启动(S20 已验未知键支=引擎 loud 拒绝、banner 被取代 → F-3 记 B23 行,**语法错支仍残余**)。B6 alpha_ping 已随 S20 C2 verified,自本清单摘除(S20 审计收尾)。证据 [audits/2026-07-05-req016](audits/2026-07-05-req016-realmachine-batch/verify.md);详见 [requirements/REQ-016](requirements/REQ-016-realmachine-verify-batch.md)  **verified(2026-07-07,S29-γ)**:残单两腿实测——冷重启往返(quit→relaunch:项目/会话/模型选择全还原、零 Not-found/白屏)+ 历史回跳(点侧栏会话→消息全量渲染);其余残单已各自归位(M2 对话框=C16 S27 verified、M3 云线=B3/REQ-020 verified、E2 凭证归 E2 行) |
| REQ-027 | typecheck 关双假绿:`bun --cwd X run Y` 在 bun 1.3.x 打印 usage 后静默退出 0、不执行脚本(alpha-check + alpha-ci 同写法) | bug | A | verified | **S17 T2 证据纪律顺带发现+同 PR 修复(2026-07-05)**:hook 全量输出暴露 usage dump → 探针实证(植入型错 `--cwd…run` exit 0 vs `cd…run` exit 2;不存在脚本亦 0)+ CI 日志同 dump(run 28733810318);修=flag 移 `run` 后 ×(alpha-check.sh 两处 / alpha-ci.yml 三处 / CLAUDE.md dev 命令);verified=红绿探针在册 + 本 PR CI 日志无 dump 复核;快车道无档  **verified(2026-07-07,S29 α 桶复核)**:本地 alpha-check 与 alpha-ci 当日多轮真实执行 tsgo(日志可见 `$ tsgo --noEmit`/`tsgo -b`,typecheck job 42-45s 真跑非秒退);REQ-052 开发期实抓类型错误能力已复证 |
| REQ-030 | 模型清单配置化 + 海内外版本收口生效(registry 抽配置文件 / prod EDITION_CONFIG 落地 / 最新代策展) | feature | X | shipped | **S18 T5 shipped+prod 部署(2026-07-05,B PR #15 + A PR #101)**:models.config.json 单一真源(schema loud-fail 逐字段/routes[] 一次定型/aliases 旧代降级)+ 5 lookup 现场 lookupModel;**prod 已收口**:EDITION_CONFIG=default cn+运营者 u_18018709299→intl 上 var(wrangler.jsonc 版本化),curl 实证 edition:cn 仅 v4 两档;ECS account 同步部署,旧 id settle 实测走 v4 价不 400;A 侧 snapshot 策展跟随;codex 审计 4 P2 修复(NaN/同链 provider 唯一/preauth max 价/disabled settle loud);运营者 intl picker 全量→用户真机自验;详见 [requirements/REQ-030](requirements/REQ-030-model-registry-config.md) |
| REQ-031 | LLM gateway 多上游路由 + 欠费 failover(canonical id→候选链,原生优先/OpenRouter 兜底,per-route 计价) | feature | B | shipped | **S18 T6 shipped+prod 部署(2026-07-05,B PR #16)**:候选链选路(原生优先/OR 兜底,保守欠费集合:ds/OR 402、openai 429+insufficient_quota、anthropic 400+credit)+ KV 短 TTL 降级(末位保留恢复探测)+ ledger/settle 按实际 route 计价(upstreamProvider,prod settle 实测 openrouter 价目生效)+ preauth 按链上最贵估(codex P2)+ web search 策略钉死首选 route(codex P1);SSE 仅首响应前换路;11 单测;欠费真实切换场景→运营演练残单;详见 [requirements/REQ-031](requirements/REQ-031-gateway-upstream-failover.md) |
| REQ-032 | catalog 远程分发(收编 E10):C 端点+签名 + A 运行时拉取/缓存/回退 + skill/agent 远程资产通道 + 条目级更新检查 | feature | X | verified | **S18 T10 shipped+prod(2026-07-05,C alpha-web #5 已部署 + A PR #103)**:C 静态端点(catalog.json+ed25519 .sig+不可变 assets,发布脚本拒改已发布版本)+ A 拉取链(ETag 304 实测/验签(篡改拒用实测)/缓存/回退 远端→缓存→内置)+ 远程技能安装(sha256 钉死,坏 sha 拒装实测,builtin 同管线桥+账本)+ 条目级更新角标(X7 origin 过滤);**远程-only 条目 conventional-commits 实证上架不发版**;E10 dup 并入;像素/回滚演练→残单;详见 [audits/s18-t10](audits/2026-07-05-s18-t10-req032/verify.md)  **verified(2026-07-07,S29 γ 桶)**:0.1.1 联网 hub 连接器 tab 实见远端下发条目(钉钉/DBHub/Playwright,70 卡);拉取链验签/304/篡改拒用已于 S18 实测,本批补 in-app 呈现腿 |
| REQ-033 | 开放生态安装面:任意 MCP 手动添加 UI + agent 导入/轻转换 + 兼容性边界诚实文档化 | feature | A | shipped | **S18 T4 shipped(2026-07-05,PR #104)**:①任意 MCP 手动添加(hub 自定义连接器表单 local/remote + env/密钥分离采集;校验主体在 main persistMcp C2 白名单**不放宽**,密钥 {file:} 化;账本 origin created)②agent 导入两段式(openFilePicker → parseAgentImport 显式映射预览(Claude Code tools/model 诚实不映射,note 指引 permission)→ 确认写入 origin imported + dispose 热生效;main 重解析防线)③hub 兼容性边界注记(MCP/skill 直装、agent 转换、异构插件不可装指引 MCP 替代);14 导入单测(含转换产物 roundtrip);**codex 审计 1H+2M 全修**(preview 经 picker token 授权读+单次消费/confirm 只收 previewId 内容取 main 留存/picker 返回值真 bug);像素→真机批;详见 [requirements/REQ-033](requirements/REQ-033-open-ecosystem-install.md) |
| REQ-036 | 创建技能化:移除 hub 交互式创建表单,skill/agent 创建统一走技能(skill-creator 出厂化 + agent-creator + alpha_reload 生效闭环) | feature | A | verified | **S18 T2 shipped(2026-07-05,PR #100)**:通道实测二分推翻原 env 注入设计(OPENCODE_CONFIG_CONTENT.skills.paths 引擎不生效)→ 改 `~/.opencode/skill` symlink 桥(ADR-019 同构,reconcile 幂等+逃生开关,7 单测);alpha_reload 两段式(X9 实锤流中 dispose 打断回复 → session.idle 后执行);表单删除+导入语义+出厂徽标;agent-creator 出厂技能;裸引擎决定性验证在册 [audits/s18-t2](audits/2026-07-05-s18-t2-req036/verify.md);像素/端到端→真机批;详见 [requirements/REQ-036](requirements/REQ-036-creation-via-skills.md)  **verified(2026-07-07,S29 γ 桶)**:0.1.1 实测——导入 tab 无旧表单、「创建 = 对话」文案 + folder/git/npm 导入入口;出厂 skill-creator/agent-creator 经真会话确认可见可答 |
| REQ-037 | 上游能力治理层:原生 agent/skill/command 隐藏/禁用/重写(governance 真源 + home jsonc 物化 + dispose 热生效 + hub「内置」分组) | feature | A | verified | **S18 T3 shipped(2026-07-05,PR #102)**:真源 ~/.alpha/governance.json + 叶子键事务物化 home jsonc(用户内容保留/空壳剪枝/记账净除)+ 保护名单硬校验(compaction 拒/alpha 注入拒 X2/build confirm)+ hub「内置(上游)」分组(隐/禁/重写/allowlist 切换/重置);**裸引擎实测**:explore 消失/build hidden/init 重写/deny 占位全命中([audits/s18-t3](audits/2026-07-05-s18-t3-req037/verify.md));denylist 默认(开批拍板);像素/会话级→真机批;详见 [requirements/REQ-037](requirements/REQ-037-upstream-governance.md)  **verified(2026-07-07,S29 γ 桶)**:0.1.1 已安装 tab「内置(上游)」治理区实见——build/general/plan 三 agent 隐藏/禁用/重写钮、customize-opencode 禁用态、/init /review 重写、黑白名单模式切换;config 层 deny+command 覆盖在 `~/.opencode/opencode.jsonc` 同步实见 |
| REQ-038 | Composer 一致性收敛:首页/会话页行为对齐(首页 `/` 菜单接线为 P0)+ 共享层收敛(逻辑/外壳 CSS 单源)+ 换皮层像素走查 | ux | A | shipped | **S18 T1 shipped(2026-07-05,PR #98)**:首页 slash 菜单+@(agent+文件)接线(数据源与会话页同源:command.list/agent.list/find.files);/name args 命中自定义命令改走 session.command(上游 submit 同语义);IME keyCode 229 三重守卫;外壳 CSS 单源 composer-shell.css;占位文案单常量;**发送按钮裁切根因修复**(上游 svg wrapper 占 grid 行挤掉 ::after 箭头 → grid-area 1/1 叠放);15 新单测,CDP 截图验收在册 [audits/s18-t1](audits/2026-07-05-s18-t1-req038/verify.md);残单=真机 IME/空工作区提示像素 →真机批; 原勘探详情见 [requirements/REQ-038](requirements/REQ-038-composer-parity.md) |
| REQ-039 | cn 租户云管线默认模型适配:edition 白名单拦掉 pipelines 默认 claude-sonnet(schedule e2e 实锤 edition_forbidden)→ 管线模型按租户 edition 选择或 cn 白名单纳入执行模型 | feature | B | shipped | **S28 shipped+prod(2026-07-06,alpha-platform PR #19,用户拍板 c 案)**:勘探发现两闸不对称——`/v1/messages` 闸(REQ-003 R5)早已豁免内部凭证,chat/completions 闸漏同款豁免即根因;修=`editionGateApplies(via)` 单源(jwt/apikey 受闸;job/dev 豁免)接 worker 两闸+dev 镜像,白名单/picker/计费零变;闸 via 分支补 3 单测(此前零覆盖=漏网原因),270/270 绿;dev e2e 绿证=cn 配置下 dev 凭证跑通 claude-sonnet 完整补全 + `/v1/models` 仍只列 v4 两档;prod 部署+smoke(无凭证 401/默认 cn picker 零泄漏)。**verified 待**真实 cn 租户(非运营者账号)prod 云任务复验——放量前执行;a 案(per-edition 选模优化)→ [[REQ-049]];详见 [requirements/REQ-039](requirements/REQ-039-cn-pipeline-model-edition.md) |

## Active — P2(债务)

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| REQ-049 | 管线模型按租户 edition 选择(REQ-039 a 案):cn→deepseek-v4(代付成本 ~6x 降 + 任务文本流向国内模型),research 搜索槽对 deepseek 切 client 路径 | feature | B | registered | **S28 立项留册(2026-07-06,用户拍板「c 案 + a 留册」)**:c 案(PR #19)已解除放量阻断,本项为纯优化——SMART/CHEAP 改 per-edition 表 + edition 从 dispatch 穿进 pipeline(勘探结论在 [requirements/REQ-039](requirements/REQ-039-cn-pipeline-model-edition.md) §候选修法 a);触发=放量后按云任务用量/代付成本评估 |
| REQ-004 | `.alpha` 项目工作目录:桥接验证 + 回填 ADR-019 | spike | A | verified | **S11 T1 完成(PR #54)**:config 注入 CONFIRMED(生产在用)+ symlink 桥 CONFIRMED(引擎同款 glob fixture 6/6,整目录链/多跳链均通,one-hop 假说证伪);双写回退不启用;schema/gitignore 已回填 ADR-019 修订;证据 [audits/req004-spike](audits/2026-07-03-req004-alpha-bridge-spike.md);**verified 待 B3 T2 打包态 in-app 冒烟**;详见 [requirements/REQ-004](requirements/REQ-004-alpha-workdir-spike.md)  **verified(2026-07-07,S29 α 桶复核)**:验收①桥接三法 verdict=audits/req004 spike 档 ②ADR-019 落地+两轮修订 accepted ③北极星守卫全程绿 ④B3 verified(S27 场次二)实证 `.alpha/runs/<id>/` 回流落点 —— 四条全闭 |
| REQ-005 | 前端接管收尾核验:重型引擎换肤(终端/diff/权限流)完成度 + timeline 验收尾项(截图归档/COUPLING 清单/真机验收) | ux | A | ready | ADR-016 待办②;tasks.md 40 项全勾但 dev-plan:98-100 未走完;COUPLING 清单关系 C14;详见 [requirements/REQ-005](requirements/REQ-005-frontend-takeover-closeout.md) |
| REQ-009 | alpha-ci 提速:guard partial clone + bun 依赖缓存 | debt | A | shipped | **PR #85(bun 缓存半)**:typecheck/test 两 job 加 `actions/cache`(key=`bun.lock`)→ 复用全局模块缓存,miss 回退全装零风险。**partial-clone 半递延**:`filter:blob:none` 有静默削弱 north-star guard 之虞,须验收③回归用例在真 CI run 确认仍拦上游改动,不可无人值守验;≤2min 实测(验收④)同待真 CI;详见 [requirements/REQ-009](requirements/REQ-009-alpha-ci-speedup.md) |
| REQ-025 | 自动化 A3 云档位:execution:cloud 注册到 B + 开机拉回 + 数据边界提示 | feature | X | shipped | **S18 T12b shipped(2026-07-06,PR #108)**:execution:cloud 全生命周期(保存=upsert B schedule 失败不落盘 loud/删除=先删 B 防幽灵触发/启停=PATCH 同步)+ 开机拉回(jobs?since&origin=schedule → status → saveCloudRun 落 .alpha/runs,job_id 对账防重)+ 面板 B 状态回读(熔断/停用原因)+ ADR-021 数据边界提示强制展示(仅任务文本上云,零项目文件);本地调度器跳过云档;scheduleToCron 纯函数单测(once/超长诚实拒);MVP=research 管线(表单明示映射);**codex 审计 3H/1M/1L 全修**(游标只越过终局 job/孤儿 schedule 补偿删除/bash 黑名单加固嵌套 shell 与包装器/拉取单飞+fresh 重读/临时会话删除重试);登录态 A↔B 真机 e2e→真机批;详见 [requirements/REQ-025](requirements/REQ-025-automations-a3-cloud.md) |
| REQ-026 | 面向非技术用户的规范文档(D3 下沉拍板分期第一步:安装→登录→对话 + 常见错误 FAQ) | docs | X | verified | **S18 T11 shipped+prod(2026-07-05,C alpha-web #6 已部署)**:`alphacodeone.com/getting-started`(装-登-用三步零术语 + FAQ×10 与 B11 口径一致 + 进阶只做索引;导航入口);落点=alpha-web(开批拍板);app 内帮助菜单链接随后续 A 侧小改;prod 200 + 内容实测;中文先行,英文随 C20  **verified(2026-07-07)**:`alphacodeone.com/getting-started` 线上 200,装-登-用内容在(下载×27/登录×37/安装×11 关键词实测);见 [qa/矩阵](qa/2026-07-07-shipped-verification-matrix.md) |
| REQ-028 | composer 真只读档:引擎 plan agent 通道 + 切换 UX | feature | A | verified | **S18 T7 shipped(2026-07-06,PR #105)**:alpha-readonly agent config 注入(edit/bash 静态 deny,question/task 允许=交互差异;裸引擎证 deny 规则入引擎)+ PermChip 三档(cycle 判停,失败诚实回退不装成功)+ agentLabel 观察源一致性 + showCustomAgents 一次性 seed + 治理保护名单(X2);像素/会话实拍→真机批;详见 [audits/s18-t7](audits/2026-07-05-s18-t7-req028/verify.md)  **verified(2026-07-07,S29-γ,v0.1.1 真机)**:三档 UI 实见 → 切「只读」→ agent 通道自动变 alpha-readonly → 实发「创建文件」指令:**文件未被创建、全程零 ask**、会话正常回复 —— 只读语义真拒写。注:chip 驱动机制随 REQ-055 改为提交时 agent 参数(语义不变,v0.1.2 批复核) |
| REQ-029 | composer effort 接入 model variants:逐模型参数档 + B 侧透传核实 + chip 驱动 | feature | X | verified | **S18 T9 shipped(2026-07-06,PR #107)**:①B 透传核实(OpenAI-wire spread 全透传✓;anthropic-wire 不映射 thinking → 支持面如实缩小)②variants 配置驱动(alpha-models.json:claude-opus/sonnet=OR 统一 reasoning{effort}、gpt-5.4-mini=reasoning_effort;direct/deepseek/nano 诚实不定义)③**echo 实验实锤**:variant 选中 → wire body 实际携带 reasoning_effort/reasoning(非 UI 自嗨,验收①机制面)④EffortChip 接真:驱动上游 model.variant.cycle+文本判停,控件缺失=模型不支持 → 禁用显示「—」(C28),移除「暂未接入」;BYOK/代理真机两路实测→真机批;详见 [requirements/REQ-029](requirements/REQ-029-effort-model-variants.md)  **verified(2026-07-07,S29-γ,v0.1.1 真机)**:会话内 Sonnet 切「高」→ chip 与引擎 variant 同步「高/高」秒级一致(观察时间线证据)。注:实现机制随 REQ-055 升级为 SDK 显式 variant 参数(dev 端到端复证:带参发送→引擎生效),更强保证 |
| REQ-022 | 云端定时执行(B 侧):CF cron trigger + schedule registry + 到期 dispatch + A 拉回契约 | feature | B | shipped | **S18 T12 shipped+prod(2026-07-05/06,B PR #17/#18)**:PA-28 全量(D1 registry+分钟 cron+dispatch 原路径+MCP 三工具+jobs?since 拉回契约)已部署 prod 并 e2e(23:25/30/35 三轮:准点触发/overlap skip/删除/`prod fail-closed 401`;research job completed 带真实结果);**codex 审计 2C/2H/2M 全修**(预约先行防双发/cap 计 reserved 恒 fail-closed/overlap 未知态 skip/卡死 6 连 skip 熔断 stuck_job/上限单语句原子);edition 闸 × 云管线默认模型交互发现并处置(dev→intl;cn 适配见新登记项);A 侧消费=REQ-025;详见 alpha-platform PR #17/#18 |
| C3 | 日志治理:opencode.log 145MB 轮转 + netlog 改 opt-in(T2.5) | debt | A | shipped | **PR #35**(→ [s9b](sprints/2026-07-03-s9b-hygiene/sprint.md));`logging.ts`:netlog opt-in(`ALPHA_NETLOG=1` 默认关)+ opencode.log 启动期超限归档(25MB,留最近 3 份);typecheck+97 tests 绿,轮转逻辑合成文件 E2E 6/6 过;**verified 待**运行期首次打包启动真机轮转 |
| C5 | skills 每 Instance 重复扫描 | perf | A | registered | 上游(R2);杠杆=减 Instance 数(B4/B12) |
| C8 | ADR-002 sidecar 语义修订:承认 main-IPC 为桌面等价物(T6.4) | docs | A | verified | **(/loop 2026-07-04)** ADR-002 追加修订(main-IPC = 桌面 sidecar 等价物 + 真 HTTP sidecar 触发条件 YAGNI)+ GLOSSARY sidecar 词条同步 + ARCHITECTURE 硬约束③措辞复核(依旧成立,无需改);详见 [requirements/C8](requirements/C8-adr002-sidecar-semantics.md)  **verified(2026-07-07,S29 α 桶复核)**:ADR-002 修订段成文(main-IPC=桌面 sidecar 等价物 + YAGNI 触发条件)、GLOSSARY sidecar 词条同步 —— docs 类验收即成文一致性 |
| C9 | 代码上云数据边界 mini-ADR:diff-only/secrets 过滤/consent/体积上限(T4.5) | security | X | verified | **S11 T3 完成(PR #56)= [ADR-021](../.claude/rules/adrs/ADR-021-cloud-data-boundary.md)**:显式通道 diff-only+1MB 帽+secrets 拒发(落点 dispatchCloudJob,待实现随 B3 记账)· 隐式通道=告知+BYOK 逃生(不装过滤)· consent 双挂钩留 B16 拍时机;与 B16 分工写明,B16 重启零返工  **verified(2026-07-07,S29 α 桶复核)**:=ADR-021(accepted);§2 三校验已实现+12 单测(S14)、§4 consent 两挂钩点 B16 已 verified(S27 场次二真机)、§5 回流侧 alpha-workdir 已落 —— 决策文档与实现均闭环 |
| C14 | 升级静默破坏面:232 选择器 / 23 处 `as any`;薄 re-export 收敛层(ADR-016 待办①) | debt | A | shipped | **S11 T8(PR #62)**:① `alpha-ui/providers.ts` 薄层建立(组件不得直 import @opencode-ai/app,复核 grep 在册)③ as any 清点 23 处=同一类 SDK codegen 偏斜,双文件契约锚(逐处手写类型不做=第二耦合面)④ brand/patch transform 默认 strict(打偏 build 红,`ALPHA_PATCH_LENIENT=1` 逃生)② 选择器载体=REQ-012 锚点+重指时机收敛到 re-freeze(ADR-020 §5);data-alpha-* 全量重打点不做(冻结使收益消失);详录 [audits/c14](audits/2026-07-04-c14-coupling-convergence.md) |
| C15 | 运行时 SSE/DOM 浪费:firehose 裸遍历 + body 全子树 MutationObserver 收窄 | perf | A | ready | R6:有去抖,影响弱于字面;含 A3 尾项:`session.idle` 全量 session.list 去抖(册 §7g deferred);**(/loop 2026-07-04 defer)** 触多注入组件+漏更新回归风险,验收④需真机 CPU 对比,ROI 低 → 性能专项,详见档 |
| C17 | schema 版本兼容守卫(旧 app × 新 DB) | debt | A | shipped | **S17 T3 shipped(2026-07-05)**:初次 spawn 前预检——DB 超前(未知迁移)→ 阻断对话框〔退出推荐/备份后继续/直接继续〕,不静默继续;将前进 → pre-migration 自动备份;守卫故障 fail-open;支持面清单=构建期派生 JSON 进包(零运行时 import core,硬约束②);34 单测含真 sqlite3 降级场景 fixture;**verified 待打包态演练**(原生对话框 → 真机批);详见 [requirements/C17](requirements/C17-schema-version-guard.md) |
| C20 | alpha-ui i18n 断裂:9 组件硬编码简中 + 每语种 OpenCode 残留(zh:19/en:30)(S8) | ux | A | ready | R7:爆炸半径大于初报;**(/loop 2026-07-04 defer)** 体量大(9 组件)+ 需双语视觉核验(离线不可做)→ i18n 专项;可先拆 brand-i18n 残留 grep 清零子任务,详见档 |
| C21 | 无障碍:focus-trap/键盘/Escape/对比度/reduced-motion(S8) | ux | A | ready | |
| C22 | 依赖漏洞:bun audit 158(2 crit/45 high),多在 dev 工具链 | debt | A | registered | **复扫(/loop 2026-07-04)**:进发布产物的高危面 = 单一包 DOMPurify 3.3.1(moderate/low XSS),在**冻结 `packages/ui`+上游 `session-ui`** → **改不了**(破 ADR-020/北极星);唯一通道=re-freeze 或接受;可利用性推测偏低未证实;定期复扫挂 B7;详见 [requirements/C22](requirements/C22-dep-vulns.md) |
| C23 | 云 SSE 退避/重连/终态判定/`subs` 泄漏(NEW-2/3/4) | debt | A | dup | **→ REQ-003 已修全部四病灶(PR #50)**;respawn 互斥(NEW-4)已随 B5(PR #48) |
| C25 | `open-path` + `ext-install-plugin` exec 触达面收紧 | security | A | shipped | **S11 T7(PR #61)**:`open -a` 收紧为编辑器/查看器白名单(白名单外降级系统默认打开,Terminal 类 exec 原语关闭);plugin 半边核实 SAFE_PACKAGE 已挡 URL/路径(无需改);verified 随打包走查 |
| REQ-043 | variant/agent cycle 的 DOM 轮询竞态:observer 滞后 >90ms 假报「切换失败」 | debt | A | verified | S20 审计发现(2026-07-06):`switchVariantTo`/`switchAgentTo` 逐步 trigger + 固定 90ms 后读 DOM 判停;S20 verify 实测到一次 observer 滞后。**shipped(同日,S20 审计续批,PR #115)**:新增 `cycle-to.ts` 等待原语(read/step 注入、不引 Solid)——单步「轮询等真实文本变化」判档(变化即返,典型切换更快),单步超时 600ms 无变化=控件无响应诚实 false,转满一圈判定不变;两个 switch 重接,7 单测含滞后 60ms 竞态回归例。**verified 待**真机 popover 点选实拍(S21 B4b:ChipPopover 走 Solid Portal + 事件委托,CDP 原生鼠标点开后 item 不渲染 → 与 REQ-041 同款 CDP 驱不动,留真人点选;机制单测已锁)  **verified(2026-07-07,S29-γ,v0.1.1 真机)**:正常路径切档零误报、即时判停;该 DOM 轮询机制本身已随 REQ-055 整体退役(cycle-to 删除)—— 误报类缺陷从机制上不再存在 |

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
| D10 | ui-mac package.json license/author 补全 | docs | A | verified | **PR #35**(→ [s9b](sprints/2026-07-03-s9b-hygiene/sprint.md));package.json 补 license:MIT/author/repository(jinjunnn/alpha-code),gates 绿;**陈旧注释子项已修(S19,2026-07-06)**:index.ts 版本注释去版本化改写(不再随升级过期)——D10 验收①②③全达成  **verified(2026-07-07)**:实读 package.json — license:MIT / author / repository(jinjunnn/alpha-code)三字段俱在 |

## Active — Harness 扩展(E 系列,证据见 E 册)

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| E2 | 钉钉 MCP(补齐飞书/语雀国产三件套) | feature | A | shipped | **S23 shipped(2026-07-06,PR #120 + alpha-web PR #7 双侧上架)**:`dingtalk-mcp@1.1.21`(open-dingtalk 官方发布,MIT 按 npm 元数据;env=DINGTALK_Client_ID/Client_Secret {file:} 化,ACTIVE_PROFILES 可选)+ 入中国办公套件;**供应链警示入 _verify**:官方 org 仓库仅 README、npm 工件无公开源码可审计;官方另有 HTTP+OAuth 网关形态(mcp-gw.dingtalk.com),A 侧无 OAuth 承载暂不接;**verified 待真机**(hub 安装+首调用)|
| E11 | 定制中心目录筛选 UI(category/license) | ux | A | dup | **→ 并入 REQ-019**(hub 左栏 IA + 筛选,T7);catalog schema 已带元数据 |
| E5 | 日历 MCP(Google/macOS) | feature | A | registered | 阻塞:OAuth/凭据存储(keychain TODO,ADR-014 §8) |
| E8 | Slack/Teams MCP | feature | A | registered | 阻塞同 E5 |
| E10 | catalog 远程增量同步(alpha-web 端点) | feature | X | dup | **→ 并入 REQ-032**(2026-07-05:升级为全流程需求——C 端点+验签+资产通道+回退链) |

> 别名/归并:G1 → B6;E12 → B3;E14 → D5(剩实测);E1/E1b/E3/E4 已发(见 E 册);C10 → dup(A6);D7/E7/E13 → Parked;D11 → Done(⊂C1)。

## Parked(搁置,含激活条件)

| ID | 标题 | 搁置原因 | 激活条件 |
|---|---|---|---|
| ~~B16~~ | ~~云派发 PIPL 同意/告知门~~ | **已重启并 shipped(2026-07-06,S25,用户 GO)** → 见 Active-P1 与 [[B16]] | — |
| C19 | Sentry opt-out + 告知 | R6:dormant(`VITE_SENTRY_DSN` 全仓无赋值,从不 init) | 发布流水线注入 DSN 时 |
| D7 | safeStorage 明文兜底告警 | R6:macOS-only 下死分支(钥匙串恒可用) | 跨平台时 |
| E7 | websearch 收编为自有 MCP | 与云端 websearch 撞车 | B3/E12 云线落地后 |
| E13 | 团队协作多端 workspace 同步 | **rejected(2026-07-05,REQ-008 D1:不做共享 workspace/会话)** | 重开 = 真实付费团队需求 + 上游多用户原语 |
| REQ-034 | 外部生态导入转换器:Claude Code plugin 大礼包→套件扇出 + Codex 可共享物导入(安装期转换,[[ADR-023]]) | 用户 2026-07-05:立项但暂不开发,想清楚再启动 | 用户拍板启动(按 ADR-023 执行);详见 [requirements/REQ-034](requirements/REQ-034-ecosystem-import-converter.md) |
| REQ-035 | 本地 harness-as-executor(claude/codex 委托执行,tool/MCP 接缝);长期演进=会话级并轨(GOALS G5) | 用户 2026-07-05:立项但暂不开发,想清楚再启动 | 第一阶段=用户拍板启动;并轨阶段另有硬前置(challenge+POSITIONING 修订+承载 spike+独立 ADR,见档) |

## 当前推进 → **三 sprint 弧(2026-07-06 用户拍板)**

> ① **S28 放量前快车道(开工,无需用户在场)**:REQ-048 落地 + REQ-039 方案/拍板(视体量顺带实施)。契约:[sprints/2026-07-06-s28-prelaunch-fastlane](sprints/2026-07-06-s28-prelaunch-fastlane/sprint.md)。
> ② **S27 场次二(等用户在场,沿用既有契约)**:重 ship 含 PR #127 的签名包(REQ-047 复验打头——毒缓存自愈是全批 env 卫生前提)→ T3 残余(E2 凭证/E6 会话级/M1-6)+ T4 数据凭证 + T5 云线(B16 打头)+ T6 稳定性。
> ③ **S29 v0.1.1 真实发版(候选,前置=场次二收尾)**:场次二包走完整发版 runbook → 收 B9 更新链(自动更新+篡改 feed 拒装)+ B7 ①③⑤;快照刷新随 runbook ①′。
> WIP 注记:S27 场次二用户门控,S28 并行由用户指令豁免(零文件交集)。

## 当前 sprint → **S29 v0.1.1 发版 + γ 桶真机走查(2026-07-07 开批,用户拍板)**

> 目标:①发版 runbook 全程 → v0.1.1(签名+公证+GitHub Release);②装机 0.1.0(7-6 build)走真实更新链 = **B9 verified**;③新包首启验出厂技能迁移 = **REQ-052 verified**;④0.1.1 上跑 γ 桶 UI 走查(矩阵 ~14 项,**只读+截图,零确认框** —— C16 后新规)。契约:[sprints/2026-07-07-s29-v011-release](sprints/2026-07-07-s29-v011-release/sprint.md)。

## 上一 sprint → **S27 真机批 vNext-3 —— 已收尾(2026-07-06/07)**(历史)

> 批前置全过(C 上架远程 agent bug-triage=alpha-web PR #11 · A 快照 2026-07-06.3=PR #125 · 签名+公证重 ship);M1 主链全过 → REQ-044/045/046 verified;场次二 8 项翻 verified + C16 误执行事故(REQ-050/051 登记);**新发现 REQ-047(P0 env 毒化)/REQ-048(更新角标 placebo)**。残单(E2 凭证/E6 会话级/B2 短TTL/cn 复验等)→ 矩阵 δ 桶。契约:[sprints/2026-07-06-s27-realmachine-vnext3](sprints/2026-07-06-s27-realmachine-vnext3/sprint.md) · 证据:[audits/vnext3](audits/2026-07-06-realmachine-vnext3/verify.md)。

## 上一 sprint → **S26 REQ-045 远程补货上架(纯 C 侧)—— 已收尾(2026-07-06)**(历史)

> 用户拍板「先 REQ-045,再攒真机批」。三条 Anthropic skill(Apache-2.0 核验 + NOTICE 溯源)+ bundle:design 回归经远程管线上架(alpha-web PR #10 已部署);prod 验签 + sha256 复验通过;A 仓零动作 = REQ-046 单侧作者纪律首次真实演练。契约:[sprints/2026-07-06-s26-req045-restock](sprints/2026-07-06-s26-req045-restock/sprint.md)。

> **S27 候选(未开,待抽取)**:**真机批 vNext-3**(S22–S26 递延全量攒单,需签名重 ship;完整清单+批前置=[qa/2026-07-06-realmachine-vnext3-plan.md](qa/2026-07-06-realmachine-vnext3-plan.md):M1 定制中心 REQ-045③/REQ-046 远程 agent(前置=C 侧先上架一条)/REQ-044 迁移开门/E2/E6 + M2 数据凭证 C16/B14/C17/B2/B21 + M3 云线 B16/B3/REQ-024/025 + M4 稳定性顺带项)· B22 崩溃复现(并入 vNext-3 M4)· REQ-005 前端收尾(独立方向)。

## 上一 sprint → **S25 B16 PIPL 数据出境同意/告知门 —— 已收尾(2026-07-06)**(历史)

> 用户拍板 GO 重启 B16。显式 per-项目派发同意门(A 侧 main gate + .alpha/prefs.json)+ 隐式登录告知(C 侧授权页 + 隐私政策出境专章);ADR-021 §4 挂钩点落地(A PR #123 + alpha-web PR #9)。契约:[sprints/2026-07-06-s25-b16-pipl-consent](sprints/2026-07-06-s25-b16-pipl-consent/sprint.md)。

## 上一 sprint → **S24 REQ-046 catalog 作者真源收敛 —— 已收尾(2026-07-06)**(历史)

> C catalog-src 唯一作者真源;四类零发版(plugin=通道例外走 npm 发包)。快照脚本+禁手编守卫+agent 远程接线+ADR-023 修订(PR #122 + alpha-web PR #8)。契约:[sprints/2026-07-06-s24-req046-catalog-snapshot](sprints/2026-07-06-s24-req046-catalog-snapshot/sprint.md)。

## 上一 sprint → **S23 C16 数据清除入口 + E2/E6 MCP 条目 —— 已收尾(2026-07-06)**(历史)

> C16(PR #120:清除引擎+分级对话框+UNINSTALL.md)+ E2/E6 双侧上架 + REQ-044 撤架半边补齐(alpha-web PR #7,已部署实测)+ REQ-045/046 登记(#121 拍板回写)。契约:[sprints/2026-07-06-s23-data-clear](sprints/2026-07-06-s23-data-clear/sprint.md)。

## 上一 sprint → **S22 REQ-044 迁移 provenance + catalog 撤无资产条目 —— 已收尾(2026-07-06)**(历史)

> 快车道 bug(S21 真机批 M1 发现),PR #119:① 迁移 provenance 终审(逐字节/形状比对,fail-closed 宁漏迁不碰用户内容)② catalog 撤三无资产条目 + 空壳 bundle:design(补货=REQ-045)。契约:[sprints/2026-07-06-s22-req044-migration-provenance](sprints/2026-07-06-s22-req044-migration-provenance/sprint.md)。

## 上一 sprint → **S21 真机批 vNext-2 + REQ-014 修法 —— 已收尾(2026-07-06)**(历史)

> 用户拍板抽取;challenge 四线裁决(两线拆分/REQ-014 两级全做/走查新发现只登记不内联修/B16 决策请求随 ship gate)。Track A = REQ-014 修法代码 PR;Track B = 重 ship 签名包清 S20 残单(M1=A2 P0 收口排第一)。契约:[sprints/2026-07-06-s21-realmachine-vnext2](sprints/2026-07-06-s21-realmachine-vnext2/sprint.md)。抽取:REQ-014(翻 in-sprint)+ 存量 shipped 项的 verified 残单(状态随证据翻,不另改行)。

## 上一 sprint → **S19 静默失败清尾 + S20 真机批 vNext —— 已收尾(2026-07-06)**(历史)

> S19(PR #111/#112):B11 复扫矩阵 ⏭ 清零(T1–T8)+ B20 收口。S20(PR #113):重 ship 走查 8 项 verified 6,挖修 F-1/F-2(REQ-040/041)+ F-3 记 B23;审计收尾(PR #114)回写补正 + REQ-042/043 登记,续批(PR #115)两债务同日修复。契约:[s19](sprints/2026-07-06-s19-easy-wins/sprint.md) / [s20](sprints/2026-07-06-s20-realmachine-vnext/sprint.md)。

## 上一 sprint → **S18 REQ-022~038 全量清扫批 —— 已收尾(2026-07-05/06)**(历史)

> 抽取 13 项(REQ-022/024/025/026/028/029/030/031/032/033/036/037/038)全部 shipped(PR #98–#110,一 REQ 一 PR,codex 只审计不改码);真机递延归真机批。契约+冲突矩阵:[sprints/2026-07-05-s18-req-sweep](sprints/2026-07-05-s18-req-sweep/sprint.md)。

## 上一 sprint → **S17 深度决策与设计批 —— 已收尾(2026-07-05)**

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
| REQ-047 | shell-env 探针把会话级隔离/调试 env 永久腌进缓存:安装物静默落死目录(placebo ok:true)+ ALPHA_CDP 被腌 = Finder 启动开调试端口 | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| A2 | catalog MCP 全部钉精确版本 + 存量配置一键钉版本(T1.5) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| B16 | 云派发 PIPL 数据出境同意/告知门(显式 per-项目 consent + 隐式登录告知) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| B3 | 云协同最后一公里:cloud MCP 健康 → dispatch → 进度 → artifact 回流(=G4、E12;T4.1-4.3) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| B6 | 装载 `@alpha-code/ext` 主接缝(=G1;T5.1-5.2) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| B14 | 会话 DB 备份/导出(损坏恢复) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| REQ-046 | catalog 双作者源收敛:C 仓唯一作者真源 + A 内置改快照生成 + CI 守卫禁手编 | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| REQ-040 | 冷启动陈旧 defaultServerUrl 无存活校验 → 连死端口卡「无法连接到 Local Server」 | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| REQ-041 | effort chip 对上游英文 variant 模型失效(deepseek=cn 默认:显示不符+切换失败) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| REQ-014 | 悬空会话路由致「Not found」白屏 → 路由恢复前校验会话存在 | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| REQ-024 | 自动化 A2 增强:standard 可写档 + LLM 辅助解析 + 连败熔断 + 立即运行 + 预算/历史 UI | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| C16 | 卸载残留 ≈0.8GB 含凭证:清理方案 + app 内数据清除入口 | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| C28 | placebo 控件诚实化(composer 只读/effort)+ 崩溃屏接管设计 | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| REQ-042 | REQ-040 丢弃陈旧默认服务器:静默无日志 + 陈旧键永不清理 | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| REQ-044 | 迁移候选名字匹配把用户自建技能列为候选(替换风险)+ catalog mcp-builder 打包资产缺失(条目安装恒失败) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| REQ-048 | catalog 存量条目缺 per-entry version:每次发版全量误亮「可更新」角标(placebo 更新提示) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| REQ-045 | 撤下条目远程补货:mcp-builder/canvas-design/brand-guidelines 三 skill 资产经远程 catalog 上架(来源核验+NOTICE+sha256) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
| E6 | 数据库 MCP(sqlite/postgres 读 schema + SELECT) | 详见需求档(无档者证据在原行内/审计档) | archived(2026-07-07,用户指令批量归档) |
