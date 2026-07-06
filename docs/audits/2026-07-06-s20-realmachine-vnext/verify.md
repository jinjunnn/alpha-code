# S20 真机批 vNext —— 逐项证据(2026-07-06)

> 包:alpha HEAD(9cb8b047,含 S17–S19 全部代码)重 ship,prod 渠道签名+公证。
> 方法:REQ-016 同法(直接二进制启动 + `--remote-debugging-port`;截图 `{fromSurface:true}` 落 `shots/`;日志 `~/Library/Application Support/ai.opencode.desktop/logs/<run>/main.log`)。
> 状态:✅ PASS · ❌ FAIL(附定性)· ⏭ 未执行(附原因)。

## P 组 —— 打包/安装

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| P1 | 签名+公证 + 包内资产 | ✅ | `stapler validate`=worked;`spctl -a`=accepted / Notarized Developer ID;dmg+zip+latest-mac.yml 三件齐;Resources/ 含 agents(code-reviewer.md)· plugins(opencode-notify)· factory-skills · skills · alpha-ext(plugin.js)· db-expected-migrations.json · NOTICE.txt(**兼 C5/B7② 复验**)|
| P2 | 装机冷启动 healthy | ✅(修污染态后)| install:local → /Applications/alpha-code.app(0.1.0 / com.tide.alphacode / Team RQX6X6A635);冷启动 CDP:侧栏渲染 + 三项目 + 登录态 `data-auth=in`(账户 PRO)+ 首页 composer(deepseek-v4-flash / effort「高」/ 权限「请求审批」)。截图 `shots/p2-coldboot-ok.png`。**首次冷启动曾卡「无法连接到 Local Server」→ 见 finding F-1** |

### F-1(冷启动 finding)—— 陈旧 `defaultServerUrl` 无存活校验 → 死端口无回退
- **现象**:首次冷启动整屏「无法连接到 Local Server · 正在自动重试…」,侧栏不挂。
- **根因**:`opencode.settings`(electron-store)持久化了 `defaultServerUrl: http://127.0.0.1:52743`(具体端口);sidecar 每次 `server.listen(0)` 随机新端口(本次 62919)→ `availableStartupServer` 原样返回陈旧 URL → AppInterface 连死端口 52743。日志佐证:`getDefaultServerUrl()` 返回 52743 而 `server ready` 在 62919。
- **触发面/严重度**:`setDefaultServer` **仅**由手动「服务器选择」弹窗的「设为默认」按钮 + WSL 设置写入(`app/src/components/dialog-select-server.tsx:70`、`wsl/settings.tsx:139`),**无自动持久化路径**;alpha 侧栏隐藏该 chrome → 普通用户不触发。本机 52743 = 历次 dev/prod 实验或旧 Tauri 迁移遗留的**污染态**,非普遍冷启动 bug(与 S16 verified 正常启动一致)。
- **处置**:备份 `opencode.settings`(工作备份,含用户真实态,未入库)后删 `defaultServerUrl` 键 → 冷启动恢复(P2 截图)。
- **真实缺口(记一笔)**:持久默认对 sidecar 型 localhost URL **无存活校验、无回退到 `sidecar`**——属 REQ-014「陈旧 store → 冷启动破且无恢复入口」家族。→ **已修(REQ-040,本 PR)**:`wsl/connections.ts` 加纯函数 `isEphemeralLocalServerUrl`(判 `127.0.0.1|localhost|[::1]:PORT`),`getDefaultServer` 读到即返 null → 回退 `sidecar`;5 单测(口径修正见文末);零改上游。**verified 待**重打包冷启动(植陈旧 key → 回退正常起窗)。

## M 组 —— 扩展生命周期(本批未执行,归下批;不阻断)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| M1 | 迁移开门(`ALPHA_MIGRATE_ENABLE=1` + 种子)| ⏭ 未执行 | 需 flag 重启 + 存量种子;本批优先清 findings,归下批 |
| M2 | git 导入真克隆 | ⏭ 未执行 | 同上,agent 可做,时间未及 |
| M3 | 卸 uv 像素(PATH 遮蔽)| ⏭ 未执行 | 同上 |
| M4 | dispose 打断活跃流(定性)| ⏭ 未执行 | 同上 |

> M 组本批未跑(时间用于 P/B/C 组 + 挖到并修复 F-1/F-2 两个真机 bug)。均 agent 可做、非阻断,原样留 REQ-016/下一真机批。

## C 组 —— 云/引擎链路(登录态)

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| C1 | saveRun 回流(in-app dispatch → `.alpha/runs`)| ⏭ 留用户批 | 消耗平台额度 + 需完整云往返;与 D 组 code-review hub 同场,归下一云线真机批 |
| C2 | B6 alpha_ping in-session(G1)| ✅ | 登录态真会话(sidecar REST,dir=/Users/tide/app/alpha-code):prompt「call alpha_ping note=S20-realmachine」→ 模型最终输出**逐字 = alpha_ping 工具输出格式**「pong (S20-realmachine)\ndirectory: …\nworktree: /」→ 工具进列表且真执行 = **G1 成功条件达成**。config 端点 plugin 数组在位、agent 列表含 alpha-automation/alpha-readonly(S18)|
| C3 | REQ-029 effort 真发(代理路)| ❌ 发现 bug F-2 | deepseek-v4-flash(cn 版**默认**模型)effort chip 显示「高」但引擎实际 variant = 「low」(英文)→ 显示/引擎不一致 + pick 必失败;根因见 F-2 → 新登记 REQ-041。**alpha 配置的 3 模型(claude-opus/sonnet·gpt-5.4-mini,中文 variant 键)真发 = 需 gateway wire 捕获 = 留 B 侧/用户批**(REQ-029 echo 实验已在实现时验过该 3 者)|

### F-2(finding)—— REQ-029 effort chip 对「上游英文 variant」模型失效
- **现象**:deepseek-v4-flash 下 effort chip 启用(title=「推理强度」非「不支持」)且显示「高」,但上游 `[data-action=prompt-model-variant]` 实际值 = 「low」;点选任意档报「切换失败」。
- **根因**:REQ-029 的 `EffortChip` 假设上游 variant 标签是 alpha 配置的中文 `低/中/高`(alpha-models.json 只给 claude-opus-4.8/claude-sonnet-4.6/gpt-5.4-mini 定义中文 variants)。deepseek 的 variants 来自**上游 opencode 模型定义、是英文 low/medium/high**——不在 `EFFORTS`(低/中/高/超高)集合 → ① `current()` 回退到默认 `effort()`=「高」(与引擎实际 low 不符,破 REQ-029「观察源一致性」)② `switchVariantTo(cmd,"高")` 逐 cycle 读英文标签、中文永不命中 → 转满一圈返 false → 「切换失败」。实证:上游 trigger 起始文本 = `low`;config/providers 含 low/medium/high variant token。
- **严重度**:中——影响一整类「上游提供 variant 且标签非中文」的模型;deepseek 是 **cn 版默认模型**,cn 用户即见此不一致 + 无法切档。REQ-029 的 echo 实验只测了 3 个 alpha 中文 variant 模型,漏了上游英文 variant 类。
- **建议**:variant 标签规范化(英文 low/medium/high ↔ 中文 低/中/高 双向映射)。→ **已修(REQ-041,本 PR)**:新增 `variant-normalize.ts`(纯函数 `normalizeVariant`,5 单测;口径修正见文末),`current()` 显示规范化档、`switchVariantTo` 按规范化命中。**dev 确认显示一致**:deepseek-v4-pro variant=`high` → chip 显示「高」(修前 `high`∉EFFORTS 会回退默认);**switch 切换的打包态实拍**(多档模型 + 真 command 层)→ 重打包批(dev 无法驱动 command 层 + 单档模型)。

## B 组 —— 边界/崩溃/呈现

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| B1 | C28 `__alphaCrashProbe` 打包态 | ✅ | 打包态完整闭环:`__alphaCrashProbe("AlphaSidebar")` → 浮条「重载此区域」命中(`data-alpha-boundary`)· 上游全屏 ErrorPage 未出(`upstreamErr:false`)· 侧栏局部降级但 composer/首页存活(`composerAlive:true, rootChildren:5`);`__alphaCrashProbe(null)` 复位 + 点重载 → 侧栏复活 + 浮条消失。截图 `shots/b1-crashprobe.png` |
| B2 | C17 超前 DB 阻断对话框 + B14 数据菜单 | | |
| B3 | B4 冷启动数据层("/"+home 不纳入)| ✅(数据层)| CDP:侧栏仅 3 具体项目(workspace/alpha-code/kama-bot-local),`hasRoot:false`(无 "/" 根项目),macOS home 未纳入 → worktree-filter 谓词生效(11 单测已覆盖);**caveat**:「零 session.list → 引擎零 Instance」深层断言需 server 端内省,info 级 main.log 不记 session.list,未在本批取到该层证据(留 netlog 专项) |
| B4 | B23 configHealth 呈现 | ✅(但走 loud 错误路径,非 AlphaHome warning banner)| 注入未知顶层键 `__alpha_b23_probe__` 重启 → 引擎**严格拒配置**(strict-key)→ 每项目一条 error toast「无法加载 <项目> 的会话 · 配置文件 …/opencode.jsonc 无效:Unrecognized key: __alpha_b23_probe__」+ 侧栏「项目列表加载失败」error banner。**= 错误如实且精确点名坏键(loud)**;但 B23 原设计的 AlphaHome「全局配置未生效」**warning banner 未出现**(bodyHasConfig 无「全局配置」)——现引擎对未知键是 loud 拒绝(非 B23 原premise 的「静默清零」)→ configHealth warning 被 loud 错误路径抢先/取代。截图 `shots/b4-badconfig-loud.png`;配置已还原、app 恢复健康(3 项目、无 err banner、登录态)。**记 F-3**|

### F-3(finding)—— B23「静默清零」premise 与现引擎「loud 拒绝」行为已不符
- **观察**:注入未知顶层键 → 引擎报 `Unrecognized key`,session.list 每项目失败 → alpha 现有错误 toast 精确点名坏键(实际是**好的**诚实呈现)。
- **含义**:B23 当初的病灶叙述「整份配置静默清零」在当前引擎版本表现为**loud 拒绝**(带具体键名),已非静默;alpha 的 B23 configHealth 主动探测 banner 在此路径下**未触发/被 loud 错误取代**。二者信息量:loud 错误 toast 点名坏键 ≥ configHealth 泛化 warning。
- **待定**:configHealth banner 是否仍有独立价值(如 jsonc **语法错**而非未知键的场景,引擎可能真静默)——需另构造「语法错」用例分别核验两病灶。本批只验了「未知键」一支;严重度低(错误已 loud 呈现,非静默),归**债务**,不阻断。
| B5 | REQ-014 打包态复现 | ⏭ 未执行 | 需毒 `tabs.recent` + 冷启动;本批未及,归下批 |
| B6 | B22 复现尝试 | ⏭ 未执行 | 同上 |
| B7 | S19 失败态实拍(T7 连崩→banner→重试)| ⏭ 用户批 | **dev 已全链 PASS(S19)**;打包态连崩会弹红条,用户在场,主动不做(避免再惊动);T1/T5/T6 需强制 IPC 失败/伪深链，归下批 |
| B8 | C3 日志运行期轮转(>25MB → 归档)| ⏭ 未执行 | 需膨胀 opencode.log + 重启;归下批 |

## 留用户批
B2 短 TTL · logout→重登 · 真断网 vendored · 真睡眠错过 · REQ-030 运营者自验 · B9 真实发版更新链。

## 记账
**跑了 8 项、✅ PASS 6 · 挖到 3 个真机 finding(F-1/F-2 已修 + F-3 债务)· ⏭ 余项归下批/用户批。**
- **✅ verified**:P1 签名公证+资产 · P2 冷启动(修污染后)· B1 C28 崩溃边界(打包态完整闭环)· B3 B4 巨型目录数据层过滤 · C2 B6 alpha_ping G1(真会话执行)· B4 B23 未知键 loud 呈现。
- **findings→已修(本 PR)**:F-1 冷启动陈旧默认无回退(REQ-040)· F-2 effort chip 英文 variant 失效(REQ-041,cn 默认模型体验 bug)· F-3 B23 premise 与 loud 行为不符(债务,记 B23 行)。
- **两个修复的 verified**:重打包签名包上——F-1 植陈旧 key 冷启动回退正常 · F-2 deepseek switch 实拍(见下重打包批结果节)。
- **⏭ 未跑/留用户批**:C1 云回流(耗额度)· B5 REQ-014 复现 · B6 B22 复现 · B7 打包态连崩(用户在场主动不做)· B8 日志轮转 · M 组 4 项 · B2 短TTL · logout · 真断网 · 真睡眠 · REQ-030 运营者自验 · REQ-029 中文 variant 模型真发 wire 捕获 · B9 真实发版。→ 原样留 REQ-016/下一真机批。

## 重打包批(F-1/F-2 修复 verified)
ship2 = alpha HEAD + 两修复,prod 签名+公证(stapler worked / spctl accepted / Notarized Developer ID),装 /Applications。

- **F-1 → verified ✅**:向真实 `opencode.settings` 植入陈旧死端口 `defaultServerUrl: http://127.0.0.1:59999` → 冷启动:侧栏渲染、**无「无法连接到 Local Server」**(`connectFail:false`)、项目加载、登录态 in。修前同一陈旧 key 必卡冷启动。截图 `shots/f1-fix-staleboot-ok.png`。测试 key 已从真实 store 清除。
- **F-2 → verified ✅(显示一致性)**:deepseek-v4-flash(cn 默认)effort chip 现随引擎 variant 规范化显示 —— 直接驱动上游 variant 触发器观测:`low → 低`、`high → 高`(逐字 CDP eval 实测);**修前 `low`∉EFFORTS 会错显回退默认「高」**。`medium → 中` 走同一 `normalizeVariant` 代码路径(单测覆盖;实测有一次读到「低」为 DOM observer 异步滞后,非逻辑错——`high` 稳定后显示正确;该竞态已登记 REQ-043)。截图 `shots/f2-fix-deepseek-effort.png`。
- **F-2 switch(切换)残留**:经 popover UI 点选切档的打包态实拍未取到(ChipPopover 走 Solid Portal + 事件委托,CDP `.click()` 未能稳定驱动);`switchVariantTo` 的规范化 `hit()` 比较由单测锁定 + 显示跟随已证 `normalizeVariant` 生效。判定:显示修复 verified;切换机制单测 verified,UI 实拍留残单(真人点选或后续注入 command 层)。

## 修正(2026-07-06,S20 审计收尾)
- **单测口径修正**:原文多处记「F-1 9 单测 / F-2 10 单测」(合计 19)与事实不符——实际新增 **10 个 test / 32 断言**(`connections.test.ts` 5 个:易失判定 2 个 9 断言 + `availableStartupServer` 3 个;`variant-normalize.test.ts` 5 个 17 断言);PR #113 commit 的「+10 新」为准。原「9/10」系把断言数与 test 数混记。
- **审计发现两条债务已登记**:REQ-042(F-1 静默丢弃无日志 + 陈旧键不清理)、REQ-043(cycle 90ms DOM 轮询竞态,即上文 observer 滞后)。
- **回写补正**:B6(C2 达成 G1)与 C28(B1 打包态闭环)补翻 verified;B4 不翻原因写明(深层断言未取证);REQ-016 残余清单摘 B6。
