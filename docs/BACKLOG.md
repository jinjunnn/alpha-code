# BACKLOG — 工作项单一真源

> **状态只在本文件翻转**;流程与模板见 [`PROCESS.md`](PROCESS.md)(权威决策 ADR-018)。
> 状态:`registered / ready / in-sprint / shipped / verified / archived`;旁路 `parked / rejected / dup`。
> 类:feature / bug / debt / security / perf / ux / docs / spike。仓:A=alpha-code · B=alpha-platform · C=alpha-web · X=跨仓。
> 证据文档:**册** = [`plans/2026-07-02-problem-register-sprints-review.md`](plans/2026-07-02-problem-register-sprints-review.md)(71 项 + R1-R7 修正 + §7f-7j 实施日志);**核查** = [`audits/2026-07-02-register-verification.md`](audits/2026-07-02-register-verification.md);**E 册** = [`harness-extension-backlog.md`](harness-extension-backlog.md)。
> 下一个新需求编号:**REQ-024**(新需求一律 REQ-NNN;A/B/C/D/E 为历史审计系列保留原号,用户 2026-07-03 确认)。
> **需求文件全覆盖(2026-07-03)**:全部开放的 A/B/C/D 条目已逐条建档 `requirements/<ID>-<slug>.md`(含验收标准),行内备注为摘要、**文件为验收真源**;E 系列以冻结 E 册为分析文档;parked/dup 项不建档。

## 发布短名单(launch-blockers,册 §6.8)

| # | 项 | 现状 |
|---|---|---|
| 1 | A7 签名/公证 | ✅ verified(v0.1.0) |
| 2 | **A6 秘钥继承给第三方 MCP/LSP** | ❌ **唯一剩余硬阻断** |
| 3 | B19 sync + B18 CI + B10 北极星守卫 | ✅ verified |
| 4 | B15 NOTICE + C18 品牌 | ✅ shipped / verified |
| 5 | B16 云派发 PIPL 同意门 | ⏸️ parked(用户搁置) |
| 6 | B11 系统性静默失败 | ⚠️ 部分(统一错误面未做) |
| 7 | B9 更新链完整性 | ⚠️ 部分(feed 已修;完整性/downgrade 未做) |

## ⚖️ 待拍板队列(需用户方案决策 —— 非 blocked,开工提案时必须附上提醒)

| 决策点 | 载体 | 影响 |
|---|---|---|
| 产品定位连拍(剩 5):团队协作 / 企业租户 / 用户下沉 / 后端前 2-3 功能 / 前端余项;~~G4 优先级~~ **已拍板(2026-07-03,S11):G4 提优先、抬为 headline** | REQ-008 | rules 三文件收口,排期基准 |
| ADR-014 未决 4 项:MVP 范围表述 / ~~Agent·Command 进 tab~~(**O2 方向已定 2026-07-04:Agent 进 tab、Command 不单列**,随 v3 方案/REQ-018;转正时写入 ADR 修订)/ F9 串台开关 / 远程 catalog 依赖 C 仓 | REQ-006 | 定制中心 roadmap + ADR 转正 |
| composer「只读」「effort」控件三选一:真实现 / 改文案 / 移除 | C28 | 用户可见行为 |
| 关 `OPENCODE_EXPERIMENTAL_FILEWATCHER` 的功能代价是否接受 | B12 | 文件树/diff 刷新体验 vs 内存 |
| B16 PIPL 同意门重启时机(现 parked;云派发/公开分发前必须) | B16 | 合规,发布节奏 |
| REQ-011 首页 composer 下方「预留位」最终放什么(云派发入口 G4/B3 / 定制中心 / 常用命令 / 暂空) | REQ-011 | 首页黄金位信息架构 |

> 拍板即从队列划掉、结论写进对应需求文件;执行中撞到未拍板点 = 停下来问,不代替决策。

## Active — P0

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| A6 | sidecar env 白名单:阻断平台 JWT / BYOK 密钥 / EXA key 继承给第三方 MCP/LSP 子进程 | security | A | shipped | **PR #40**(→ [S9](sprints/2026-07-03-s9-proxy-e2e/sprint.md));方案=白名单(`sidecar-env.ts` default-deny)+ `{file:}` 密钥通道(`alpha-secret-files.ts`,fork 时镜像/吊销)联动——勘察实锤泄漏是**两条通道**(密钥 env 直继承 + `OPENCODE_CONFIG_CONTENT` 内联明文),单做白名单会断平台/BYOK;typecheck+**115 tests** 绿(+18 安全路径);采纳方案/行为变化/残余风险见 [requirements/A6](requirements/A6-sidecar-env-allowlist.md);**verified 待真机**:MCP 子进程 env dump + 四链路复验 + 登出吊销(清单在档)。**R3 门控未解除**(解除随 verified,届时解锁 A2b/E2/E6) |
| A2 | catalog MCP 全部钉精确版本 + 存量配置一键钉版本(T1.5) | security/perf | A | shipped | **S12 完成**:catalog 全条目钉版本(2026-07-03)+ **存量一键钉迁移随 T3 迁移引擎落地(PR #71)**——迁移复用 catalog 已钉版本重装,旧位净除。**verified 待真机迁移开门演练**(`ALPHA_MIGRATE_ENABLE=1`,随 A6 R3 解锁,REQ-016 同场)。R3 澄清:catalog 钉版本≠推广安装、不扩 A6 面 |

## Active — P1

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| REQ-001 | 网关 allowed-providers/models 白名单接口 + 客户端按版本显隐(国内版 DeepSeek 系 / 国际版世界模型) | feature | X | verified | **B=alpha-platform `e6e90c1`(prod 已部署)· A=PR #41**(→ [S9](sprints/2026-07-03-s9-proxy-e2e/sprint.md));`/v1/models` 返回 edition+byok_providers,`EDITION_CONFIG` env 改配置不发版(dev server 实测生效);A 侧文件桥缓存 + picker/装配收窄 + 降级徽标;**验收⑤已拍板**:BYOK 目录跟随 edition、自定义节点不拦(记录在档);收编 D2、消灭占位 id 漂移;B 215 tests / A 126 tests 绿;**verified 待真机 picker 截图**(与 A6/REQ-002④ 同场);详见 [requirements/REQ-001](requirements/REQ-001-gateway-provider-allowlist.md) |
| REQ-002 | 平台↔alpha-code 代理联调:E2E 打通并计量出数 | feature | X | shipped | **S9;核心链路 verified**(登录→platform→真实模型流式→计量出数,4 次调用一致累加);修 3 断点:BP-1 网关流式计量 waitUntil 缺位(B,`6fe49f3` prod 部署)· BP-2 冷启动登录态丢失(A,待重打包 verify ④)· BP-3→REQ-014;证据 [audits/2026-07-03-req002](audits/2026-07-03-req002-proxy-e2e.md);④ token 过期(B2)/logout 复验未做 |
| REQ-003 | 网关 SSE 流式健壮性:卡顿/断连/重连/心跳审查与加固 | debt | X | shipped | **PR #50**;审查报告 [audits/2026-07-03-req003](audits/2026-07-03-req003-sse-robustness.md)(链路1 B 侧已健壮,2 建议项留档;链路2 C23 四病灶全修+90s 悬挂回收,7 单测);**C23 随本批关闭**;弱网 UI 呈现 → 真机批+B11;详见 [requirements/REQ-003](requirements/REQ-003-gateway-sse-robustness.md) |
| REQ-010 | alpha-ui 视觉 + 注入/路由回归修复批(546-sync 后 reskin 耦合面失效,图1–图9) | bug | A | verified | **ADR-020 冻结使名字级断裂蒸发**(app/ui 回到 6/30 reskin 验证态,4 个"死"锚点在冻结树运行时为活);剩余 = **冻结态真机视觉核验**(图1–9 逐屏对照,→ 真机批);若仍有残症才另修;历史诊断见审计及其修正节;**冻结态真机核验通过**(prod 包 CDP 截图:首页/会话/picker 全换肤,用户消息气泡等回归元素恢复,[audits/2026-07-03-realmachine-verify](audits/2026-07-03-realmachine-verify.md));详见 [requirements/REQ-010](requirements/REQ-010-alpha-ui-visual-regression.md) |
| REQ-012 | 上游同步前端回归防护:锚点契约测试 + sync tripwire + post-sync 视觉冒烟 gate | debt | A | shipped | **PR #44**;范围拍板=锚点存在性 only(像素基线不做);清单 195 alive/4 dead + 5 用例契约测试 + sync tripwire + 发版 runbook ⓪ 步;**首跑即修正原审计:94 死→真死 4(session-ui 搬包)+ v0.1.0 回放 0 名字级死→结构性断裂假说上位**(审计修正节);详见 [requirements/REQ-012](requirements/REQ-012-frontend-sync-regression-guard.md) |
| REQ-013 | 前端脱耦策略:让 alpha UI 免疫上游前端 churn(选定并落地) | spike | A | verified | **拍板=E 冻结 @ 546 前(用户 2026-07-03)→ ADR-020 落地(PR #45)**:tag `frontend-freeze-base` + sync restore 步 + 守卫范围修订;spike 实证 546 偏斜下 typecheck/build 全绿(唯 3 行 alpha WSL 适配);A 防护网已先行(REQ-012);**上游前端 churn 自此物理隔离**;verified 待冻结态真机视觉核验(→真机批);详见 [requirements/REQ-013](requirements/REQ-013-frontend-decoupling-strategy.md) |
| REQ-018 | 定制中心 v3-M1 通用化地基:安装账本 + 全类型卸载 + **免重启生效(dispose)** + `.alpha` 双层落盘迁移 + MCP 密钥 file 化 + Agent tab | feature | A | shipped | **S12 完成(PR #66–#71)**;修 P0×4(装完 placebo/明文密钥/已装态缺失/写盘根跑偏);T1 账本·T2 `.alpha`桥·T4 dispose 免重启·T5 密钥`{file:}`+采集·T6 全类型卸载·T7 Agent tab+skill-creator·T3 迁移(门控);**引擎级四步端到端 PASS**([audits/s12-verify](audits/2026-07-04-s12-ext-hub-m1-verify.md));266 单测;**verified 待真机批**(in-app 四步/A6 env dump 解 R3/迁移开门 → REQ-016 同场);方案 [designs/ext-hub-v3](designs/2026-07-04-extension-hub-v3-universal.md) |
| B1 | 登录 shell 同步探测黑屏 → 异步化 + 缓存(T1.2) | perf | A | shipped | **PR #49**;缓存命中 0ms + 后台异步刷新(shell 键控/空探测不缓存/真 export 赢);首启保持同步(fork 前必须有 PATH);**verified 待真机**(缓存命中启动耗时);详见 [requirements/B1](requirements/B1-shell-probe-async.md) |
| B2 | refresh token 续期 + 401 拦截 + 失败降级 BYOK/登出(T3.1 剩余) | feature | A | shipped | **PR #42 + alpha-web `a1d4d8a`**;寿命拍板 7*24h(env 可调短测试)+ 提前量续期(整点 tick)+ 401 拦截重试 + invalid_grant 降级登出(明确 UI)+ 冻结 token 快死备胎 respawn;REQ-002④ 过期路径就此成型;134 tests 绿;**verified 待真机**(短 TTL 实测 过期→续期/撤销→降级/logout 不串台);详见 [requirements/B2](requirements/B2-refresh-token.md) |
| B3 | 云协同最后一公里:cloud MCP 健康 → dispatch → 进度 → artifact 回流(=G4、E12;T4.1-4.3) | feature | X | shipped | **S11 T2(PR #55+#58)**:回流全链落地——主进程 `alpha-workdir.ts`(`.alpha/runs/<runId>/`,防逃逸/消毒/体积帽)+ `cloud-save-run` IPC(#55);renderer `CloudRunWatcher`(firehose tool-part 终态检测 → saveRun → toast,worktree 映射,纯解析核 10 单测)+ i18n(#58);呈现=会话内工具调用(验收④,引擎原生);**verified 待真机**:登录态 in-app dispatch 冒烟(兼 REQ-004 verified);配额预估 UI(验收⑥后半)→ T4/B11 账户 banner 一并;**R1:勿切端点** |
| B4 | 巨型目录当项目(`/`、`~`、`~/Documents` 建 Instance)治理 | perf | A | ready | 部分上游(R2);alpha 杠杆=垃圾项目引导/隐藏项目不取数;`worktree==="/"` 跳过已做(PR #23) |
| B5 | sidecar 崩溃自愈 + respawn 竞态/互斥(T2.4 + NEW-4) | debt | A | verified | **全量完成:PR #48(互斥)+ PR #57(S11 T5 崩溃自愈)**——意外退出指数退避自愈(1s→16s,5 次封顶防风暴,60s 健康在线重置梯子;gen 区分蓄意 kill/迟到 exit)+ 未健康不 reload(竞态修复,验收②);纯逻辑 4 单测;**verified(2026-07-04)**:真机 kill -9 → respawn(pid 更替)+ renderer/登录态完好截图([audits/s11-ship-visual](audits/2026-07-04-s11-ship-visual-verify.md));详见 [requirements/B5](requirements/B5-sidecar-self-heal.md) |
| B6 | 装载 `@alpha-code/ext` 主接缝(=G1;T5.1-5.2) | feature | A | verified | **PR #46**(→ [S10](sprints/2026-07-03-s10-hardening/sprint.md));extraResources alpha-ext/ + StartCommand 传路径 + injectAlphaConfig 合并 V1 `plugin` 数组;ALPHA_EXT_DISABLE 逃生;缺 bundle loud warn;**verified 待真机**(alpha_ping 进工具表且执行 = G1 成功条件 + zod 跨实例证明);详见 [requirements/B6](requirements/B6-ext-seam-activation.md) |
| B7 | 发布流水线制度化:CI 断言版本/种子资产/断网首启 smoke(T2.6 剩余) | debt | A | ready | 部分:DISTRIBUTION.md 已写 + S7 部分断言 |
| B8 | 扩展物运行时生命周期:版本/健康/更新三要素(T5.4/T5.6) | feature | A | registered | 系统性条目,症状=A2;终态=定制中心从商店→运行时管理器;**具体实现路径已立 = REQ-018(账本/生效)+ REQ-019(详情/更新),B8 保留为终态验收视角** |
| B9 | 更新链完整性:关 `allowDowngrade` + feed 完整性校验 | security | A | shipped | **PR #47**(→ [S10](sprints/2026-07-03-s10-hardening/sprint.md));降级闸关闭(理由入注释:单 prod 渠道无跨渠道降级需求;旧版逃生=手动 dmg);完整性链文档化(yml sha512 → zip → 签名同 identity → 降级闸);**verified 待下个真实发版**(自动更新实测 + 篡改 yml 拒装用例);详见 [requirements/B9](requirements/B9-update-chain-integrity.md) |
| B11 | 统一错误/健康呈现面 + 账户 banner(S8 底座) | ux | A | shipped | **S11 T4(PR #60)**:Banner 基元 + pushToast 唯一出口(hub 私有 toast 收编)+ 首页/hub store.error banner + 账户 error 判别式(#1 误显根治,picker error 态+重试;侧栏会员行不装「未订阅」)+ **B23 configHealth**(语法错/未知顶键 → warning banner,5 单测)+ splash 状态行(B20);复扫矩阵 20 项:✅10/🆗6/⏭4([audits/rescan](audits/2026-07-04-silent-failure-rescan.md));⏭4(会话操作 toast/登录链事件/骨架/连崩呈现)留行内追;**verified 待视觉批**(banner/toast 截图) |
| B12 | Instance 不驱逐 + 递归 watcher 常驻 | perf | A | ready | 上游归属(R2);alpha 杠杆=`server.ts:58` 停强开 `OPENCODE_EXPERIMENTAL_FILEWATCHER` + 垃圾项目治理(B4) |
| B13 | DB 跨进程并发(SQLITE_BUSY → orDie) | debt | A | registered | 上游归属(R2);R6 降级:busy_timeout=5000 已缓解;alpha 无直接修点 |
| B14 | 会话 DB 备份/导出(损坏恢复) | feature | A | registered | 上游 DB 本体改不了(R2);alpha main 纯文件操作可做备份/导出 |
| B20 | 弱网降级 UX:超时/重试/splash 状态/真骨架/websearch 优雅降级(S8) | ux | A | ready | **S11 已收尾,余项转回 ready**;S11 T4 部分随 PR #60(splash 状态行 + banner/重试底座);余项=真骨架(Skeleton 死代码去留)/promptAsync 超时(豁免记录)/websearch(上游 R2 豁免),见 [audits/rescan](audits/2026-07-04-silent-failure-rescan.md) ⏭/🆗 行 |
| B21 | BYOK 改键/删键即时生效(触发重注 env/respawn) | bug | A | shipped | **PR #48**;根因=env 桥 set-if-unset 滞留旧 key;修=自有注入权威覆盖/清除(用户值永不动,纯逻辑 5 单测)+ 改键回调触发重注+respawn;删键即时吊销;**verified 待真机**(改键→picker 即时反映→新 key 出账);详见 [requirements/B21](requirements/B21-byok-key-live-reload.md) |
| B22 | message-timeline.tsx:481 会话时间线崩溃 | bug | A | ready | 546-sync 后**先代码复验再修**;疑 timeline-inject DOM 注入扰动上游 virtualizer |
| B23 | strict-key 配置致瘫:全局 jsonc 解析失败 → 整份配置静默清零 | bug | A | shipped | **S11 T4(PR #60)呈现半边落地**:`configHealth()`(语法错 + 未知顶层 key 双病灶,V1 顶键集自引擎 schema;5 单测)→ AlphaHome warning banner + 打开配置;写前校验(C2)继续挡 alpha 自写;上游清零行为本体不可改(R2);**verified 待视觉批**(故意写坏配置截图) |

## Active — P2(债务)

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| REQ-004 | `.alpha` 项目工作目录:桥接验证 + 回填 ADR-019 | spike | A | shipped | **S11 T1 完成(PR #54)**:config 注入 CONFIRMED(生产在用)+ symlink 桥 CONFIRMED(引擎同款 glob fixture 6/6,整目录链/多跳链均通,one-hop 假说证伪);双写回退不启用;schema/gitignore 已回填 ADR-019 修订;证据 [audits/req004-spike](audits/2026-07-03-req004-alpha-bridge-spike.md);**verified 待 B3 T2 打包态 in-app 冒烟**;详见 [requirements/REQ-004](requirements/REQ-004-alpha-workdir-spike.md) |
| REQ-015 | 冻结前端 typecheck 偏斜:session-ui(546 后新增)依赖新版 ui API 与冻结 ui 不兼容 | debt | A | registered | ADR-020 冻结缺口;**CI 绿**(alpha-ci 只查 ext/ui-mac)**只卡本地 pre-push**(上游全量 turbo);影响面窄(session-ui 仅喂上游 enterprise/storybook,alpha 不 ship);方案 移包/补丁/`--no-verify`/扩冻结范围 待拍板;详见 [requirements/REQ-015](requirements/REQ-015-frozen-frontend-typecheck-skew.md) |
| REQ-016 | 真机验证收尾批:A6 R3 解锁 / B2 短TTL / REQ-002④ logout / B3 in-app(登录门控/破坏性 4 项) | spike | X | registered | S9+S10 真机自动验证已 verified 一批(见 [audits/realmachine-verify](audits/2026-07-03-realmachine-verify.md));剩 4 项登录门控/破坏性/需改 prod 配置,收敛后续统一执行;**A6 verified 解 R3 门控**(A2b/E2/E6);**A6 子项随 S12 T8 真机批同场消化**;详见 [requirements/REQ-016](requirements/REQ-016-realmachine-verify-batch.md) |
| REQ-014 | 悬空会话路由致「Not found」白屏 → 路由恢复前校验会话存在 | bug | A | registered | REQ-002 联调 BP-3;`tabs.recent` 指向已删会话 → 冷启动整屏 Not found 无恢复入口;alpha 杠杆=恢复前校验会话存在、失败回退首页;详见 [requirements/REQ-014](requirements/REQ-014-dangling-session-blank-screen.md) |
| REQ-005 | 前端接管收尾核验:重型引擎换肤(终端/diff/权限流)完成度 + timeline 验收尾项(截图归档/COUPLING 清单/真机验收) | ux | A | ready | ADR-016 待办②;tasks.md 40 项全勾但 dev-plan:98-100 未走完;COUPLING 清单关系 C14;详见 [requirements/REQ-005](requirements/REQ-005-frontend-takeover-closeout.md) |
| REQ-006 | ADR-014 转正收尾:桌面端验收用例(装 markitdown→免重启可用→卸载→依赖预检)+ 4 个 plan-review 未决项拍板 → trial 转 accepted | docs | A | in-sprint | **S12 顺带(T8 真机批同场)**;事实核查:Phase ④(plugin 装包)实际已发(E 册,commit 59c0786),ADR 前提已满足;设计文档 §C1-C5 未勾系文档滞后,随核验回勾;桌面验收依赖 D5 同场;O2 已定(Agent 进 tab) |
| REQ-008 | 产品定位〔待补〕决策批:团队协作/企业租户/用户下沉/前 2-3 具体功能/G4 优先级,一次收口 | spike | X | registered | POSITIONING/GOALS/NON_GOALS 三处〔待补〕;详见 [requirements/REQ-008](requirements/REQ-008-positioning-open-decisions.md) |
| REQ-009 | alpha-ci 提速:guard partial clone + bun 依赖缓存 | debt | A | ready | **真 CI 痛已由 D12 解**(卡的是上游 blacksmith 僵尸 workflow,非 alpha-ci);alpha-ci 本体已 ~30-46s **本就 <2min 目标达标** → REQ-009 降级为**可选打磨**(partial clone + bun cache 再压时间);验收「改上游必红」用例仍需真 CI run;详见 [requirements/REQ-009](requirements/REQ-009-alpha-ci-speedup.md) |
| REQ-011 | 首页 composer 下方项目/会话 chips 移除 → 预留后续功能入口位 | ux | A | registered | 用户 2026-07-03;非回归=信息架构决策(侧栏已有项目导航,首页去重);只清场留白,「预留位放什么」进⚖️待拍板;详见 [requirements/REQ-011](requirements/REQ-011-composer-project-chips.md) |
| REQ-019 | 定制中心 v3-M2:hub **横向 tab** IA(2026-07-04 拍板,否决左栏)+ 逐类型详情页(数据边界/实时依赖检测)+ 「添加」三档分流 + 更新通道 + 导入 folder/git | feature | A | shipped | **S13 全量 shipped(2026-07-04,PR #74-#77)**:横向 IA+详情页+三档分流(#74)、六类专属区块+tools[](#75)、实时依赖+更新通道+导入(#76)、筛选/行内反馈+供给链(#77);验收汇总 [audits/s13-acceptance](audits/2026-07-04-s13-acceptance.md);**verified 待真机批**(卸 uv/断网 vendored/git 真克隆/dispose 打断,与 REQ-016 同场);吸收 E11;详见 [requirements/REQ-019](requirements/REQ-019-ext-hub-detail-lifecycle.md) |
| REQ-020 | 定制中心 v3-M3:云能力进 hub(登录门控+pipeline 条目)+ **ADR-021 §2 三校验落地** | feature | X | shipped | **shipped(2026-07-04,PR #80,S14 T1–T4)**:三校验(guard 单测 12 例,ADR-021 翻 ✅)+ 云分区门控 + 连接器详情 + pipeline 条目(启用=receipts-only,code-review diff-only dispatch 入口);**T5 远程 catalog 不抽**(门=C 端点未建,E10 留册);**verified 待真机批**(platform 点亮双态截图/真发被拒/hub 端到端,并入 REQ-016);BYOK 灰显态已 CDP 三屏核验;契约 [sprints/s14](sprints/2026-07-04-s14-ext-hub-m3/sprint.md);是 REQ-021 A3 硬前置;详见 [requirements/REQ-020](requirements/REQ-020-ext-hub-cloud.md) |
| REQ-021 | 自动化(定时任务)完整需求:A1 本地只读 MVP → A2 增强 → A3 云档位 | feature | A | registered | **用户拍板 2026-07-04:先完整需求、按优先级分步;MVP 只读档**;侧栏定制中心下方入口;新 ADR-022 随 A1 立;详见 [requirements/REQ-021](requirements/REQ-021-automations.md) |
| REQ-022 | 云端定时执行(B 侧):CF cron trigger + schedule registry + 到期 dispatch + A 拉回契约 | feature | B | registered | **用户拍板 2026-07-04 立项 B 仓**;B 侧真源 = alpha-platform `designs/2026-07-04-cloud-scheduled-automations.md`(PA-28 proposed);前置 PA-27 P0 整改 + REQ-020 T1;详见 [requirements/REQ-022](requirements/REQ-022-cloud-schedules-platform.md) |
| REQ-023 | 扩展安装供给链:官方扩展全配置化 + 离线资产通道(vendored plugin/agent,绝对路径写 plugin[] 绕 npm 下载)+ 安装管线状态机 | feature | A | shipped | **shipped(2026-07-04,PR #77)**:agent 进 catalog(code-reviewer 只读档)+ vendored 插件零网络(opencode-notify,绝对路径进 plugin[],卸载净除)+ 安装状态机;**verified 待真机批**(关 Wi-Fi 走查 + osascript 回退通知);不自建 CDN(→E10/REQ-020);详见 [requirements/REQ-023](requirements/REQ-023-ext-supply-chain.md) |
| C3 | 日志治理:opencode.log 145MB 轮转 + netlog 改 opt-in(T2.5) | debt | A | shipped | **PR #35**(→ [s9b](sprints/2026-07-03-s9b-hygiene/sprint.md));`logging.ts`:netlog opt-in(`ALPHA_NETLOG=1` 默认关)+ opencode.log 启动期超限归档(25MB,留最近 3 份);typecheck+97 tests 绿,轮转逻辑合成文件 E2E 6/6 过;**verified 待**运行期首次打包启动真机轮转 |
| C5 | skills 每 Instance 重复扫描 | perf | A | registered | 上游(R2);杠杆=减 Instance 数(B4/B12) |
| C8 | ADR-002 sidecar 语义修订:承认 main-IPC 为桌面等价物(T6.4) | docs | A | ready | YAGNI:真 HTTP sidecar 出现需求再立 |
| C9 | 代码上云数据边界 mini-ADR:diff-only/secrets 过滤/consent/体积上限(T4.5) | security | X | shipped | **S11 T3 完成(PR #56)= [ADR-021](../.claude/rules/adrs/ADR-021-cloud-data-boundary.md)**:显式通道 diff-only+1MB 帽+secrets 拒发(落点 dispatchCloudJob,待实现随 B3 记账)· 隐式通道=告知+BYOK 逃生(不装过滤)· consent 双挂钩留 B16 拍时机;与 B16 分工写明,B16 重启零返工 |
| C12 | CORS 过宽(localhost/无 Origin 放行) | security | A | registered | 上游(R2);alpha 杠杆=先撤自己注入的 `ACAO:*`(→C24) |
| C14 | 升级静默破坏面:232 选择器 / 23 处 `as any`;薄 re-export 收敛层(ADR-016 待办①) | debt | A | shipped | **S11 T8(PR #62)**:① `alpha-ui/providers.ts` 薄层建立(组件不得直 import @opencode-ai/app,复核 grep 在册)③ as any 清点 23 处=同一类 SDK codegen 偏斜,双文件契约锚(逐处手写类型不做=第二耦合面)④ brand/patch transform 默认 strict(打偏 build 红,`ALPHA_PATCH_LENIENT=1` 逃生)② 选择器载体=REQ-012 锚点+重指时机收敛到 re-freeze(ADR-020 §5);data-alpha-* 全量重打点不做(冻结使收益消失);详录 [audits/c14](audits/2026-07-04-c14-coupling-convergence.md) |
| C15 | 运行时 SSE/DOM 浪费:firehose 裸遍历 + body 全子树 MutationObserver 收窄 | perf | A | ready | R6:有去抖,影响弱于字面;含 A3 尾项:`session.idle` 全量 session.list 去抖(册 §7g deferred) |
| C16 | 卸载残留 ≈0.8GB 含凭证:清理方案 + app 内数据清除入口 | debt | A | ready | |
| C17 | schema 版本兼容守卫(旧 app × 新 DB) | debt | A | registered | 上游 DB(R2);alpha 可做启动前版本预检 |
| C20 | alpha-ui i18n 断裂:9 组件硬编码简中 + 每语种 OpenCode 残留(zh:19/en:30)(S8) | ux | A | ready | R7:爆炸半径大于初报 |
| C21 | 无障碍:focus-trap/键盘/Escape/对比度/reduced-motion(S8) | ux | A | ready | |
| C22 | 依赖漏洞:bun audit 158(2 crit/45 high),多在 dev 工具链 | debt | A | registered | 发布产物暴露面小;定期复扫 |
| C23 | 云 SSE 退避/重连/终态判定/`subs` 泄漏(NEW-2/3/4) | debt | A | dup | **→ REQ-003 已修全部四病灶(PR #50)**;respawn 互斥(NEW-4)已随 B5(PR #48) |
| C24 | CSP 落地 + 撤 alpha 自注入 `ACAO:*`(exfil 通道) | security | A | verified | **S11 T6(PR #59)**:ACAO/ACAH 收敛回环-only(darwin;win32 留旧供 WSL)+ 打包态 renderer CSP(connect-src=self+回环,script=self+wasm-unsafe-eval 供 ghostty,img 放 https 供 markdown 远图;双路径注入 webRequest+protocol.handle;`ALPHA_CSP_DISABLE=1` 逃生);11 单测;**verified(2026-07-04)**:双态走查 + exfil 取证 + 终端 WASM 断点走查实抓并修复(PR #64,connect-src data:)+ 复验干净;证据 [audits/s11-ship-visual](audits/2026-07-04-s11-ship-visual-verify.md) |
| C25 | `open-path` + `ext-install-plugin` exec 触达面收紧 | security | A | shipped | **S11 T7(PR #61)**:`open -a` 收紧为编辑器/查看器白名单(白名单外降级系统默认打开,Terminal 类 exec 原语关闭);plugin 半边核实 SAFE_PACKAGE 已挡 URL/路径(无需改);verified 随打包走查 |
| C27 | Electron fuses(关 RunAsNode)+ asar-integrity + entitlements 收紧 | security | A | verified | **S11 T7(PR #61)**:fuses 六项(RunAsNode/NODE_OPTIONS/inspect 关 + asar-integrity/OnlyLoadAppFromAsar/CookieEncryption 开)+ entitlements 移除 dylib 注入组合三项(保 JIT 两项+audio;若 native 加载失败仅回补 library-validation 一项);记账 DISTRIBUTION.md §5;**verified(2026-07-04)**:fuses 执行 + entitlements dump 实证三删 + 公证一次过 + spctl accepted/staple validate + 全屏走查;证据 [audits/s11-ship-visual](audits/2026-07-04-s11-ship-visual-verify.md) |
| C28 | placebo 控件诚实化(composer 只读/effort)+ 崩溃屏接管设计 | ux | A | registered | 顶层 ErrorBoundary 方案已实测证伪撤回(册 §7h);品牌部分已由 C29 修;剩=控件诚实化 + 边界下沉设计 |

## Active — P3(卫生)

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| REQ-007 | ADR-015 待办①③:per-agent prompt 优化清单 + Tier-3 回答长度校准桌面实测 | docs | A | registered | 待办②(sync tripwire)已随 S7 完成 |
| D1 | 健康轮询先 sleep 100ms 再首查 | perf | A | ready | |
| REQ-017 | `alpha-check.sh` 北极星守卫未跟 ADR-020(仍扫 packages/app → 本地自检恒假红,与 alpha-ci 不再 1:1) | debt | A | shipped | **PR #63**:UPSTREAM_PATHS 对齐 alpha-ci.yml(移出 app/ui,本地实跑三关全绿)+ `ext-fs-installer.opencodeConfigDir` 改 XDG-aware(与 ext-config/上游同规则,修写读分叉);verified=本地 alpha-check 实跑绿(记录于行内) |
| D2 | `/v1/models` live 同步死代码 | debt | A | dup | **→ 并入 REQ-001**(接进 picker 按白名单装配) |
| D3 | 官方 4 条 Anthropic skills 内容打包 + NOTICE(T5.3) | feature | A | dup | **→ 并入 REQ-018**(T7 官方 skill 资产打包);原状:现诚实失败,非占位 |
| D4 | 定制中心 skill 卡片「已安装」态(T5.4) | ux | A | dup | **→ 并入 REQ-018**(安装账本 receipts ⨝ SDK 真相,全类型已装态一并解决) |
| D5 | playwright MCP 浏览器内核来源实测拍板(=E14 遗留;T5.5) | spike | A | ready | 关 ADR-014 `_verify` |
| D6 | userData 每启动新建 log 目录 | debt | A | registered | 7 天清理已有,观察 |
| D8 | DB WAL 周期 TRUNCATE | debt | A | registered | 上游(R2) |
| D9 | 分支命名 DB 累积 | debt | A | registered | R6:仅 dev 机器关切,prod 单库 |
| D10 | ui-mac package.json license/author 补全 | docs | A | shipped | **PR #35**(→ [s9b](sprints/2026-07-03-s9b-hygiene/sprint.md));package.json 补 license:MIT/author/repository(jinjunnn/alpha-code),gates 绿;**index.ts:82 陈旧注释子项未做**(与 S9/REQ-002 deep-link 同文件避撞)→ 该子项待 S9 收尾后另修,行保留 |
| D12 | CI 卫生:上游 cron workflow 在 fork 误触 + lint gate + e2e 范围 | debt | A | verified | **2026-07-03 live 处置**:26 个上游 workflow `gh workflow disable`(仅留 alpha-ci/sync-upstream),清 20 个挂死 queued run;根因=上游 `runs-on: blacksmith-*` runner 本 fork 无 → queued 挂死(=「CI 卡/连不通」真因,非 API);零改 yml(设置层,ADR-005 不破);证据+清单见 [requirements/D12](requirements/D12-ci-hygiene.md) 验证记录 |

## Active — Harness 扩展(E 系列,证据见 E 册)

| ID | 标题 | 类 | 仓 | 状态 | 备注 |
|---|---|---|---|---|---|
| E2 | 钉钉 MCP(补齐飞书/语雀国产三件套) | feature | A | registered | 核实官方包名/鉴权字段;**上架受 A6 门控(R3:新增条目=扩安装面)** |
| E6 | 数据库 MCP(sqlite/postgres 读 schema + SELECT) | feature | A | registered | 命令型,无 OAuth;**上架受 A6 门控(R3)** |
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
| E13 | 团队协作多端 workspace 同步 | NON_GOALS〔待补〕未决 | 产品定位决策后 |

## 当前 sprint → **S13 已就绪待接手(2026-07-04,定制中心 v3-M2)**

> **抽取**:REQ-019(headline)—— hub 左栏 IA + 逐类型详情页 + 更新通道 + 导入 + E11 筛选。契约见 [sprints/2026-07-04-s13-ext-hub-m2](sprints/2026-07-04-s13-ext-hub-m2/sprint.md)(**自含 M1 地基指针,新 session 可直接抽 T1 开工**)。**起手 = T1 IA 重排**(左栏竖栏),T2 详情页框架挂其上,T3/T4 填类型区块+边界,T5/T6 更新+导入并行,T7 打磨,T8 真机截图批。**WIP=1**:S12 收尾达标(shipped+引擎级 verified,真机残余折 REQ-016)。后续 M3(REQ-020 云)/M4(REQ-021 自动化)择一续(设计 §8 序 M2→M3→M4;M4 可提前)。

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

## Done(shipped/verified,待 retro 归档)

| ID | 标题 | 落点 | 验证 |
|---|---|---|---|
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
