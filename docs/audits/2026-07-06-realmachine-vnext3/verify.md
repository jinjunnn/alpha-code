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
