# S21 真机批 vNext-2 —— 逐项证据(2026-07-06)

> 包:**ship1** = alpha HEAD @ PR #116(REQ-014 预清 tier-1/tier-2-list + S20 续批 REQ-042/043);**ship2** = + PR #117(tier-2 改按 id 直查)。均 prod 渠道签名+公证(0.1.0 / com.tide.alphacode / Team RQX6X6A635)。
> 方法:REQ-016/S20 同法(`ALPHA_CDP=1` + 二进制启动,CDP 9222;DOM 断言 + 截图落 `shots/`;日志 `~/Library/Application Support/ai.opencode.desktop/logs/<run>/main.log`);破坏性操作先备份后还原(store 备份 `scratchpad/s21-backups/`);M1/C17 用隔离根(`OPENCODE_CONFIG_DIR`/`ALPHA_GLOBAL_DIR`/`ALPHA_OPENCODE_HOME`/`OPENCODE_DB` 覆盖),零碰真实数据。
> 状态:✅ PASS · ⚠️ 部分 · ❌ FAIL(附定性)· ⏭ 留用户批/下批(附原因)。

## B0 —— 打包/安装(ship1 + ship2)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| B0 | 签名+公证 + 装机冷启动 healthy | ✅ | `stapler validate`=worked · `spctl -a`=accepted / Notarized Developer ID · dmg+zip+latest-mac.yml 三件齐 · Resources 含 agents/plugins/skills/factory-skills/alpha-ext/NOTICE.txt(兼 B7② 复验);冷启动 CDP:侧栏渲染 + 16 项目 + 登录态 PRO + composer(deepseek-v4-flash)|

## B2 —— REQ-014 修后复验(ship1 tier-1 + ship2 tier-2)· B4 —— REQ-042/043

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| B2-tier1 | 植形态 B(缺 dirBase64,S17 原件形状)+ 旧格式 recent → 冷启动正常起屏 + 毒键剔除 + 留痕 | ✅(ship1,run 20260706T060710)| CDP probe:`connectFail:false, notFound:false, upstreamErrorPage:false, sidebar:true, projectCount:16, composer:true`(截图 `shots/b2-coldboot-poisoned-ok.png`);main.log:`[req014-preclean] dropped (tabs): malformed session tab … 形态 B` + `dropped (recent): recent key matches no surviving tab` + `tier-1 done: dropped 2 entries, 83 kept`;store 核验:`poisonB_remaining:0`、原始 82 条保留 |
| B2-tier2 | 植形态 A(悬空会话 id,格式合法)→ ship2 冷启动剔除 | ✅(ship2,run 20260706T064915)| main.log:`[req014-preclean] dropped (tabs): dangling session tab … ses_s21danglingA…`(我植的形态 A 毒键)+ **顺带剔一个真实悬空 tab**(`ses_1272e0b5…` kama-bot-local 已删会话)+ `tier-2 done: dropped 2, 84 kept` + `tier-2 fail-open: 1 unverifiable — kept`(留痕);store 核验:`danglingA_remaining:1→0`;截图 `shots/b2-ship2-tier2-ok.png`;DOM 全绿(`connectFail:false, sidebar:true, projectCount:16`)。**ship1 list 版当场证伪修正闭环**:list `?limit` 真机不生效 → id 直查生效 |
| B4a | REQ-042:植 `defaultServerUrl: http://127.0.0.1:59998` → 留痕 + 键消失 + 无「无法连接」 | ✅(ship1)| main.log:`[server] discarding stale local default server url (http://127.0.0.1:59998) — … (stale key removed)`;store 核验:`defaultServerUrl:null`;冷启动无「无法连接到 Local Server」(`connectFail:false`)|
| B4b | REQ-043:effort popover 切档实拍 | ⏭ 留用户批 | ChipPopover 走 Solid Portal + 事件委托,CDP 原生鼠标事件(Input.dispatchMouseEvent)点开 chip 后 popover item 未渲染出(`.a-pop-item` 空)—— 与 S20 同款 CDP 驱不动;机制由 cycle-to 7 单测(含 60ms 滞后回归)+ tabs 侧 normalizeVariant 锁定,像素留真人点选 |

## B1 —— M1 迁移开门演练(隔离根)✅

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| B1 | `ALPHA_MIGRATE_ENABLE=1` + 隔离 legacy 种子 → hub 迁移条 → 迁移 → 四要件 | ✅ | migrateScan:`{enabled:true, skills:["safe-refactor"]}`;hub featured 迁移条「发现 1 项可迁移的旧安装 / 迁移到 .alpha」(截图 `shots/b1-m1-migrate-bar.png`);点击 → toast「已迁移 1 项」+ 迁移条消失(截图 `shots/b1-m1-migrated-ok.png`);**四要件核验**:① `~/.alpha/skills/safe-refactor/SKILL.md` 落地 ② `installs.json` receipt(origin:catalog, version:2026-07-05.1) ③ 旧位 `legacy/skills/` 空 ④ 桥 `~/.opencode/skills → ~/.alpha/skills` symlink |

> ⚠️ **发现(登记不内联修 → REQ-044)**:① 真实 `~/.config/opencode/skills/` 含用户自有内容,`mcp-builder` 与 catalog 同名——名字匹配启发式会把**用户自建技能**列为迁移候选(替换风险)→ 真实根迁移留用户批,本演练用隔离根;② 种子 `mcp-builder` 首次迁移「已迁移 0 项 · 1 失败」——builtinAssetKey `skills/mcp-builder` 未随 app 打包(Resources/skills 仅 skill-creator/alpha-upstream-sync/safe-refactor)→ 该 catalog 条目安装恒失败(诚实失败非静默),换 `safe-refactor`(资产在包)即 PASS。**mcp-builder 打包缺失 = REQ-044 同记**。

## B3 —— B7 发布断言

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| B7① | 打包产物版本断言(非 local/0.0.0)| ✅ | `PlistBuddy CFBundleShortVersionString`=`0.1.0`(非 local/0.0.0);latest-mac.yml version 同 |
| B7③ | 断网首启 smoke | ⏭ 留用户批 | 真断网需切断本机网络(agent 不代跑,S20 同先例)|
| B7⑤ | 0.0.0 注入 → 守卫红 | ⏭ 归下批 | 依赖①的 release-time 版本断言守卫脚本(B7 档验收⑤,需 CI 侧构造,非本真机批范畴)|

## B5 —— C17 超前 DB 对话框演练 ⚠️

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| B5 | 隔离 `OPENCODE_DB` 构造超前 DB(未知迁移)→ 阻断对话框 | ⚠️ 日志级 PASS,原生对话框像素留用户批 | 隔离 sqlite 库注入 `20991231000000_future_from_the_future`(未来迁移),`OPENCODE_DB=<隔离>` 启动 → main.log:`db-safety: DB AHEAD of app — 1 unknown migrations (latest 20991231000000_future_from_the_future)` = 守卫触发且走 AHEAD 分支(`dialog.showMessageBox` 阻断档);**原生 Electron dialog CDP 驱不到、整屏截图会侵入用户隐私桌面 → 像素诚实留用户批**(真人点选〔退出/备份继续/直接继续〕);B14「数据」菜单实操同属原生菜单,留用户批 |

## M2/M4/M3 —— 扩展生命周期

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| M2 | git 导入真克隆 | ✅ | `importSkillGit("https://github.com/jinchenma94/bazi-skill", {scope:"global"})` → `{ok:true, name:"bazi"}`;隔离真源落 `~/.alpha/skills/bazi/SKILL.md`(公网 16KB 小仓,https 浅克隆 `--depth 1 --single-branch --no-tags`);receipt `origin:imported`;顺带发现契约:preload target 必须是 `{scope:"global"}` 对象非字符串"global"(字符串报「invalid project directory」)|
| M4 | dispose 打断活跃流(定性)| ⚠️ 定性:卸载即时生效、无崩溃,打断与否不确定 | 长回复流式中卸载 bazi → `uninstall {ok:true}`;卸载后正文停止增长(4767→4767),app 无崩溃/无错误 toast、侧栏存活。**但无法区分「dispose 打断了流」vs「回复恰好写完」**(该 prompt 约 600 字,时间接近);会话消息端点未取到确证。定性结论:**卸载在活跃流期间安全(不崩溃、UI 存活),打断语义未证**;归下批精确复现(超长 prompt + 时间戳比对)|
| M3 | 卸 uv 像素 | ❌ 未验成(PATH mask 被 app shell-env 探测绕过)| `PATH=/usr/bin:/bin` 启动后进 markitdown 详情页仍显示「uv ✓」——app 主动探测用户登录 shell env(`shell-env.ts` source rc 找回 `/opt/homebrew/bin`)→ 简单 PATH mask 不足以模拟缺失;真「卸 uv」需临时移走二进制(侵入本机工具链,不做)→ 留用户批或隔离容器 |

## 记账
**跑了 11 项 · ✅ PASS 5(B0/B2-tier1/B4a/B1/B7①/M2)· ⚠️ 部分 3(B5 日志级/M4 定性/B2-tier2 待 ship2)· ❌ 1(M3 mask 失效)· ⏭ 留用户批/下批 3(B4b/B7③⑤)。**
- **真机核心价值**:B2 首验当场证伪 tier-2 list 版(`session.list?limit` 真机不生效 → placebo)→ 改按 id 直查(PR #117)——challenge 阶段 Skeptic 的 placebo 预警在第一次接触真机时应验。
- **新发现登记(不内联修)**:REQ-044(迁移名字匹配把用户自建列为候选 + mcp-builder catalog 条目打包资产缺失)。
- **verified 翻转**:REQ-014 tier-1 + REQ-042 = ship1 verified;REQ-014 tier-2(形态 A)待 ship2;M1(=A2 P0 收口)verified;B7① verified。
- **ship2 待验**:B2-tier2 形态 A 冷启动剔除(真实 store 已含形态 A 毒键 `ses_s21danglingA…`,ship2 冷启动应剔)。
