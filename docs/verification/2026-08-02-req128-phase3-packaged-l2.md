---
title: REQ-128 Phase 3 本地插件包导入 —— 打包版真机 L2 取证
kind: verification
status: partial
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-02
review_after: 2026-11-02
---

# REQ-128 Phase 3 本地插件包导入 —— 打包版真机 L2 取证(2026-08-02)

覆盖 [#783](https://github.com/jinjunnn/alpha-code/issues/783) 的 **AC⑤(裁决 B 的完整用户路径)**,
即 [Phase 3 方案基线](../design/2026-08-02-req128-phase3-local-claude-plugin-import.md) §4 第 1→9 跳
在**打包产物**上的一次端到端实跑,以及 §12 风险 5「零真机证据」的闭合尝试。

本仓的硬教训是 **dev 用 bun 测不出打包问题**:`#516`(source-only 依赖被 externalize 进 asar)与
`#515`(渲染进程 CSP 打死 eager ajv)两次都只在打包后才暴露。本轮因此不接受任何 dev 环境的替代观察。

---

## 0. 被测件

| 项 | 值 |
| --- | --- |
| 产物 | `packages/ui-mac/dist/mac-arm64/alpha-code.app`(**未**装进 `/Applications`,见 §6) |
| 基线 sha | `9996d2c995f9909f10c66743e855250be6f407d3`(`origin/alpha`),工作树干净 |
| bundle id / 版本 | `com.tide.alphacode.dev` / `CFBundleShortVersionString 0.1.2` |
| 构建时间 | 2026-08-02 10:11:45 EDT(`app.asar` mtime) |
| Electron / electron-builder | 42.3.3 / 26.15.2 |
| 内嵌引擎版本 | opencode `InstallationVersion` 由 `local` 改写为 `1.17.13`(`patch-server-version`) |
| 签名 | `Developer ID Application: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)`,`codesign --verify --deep --strict` 通过 |
| 启动方式 | 直接执行 bundle,env:`ALPHA_CDP=1`、`ALPHA_OPEN_DIR=<语料目录>` |
| 运行时账号态 | owner 已登录(PRO),平台代付;未登出、未删除任何会话 |
| 引擎 sidecar | `http://127.0.0.1:49240`(口令为进程内随机 UUID,不入档) |

**语料**:`~/.claude/plugins/marketplaces/tide-plugin`。本轮亲测其形态,不引用票面转述:
`.claude-plugin/plugin.json` = `{name:"tide", version:"0.1.0", description:…}`;
`skills/` 下 **10** 个技能目录,每个恰含 1 份 `SKILL.md`(frontmatter 只有 `name` / `description`,
无 G17 的控制字段);另有 `commands/` 9 条、`agents/` 1 条、根级 `.mcp.json`;
`rg -a` 全目录检索 `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_SKILL_DIR}` / `../` **零命中**,
`find -perm -u+x -type f` 与 `find -type l` 各 **0** ⇒ 10 个技能全部自包含,预期 10/10 可装。

## 1. 启动成功的证据

打包应用真的起来了,不是"进程还在":

```
[10:19:23.590] app starting { version: '0.1.2', packaged: true }
[10:19:23.…]  alpha environment resolved { environment:'dev',
              mutableRoot:'…/alpha-code-state/env/dev', rootOverridden:false }
[10:19:24.…]  alpha-ext: loading plugin bundle { path: '…/alpha-code.app/Contents/Resources/alpha-ext/plugin.js' }
[10:19:24.633] server ready { url: 'http://127.0.0.1:49240' }
startup-timeline: main.window.ready_to_show / renderer.root.mount(occurrence:1)
```

- **不是空白窗口**:CDP 列出 `oc://renderer/index.html` 的 page target,`document.body.innerHTML.length = 734807`,
  首屏截图为正常主页(见 §2 第 0 帧链路)。`#515` 那类"窗口起来但白屏"在本产物上没有复现。
- **asar 里没有裸 `.ts` 崩溃**:`alpha-ext/plugin.js` 正常装载,sidecar 起服务,`#516` 形态未复现。

## 2. 八步逐步实测

编号对应票面 AC⑤ 的八步。**所有界面操作都发生在打包产物的真实 renderer 上**(经 CDP 驱动 DOM,
调用的是生产事件处理器与生产 IPC);"引擎侧"观察点见 §3。

| # | 步骤 | 实际观察 | 判定 |
| --- | --- | --- | --- |
| 1 | 打包 → 启动 | §0 / §1 | ✅ |
| 2 | 扩展中心 → 从文件夹导入 → 选语料目录 | 定制中心 → **导入** 页 → 「文件夹 / 本地 SKILL.md / agent」卡片。目录由 **main** 侧的生产短路 `ALPHA_OPEN_DIR` 提供(`ext-ipc.ts` `pickImportSkillDir`),renderer 全程未传路径 | ⚠️ 见 §6-a(原生 NSOpenPanel 未由真人点击) |
| 3 | 预览屏逐条列出能装 / 不能装 | 标题 `tide · v0.1.0 · 找到 10 个技能`;**会安装 · 10**(10 个技能逐条点名);**这一版不安装的内容 · 3** —— `commands`「这个插件带了斜杠命令,本版本不安装」/ `agents`「…带了子 agent…」/ `.mcp.json`「…带了 MCP 服务配置…」;未审核警示与「取消不会在这台电脑上留下任何东西」均在场 | ✅ |
| 4 | 确认 → 一次装完 | 点「安装 10 个技能」;journal `tx-msbwpqde-4f39d41d` **一条**事务、`items=10`、`state=committed`,`createdAt 14:39:51.746Z → updatedAt 14:39:52.161Z`(415ms)。盘上 `ext-store/skill--*` 恰 10 个 key | ✅ |
| 5 | 已安装列表出现「扩展包」区块,包卡显示插件名,每个技能显示未启用 | `扩展包 · 1` → 包头 **`tide`**(取自 `plugin.json` 的 `name`)+ 标签「扩展包」「来自本地文件夹」+ `v0.1.0 · 10 个技能 · 全部未启用` + 「移除此扩展包」;10 行各显示「已安装 · 未启用 / 未启用 —— 打开开关后生效」,开关全部关。账本侧 `records=10` 全部 `desiredState:"disabled"`、`origin:"imported-claude"`;`packageGraphs=1`(`packageId="local:tide"`,`displayName="tide"`);`claims=10` | ✅ |
| 6 | 用户拨开关启用其中一个 | 点包区块内某一行的开关 ⇒ 包头变 `10 个技能 · 1 个已启用`,该行变「已启用」,其余 9 行不变;`skills-enabled.json` 由 `keys:[]` 变为恰含该一个 key | ✅ |
| 7 | 下一条消息里那个技能真被引擎注入 | **见 §3**(本轮最重要的一格) | ✅ |
| 8 | 整包移除 → 无残留,引擎当场不再暴露 | 点「移除此扩展包」⇒ toast「扩展包已移除」,`扩展包` 区块整段消失,`已安装条目 · 1`(只剩既有的 `cloud`)。引擎与磁盘见 §4 | ✅(残留口径见 §4) |

截图:
[预览屏](assets/2026-08-02-req128-l2-01-preview.png) ·
[预览屏「不安装」段](assets/2026-08-02-req128-l2-02-preview-skipped.png) ·
[已装扩展包(全部未启用)](assets/2026-08-02-req128-l2-03-installed-disabled.png) ·
[拨开关后](assets/2026-08-02-req128-l2-04-toggled-on.png) ·
[真实回合里技能被加载](assets/2026-08-02-req128-l2-05-skill-loaded-in-turn.png) ·
[整包移除后](assets/2026-08-02-req128-l2-06-after-remove.png)

## 3. 第 7 步:判据是什么,以及为什么它不是"查账本"

R1 审计的 Blocker 是「**读引擎会读的那个文件 ≠ 跑引擎的读**」。因此本轮的判据不取
`skills-enabled.json`、不取 `installs.json`,取**运行中引擎自己的枚举**。

**观察点 = 引擎 HTTP API `GET /skill`(OpenAPI identifier `app.skills`)。**
它由 `packages/opencode/src/skill/index.ts` 的 `Skill.Service` 直接服务,而
`packages/opencode/src/session/system.ts:98-110` 的 `SystemPrompt.skills` 调的是**同一个 service 的**
`skill.available(agent)` → `Skill.fmt(list, {verbose:true})`。
本仓 `alpha-installs.ts` 抬头亦把 `app.skills` 列为「引擎可见性真相」的权威面。

**精确到什么程度(编排者复核后收紧的措辞 —— 原稿写的是「就是同一个集合」,比事实强一格):**

实读 `skill/index.ts:301-315`:`all()` 与 `available(agent)` **读的是同一份
`InstanceState.get(state)` 的 `state.skills`**;差别是 `available` 会排序,**并且在传了 agent 时
按 `Permission.evaluate("skill", …).action !== "deny"` 多过一层过滤**。
而 `skill.available(` 在全仓**只有 `system.ts:101` 一处调用**。

所以准确说法是:**两者读同一份 live state;`available(agent)` 另加一层 agent 权限过滤。
本次无 skill 被 permission deny,故两者重合。**

**残余那一格由下面「真实模型回合」闭合** —— 引擎自报的
`Skill "tide-intro" not found. Available skills: … chain-analysis …`(`Skill.NotFoundError.available`)
是**被测系统在被测路径上自报的可用集**,它不经 `/skill`,因此覆盖了「`/skill` 可能不过 agent 过滤」
这一格。**这条与计数证据同等承重,不是补充说明。**

实测(同一个引擎进程,全程**未重启应用、未重启 sidecar**):

| 时点 | `GET /skill` 数量 | tide 技能 | `ext-store` 路径的条目 |
| --- | --- | --- | --- |
| 装之前 | **20** | 无 | 无 |
| 装完 10 个、全部 disabled | **20** | 无 | 无 |
| 拨开 `chain-analysis` 一个开关之后 | **21** | 仅 `chain-analysis` | `…/env/dev/ext-store/skill--chain-analysis/generations/gen-000001-4f39d41d/SKILL.md` |
| 第二轮改拨 `tide-intro` | **21** | 仅 `tide-intro` | `…/ext-store/skill--tide-intro/generations/gen-000001-a4f62ec1/SKILL.md` |
| 整包移除之后 | **20** | 无 | 无 |

「装完但全 disabled ⇒ 引擎数量**不变**」这一格,是裁决 B 在**引擎侧**为真的证据 ——
默认关不是界面话术,是引擎确实拿不到。

### 3.1 还做了模型侧的真实回合(不止 API)

上表是确定性的,但票面写的是「**下一条消息里**」,所以另外在打包应用里发了真实消息
(deepseek-v4-flash,build agent):

- **正向**:`用 skill 工具加载名为 chain-analysis 的技能…` ⇒ 会话里出现
  「技能 `chain-analysis` **已加载**」的工具调用块 + `Skill: chain-analysis`(0.6 秒 / 297 tokens)。
  技能确实进了系统提示并被模型调用。
- **负向(同一会话、同一引擎实例)**:`用 skill 工具加载名为 tide-intro 的技能` ⇒ 工具执行失败,
  引擎原文回来:

  ```
  Skill "tide-intro" not found. Available skills: agent-creator, agents-sdk, alpha-workspace,
  brand-guidelines, canvas-design, chain-analysis, cloud-dispatch, cloudflare,
  cloudflare-email-service, customize-alpha, customize-opencode, durable-objects,
  integrate-project, mcp-builder, office-docs, sandbox-sdk, skill-creator, turnstile-spin,
  web-perf, workers-best-practices, wrangler
  ```

  这串是 `Skill.NotFoundError.available`(`skill/index.ts:294-299`)—— **引擎在一次真实模型回合中
  自己报出的可用集**:含被拨开的 `chain-analysis`,不含同一个包里其余 9 个仍关着的技能。
  比任何外部断言都强,因为它由被测系统在被测路径上自己说出来。

## 4. 第 8 步的「无残留」到底残了什么(如实)

移除后**立刻**(未重启应用、未重启 sidecar)复测:

- 引擎:`GET /skill` 回到 **20**,零 tide 技能,零 `ext-store` 路径条目 ⇒ **当场不再暴露**,成立。
- 账本:`installs.json` = `{v:2, receipts:0, records:0}`,**`packageGraphs` 与 `claims` 两个键整体消失**。
- `skills-enabled.json` = `{v:1, keys:[]}`。
- `ext-store/` = **空目录**(目录本身保留)。

**但盘上确实还有东西**,`find` 逐条对照安装前快照的差集:

| 残留 | 是什么 | 判 |
| --- | --- | --- |
| `env/dev/ext-store/`、`env/dev/ext-tx/staging/` | 空目录 | 无内容,不构成残留风险 |
| `env/dev/ext-tx/journal/tx-*.json`、`ext-tx/authz/tx-*.json`(两轮各一份) | 安装事务的 journal 与授权决议(含各技能的 `sha256`/`size`/receipt 元数据,**不含文件内容**) | **按设计保留**:`ext-cas-gc.ts` 抬头写明 journal 是 GC 的 mark 根,committed 有界保留 100 条 |
| `alpha-code-state/cas/v1/sha256/**` **10 个 blob,合计 52K** | **就是那 10 份 `SKILL.md` 的正文** | **按设计保留**:CAS 走 mark/sweep 定时 GC,`CAS_GC_GRACE_MS_DEFAULT = 6 小时`(`ext-cas-gc.ts:34`);移除动作本身不删 blob |

结论:**「整包移除无残留」在账本 / `ext-store` / 引擎三个面上逐字成立;在 CAS 面上不成立** ——
用户移除之后,插件正文仍在本机 CAS 里,直到定时 GC 过了宽限窗才被清掉。
这是既有设计(`#194` REQ-102 A)的直接后果,不是本期引入的缺陷,但它让"无残留"这句话
在**用户能理解的口径**上是有条件的。是否需要在移除文案上如实说明,建议交 owner 判。

## 5. 顺带覆盖到的两件事

- **移除后可以重装**:第一轮整包移除后立即再走一遍导入,`tx-msbyxpdf-a4f62ec1` 同样 10 items 一次 committed。
  §7 K19 / G4 说的「第二次导入同一插件会撞 `uncuratedSkillFreshGate`」只发生在**没有先移除**的情况;
  移除之后账本干净,重装路径畅通。
- **单个技能不能被单独移除**:未在本轮单独取证(第 8 跳),已装列表里包内技能行仍显示「属于扩展包 tide」。
  该跳的判据在 `#783` 的夹具半场(`planDirectUninstall` / `directUninstallVerdict`),此处不重复。

## 6. 做不到 / 打了折扣的部分(不用近似观察冒充)

**a. 原生目录选择器没有由真人点击。**
本机在整个取证窗口内**屏幕处于锁定态**(`ioreg` 的 `CGSSessionScreenIsLocked = true`,锁定于 09:15),
锁屏下 `screencapture` 只拿得到壁纸、System Events 对**所有**进程都报 0 windows,
因此原生 `NSOpenPanel` 无法被点击。改用**生产代码里既有的** main 侧短路
`ALPHA_OPEN_DIR`(`ext-ipc.ts` `pickImportSkillDir` 第一行,注释写明「headless/测试短路(main 控制的 env)」)。
**被替换掉的只有 picker 的返回值**;`#255` 的安全性质(renderer 全程给不出可回传的绝对路径)不受影响。
**没有取证的是**:真人在 NSOpenPanel 里选目录这一下,以及该对话框本身的标题/默认路径。

**b. 界面操作经 CDP 驱动,不是真实鼠标事件。**
沿用本仓既有口子 `ALPHA_CDP=1`(`main/index.ts:515`,`docs/verification/2026-07-27-e7-packaged-live/` 的同款做法),
截图取自 `Page.captureScreenshot`(渲染进程合成结果,不受锁屏影响)。
点击走的是生产 DOM 元素的 `click()`,处理器、IPC、main、引擎全是真的;
**没有覆盖的是** hover/键盘焦点/无障碍路径这类只有真实输入才能触到的面。

**c. 第 7 步的「真实模型回合」发生在第一轮,拨开关与发消息之间有一次 renderer reload。**
原因见 §7 的第 2 条(与本期无关的 composer 门)。
**未经 reload 的那一半由 §3 的 `GET /skill` 覆盖**(拨开关后立即 21、且只多出那一个),
但「拨开关 → 紧接着发一条消息 → 模型用上」这条**完全不中断**的链路,本轮**没有**一次性跑通。

**d. 未装进 `/Applications`。**
主 checkout 与 `/Applications/alpha-code.app`(owner 的 Developer ID 正式产物)都被别的 session 占着,
本轮不动它们,直接从 `dist/mac-arm64/` 运行。`app.isPackaged=true`、`process.resourcesPath` 指向 bundle 内,
出厂技能路径实测也确实指向 bundle(见 sidecar env 的 `ALPHA_FACTORY_SKILL_DIRS`)。
**没有覆盖的是** `install-local.ts` 的安装步骤本身(LaunchServices 注册、Spotlight、单实例锁清理)。

**e. 未覆盖**:Windows;冷启动性能;多包并存;超预算 / 0-skill / 不支持布局等**负向**输入在打包环境的表现
(这些在 `#783` 的夹具半场已有断言,本轮只跑了真实语料的正向路径)。

6. **`GET /skill` 这条路径未覆盖 agent 权限过滤那一层。**
   `available(agent)` 比 `/skill` 多一层 `Permission.evaluate("skill", …)` 的 deny 过滤
   (`skill/index.ts:310-315`),而本次**无任何 skill 被 permission deny** ⇒ 该分支**恒不触发**。
   按本仓判据,**「本次没有反例」不等于「验过了」** —— 如实登记为未覆盖,
   不因为「真实模型回合那条另外闭合了残余」就把它记成已覆盖(那是另一条证据,不是这一条)。

## 7. 打包与真机过程中踩到的坑(留给下一个人)

1. **`electron-builder 26.x` 的 `identity: null` 不做 ad-hoc 签名,只是"跳过签名"。**
   `electron-builder.config.ts:155-157` 的注释写的是「null => ad-hoc sign」,而 26.15.2 实际打印
   `skipped macOS code signing reason=identity explicitly is set to null`,产物只剩 Electron 自带的
   linker-signed 主二进制;`@electron/fuses` 改完二进制后签名失效 ⇒ **直接 `Killed: 9`(exit 137),
   零日志、零窗口**。修法就是 `install-local.ts` 3.5 节做的事:`codesign --force --deep --sign <identity>`。
   **只跑 `package:mac` 而不跑 `install:local` 的人一定会撞上这个**,而且症状(静默秒退)极易被误判成代码崩溃。
2. **本机 DNS 对 `models.dev` 被污染**(默认解析到 `31.13.95.34`,TLS 证书名不匹配;`curl -k` 返回 200 但**空体**),
   导致 `prebuild` → `packages/opencode/script/generate.ts` 直接失败,整个 `bun run build` 挂掉。
   绕法:走本机 clash 的 fake-ip 取一份真快照
   (`curl --resolve models.dev:443:198.18.0.5 https://models.dev/api.json`,3.3MB / 178 providers),
   再 `MODELS_DEV_API_JSON=<file> bun run build`(该 env 是 `generate.ts` 自带的入口,不是我们发明的)。
3. **`scripts/worktree-link-deps.sh` 不链 `node_modules/.bin`。**
   它用 `for entry in "$src"/*` 遍历,glob 默认不含点开头的条目 ⇒ worktree 里 `electron-vite` /
   `electron-builder` / `tsgo` 全部 `command not found`。`bun test` / `tsgo -b` 走 bun 解析所以没暴露过,
   **凡是要跑 bin 脚本(打包就是)的 worktree 都会撞**。本轮手工补链了 157 个 bin 条目才跑通。
4. **锁屏会让所有 GUI 取证手段静默失效**:`screencapture` 给壁纸、System Events 给 0 windows,
   两者都**不报错**。判据是 `ioreg -n Root -d1 -a | grep -a CGSSessionScreenIsLocked`,先判它再判 UI。
   CDP 截图不受影响,是锁屏下唯一可信的界面证据。

## 8. 本轮顺带发现、**不属于 REQ-128** 的一条

**sidecar 因 token 轮换 respawn 之后,composer 的模型预检会认为「本次引擎启动没有加载这个模型」,
一直到 renderer 重载才恢复。**

- 现象:发送被 `alpha.composer.modelNotLoaded` 拦下(`alpha-composer.tsx:1237-1251`,
  `preflightBlockReason` 返回 `byok-not-registered`),平台模型与 BYOK 模型**都**被拦;
  同一时刻引擎 `GET /config/providers` 明明列出 `alpha` / `deepseek-byok` / `zhipuai-byok` 三组共 10 个模型。
- 相关性:主进程每 ~10 分钟 `respawning sidecar {reason:'token-only'}` → `sidecar token rotated without renderer reload`
  (本次运行:10:34 / 10:44 / 10:55 / 11:05 / 11:15 / 11:25 / 11:35,逐条在 `main.log`)。
  两次被拦分别落在 11:15 与 11:25 那两次 respawn 之后;两次 renderer reload(11:20:54 / 11:39:17)之后
  第一条消息就发得出去(11:23 与 11:40 各一条成功回合)。
- **已做的排除**:安装成功后的 `refreshEngine()`(`POST /global/dispose`)**不会**引起该现象 ——
  reload 后先发一条对照消息成功,随即完成一次完整安装(必走 `refreshEngine`),再发仍然成功。
  所以肇事者不是 G20 的热重载接线。
- **诚实边界**:这是**相关性**,不是隔离出来的因果。没有做「只 respawn 不做别的」的单因实验。
  建议单开一张票按 REQ-109/110 的 token 轮换面去查,不要挂在本期。

## 9. 结论

**AC⑤ 的八步在打包产物上跑通,§12 风险 5「零真机证据」由本记录闭合到 §6 划定的边界为止。**
剩下的三处不是"应该没问题",是**本轮确实没测**:原生 picker 的真人一点(§6-a)、
真实鼠标/键盘输入面(§6-b)、以及「拨开关后不经 reload 直接发消息」的完全连续链路(§6-c)。
另有一条口径修正应进 owner 视野:**移除之后插件正文仍在 CAS 里,最长 6 小时**(§4)。
