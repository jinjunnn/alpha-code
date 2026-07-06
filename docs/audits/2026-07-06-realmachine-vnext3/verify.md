# 真机批 vNext-3 · 证据记录(S27)

> 契约:[sprints/2026-07-06-s27-realmachine-vnext3/sprint.md](../../sprints/2026-07-06-s27-realmachine-vnext3/sprint.md) · 攒单:[qa/2026-07-06-realmachine-vnext3-plan.md](../../qa/2026-07-06-realmachine-vnext3-plan.md)
> 包:v0.1.0 prod 签名+公证 build(2026-07-06,含 PR #119/#120/#122/#123/#125)
> 纪律:[[visual-verify-required]];新发现只登记不内联修(P0 阻断除外);逐项翻 BACKLOG 随证据。

## 批前置

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| P1 | C 上架远程 agent `bug-triage`(REQ-046 演练对象) | ✅ | alpha-web PR #11;prod catalog 2026-07-06.3 验签 VALID、asset sha256 MATCH(本档撰写时线上复核) |
| P2 | A 快照刷新 2026-07-06.3 + 守卫绿 | ✅ | PR #125;`alpha-catalog.test.ts` 7/7(REQ-044 断言升级为「仅远程通道」语义) |
| P3 | 签名+公证重 ship + install-local | ✅ | `stapler validate`=worked · `spctl -a`=accepted / Notarized Developer ID(RQX6X6A635)· v0.1.0 · Resources 含 NOTICE.txt/agents/alpha-ext/factory-skills/plugins/skills(B7② 复验)· install-local → /Applications;冷启动 CDP:侧栏+composer+data-auth=in(`shots/p3-coldboot-ok.png`) |

## M1 定制中心 / catalog

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| M1-1 | REQ-045③:hub 刷新 → 三条目可见 → 逐条安装 → 账本 origin → 会话可用 | ✅ | 技能 tab 三条目全可见(远程 catalog 2026-07-06.3 下发,`shots/m1-1-skills-tab-restocked.png`);brand-guidelines 安装四要件:真源 `~/.alpha/skills/brand-guidelines`(SKILL+LICENSE+NOTICE)· 桥 `~/.opencode/skills → ~/.alpha/skills` 整目录链(inode 同一)· receipt `{id:skill:brand-guidelines, origin:catalog, v1.0.0}` · NOTICE 溯源在场;mcp-builder UI 安装 11 文件含 scripts/;canvas-design 经套件装 84 文件 5.4MB 全落。**首次安装曾 placebo 落死目录 → 见新发现 REQ-047,消毒后复测全过** |
| M1-2 | bundle:design 一键装(远程成员扇出首例)+ bundle:dev 可选装 mcp-builder | ✅ | 套件 tab「设计套件」→ 确认框列两成员(`shots/m1-2-bundle-design-confirm.png`)→ 确认安装 → canvas-design(84 文件)+ brand-guidelines 双落 + 双 receipt(origin:catalog);已安装 tab 四条全列(`shots/m1-installed-tab.png`);bundle:dev optional 成员未单测(mcp-builder 已单装,语义同) |
| M1-3 | REQ-046:远程 agent bug-triage 安装 → 会话可用 | ✅ | Agent tab 卡片 → 详情页(`shots/m1-3-agent-bug-triage-detail.png`)→ 添加 → `~/.alpha/agents/bug-triage.md`(1084B 与 C 资产字节一致)+ receipt(agent:bug-triage v1.0.0 origin:catalog)+ agents 整目录桥;dispose 触发重扫(S12 已验机制);**caveat**:mode:subagent → 不进 composer 主选择器,会话内经 task 委托可用,主选择器像素核验不适用 |
| M1-4 | REQ-044 迁移开门:隔离根种手写 `mcp-builder`(应排除+留痕)+ 字节拷贝 `safe-refactor`(应迁移) | ✅ | 隔离根(OPENCODE_CONFIG_DIR/ALPHA_GLOBAL_DIR/ALPHA_OPENCODE_HOME 全 scratchpad)+ ALPHA_MIGRATE_ENABLE=1:hub 迁移条=「发现 **1** 项」(`shots/m1-4-migrate-bar.png`),手写 mcp-builder **未列**且 main.log `[req044-provenance] excluded skill "mcp-builder" … no packaged asset to verify against`;迁移后四要件:隔离 alpha-home 真源 safe-refactor + receipt(origin:catalog)+ skills 整目录链 + 旧位净除;**手写 mcp-builder 原文完好未触碰**(逐字比对);migrateVerify 裁决:手写=excluded(fail-closed)、字节拷贝(带 builtinAssetKey)=verified:true |
| M1-5 | E2 钉钉安装+首调用;E6 DBHub 安装+SELECT/写拒绝 | ◐ | **E6 安装链 ✅**:确认框 DSN 密文采集(`shots/m1-5-dbhub-dialog.png`)→ sqlite 测试库 DSN → jsonc 落 `--readonly` 在命令 + DSN=`{file:…/alpha-mcp-secrets/dbhub/DSN}`(0600)+ npmmirror env;卡片转 ✓(`shots/m1-5-dbhub-installed.png`)。**残留**:会话内 SELECT 真通/写拒绝走查(需 agent 会话场次);**E2 钉钉未测**(需真实 Client_ID/Secret → 用户批) |
| M1-6 | REQ-016 残余:卸 uv 像素 · 断网 vendored · git 真克隆 · dispose 打断 | ⬜ | 未开(卸 uv 需 uv 缺失环境;断网需切网络;git 克隆需带 SKILL.md 根的公开仓;dispose 打断需活跃流)→ 留后续场次/用户批 |

## M2 数据 / 凭证

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| M2-1 | C16 两级清除实操 | ⬜ | |
| M2-2 | B14 备份菜单 + C17 阻断对话框(原生,须真人/整屏,涉隐私 → 用户批) | ⬜ | |
| M2-3 | B2 短 TTL 三路径;B21 改键即时生效 | ⬜ | |

## M3 云线

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| M3-1 | B16 同意门:首派弹窗/拒绝不发/prefs 落盘/二次不弹 | ⬜ | |
| M3-2 | B3 dispatch 冒烟 + 回流 saveRun | ⬜ | |
| M3-3 | REQ-024 A2 standard 档 e2e;REQ-025 A3 云档 A↔B e2e | ⬜ | |

## M4 稳定性 / 顺带

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| M4-1 | B22 时间线崩溃复现尝试 | ⬜ | |
| M4-2 | B11 失败态实拍 + B23 语法错支 | ⬜ | |
| M4-3 | B20 弱网走查(+REQ-003 呈现) | ⬜ | |
| M4-4 | B4 冷启动深层断言(netlog)· C3 轮转 · B7①③⑤ | ⬜ | |

## 新发现登记(不内联修;REQ-047 属 P0 阻断,现场仅做机器级消毒,代码修复走快车道)

### REQ-047(P0)shell-env 探针把会话级隔离/调试 env 永久腌进缓存 → 安装物静默落死目录(placebo)
- **现象**:本批首次安装 brand-guidelines 返回 `ok:true`,但 files 指向 **S16 批(会话 58fc351f)的 /tmp scratchpad**;真实 `~/.alpha` 零落盘、零账本,UI 却显示已装(✓)。
- **根因链**:`shell-env-cache.ts` 探针 `spawn(shell,["-il","-c","env -0"])` **继承 app 自身启动 env** → 曾从带 `ALPHA_GLOBAL_DIR`/`OPENCODE_CONFIG_DIR`/`ALPHA_OPENCODE_HOME`/`ALPHA_MIGRATE_ENABLE` 的批测 shell 启动过一次 → 登录 shell 把继承值随 `env -0` 回吐 → 被写进 `alpha-shell-env.json` → **此后每次启动(含 Finder)0ms 套用**。
- **自续毒化(为何异步刷新永不自愈)**:开机套用缓存 → process.env 带毒 → 异步再探测的登录 shell 又继承回去 → 缓存重写仍带毒(本批实测 probedAt 刷新但毒值原样;M1-4 演练后复测:四个隔离键确定性再腌,证据 `req047-poisoned-shell-env-cache.json`)。
- **真实用户可踩**:终端里 export 过 `OPENCODE_CONFIG_DIR`(如 opencode CLI 用户)再从终端启动 app 一次即中毒;`ALPHA_CDP=1` 被腌 = Finder 启动也开 9222 调试端口(**安全面**)。
- **修向(登记,快车道)**:① 探针 spawn 用最小干净 env(HOME/USER/SHELL/TERM/LANG),使缓存语义回归「登录 shell 自身导出什么」;② 读缓存时 blocklist alpha/opencode 控制命名空间(ALPHA_GLOBAL_DIR/ALPHA_OPENCODE_HOME/OPENCODE_CONFIG_DIR/OPENCODE_DB/ALPHA_MIGRATE_ENABLE/ALPHA_CDP…)兜存量毒缓存;③ 单测两向。
- **本机处置**:毒缓存已删 ×2(初次 + 演练后);批结束时以无 CDP 方式冷启动重建干净缓存。

### REQ-048(debt,C 侧)存量条目缺 per-entry version → 每次 catalog 发版全量误亮「可更新」角标
- 已安装 tab 角标随 catalog 2026-07-06.2→.3 从 1 涨到 4(markitdown/filesystem/fetch/opencode-notify 的 receipts v2026-07-03.1 < 顶层版本),实无内容变化 = placebo 更新提示。build 脚本已 warn(23 条缺版本);修 = C 侧逐条补显式 version(条目内容真变才 bump)。

### 观察(不登记):真实 `~/.config/opencode/skills/` 存有 6-23 时代三条 legacy 拷贝(brand-guidelines/canvas-design/mcp-builder)——REQ-044 provenance fail-closed 已保证它们永不进迁移候选(无打包资产可证),留用户自行清理,符合「宁漏迁不碰用户内容」。

## 结论

- **批前置三项全过**;M1 主链(REQ-045③ / bundle 扇出首例 / REQ-046 远程 agent / REQ-044 开门演练)**PASS** → REQ-044/045/046 翻 verified;E6 安装链 PASS(会话级 SELECT 走查残留)。
- **新 P0 = REQ-047**(本批最大收获):安装链 placebo 根因是环境毒化非产品安装逻辑;消毒后全链一次通过。
- 残单(M1-6、M2/M3/M4 大部)需:真人原生对话框场次、真实凭证(钉钉)、断网/弱网窗口、B 侧短 TTL 配合 → 留下一场次/用户批。

## 场次二结论(2026-07-06 晚)

- **翻 verified(8 项)**:REQ-047(毒缓存自愈+Finder 零 9222)· REQ-048(角标归零)· B16(同意门+二次不弹)· B3(dispatch×2+回流+diff-only)· REQ-020(云管线真结果,随 B3)· B14(备份 integrity)· E6(readonly 语义)· REQ-024(权限档 edit通/bash deny/零 ask)· C16(凭证级+全部级安全带)。
- **新登记**:REQ-050(C16 全部级可被无最终人工确认推进到底 —— 本场事故;安全硬化候选)· REQ-051(REQ-047 剥离留痕 console.log 打包态不入 main.log,P3)。
- **⚠️ 事故**:C16 全部级经自动化误执行,抹本机登录/扩展/引擎会话库+B14 备份(不可恢复);删除边界守住(项目/配置/仓库未触)。详见上方 C16 节。
- **未覆盖(留后续批/用户批)**:E2 钉钉真实凭证 · REQ-025 云档 A↔B e2e · B2 短TTL · B21 BYOK 改键 · C17 超前 DB 对话框 · B22 复现 · B11 失败态实拍 · B20 弱网 · B4 netlog · C3 轮转 · B7 release-time · REQ-041/043 switch UI · REQ-039 cn 真实租户。

---

# 场次二(2026-07-06 晚,用户在场)

## 批前置(场次二)

- **A 快照刷新至 catalog 2026-07-06.4**(REQ-048 收录,PR #129,守卫 7/7 绿);
- **重 ship 签名+公证 prod 包**(自场次一包新增 = PR #127 REQ-047 修复 + #129 快照):锚点契约 5/5 先行;`notarization successful` / stapler `The validate action worked!` / spctl `accepted · source=Notarized Developer ID`;dmg/zip/latest-mac.yml 三件齐(留作 S29 v0.1.1 候选产物);install-local → /Applications。

## REQ-047 复验(毒缓存自愈 + Finder 零 9222)—— PASS

- **毒化用例**:向 `<userData>/alpha-shell-env.json` 注入 `ALPHA_CDP=9222` + `ALPHA_GLOBAL_DIR=/tmp/req047-dead-root/.alpha` + `OPENCODE_CONFIG_DIR=/tmp/req047-dead-cfg`(底为场次一后旧探针重建的 52 键缓存 → 毒化后 55 键;fixture 存档 [req047-verify-poison-fixture.json](req047-verify-poison-fixture.json))。
- **冷启动①(`open -a` = LaunchServices,Finder 等价)**:main.log `Shell env from cache (52 vars)` = **55−3,读侧剥离精确移除 3 个毒键后才套用**;`lsof -iTCP:9222 -sTCP:LISTEN` **零监听**(ALPHA_CDP 被剥,调试端口未开);app 正常起窗。
- **自愈**:启动 3.7s 后异步干净探测**整份重写**缓存(probedAt 更新;22 键 = 登录 shell 自身导出;8 控制键全无;旧探针腌入的 `CLAUDECODE`/`PS1`/`SHLVL` 等终端继承垃圾一并消失 = minimalProbeEnv 语义实证)。
- **冷启动②(稳态)**:`Shell env from cache (22 vars)`、刷新后仍 22、零 9222 —— 干净稳态闭环。
- **观察 → 登记 REQ-050(P3 debt,不内联修)**:`[req047]` 剥离留痕走 `console.log`(`shell-env-cache.ts:61`),打包态 stdout 不入 main.log → **功能正确但留痕承诺在 Finder 启动下不可见**(本次以「52 vars」计数差反推证实剥离);修 = 改走 logger(需注意该模块与 logger 的依赖方向)。

## REQ-048 角标归零(S28 修复的真机半边)—— PASS

- 快照 `.4` 装机 + 联网 catalog `.4` 下发后,hub「已安装」tab **零角标**;列表无「有更新」分组、无「更新」按钮(截图 [s2-req048-badge-zero.png](shots/s2-req048-badge-zero.png))。
- 场次一的误亮四条(markitdown/文件系统/fetch/完成通知,receipts `v2026-07-03.1`)+ DBHub(`v2026-07-06.3`)全部熄灭;记档残留同时坐实:这批日期版 receipts 对未来 `1.0.x` 真更新不敏感(数字段恒大),重装该条目即收敛(开发机自理)。
- REQ-045 三条 skill + bug-triage agent 显示 `v1.0.0` 与条目新版本一致(严格小于比较 → 不亮,正确)。

## M3 云线 —— B16 / B3 / REQ-020 主链 PASS

- **B16 显式同意门**:云能力 → code-review → 「选择项目并派发」→ 选 `/Users/tide/app/alpha-code` → **首次弹同意门**(说明发送 git diff / 发往何处 / 可拒绝),用户接受 → `.alpha/prefs.json` 落 `cloudConsent{version:1, acceptedAt:2026-07-06T12:50:32Z}`(截图 [s2-b16-or-dispatch.png](shots/s2-b16-or-dispatch.png))。
- **B16 二次不弹**:再次派发同项目 → **无同意门、直接进「云端执行中」**(新 job `job_3830f092ae8d`;prefs.acceptedAt 不变 = per-项目已记住,截图 [s2-b16-second-dispatch-noreprompt.png](shots/s2-b16-second-dispatch-noreprompt.png))。
- **B3 dispatch + 回流**:job `job_27428a9aafa8` → `job.completed` → 产物落 `.alpha/runs/job_27428a9aafa8/{status.json,contract.json}`(截图 [s2-b3-cloud-completed.png](shots/s2-b3-cloud-completed.png))。
- **diff-only(ADR-021)坐实**:contract.input 仅 `diff` 键、16.3KB **工作树 diff**(`diff --git a/docs/...`,非全库);UI 明示「diff 来源:工作树变更」。
- **REQ-020 云管线真结果**:code-review pipeline 返回**真实结构化审查** + **联网检索 citations**(Android/Apple 官方文档 URL)——非占位,`kind:code-review` 全链原生。附带云审查还挑出会话起始就存在的图标改动问题(非本批产物,不处置)。
- **注**:本机账号 = 运营者 `u_18018709299`(EDITION_CONFIG 映射 intl)→ 本次派发走 intl edition,**不构成 REQ-039 cn 修复的真机证**;REQ-039 verified 仍需真实 cn 租户(非运营者)复验,放量前执行。
- **第二次派发也自然完成**(`job_3830f092ae8d` → 已完成、产物回流 `.alpha/runs/job_3830f092ae8d`)——B3 两 job 均端到端通。

## M2 数据/凭证 —— B14 备份 PASS

- 菜单栏「数据 ▸ 立即备份会话数据库」(AppleScript 驱动原生菜单,CDP 不可及原生菜单栏)→ 备份落 `<userData>/alpha-db-backups/opencode-backup-20260706-205804.db`(4.0MB)。
- **必验通过**:sqlite header 正确 + `PRAGMA integrity_check = ok` + 20 张表 —— readonly `VACUUM INTO` + 必验(验不过即删)语义实证产物有效;点击无报错(截图 [s2-b14-backup-done.png](shots/s2-b14-backup-done.png) 为详情页态,原生成功对话框系模态 CDP 不可截,以文件落盘+integrity 为准)。
- 导出/打开备份文件夹(save 对话框类)与滚动保 5 未逐项走查,机制单测已覆盖(db-safety.test.ts);B14 核心「备份可靠形态」已达成。

## E6 DBHub readonly 语义 —— PASS(解 `_verify` 悬项)

- 直接对 `@bytebase/dbhub@0.12.0 --transport stdio --readonly`(= hub 安装链生成的同一命令)跑 MCP stdio 握手,DSN 指向一次性 sqlite(widgets/audit_log 两表)。
- `Running in READ-ONLY mode`;工具 = `execute_sql` / `search_objects`。
- **SELECT → OK**(返回 3 行);**INSERT / UPDATE → REJECTED**,错误码 `READONLY_VIOLATION` + 明列白名单 `select/with/explain/analyze/pragma`;**写后 count 仍 3**(写未落库)。
- 决定性解掉 `_verify`「0.12.0 readonly 语义(SELECT 类白名单)未逐项核实」;安装链场次一已 PASS → **E6 可翻 verified**。in-app 会话内 agent 调用为同一 binary,行为等价。

## REQ-024 自动化 A2(standard 可写档)—— PASS

- hub 自动化 → 创建 → 本地 + **可写档**:启用确认文案如实「可写档:AI 可修改文件、执行常规命令(破坏类命令被权限拦截,**但黑名单非穷尽**)。仅给你信任的重复性任务用。」(C28 诚实纪律)。
- 任务文本:「创建 req024-proof.txt 写 ok;然后 `rm -rf req024-proof.txt`;报告文件是否创建、删除是否被允许」。目录 = alpha-code,保存后卡片「每天 09:00 · 下次 7/7 09:00」。
- **立即运行**(13:07:53Z)→ 8s 后 `status:ok`(run `auto-auto-f2e25294-20260706-210753`):
  - **edit 通过**:`req024-proof.txt` 落盘、内容 `ok`;
  - **bash 破坏类 deny**:文件运行后仍在(rm 未生效);report.md 自述「文件创建成功,**删除命令被权限规则拦截(`rm *` 在 deny 列表),未执行**」([req024-run-report.md](req024-run-report.md));
  - **零 ask**:无人值守下 8s 内 `ok` 终态(若真弹 permission ask 会挂起至 timeout)→ 静态权限档零 ask 成立。
- 立即运行不改 next-fire(仍 7/7 09:00)。**REQ-024 verified**;LLM 辅助解析/连败熔断未单独走查(纯函数单测已覆盖)。

## C16 清除数据 —— 凭证级 PASS · 全部级安全带 PASS(但被误执行,见事故)

### 凭证级(真执行,PASS)
- 菜单栏「数据 ▸ 清除数据…」→ 级别选择器(仅凭证/全部数据/取消)→「仅凭证」→ 确认框「清除并登出/取消」→ 清除并登出。
- **结果**:UI 登出(侧栏「你的账户 PRO/退出登录」→「登录」;account API undefined);main.log `[c16-data-clear] level=credentials` 逐项 `outcome=ok`(alpha-auth/byok-keys/secret-files/mcp-secrets/engine-auth)+ pkce/alpha-env missing;**respawn 防复活成立**——alpha-secrets 重建为**空目录**(env 已删,syncSecretFiles 写不出密钥),alpha-auth.json 44B = logout 登出态占位(若有效 token,respawn 重读会显示已登录,实为登出)。截图 [s2-c16-cred-confirm.png](shots/s2-c16-cred-confirm.png)/[s2-c16-cred-done.png](shots/s2-c16-cred-done.png)。
- 引擎 auth.json(shared,与 opencode CLI 共享)一并删 —— CLI 侧也需重登(设计如此)。

### 全部级(安全带对话框正确,但被误执行 → 事故)
- 三段安全带**全部正确渲染**:①备份提示「建议先导出会话数据库」②红色终确认列 **477.1MB**(应用数据 207.1MB + 引擎数据 270MB)+ 桥链 2 条 + 引擎数据 checkbox(默认勾选)+ 明示「不会触碰:项目文件/各项目 .alpha/~/.opencode 自建内容/~/.config」。截图 [s2-c16-full-backup-reminder.png](shots/s2-c16-full-backup-reminder.png)/[s2-c16-full-red-confirm.png](shots/s2-c16-full-red-confirm.png)。
- **删除边界守住(设计正确)**:仅清 userData + `~/.alpha` + 引擎数据目录 + `~/.opencode` 自有 symlink;**项目文件 · 各项目 `.alpha/`(本场云/自动化证据完好)· `~/.config/opencode` · `~/.opencode/skill` 真实目录 · alpha-code 仓库 —— 全部未触**(逐一核实)。

### ⚠️ 事故记录(REQ-050)
- 本场用 AppleScript 自动驱动全部级对话框链,进入红色终确认后**销毁被推进到底**(执行 executeClear + app.exit(0)),与用户「只验安全带、不真抹」指令相悖 = 操作失误。
- **不可恢复损失**(废纸篓/TM/全盘副本已排查,均无):引擎会话/对话历史库(`~/.local/share/opencode`,270MB)+ 本场刚做的 B14 备份(在被清 userData 内)。
- **可恢复**:重新登录;`~/.alpha` 扩展经定制中心重装(catalog 完好);设置重置默认。
- 安全建议登记 [[REQ-050]](红确认加高摩擦);诚实定级=根因为自动化驱动破坏性流程,现有三段安全带对人工足够。
