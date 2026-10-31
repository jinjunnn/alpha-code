---
title: REQ-236 T01–T04 与 §2.4 方案基线 —— 三档权限的真实边界、始终允许、工具来源证明与受控配置字段
kind: design
status: draft
owners:
  - Code Puppy desktop and runtime maintainers
last_reviewed: 2026-10-30
review_after: 2027-01-30
---

# 三档权限、始终允许与工具来源

**给 owner 的一段话。** 你在 0.1.22 里切换「全部批准 / 请求审批 / 只读」时,界面只写了一句副标题,
没说清哪些事仍会被拦、哪些工具不受档位管;审批卡上「始终允许」永远是灰的,而卡片下方却写着
「会为当前项目创建永久授权」;云端工具在对话里被标成「第三方 MCP 工具」。本文把这三件事追到源码:
「始终允许」是被刻意关掉的(引擎里那种授权只活到下次引擎重启,而引擎每 10 分钟随续期重启一次);
云工具被标成第三方,是因为「这是 Code Puppy 云」的证明在比对时把已解开的令牌和未解开的文件引用当成
两份不同的定义,从来没成立过。顺带查出几处比显示更要紧的问题:「只读」和「请求审批」档下,模型把活
派给子任务、你点名某个助手、或发一条斜杠命令,都会落到不受档位约束的助手上,能直接改文件和跑命令;
设置里写着「只对当前账户生效」的工具授权其实不分账户;项目里自带的配置文件能悄悄放宽默认档仍会询问的
那几类操作。方案让三档说实话并堵上这几条路,让「始终允许」按授权种类真正可用,让来源显示改用已验证的证明。不做的话,用户看到的权限和来源与实际执行对不上,而「只读」并不只读。

服务 [REQ-236 / alpha-work#118](https://github.com/jinjunnn/alpha-work/issues/118) 的 T01(实际边界说明)、T02、T03、T04
与 T24 §2.4「配置 / 权限 / 来源显示」,对应父 AC1。不覆盖:三档颜色(alpha-code#1550)、模型选择最终权威
(目录与模型 lane C6)、令牌热续期与 MCP 逐服务启动(引擎生命周期 lane)、生图/产物/附件(交付 lane)、
品牌改名(T05,本文按现名书写,§2.9 标出改名接口点)。

## 0. 基线与证据边界

| 项 | 值 |
| --- | --- |
| 源码 | alpha-code `393a35c2a`(= 0.1.22);本 worktree 相对它只多架构稿三个文档提交(`git diff --stat 393a35c2a HEAD` → `docs/README.md`、`docs/design/codepuppy-runtime-authority.md`) |
| 平台 | alpha-platform `1bcfe09`(`git show 1bcfe09:<path>` 只读) |
| owner 证据 | alpha-work#118 正文「已复现」与 2026-10-30T03:54 评论第 2 条(会话里 access / 两次 dispatch / await 的 `display.authority.kind` 均为 `not-asserted`) |
| owner 机日志 | `~/Library/Application Support/ai.opencode.desktop/logs/*/main.log` **观测不到 sidecar/ext 输出**:三个目录里 `[@alpha-code/ext]` 行数均为 0(含应当出现的安装回执),所以日志不能证明或否定任何 ext 行为,本文不用它下结论 |
| 架构约束 | `ls docs/architecture/constraints.md` → `No such file or directory`;无已登记偏离可对照,本方案发现的偏离列在交回 |

写作 `路径:行`,省略仓名即 alpha-code;`ui-mac`/`ext`/`opencode`/`schema`/`plugin`/`core`/`app` 均为 `packages/` 下的包。
本文没有启动/退出 App、没有跑测试、没有读任何密钥;「实测」只指只读命令与日志计数。

## 1. 只读勘破

### 1.1 一次工具调用要过哪几道闸(生产路径)

按执行先后:

1. **注册与来源**:内置工具在 `opencode/src/tool/registry.ts:276-281` 铸 identity(`source:"builtin"`,`execute` 为 `"host"`);
   插件工具 `registry.ts:155`(`plugin`);MCP 工具 `opencode/src/mcp/index.ts:756-764`(`{source:"mcp", origin:<配置键>, name:<远端名>}`,
   authority 取 `s.authority[clientName]`);MCP 资源三件套 `session/tools.ts:296-300,384-388,471-475`(`host`)。
   `builtin-v2` 只出现在分类代码里:`grep -rn "builtin-v2" packages/opencode/src` → `alpha-risk-classification.ts:536,686`、
   `alpha-tool-policy-gate.ts:53`,v1 引擎不铸它。
2. **身份轴闸**(包在执行外层):`session/tools.ts:99-121` `identityGate` → `permission/alpha-tool-policy-gate.ts:162-190`
   `gateToolExecution`。每次调用重读策略文档与当前 binding(`session/tools.ts:81-98`:mcp = `bindingFacts` 现派生,plugin = 装载代 digest,
   builtin/host = 常量)。合成:deny ⇒ 具名拒绝、零 hook;ask ⇒ 往本次 ruleset 末尾追加 exact-canonical ask,`patterns:["*"]`、`always:["*"]`
   (`:169-189`);allow ⇒ 不加。调用方 3 处:`session/tools.ts:107`、`tool/code-mode.ts:157`、`session/prompt.ts:299`。
3. **策略文档轴默认**:`schema/src/alpha-tool-policy.ts:133-153` 分类只看 `identity.source` 与 verified authority:
   builtin/builtin-v2/host ⇒ `builtin`;mcp ⇒ `authority.kind==="alpha-cloud"` 时 `alpha-cloud`,否则 `third-party-mcp`;plugin ⇒ `plugin`。
   `:157-159` 默认:builtin = enabled,其余一律 ask。
4. **`tool.execute.before` 钩子**:在被包的 execute 内部、身份轴之后(`session/tools.ts:176-180` 内置、`:499-503` MCP)。
5. **能力轴**(内置工具体内 `ctx.ask`):`permission/index.ts:159-244` 唯一的 v1 Request 构造点;deny/allow 只由 ruleset 决定,
   session grant 只能消掉 ask(`:164-178`)。ruleset = `Permission.merge(agent.permission, session.permission)`(`session/tools.ts:111,157`)。
6. **进程围栏**:seatbelt `(allow default)(deny file-write*)` + 工作区并集可写(`ui-mac/src/main/process-fence-apply.ts:76` 拒绝不带
   `(deny file-write*)` 的 profile;工作区清单 `process-fence-plan.ts:65`)。**读不受限,写只在工作区并集内**。
7. **出网围栏**:代理白名单 = 静态表 + 真源派生 + 用户当场批准的目的地(`ui-mac/src/main/network-egress-grants.ts:1-40`);
   未登记目的地由 main 原生对话框单独询问,与三档无关。
8. **能力总闸**:`ALPHA_WEBSEARCH_DISABLE` 下本地 websearch 在 `execute` 首行拒、云侧在 ext 的 before 钩子拒
   (`docs/architecture/2026-09-23-runtime-permission-tiers.md` §1 第 3 问,坐标已核)。

### 1.2 三档各是什么(T01/T02)

`ui-mac/src/renderer/alpha-ui/composer-state.ts:36-62`:`PermMode = "allow"|"ask"|"readonly"`,提交时按穷举表强制 agent
(`PERM_AGENT`:allow → 不压 / ask → `alpha-ask` / readonly → `alpha-readonly`),`buildPromptRequest` `:366-368`。默认档 `allow`。

| 档 | 载体 | 规则来源 |
| --- | --- | --- |
| 全部批准 | 引擎默认 `build` | `opencode/src/agent/agent.ts` defaults:`"*":"allow"`、`doom_loop:ask`、`external_directory:{"*":ask, 临时/技能目录:allow}`、`read:{"*.env":ask,"*.env.*":ask}` + `question/plan_enter:allow` + 用户 `cfg.permission` |
| 请求审批 | 注入 `alpha-ask`(`ui-mac/src/main/alpha-config-injection.ts:270-283`) | 同 build,另 `edit:ask`、`bash:ask` |
| 只读 | 注入 `alpha-readonly`(`alpha-config-injection.ts:234-252`) | defaults + `read:{"*":allow,"*.env*":deny}`、`edit/bash/external_directory:deny`;**未写 `task`**,沿用 defaults 的 `"*":"allow"` |

现有常驻闸 `opencode/test/permission/alpha-composer-tiers.test.ts`(真注入 + 真 `Agent` + 真 `Permission.ask`)只罩内置权限键;
MCP / 云 / 插件 / 子任务不在其中 —— 这就是父票「全部云工具在三档下的行为:未验证」。

### 1.3 发现 F1:只读与请求审批可以经子任务绕开(代码推导,待测试先红)

- `task` 在只读档可用:09-23 勘破的工具表实测里 `alpha-readonly` 移除的是 `apply_patch bash edit plan_exit question write`,
  不含 `task`(`2026-09-23-runtime-permission-tiers.md` §3 表);`alpha-config-injection.ts:227-229` 的注释也写「委托子任务不破只读:子 agent 权限独立」。
- 子会话权限:`opencode/src/tool/task.ts:138-171` 用 `deriveSubagentSessionPermission`(`agent/subagent-permissions.ts:9-21`)
  只继承**父会话** permission 的 deny 与 external_directory 规则,注释原文「Parent agent restrictions only govern that agent」。
  三档的限制写在 **agent** 上,父会话 permission 为空 ⇒ 子会话什么都不继承。
- 子 agent:`general`(`agent.ts:182-194`)= defaults + `todowrite:deny`,即 `edit`/`bash` = allow;`explore` 显式 `bash:"allow"`。
  上游 `plan` 自己就为此写了 `task:{general:"deny"}`(`agent.ts:165-167`)。
- 推论:只读档下模型调 `task(general)` ⇒ 子会话可改文件、跑命令;请求审批档同理,且不弹审批。进程围栏仍限制写在工作区内,
  所以越界写仍会失败 —— 但「只读」与「逐次询问」两个承诺在工作区内都不成立。
- 委派入口不止模型的 `task` 调用(Codex 方案审 F2 指出,坐标已核):
  - **点名助手**:用户消息里带 agent part(`@general`)⇒ `session/prompt.ts:1263-1265` 置 `bypassAgentCheck` ⇒ `tool/task.ts:119` 整段跳过 `task` 的询问。
  - **斜杠命令丢档位**:composer 的两个 `session.command` 调用(`ui-mac/src/renderer/alpha-ui/alpha-composer.tsx:1668-1673`、
    `sidebar/use-projects.ts:486`)都不带 `agent`;引擎 `prompt.ts:1414` `agentName = cmd.agent ?? input.agent`,缺席即默认 agent(build)。
    非子任务命令因此以 build 运行;命令自带 `agent` 时也压过档位。
  - **直接子任务**:`subtask:true` 的命令(内置 `/review`,`command/index.ts:86`)或 subagent 模式的命令产生 subtask part(`prompt.ts:1483-1497`),
    走 E6 直接执行,闸用的是**目标** agent 的规则集(`prompt.ts:288-308` 的 `taskRuleset`),父档位不参与。

### 1.4 发现 F2:只读与请求审批不约束非内置工具(编排器转来的读码发现,已核)

- 第三方 MCP / 插件 / 云工具在 ruleset 轴上被三档的 `"*":"allow"` 放行(`Permission.evaluate` 用 `Wildcard.match`,
  `core/src/util/wildcard.ts:3-13` 把 `*` 编成 `.*`,跨 `/` 与 `:`),只靠文档轴默认 ask(`alpha-tool-policy.ts:157-159`)。
  用户在设置 → 工具把某个第三方工具设为「启用」后,三档下它都直接执行,包括有副作用的动作。
- 宿主工具(`host`)归 `builtin` 类、默认 enabled(`alpha-tool-policy.ts:145-146`)。生产里的 host 只有 MCP 资源三件套(读)与
  code-mode 的 `execute`(其子调用各自过闸,`code-mode.ts:157`;code-mode 默认关,`session/tools.ts:478`)。

### 1.5 T03:「始终允许」为什么永远是灰的

链路(全部坐标已读):

1. 会话执行走 v1 引擎,审批请求是 v1 `permission.asked`。审批面经 `app/src/context/permission-v1-adapter.ts:94-110` 把它投影成 v2 形状:
   `resources ← patterns`、`scope = {kind:"session"}`、`expiresAt = null`,**`save` 刻意不投影**(`:89-93` 注释:「v1 的 always 只是把规则推进
   引擎进程内存……而『始终允许』承诺的是为当前项目创建永久授权……宁可少一个按钮,也不要在授权持久性上说谎」)。
2. `ui-mac/src/renderer/alpha-ui/PermissionDialog.tsx:55-61` `canAlways` 要求 `save` 非空 ⇒ 对 v1 请求恒 false;
   悬停文案 `alpha.permission.noSavedResources`「请求未提供可保存资源,不能创建永久授权」(`i18n/zh.ts:1059`)正是父票复现的那句。
3. 同一张卡上的说法互相矛盾:`Scope = 本次会话`、`Expiry = 不过期`(adapter 写的 `expiresAt:null` 被 `expiryLabel` 渲染成「不过期」,
   `PermissionDialog.tsx:229-247,503-504`),而页脚恒显示「『始终允许』会为当前项目创建永久授权(grantExpiresAt = null)」(`:102`、`zh.ts:1056`)。
4. v1 `always` 的真实语义:`permission/index.ts:280-290` 按 `(sessionID, permission, always 里的每个 pattern)` 记 session grant,
   存在 `InstanceState` 内存里;实例销毁即失(`:138-157`)。生命周期 lane 实测 0.1.22 每 10 分钟一次 token-only 换代,4 小时 25 次,
   「每一次都中断在途流、清会话授权」(`req236-lifecycle` 基线 §1.1)。
5. v1 `always` 的范围比卡上显示的宽:卡只显示 `patterns`,不显示 `always`。`edit`/`write`/`apply_patch`/`read` 的 `always` 都是 `["*"]`
   (`tool/edit.ts:102-105`、`write.ts:54-57`、`apply_patch.ts:206-209`、`read.ts:256-259`);身份轴 `["*"]`;
   `external_directory` 是目录 glob(`tool/external-directory.ts:28-43`,shell 版 `tool/shell.ts:262-276`),而 `*` 匹配任意深度,
   即整棵子树。owner 截图里的「两条目录通配」就是 shell 的 external_directory 请求。
6. 持久授权今天只有一个现成权威:REQ-131 设置 → 工具的策略文档(`opencode/src/permission/alpha-tool-policy-store.ts` 按
   `(账户, 项目)` 分区落盘;`schema/src/alpha-tool-policy.ts:71-90` 要求 service/tool 级 enabled 带 `bindingDigest`;
   `opencode/src/permission/alpha-tool-policy.ts:164-165` 绑定变了即回 ask)。写入口 `core/src/permission/alpha-tool-policy-api.ts`
   `setRecord`,renderer 经 preload `toolPolicy.setRecord`(`ui-mac/src/preload/index.ts:138-143`)。它只管**身份轴**(某个工具能不能用),
   不管能力轴(改哪个文件、跑哪条命令、读哪个外部目录)。

结论:按钮置灰不是缺陷,是对一个会说谎的按钮的止损;缺陷是**卡上的作用域/期限/页脚说法与真实语义不一致**,以及**用户没有任何
可用的持久授权入口**。

### 1.6 T04:云工具来源证明链在哪断了(含对生命周期 lane 推断的核对)

证明链:main 每次 fork 写两个 env —— `ALPHA_CLOUD_MCP_SERVER="cloud"` 与 `ALPHA_CLOUD_MCP_DEF=JSON.stringify(cloud)`
(`alpha-config-injection.ts:386-391`),`cloud` 由 `ui-mac/src/main/cloud-sidecar-config.ts:42-48` 产出:
`{type:"remote", url, enabled:true, headers:{Authorization:"Bearer {file:…/ALPHA_MCP_TOKEN}"}, oauth:false}`。
引擎在 MCP 连接成功时调 `authorityForMcp(key, mcp)`(`mcp/index.ts:590,654`)→ `governedMcpEvidence`
(`plugin/src/alpha-cloud-authority.ts:67-82`):名字与 URL 对上后,要求**整份装载后的 entry 与 DEF 的 canonical JSON 逐字相等**(`:77`)。

**断点 = 装载后的定义 ≠ 注入的定义,原因按分支不同:**

| 分支 | 判定 | 进入引擎的路径 | 装载后的 Authorization | 结果 |
| --- | --- | --- | --- | --- |
| 正常(代付、无总闸)—— **生产默认** | `platformPays && !killSwitch`(`alpha-config-injection.ts:102,105,399-406`) | 定义写进 `OPENCODE_CONFIG_CONTENT` 文本;引擎 `config/config.ts:487-494` → `loadConfig` `:231-243` → `ConfigVariable.substitute`(`config/variable.ts:35` 起)在**解析文本时**把 `{file:}` 换成令牌 | `Bearer <令牌字面量>` | ≠ DEF ⇒ `not-asserted` |
| 总闸(`ALPHA_WEBSEARCH_DISABLE`) | `killSwitch` | 文本里是中和条目;ext `config` 钩子 `installCloudMcp`(`ext/src/cloud-websearch-kill.ts:411-449`)在 `ARM` 在场时用 `resolveFileRefs` 解开后写回 | `Bearer <令牌字面量>` | ≠ DEF ⇒ `not-asserted` |

- 生产走第一行:`ALPHA_WEBSEARCH_DISABLE` 只读自进程 env,main 不设它(`grep -rn ALPHA_WEBSEARCH_DISABLE packages/ui-mac/src packages/ext/src` →
  只有读取点与 `sidecar-env.ts:66` 白名单);owner 机 `launchctl getenv ALPHA_WEBSEARCH_DISABLE` → 空。`ARM` 只在总闸分支置位
  (`alpha-config-injection.ts:408-416`),所以**生产里 `installCloudMcp` 根本不运行**(`:416` 前 `if (!name || !raw) return undefined`)。
- MCP remote schema 没有解码默认值(`core/src/v1/config/mcp.ts:44-59`,`enabled/headers/oauth/timeout` 全是 optional),所以除令牌值外
  不会多出字段;若别的配置源也定义了 `cloud`,深合并会留下它的 `headers`/`timeout`(`cloud-websearch-kill.ts:366-367` 已登记),同样判不等。
- 为什么测试一直绿:`opencode/test/tool/alpha-tool-identity.test.ts:66-121` 的夹具 DEF 是 `{type, url}`,不带 `enabled`、不带 header 引用 ——
  夹具顶替了生产形状(CLAUDE.md「绿但其实没测生产路径」)。
- 仓里早有人绕过它:`ui-mac/src/renderer/alpha-ui/cloud-facade-identity.ts:10-20` 注明「#879 审计终轮裁定 category==="alpha-cloud"
  (依赖 governedMcpEvidence 运行时铸造)会误杀现网真实云产物行,准入只看 identity」—— 产物行改按 `(mcp, "cloud")` 判,工具卡没改,
  于是工具卡落到第三方降级卡(`session-timeline/cards/tool-card-model.ts:268-279`)。
- 全称:`grep -rn 'kind: "alpha-cloud"' --include='*.ts' packages | grep -v test` → 只有 `opencode/src/mcp/index.ts:199` 与两份 SDK 生成类型;
  alpha-cloud authority 的唯一铸币点就是 `authorityForMcp`。

**对生命周期 lane #1 推断的核对**(它说 #1 落地后装载定义将与注入定义一致、authority 将变成 `alpha-cloud`):**断点判断对,修法覆盖不全。**
它的 §1.1 与 §2.1 第 5 步只改 `installCloudMcp` 写回未解开的定义 —— 那只是总闸分支;生产分支的 `{file:}` 是引擎自己在文本阶段解开的,
与 `installCloudMcp` 无关。照 #1 原文落地,生产里 authority 仍是 `not-asserted`;而且 #1 自己「对 `governedMcpEvidence` 成立的条目在每次
请求时现读令牌」的热续期机制在生产分支也不会生效(谓词不成立 ⇒ 仍用 fork 时的字面量令牌)。本方案 §2.6 把谓词改成不依赖令牌值,
并给 #1 一个冻结接口(§2.9):受治理条目的凭据引用从 DEF 读,不从装载后的 entry 读。顺带核实其另一条:`ALPHA_CLOUD_TOKEN` 在 sidecar 内
无读者,与本 lane 无关,不展开。

### 1.7 来源分类与显示现状(T04)

- 显示类别 `tool-card-model.ts:216-231` `categoryOf`:builtin/builtin-v2 ⇒「本机工具」,host ⇒「宿主工具」,mcp ⇒ 有 alpha-cloud authority 时
  「Code Puppy 云端工具」否则「第三方 MCP 工具」,plugin ⇒「插件工具」(`zh.ts:1471-1476`)。用户会看到**内部类目**(宿主),
  也看不到执行位置。
- 云专用卡规则表 `tool-card-model.ts:138-147` 只登记了 `cloud_web_search/dispatch/status/await/artifacts` 与三条历史 schedule;平台注册表
  (`alpha-platform 1bcfe09:packages/gateway/src/lib/mcp-tool-registry.ts:68-147`)与桌面生成快照
  `ui-mac/src/main/fixtures/cloud-mcp-tools.ts:4-15` 都是 10 个:另有 `cloud_cancel/web_fetch/vision/decide/account_status`。
  即使 authority 修好,这 5 个仍落降级卡 —— 手抄表与权威各自漂移。
- 「官方连接器」= `github-official`、`dbhub-readonly`(`ui-mac/src/main/official-connector-recipes.ts:13`):Code Puppy 的封闭安装配方,
  服务本身是第三方厂商的。工具来源上它们是第三方。
- Office/PDF 四个本机 MCP:Code Puppy 随包的 `resources/office-mcp/server.py`,今天 identity 为 `(mcp, <配置键>)`、authority `not-asserted`,
  显示成「第三方 MCP 工具」、参数与结果全隐藏。生命周期 lane #4 新增 `plugin/src/alpha-first-party-mcp.ts` 的
  `declaredFirstPartyTools`(命令与随包模板逐 token 相等、`server.py` sha256 与清单一致才成立,其基线 §2.3 第 2 步)—— 这正是缺的 binding 证明。

### 1.8 §2.4:受控字段的真实写入方与覆盖路径

受控字段(本 lane 范围):三档载体与默认档的权限规则、第一方服务地址(平台 provider、云 MCP)、来源证明。模型字段按目录 lane C6
(显式选择随 `promptAsync` 携带,引擎 `input.model` 优先),本文不另设计。

| 写入方 | 时机 / 优先级 | 能写什么 | 信任门 |
| --- | --- | --- | --- |
| W1 main `injectAlphaConfig` | 文本 `OPENCODE_CONFIG_CONTENT`,晚于全局、`OPENCODE_CONFIG`、项目文件(`config.ts:420-494`),早于 managed | `plugin`/`instructions`/`enabled_providers`/`model`/`provider`/`agent`(alpha-*)/`mcp`(`alpha-config-injection.ts:117,165,190-200,399`) | 本体 |
| W2 用户全局 / `alpha.jsonc` | 文本,早于 W1 | 任意 | 用户本人 |
| W3 **项目 `opencode.json(c)` 与 `.opencode/`** | 文本,早于 W1(`config.ts:425-429`;发现规则 `config/paths.ts:10-41`) | 任意,含顶层 `permission`、`agent.*`、`mcp`、`plugin` | **无**:`OPENCODE_DISABLE_PROJECT_CONFIG` 在 main 从不设置(`grep -rn OPENCODE_DISABLE_PROJECT_CONFIG packages/ui-mac/src/main` → 只有三个 `*.test.ts`);`mcp-default-deny.ts:1-5` 明写「项目配置面……均不动」 |
| W4 项目 `.code-puppy/alpha.jsonc`(ext `config` 钩子) | 钩子,装载后 | `mcp`(需信任)、`agent`/`command`(**恒加载**)、`skills.paths`;只补缺席的名字(`ext/src/project-config.ts:117-150,175-187`) | `agent` 无 |
| W5 已信任项目插件的钩子 | 自有钩子之后串行(`ext/src/plugin-fanout.ts:9-36`) | 任意变异 `cfg`、`args`、headers | 项目 consent |

覆盖面(按引擎装配实读):`agent/agent.ts:267-294` 对 `cfg.agent` 里的每个名字(包括 `build`/`general`/`explore` 这些原生名)合并
`model` 与 `permission`(追加在后,`findLast` 下胜出);`cfg.permission` 作为 `user` 合进每个 agent(`agent.ts` build/general/plan 与配置 agent 的
`merge(defaults, user)`)。注入 agent 的显式键排在后面,所以**三档载体自己写了的键压得住**;没写的键与原生 agent 压不住。

已由代码证实的覆盖路径:

- **P1(W4)**:未信任项目的 `.code-puppy/alpha.jsonc` 写 `agent.build.permission.external_directory:"allow"`(或 `general`/`explore` 的权限、
  `build.model`)⇒ 不经同意改掉「全部批准」仅剩的询问与默认模型。`mergeNamed` 只挡「已存在的名字」,而 `cfg.agent.build` 通常不存在。
- **P2(W3)**:同样的写法放进仓库根的 `opencode.json`,另可写顶层 `permission`(压过「请求审批」没写的键,如 `external_directory`/`doom_loop`/
  `read .env`)、`mcp`(本机命令服务器在实例初始化时直接起进程)、`plugin`。
- **账户分区没有接上**(Codex F3,已核):策略文档声明按 `(账户, 项目)` 分区,但生产账户恒为 `"anonymous"` ——
  `opencode/src/permission/alpha-tool-policy.ts:227-228` 注释「生产默认 anonymous —— 引擎侧今天没有账户权威」,`:238` 默认值,`:316` 的 `node`
  以无参 `layer()` 装配。账户 A 存下的「启用」,登出后登录 B、同项目同 binding 仍生效。main 侧已有跨刷新稳定的账户标识
  `getAuthIdentityTag()`(`ui-mac/src/main/alpha-auth.ts:425`,取 `account.read` 令牌的 `sub`)。
- **分区与运行态粒度不同**(Codex F5,已核):策略分区取 `ctx.project.id`(`alpha-tool-policy.ts:241-245`),而 Permission 的 session grant 住在
  按目录缓存的 `InstanceState`(`effect/instance-state.ts:47-50` 以 `directory` 取)。同一项目两个工作目录共用一份策略、各有一份 grant。
- **P3(W5)**:已同意的项目插件 = 引擎进程内的任意代码(可改 `process.env`、可经 SDK 自答审批),对它封印字段没有意义;边界在 consent。
- **P4(钩子改参)**:身份轴在钩子**之前**批准,钩子再原地改 `args`,执行用的是改过的。生产实例就在自家代码:
  `ext/src/cloud-vision-hooks.ts:276-290` 把 `cloud_cloud_vision` 的 `args.image` 从引用原地换成本机文件的 base64 并写死 `model`;
  `grep -rn "output\.args" packages/ext/src` → 只有它与 `plugin.ts:111` 的只读校验。

### 1.9 架构稿断言复核(`codepuppy-runtime-authority.md`)

| 断言 | 结论 |
| --- | --- |
| §1 表「`session/tools.ts:83` 执行前重读绑定」 | 对:`:81-98` 每次调用现派生 subject |
| §1 表「`plugin-fanout.ts:9` 自有 hook 先于项目 hook,后者仍能改变共享输出」 | 对(`:26-35`);但「封印字段」对 P3 无效(§1.8),真正未设门的是 W3/W4 |
| §2.4「当前 ToolAuthority 只有两种形状」 | 对(`schema/src/tool-identity.ts:16-23`) |
| #118 评论 2「`installCloudMcp` 会解析密钥文件引用,`governedMcpEvidence` 将装载配置与原始定义完整比较」 | 半对:比较逻辑如此,但生产分支里解开引用的是引擎配置加载器,`installCloudMcp` 不运行(§1.6) |
| §2.4「审批绑定真实主体、资源、参数和请求 ID」 | 目标对;现状不成立:身份轴批的是钩子前的参数(P4),session grant 不带 binding(§2.5) |
| §2.1「`not-asserted` 不是通用不可信等级」 | 对;但今天它在策略层确实把云工具归进 `third-party-mcp` 类(`alpha-tool-policy.ts:147`),设置页也把云工具列在「第三方 MCP」组 |

### 1.10 跑过的全称断言

| 断言 | 命令 | 输出 |
| --- | --- | --- |
| alpha-cloud authority 唯一铸币点 | `grep -rn 'kind: "alpha-cloud"' --include='*.ts' packages \| grep -v test` | `opencode/src/mcp/index.ts:199` + SDK 生成类型两处 |
| main 不关项目配置发现 | `grep -rn OPENCODE_DISABLE_PROJECT_CONFIG packages/ui-mac/src/main` | 只有 `mcp-server-derivation.test.ts:139`、`custom-provider-derivation.test.ts:117`、`process-fence-engine.test.ts:164` |
| 生产不设总闸 | 上表 grep + `launchctl getenv ALPHA_WEBSEARCH_DISABLE` | 只有读取点;env 为空 |
| v1 引擎不铸 builtin-v2 | `grep -rn "builtin-v2" packages/opencode/src` | 三处,全在分类代码 |
| 身份轴闸的调用方 | `grep -rn "gateToolExecution(" packages/opencode/src` | `session/tools.ts:107`、`tool/code-mode.ts:157`、`session/prompt.ts:299` |
| session grant 清理无调用方 | `grep -rn "clearGrants" packages --include='*.ts' \| grep -v test` | 只有定义(`permission/index.ts:78,313`);登出/切账户靠 structural 换代清掉 |
| 自家钩子改参 | `grep -rn "output\.args" packages/ext/src` | `cloud-vision-hooks.ts`(改写)、`plugin.ts:111`(只读) |
| 钩子触发点(confirm 的全部落点) | `grep -n "tool.execute.before" packages/opencode/src/{tool/code-mode.ts,session/prompt.ts,session/tools.ts}` | `session/tools.ts:177`(内置)、`:251/:339/:424`(三条 host 资源)、`:500`(MCP);`code-mode.ts:178`;`prompt.ts:354`(直接子任务) |
| composer 的命令入口 | `grep -rn "session.command(\|\.command({" packages/ui-mac/src/renderer` | `alpha-composer.tsx:1668`、`use-projects.ts:486`,均不带 `agent` |
| 桌面云工具快照 | `cat ui-mac/src/main/fixtures/cloud-mcp-tools.ts` | 10 个名字,与平台 `MCP_TOOL_REGISTRY` 键一致 |

## 2. 选定方案

一句话:**档位、审批与来源各自只有一个权威 —— 三档 = 注入 agent 的完整规则表,所有委派入口都按父档位问或拒;审批 = 现有身份轴闸 + v1 Permission,
批的是钩子之后的参数,批准返回后再复核策略与绑定;持久授权 = REQ-131 策略文档(接上真实账户);来源 = `authorityForMcp` 用不含令牌值的证据铸币,
执行位置随显示快照持久化。** 不新增审批器、不新增白名单、不新增持久化存储。

### 2.0 已定默认(编排器 2026-10-30 代定,可撤;不是 owner 裁决)

| # | 默认 | 撤法 |
| --- | --- | --- |
| D1 | 只读档下第三方 MCP、插件与 Code Puppy 云工具**每次询问,不能始终允许**(设置里启用了也问;已有的会话内放行不能消掉这一问) | 删掉 `alpha-readonly` 的 `"mcp:*":"ask"`、`"plugin:*":"ask"` 两条规则 |
| D2 | 请求审批档:任何委派(模型派子任务、点名助手、命令指定其它助手、直接子任务)派出前询问,卡上说明「子任务按它自己的权限运行,里面不再逐项询问」 | 把 `alpha-ask` 的 `task` 规则改回 allow |
| D3 | 项目自带 `opencode.json` / `.opencode/` 能起 MCP 进程、装插件的更广风险**本期不改**,记残余(理由:owner 只打开自有仓库,不受信仓库基数为零);受控字段(权限、模型)经 `.code-puppy` 的覆盖照 C6 修 | 另开票按 §3 残余第 1 条的三种做法之一处理 |

### 2.1 T01:三档的界面说明(文案,进现有菜单提示位;是否加第二行由设计稿定)

| 档 | 一两句人话(草案,定稿随设计稿) |
| --- | --- |
| 全部批准 | 改文件、运行命令不再询问。访问项目以外的文件夹、读取 .env、外部与云端工具第一次使用仍会询问;项目文件夹以外的位置始终写不进去。 |
| 请求审批 | 改文件、运行命令、派出子任务或换用其它助手前都会询问。外部与云端工具按「设置 → 工具」的规则执行。 |
| 只读 | 不能改文件、运行命令,不能派出会改东西的子任务,项目以外的文件夹不能访问;外部与云端工具每次使用都要你确认。 |

三档共同、任何档都越不过的(审批卡与设置页同一句):在「设置 → 工具」里停用的工具、管理策略或套餐关掉的工具、网络白名单之外的地址、
项目文件夹以外的写入。

### 2.2 T02:工具类 × 档位矩阵(修完之后的预期;今天不同的格加注)

| # | 工具类 | 全部批准 | 请求审批 | 只读 | 判定路径 |
| --- | --- | --- | --- | --- | --- |
| R1 | 内置读(read/glob/grep,工作区内) | 放行 | 放行 | 放行 | 能力轴 allow |
| R2 | 内置读/写到工作区外 | 询问;写仍被围栏拒 | 询问;写仍被围栏拒 | 拒绝 | `external_directory` + 进程围栏 |
| R3 | 读 `.env` | 询问 | 询问 | 拒绝 | `read` 规则 |
| R4 | 改文件(edit/write/apply_patch) | 放行 | 询问 | 拒绝(且不进工具表) | 能力轴 |
| R5 | 运行命令(bash) | 放行 | 询问 | 拒绝(且不进工具表) | 能力轴 |
| R6a | 模型派子任务(`task`) | 放行,子任务按自身规则 | **询问**(今天放行) | **拒绝**,同档自身的子任务除外(今天放行且子任务可写可执行) | §2.3 |
| R6b | 用户点名助手(`@general`) | 放行 | **询问**(今天跳过询问) | **拒绝** | §2.3 E2 |
| R6c | 斜杠命令(非子任务) | 以命令自带助手或默认助手运行 | 以本档运行;命令自带其它助手 ⇒ **询问**(今天以 build 运行) | 以本档运行;命令自带其它助手 ⇒ **拒绝**(今天以 build 运行) | §2.3 E4/E5 |
| R6d | 直接子任务(`/review` 等) | 放行 | 目标是本档 ⇒ 放行;其它助手 ⇒ **询问** | 目标是本档 ⇒ 放行;其它助手 ⇒ **拒绝** | §2.3 E3 |
| R7 | 本机打开网页 / 搜索 | 放行;未登记地址另弹网络授权;总闸下搜索拒 | 同左 | 同左 | 能力轴 allow + 出网围栏 + 总闸 |
| R8 | 宿主工具(MCP 资源列出/读取) | 放行 | 放行 | 放行 | builtin 类 enabled + `read` 规则 |
| R9 | Code Puppy 云工具 | 首次询问;设置启用后放行;额度由云端逐次判定 | 同左 | **每次询问,不可始终允许**(D1) | 文档轴 alpha-cloud 类(今天误归 third-party-mcp,§2.6);只读另有 ruleset ask |
| R10 | 第三方 MCP(含官方连接器;Office 见 §2.6) | 首次询问;设置启用后放行 | 同左 | **每次询问,不可始终允许**(D1) | 文档轴 third-party-mcp 类 + 只读 ruleset ask |
| R11 | 插件工具 | 首次询问;设置启用后放行 | 同左 | **每次询问,不可始终允许**(D1) | 文档轴 plugin 类 + 只读 ruleset ask |
| R12 | 任一工具在设置里停用 / 管理策略 / 全局开关 | 拒绝 | 拒绝 | 拒绝 | 文档轴 deny = 上限,先于钩子,批准后再复核(§2.5) |

R9–R11 的只读格覆盖三种状态:设置为默认询问、设置里已启用、本会话已有放行 —— 三种都必须弹卡且卡上没有任何「始终/本次会话」按钮。

证据归属(不另开 VERIFY 票):

- **规则层全格**:C1 新增 `opencode/test/permission/alpha-tier-tool-matrix.test.ts`,与 `alpha-composer-tiers.test.ts` 同一手法(真 `injectAlphaConfig`
  → 真 `Agent.Service` → 真 `AlphaToolPolicyGate.gateToolExecution` + 真 `Permission.Service`,`ALPHA_PERMISSION_ASK_TIMEOUT_MS=300`),
  对 R1–R12 每格断言 PASSED-THROUGH / `UnansweredError` / `DeniedError`;R9/R10 的 subject 用**生产形状**的 DEF 与装载 entry 经真 `authorityForMcp` 派生。
- **入口层(规则表全绿也可能被入口绕过,必须单测入口)**:C1 新增 `opencode/test/permission/alpha-tier-delegation.test.ts` —— 真 `TaskTool` 在
  `bypassAgentCheck` 情形下(R6b)、真 `SessionPrompt.command` 走非子任务命令与 `subtask:true` 命令(R6c/R6d)、真 E6 直接子任务,逐档断言**真的出现那一问**
  (`permission.asked` 事件计数 = 1)或具名拒绝、且实现调用计数为 0;ui-mac 侧 composer 组件用例断言两个 `session.command` 请求体带档位 agent。
- **授权状态层**:R9–R11 只读格的「已有放行」状态归 C2 的 `alpha-approval-binding.test.ts`(依赖 C2 的逐次 pattern)。
- **打包版**:共享 RC 回归 T23 —— T23-P1 只读档让模型派子任务改一个文件 ⇒ 拒绝且文件未变;T23-P2 请求审批档发 `@general 改个文件` ⇒ 弹卡;
  T23-P3 全部批准档首次调用 `cloud_dispatch` ⇒ 弹卡、卡上来源为「Code Puppy 云」;T23-P4 「本次会话内允许」后同类请求不再弹、重启 App 后再弹;
  T23-P5 「在此项目中始终允许」某第三方工具后新会话不弹、设置页可撤回且撤回后再弹、换一个账号登录后同项目要重新询问;
  T23-P6 只读档调用一个已在设置里启用的第三方工具 ⇒ 仍弹卡且无「始终」按钮。

### 2.3 委派入口按父档位问或拒(F1 / Codex F2)

规则表(alpha 自有注入面):

- `alpha-readonly`(`alpha-config-injection.ts:240-251`)加 `task: {"*":"deny","alpha-readonly":"allow"}` —— 委派给其它助手一律拒;同档自身的子任务
  (如以只读档运行的 `/review`)放行。`Permission.disabled`(`permission/index.ts:381-382`)只在最后一条 `task` 规则是 `pattern:"*"` 的 deny 时才把工具移出表,
  所以 `task` 工具留在表里、按 pattern 判;另加 D1 的 `"mcp:*":"ask"`、`"plugin:*":"ask"`。其余承诺的键(`edit/bash/external_directory` deny、`*.env*` deny)已显式写在后面。
- `alpha-ask`(`:274-282`)加 `task: {"*":"ask","alpha-ask":"allow"}`,并显式写 `read: {"*.env":"ask","*.env.*":"ask"}` 与 `doom_loop:"ask"`(防项目层顶层
  `permission` 放宽这两项)。**不**显式写 `external_directory`:追加 `{"*":"ask"}` 会在 `findLast` 下压掉 defaults 里临时目录/技能目录的白名单,
  而注入面拿不到引擎的 `Global.Path.tmp`;「请求审批」的说明也不承诺外部目录(§2.1)。
- 注释订正:`alpha-config-injection.ts:227-229`「委托子任务不破只读」改为事实。

入口(引擎改动都在 ADR-041 已接管的 `session/prompt.ts`;不改上游 `task.ts`/`subagent-permissions.ts`):

- **E1 模型的 `task` 调用**:`task.ts:119-129` 的 `ctx.ask({permission:"task", patterns:[subagent_type]})` 用当前(档位)agent 的规则集求值,规则表改完即生效。
- **E2 点名助手**:`prompt.ts:1263-1265` 改为 `bypassAgentCheck = 消息里有 agent part && 对每个被点名的助手,Permission.evaluate("task", <名>, merge(agent.permission, session.permission)).action === "allow"`。
  全部批准档(`*` allow)行为不变;请求审批档点名 ⇒ 仍走 E1 的询问;只读档 ⇒ 拒。
- **E3 直接子任务**:`prompt.ts:288-308` 在现有 E6 闸之前加一问 —— 当 `task.agent !== lastUser.agent` 时,以**父** agent(`agents.get(lastUser.agent)`)的规则集
  调 `permission.ask({permission:"task", patterns:[task.agent], always:[], tool:…})`;deny 具名拒绝、ask 挂起、allow 通过。同档子任务不问。
- **E4 命令换助手**:`prompt.ts:1414` 之后,若 `input.agent` 存在且 `cmd.agent` 存在且不同,按同一规则以 `input.agent` 的规则集问 `task` / `cmd.agent`;
  被拒则命令不执行并返回具名错误。
- **E5 composer 带档位**:`alpha-composer.tsx:1668-1673` 与 `use-projects.ts:486` 的 `session.command` 请求体按 `PERM_AGENT[perm]`(`composer-state.ts:45-49`)带 `agent`;
  「全部批准」不带(与 `buildPromptRequest` 同一规则,抽一个共用函数,不另写一份映射)。
- **获准后**:子任务按它自己的权限运行(D2),请求审批档的委派卡加一行这句话。

被否决:接管上游 `subagent-permissions.ts` 让父档位的 deny/ask 传给子会话 —— 语义更完整,但新增 L3 接管面与 ADR;本期 D2 的「派前询问 + 披露」已由编排器定为默认。

### 2.4 T03:「始终允许」按授权种类可用,并如实说明

| 请求种类(判据) | 按钮 | 做什么 | 作用域 / 期限(卡上显示) | 卡上显示「将记住」 |
| --- | --- | --- | --- | --- |
| 能力轴(v1 请求,`metadata.policy` 缺席) | 本次会话内允许 | v1 `reply:"always"` → session grant(`permission/index.ts:280-290`) | 本次会话 / 应用或引擎重启后失效 | v1 `always` 原文的人话投影:`*` ⇒「本会话内的所有<动作>」;目录 glob ⇒「<目录> 及其所有子文件夹(写入仍只限项目文件夹)」;bash 前缀 ⇒「以 <前缀> 开头的命令」 |
| 身份轴,`metadata.policy.askedBy === "policy"` | 在此项目中始终允许 | `toolPolicy.setRecord({directory, record:{selector:{level:"tool", canonical}, state:"enabled", bindingDigest}})`,成功后 `reply:"once"`;写失败卡保持挂起并显示失败 | 当前项目 · 当前账户 / 直到你在「设置 → 工具」改回,或该服务的配置发生变化 | 工具的可读名与来源(§2.6),不显示 digest |
| 身份轴,`askedBy === "ruleset"`(含只读档 D1) | 只有「允许一次」与「拒绝」,写明「当前档位要求每次确认」 | — | 仅这一次 | — |
| v2 请求(带 `save`,今天生产里不出现) | 始终允许 | 现有逻辑不变 | 当前项目 / 不过期 | `save` |

实施点(值谁写谁读):

1. **引擎写事实**:`alpha-tool-policy-gate.ts:173-189` 的 `metadata` 增加 `policy: { directory, canonical, bindingDigest, askedBy }`。`directory` 取 `InstanceState.directory`;
   `bindingDigest` 取 `subjectBindingDigest(subject)`(`alpha-tool-policy.ts:69-72`,alpha-cloud 用 evidenceDigest);
   **`askedBy` 先看 ruleset 轴**:`rulesetIdentityAction(canonical, ruleset)`(`alpha-tool-policy-gate.ts:66-68` 已有)为 `ask` ⇒ `"ruleset"`(档位或用户规则要求询问,
   文档轴是什么都不改变),否则文档轴 `effective.action === "ask"` ⇒ `"policy"`。ruleset 轴要求的询问同时改用**逐次 pattern**(§2.5 第 3 条),已有 grant 消不掉、也不产生新 grant。
2. **adapter 投影**:`permission-v1-adapter.ts:94-110` 对能力轴请求增加 `save: [...request.always]`;身份轴请求不投影 `save`;`:89-93` 注释改成新语义。`packages/app` 内文件,走前端补丁 round-trip。
3. **卡片**:`PermissionDialog.tsx` 的 `canAlways` / `createPermissionDecisionCommand` 按上表分流;v1 指纹的 always 命令不再带 `grantScope:project`(`replyPermissionV1` 只读 `decision`,
   `permission-v1-adapter.ts:217-229`);页脚 `alwaysNote` 随种类变化;v1 请求的 Expiry 行显示「本次会话」而非「不过期」。身份轴写入走现有 preload `toolPolicy.setRecord`。
4. **「当前账户」接上生产**(Codex F3):main 在 fork 时直接写进 sidecar env `ALPHA_POLICY_ACCOUNT = "acct:" + sha256(<安装级 machine id> + ":" + getAuthIdentityTag())`(安装级 machine id = `<userData>/artifact-quota-machine-id`;账户或安装标识取不到 ⇒ 不写),**不进** `sidecar-env.ts` 白名单 —— shell 导出的同名变量在建 env 时即被丢弃,选不了分区;混入安装标识是因为这个变量会被第三方 MCP / LSP / shell 子进程继承,同一账户换一台安装就是另一个值(`#1575` 落地,`packages/ui-mac/src/main/server.ts`);
   `alpha-tool-policy.ts:238` 默认改为 `Effect.sync(() => process.env.ALPHA_POLICY_ACCOUNT || "anonymous")`。登录/登出/切账户本就是 structural 换代(生命周期 #1562 的恢复范围表保留),
   新进程读新值;热续期不改账户。匿名分区里已有的记录**不迁移**(无法判断是哪个账户写的;回到默认询问是安全方向),仍供未登录时使用。
5. **撤回不残留**(Codex F5,替换原「清 grants」做法):身份轴的 session grant 绑定**策略修订号** —— `AlphaToolPolicy.snapshot()` 增加 `revision`
   (已加载用户文档 records 的 `canonicalJsonDigest`,缺席为 `"absent"`),身份轴 pattern 为 `<bindingDigest>@<revision>`(§2.5 第 3 条)。任一工作目录写策略 ⇒ 该项目分区的修订号变
   ⇒ 同项目**所有**活跃实例里的旧身份轴 grant 都不再命中。不需要枚举实例,也不改 `clearGrants`。

能力轴为什么不做跨会话持久:它的 `always` 是 `*` 或整棵目录子树(§1.5 第 5 条),持久化等于「这个项目里永远可以改任何文件 / 读这棵树的任何文件」;
「全部批准」档已经是长期不问改文件与命令的开关;外部目录长期放行没有现成权威,不在本期新建。

### 2.5 审批绑定最终参数、批准后复核、绑定当前定义(P4 / Codex F4 / Q1 / Q2)

1. **deny 前置、confirm 后置**:`gateToolExecution` 拆成 `decide`(重读策略与当前 binding,deny 即抛)与 `confirm`(必要时 `Permission.ask`,然后复核)。
   `decide` 留在钩子之前;`confirm` 放在每个分支的 `tool.execute.before` 之后、实现本体之前,以**钩子之后的 args** 作为 `metadata.args`。全部落点:
   `session/tools.ts` 五个 wrapper 分支 —— 内置 `:177→181`、三条 host 资源 `:251/:339/:424`(这三条在钩子前已解析参数 `:233/:321/:413`,统一改到钩子之后解析)、
   MCP `:500→508`;另两个独立调用方 `tool/code-mode.ts:157`(钩子 `:178`)与 `session/prompt.ts:299`(钩子 `:354`)。一次调用仍恰好一问。
2. **批准返回后复核**:`confirm` 在 `Permission.ask` 返回(含挂起后被 `once`/`always` 唤醒、`permission/index.ts:279`)之后、实际调用之前再跑一次 `decide`:
   deny ⇒ 具名拒绝;当前 `bindingDigest` ≠ 请求里写的那个(审批期间重绑、换端点)⇒ 拒绝并返回「服务配置在审批期间变化,请重试」;只有两项都不变才执行。
   这样审批挂起期间在设置里停用工具或改服务定义,旧卡的「允许一次」不会直接唤醒执行;不需要取消挂起请求。
3. **pattern 规则**:身份轴这一问 —— 文档轴要求询问时 `patterns = always = [<bindingDigest ?? "binding:unknown">@<revision>]`;ruleset 轴要求询问时
   `patterns = ["call:" + callID]`、`always = []`(逐次,grant 消不掉也不产生)。ruleset 里 `pattern:"*"` 的规则照常匹配。风险分级不变:有 identity 时分类走
   identity 分支(`alpha-risk-classification.ts:728`),读 `metadata.transport/authority/args`,不读身份轴 patterns(Codex Q2 已核)。只改确实断言旧 `patterns:["*"]` 的用例,
   保留风险与零副作用断言,另加「同事实换 patterns 风险不变」对照。卡片对身份轴请求不把 patterns 当资源显示。
4. **对生命周期 #1563 的接口**:MCP 执行入口接收获批的 `bindingDigest`;若调用时该服务当前代的 binding digest 不同(同 schema 重连到新端点),拒绝本次调用。
5. 残余:钩子在批准前运行,自家 `cloud_vision` 钩子可能在用户拒绝前已在本机读并压缩已登记的图片(不出网,`cloud-vision-hooks.ts:276-290`)。

### 2.6 T04:来源证明与显示

1. **铸币修正**(`plugin/src/alpha-cloud-authority.ts:67-82`,alpha 自有):对 DEF 中**值含 `{file:}` 引用的 header**,只要求 entry 有同名 header 且为字符串,不比较其值;
   其余字段(`type/url/enabled/oauth/timeout`、其它 header 的键与值、键集合)仍逐字相等。evidence 仍是 `canonicalJson({kind:"alpha-cloud-mcp", name, definition: DEF 原文})`,
   不含令牌,digest 与 bindingId 随令牌轮换不变。它**证明来源,不证明凭据有效**。两个分支今天就都成立;生命周期 #1562 已按冻结接口从 DEF 引用取请求期凭据。
2. **测试先红**:`alpha-tool-identity.test.ts` —— DEF = `materializeCloudMcpConfig(url, "{file:/x/ALPHA_MCP_TOKEN}")` 真产物,entry = 同一对象 `Authorization` 换成字面量 ⇒ `alpha-cloud`(现码红);
   entry 多一个 header 或 URL 不同 ⇒ `not-asserted`;DEF 无引用而 Authorization 值不同 ⇒ `not-asserted`;生产接线:真 `injectAlphaConfig`(代付分支)产出的
   `OPENCODE_CONFIG_CONTENT` 经真 `ConfigVariable.substitute` + 真解析得到 entry,与同次写入的 `ALPHA_CLOUD_MCP_DEF` 喂 `authorityForMcp` ⇒ `alpha-cloud`。
3. **策略层随之变化(如实登记)**:云工具分类从 `third-party-mcp` 变 `alpha-cloud`;默认仍 ask;设置页移到「云端工具」组;已有工具/服务级「启用」记录的 `bindingDigest`
   是第三方口径,对上 evidenceDigest 后回到 ask 并显示「服务配置已变更」一次。
4. **执行位置进入快照**(Codex F6):`ToolDisplaySnapshotV1`(`schema/src/tool-identity.ts:32-38`)增加可选 `location: {kind:"local"} | {kind:"remote", host}`,
   在注册时由宿主写:内置/host/插件 ⇒ local;MCP ⇒ 由 `bindingFacts(origin).entry` 经 `mcpTransportFact`(`alpha-tool-policy-gate.ts:134-138`,同一去秘密口径)派生,
   远端取 URL 主机名,本机命令 ⇒ local。随首个 ToolPart 持久化(ADR-041 决策 4 的同一条快照链,`session/tools.ts:123-127` `register` → `processor.registerToolDisplay`),
   不读工具返回的同名字段。缺这一字段(历史行、事实缺席)显示「位置未知」。可选字段:旧读者忽略多余键,无回填。
5. **显示三分**:`tool-card-model.ts` 的类别映射为用户层三类 ——「Code Puppy 内置」(builtin、host、§2.6 第 7 条的随包 MCP)、「Code Puppy 云(已验证)」(alpha-cloud)、
   「第三方来源」(其余 mcp、plugin;有 origin 时带名字);位置格只读快照的 `location`(alpha-cloud 的远端显示为「云端」)。「宿主工具」不再出现在正常界面;
   开发者详情保留 `identity`、`authority.kind`、`bindingId`、`evidenceDigest`、`location`。没有 authority 的 `(mcp,"cloud")` 仍按第三方显示。
6. **云卡规则覆盖权威**:`ALPHA_CLOUD_RULES` 补齐 5 个缺席工具;断言「`CLOUD_MCP_TOOLS`(平台注册表生成快照)的每个名字都有规则」,平台新增工具 ⇒ 快照刷新 ⇒ 断言红。标题文案归 T05。
7. **随包文档工具(依赖生命周期 #1565 与 owner 裁决)**:`ToolAuthority` 增加 `{kind:"alpha-bundled", bindingId, evidenceDigest}`,只由 `authorityForMcp` 在
   `declaredFirstPartyTools` 成立时铸造;`ToolClass` 增加 `alpha-bundled`,默认 ask(不改权限默认);设置页多一组「Code Puppy 文档工具」。ADR-041(`:145`)规定新增 authority kind
   须另开 owner 裁决,故列入「待 owner 裁决」,未获批前 C5 不开。**数据回退**(Codex F7):`alpha-tool-policy-store.ts:72` 对未知枚举整份隔离、隔离 ⇒ 用户可配置工具全部停用
   (`alpha-tool-policy.ts:142-144`)。所以 C5 的回退只撤分类、铸造与设置组,**保留** schema 里 `"alpha-bundled"` 两处字面量;届时已落盘的 `class:"alpha-bundled"` 记录可读、
   不匹配任何工具、不触发隔离。C5 的测试含「分类撤回后,含该记录的文档仍 `status:"ok"`」。
8. 官方连接器(`github-official`、`dbhub-readonly`)按第三方来源显示,不升级。

### 2.7 §2.4:只修已证实的覆盖路径

- **P1 修(C6)**:`ext/src/project-config.ts:144-147` 对未信任项目的 `agent` 条目剥掉 `permission`、`model`、`disable`、`mode` 再合并(文本字段照旧恒加载);已信任时原样。
  先红:`project-config.test.ts`「未信任项目写 `agent.build.permission` ⇒ cfg 里没有它」「已信任 ⇒ 有」。
- **P2 不修(D3)**:残余见 §3。§2.3 已把两档承诺的键写全,所以 P2 改不动「请求审批」「只读」说明里承诺的事;剩余影响限于「全部批准」三类询问、
  「请求审批」的外部目录询问与 W3 的 `mcp`/`plugin` 装载。
- **P3**:不封印(进程内代码);consent 文案写明「项目插件可改变权限与模型设置」(建议,不是本期 AC)。
- **P4**:§2.5。
- 来源伪造咽喉:`ALPHA_CLOUD_MCP_DEF` 只由 main 在 fork 时写(`alpha-config-injection.ts:390-391,418-420` 每条分支覆盖或删除);配置层最多让证明不成立,造不出 `alpha-cloud`。

### 2.8 alpha-platform 一节

不开票。信任根是桌面 main 写进 sidecar env 的端点定义(URL 来自 `ALPHA_CLOUD_MCP_URL`);平台签名只能防同一用户下能改应用配置的进程,而那样的进程同样能改 env 与二进制。
平台侧被消费的只有 `MCP_TOOL_REGISTRY` 的键(桌面生成快照 + §2.6 第 6 条的覆盖断言);交付 lane 把 `cloud_dispatch.kind` 改成注册表枚举不改工具名。

### 2.9 与其它 lane 的冻结接口

| 对方 | 我方假设 / 提供 | 形状 |
| --- | --- | --- |
| 生命周期 #1562(热续期,方案 `29eedb6f2`) | 我方提供:`governedMcpEvidence` 两个分支都成立、与令牌值无关;对方已改为请求期凭据从 `ALPHA_CLOUD_MCP_DEF` 的引用读 | `governedMcpEvidence(name, entry, env) → string \| undefined` 签名不变 |
| 生命周期 #1563(MCP 逐服务) | MCP 执行入口接收获批 `bindingDigest`,当前代 binding 不同则拒绝(§2.5 第 4 条) | 执行入口多一个参数 |
| 生命周期 #1565(第一方文档工具连接前可选用) | C5 消费 `declaredFirstPartyTools(name, entry, env, readFile)` 及其 evidence 输入(`serverSha256` + 命令 token) | — |
| 目录与模型 C6 | 模型字段最终权威按其 C6;本方案 E5 只给 `session.command` 加档位 agent,不动模型字段 | — |
| 交付 lane | 图片卡与附件只依赖 identity;§2.6 修好后云派发卡改为专用卡,产物行判定不变 | — |
| 命名迁移(alpha-code#1568 依赖 C4) | 改名接口点:`ToolAuthority.kind` 的 `"alpha-cloud"`/`"alpha-bundled"`、`ToolClass` 同名值、`bindingId` 前缀 `mcp:`、evidence 内 `kind:"alpha-cloud-mcp"`、`ALPHA_CLOUD_MCP_SERVER/DEF/ARM` 与新 `ALPHA_POLICY_ACCOUNT` env、`ALPHA_CLOUD_RULES` 键、`alpha-ask`/`alpha-readonly` 与 `task` 规则里的同名 pattern。改 evidence 内 kind 会改 digest ⇒ 已有云工具「启用」回 ask 一次 | — |
| 颜色 #1550 | 只改说明与按钮语义,不改颜色 | — |

### 2.10 被否决的替代

| 替代 | 不采用的理由 |
| --- | --- |
| 把 v1 session grant 落盘,让「始终允许」跨重启 | 新建第二个持久授权存储;能力轴 `always` 是 `*`/整棵子树,范围过宽 |
| 把「始终允许」写成 session 规则(`Session.setPermission`) | session 规则排在 agent 之后,allow 会压过只读档的 deny |
| 能力轴持久授权写进用户 `alpha.jsonc` 的 `permission` | 同样压过档位 deny;撤回入口不在设置页 |
| 撤权时逐实例 `clearGrants` | 运行态按目录、策略按项目,要枚举同项目所有实例;修订号进 pattern 不用枚举 |
| 撤权时取消挂起的审批请求 | 批准后复核已覆盖「停用/重绑」;改回「询问」时旧卡的「允许一次」本就是对这一次调用的明确批准 |
| 为 `not-asserted` 加一个「不可信」显示等级 | 它的含义是「未声明已验证云来源」,内置工具也是它 |
| 按 `origin==="cloud"` 或工具名前缀显示为官方云 | 名字可被任何 MCP 配置键复用;违反 ADR-041 决策 5 |
| 铸币时读令牌文件比较解开后的值 | 令牌轮换后 entry 里的旧字面量与新文件不等,证明会翻成 `not-asserted` |
| 执行位置从「非云即本机」推断 | 已启用的远端第三方 MCP 无需审批,推断会把它显示成本机 |
| 由 alpha-platform 签发云工具 binding | 见 §2.8 |
| 在 ext 自有钩子之后再加「封印」钩子重写受控字段 | 对已同意的插件无效,对未信任来源门不在那里 |
| `OPENCODE_DISABLE_PROJECT_CONFIG=1` 一刀切 | 同时关掉项目 `AGENTS.md`/`CLAUDE.md` 指令发现(`session/instruction.ts:81,123`);且 D3 已定本期不改 |
| 钩子改参后再问一次 | 自家 `cloud_vision` 每次都改参,同一次调用会问两遍 |
| 只给两个 agent 加 `task` 规则 | 点名助手、斜杠命令、直接子任务三条入口不经它(Codex F2) |
| 未知策略枚举改为「忽略该条」而不是整份隔离 | 违反 #724 §5「不得静默忽略一条可能原本是 deny 的坏记录」;回退时保留字面量即可 |

## 3. 安全面与不变量

整类边界:伪造来源;项目文件 / 项目插件覆盖受控字段;改参后沿用旧批准;审批挂起期间撤权或重绑;持久授权范围过宽或跨账户;撤权后残留授权;委派绕开档位。

| # | 不变量(实现必须守住) | 咽喉点 | 先红的测试 |
| --- | --- | --- | --- |
| I1 | `alpha-cloud` / `alpha-bundled` 只由 `authorityForMcp` 铸;输入只有 sidecar env 的 DEF/清单与装载 entry;URL、命令、键集任一不等即 `not-asserted` | `plugin/src/alpha-cloud-authority.ts`、`mcp/index.ts:191-203` | `alpha-tool-identity.test.ts` 生产形状四臂 |
| I2 | 正常界面的来源与位置只从持久化快照(`authority`、`identity.source`、`location`)派生,不读名字、URL、标题、工具返回 | `tool-card-model.ts` | `tool-card-provenance-gates.test.ts` 增「origin=cloud 无 authority ⇒ 第三方」「无需审批的远端第三方调用 ⇒ 持久化 ⇒ 重载回放显示远端主机」「缺 location ⇒ 位置未知」 |
| I3 | 文档轴 deny 先于任何钩子与副作用;档位、session grant、「始终允许」都撬不开 deny | `decide` | 矩阵 R12 |
| I4 | 人批准的是钩子之后、实现之前的参数;批准返回后、调用前再复核 deny 与 binding,任一变化即拒绝 | `confirm` 全部落点 | `alpha-approval-binding.test.ts`:钩子改参 ⇒ `metadata.args` 为改后值;挂起期间停用 / 重绑 ⇒ 回复 once 后实现调用计数为 0 |
| I5 | session grant 只消 ask、只在本会话、只对同一 binding 与同一策略修订号生效;ruleset 轴要求的询问不产生也不接受 grant | 身份轴 patterns | 用例:grant 后改 MCP entry ⇒ 再问;同项目目录 B 写策略 ⇒ 目录 A 的 grant 失效;只读档已有 grant ⇒ 仍问 |
| I6 | 持久授权只写 REQ-131 策略文档 tool 级 `enabled`,带当前 `bindingDigest`,只在 `askedBy:"policy"` 时提供;分区账户来自真实登录主体 | `PermissionDialog` + `setRecord` + `ALPHA_POLICY_ACCOUNT` | 组件用例:`askedBy:"ruleset"` ⇒ 无持久按钮;写失败 ⇒ 不 reply;生产装配 `AlphaToolPolicy.node` 换账户用例:A 的记录在 B 下不生效 |
| I7 | 卡上的作用域、期限、「将记住」与实际授予范围逐字对应 | adapter + dialog | adapter 用例:edit 请求 `save === ["*"]`、文案「本会话内的所有编辑」 |
| I8 | 只读档不派出其它助手;请求审批档任何委派必问;composer 发命令带档位 | §2.3 E1–E5 | `alpha-tier-delegation.test.ts`(现码红);composer 命令请求体用例 |
| I9 | 未信任项目文件不能改任何 agent 的 `permission/model/disable/mode` | `ext/src/project-config.ts` | `project-config.test.ts` 两臂 |

残余风险(本期不关):

- W3(项目 `opencode.json`/`.opencode/`)仍可放宽「全部批准」的三类询问与「请求审批」的外部目录询问,并能在打开项目时起 `mcp` 本机命令服务器、装 `plugin`(D3)。
  将来要关时的三种做法:关掉项目配置发现(连带关掉项目指令自动加载)、接管引擎配置加载的项目文件阶段(新增接管 + ADR)、或把它们移到 `.code-puppy` 的信任门后。
- 已同意的项目插件是进程内代码,可改 env、配置与审批;边界只有 consent。
- 能力轴「本次会话内允许」对 `external_directory` 授予整棵子树(上游语义,卡上如实显示);外部目录读不受进程围栏限制(`allow default`)。
- 钩子在批准前运行(§2.5 第 5 条)。
- 匿名分区里的旧授权不迁移,登录后需要重新授权一次。
- Codex 方案审另记一条不在本轮的观察:斜杠模板的 shell 展开(`session/prompt.ts:1441` 一带直接调用 `Process.text`)发生在工具执行闸之外;未核、未纳入本方案。

## 4. 子票切分

拆分理由:C1/C2 是安全面,必须各自独立 PR 且不该等 UI 稿;C3/C4 含 UI 要等稿;C5 等生命周期 #1565 与 owner 裁决;C6 很小、与 REQ-060 信任门同源,单独可审。
全部在 alpha-code;alpha-platform 不开票(§2.8)。

| # | 标题 · 仓 | 覆盖 | 边界(关键文件) | out-of-scope | 退出条件 | 尺寸·难度·依赖·独立 PR | 将来拿什么证明 | UI 稿 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | `[REQ-236][CODE] 只读与请求审批档的子任务、点名助手和斜杠命令不再绕过档位` · alpha-code | AC1 · T02(R6a–R6d、R9–R11 只读格的默认/已启用状态)、T01 事实 | `ui-mac/src/main/alpha-config-injection.ts`(两个 agent)、`opencode/src/session/prompt.ts`(E2/E3/E4)、`ui-mac/src/renderer/alpha-ui/alpha-composer.tsx`、`sidebar/use-projects.ts`、`composer-state.ts`(共用档位映射);新 `alpha-tier-tool-matrix.test.ts`、`alpha-tier-delegation.test.ts` | 上游 `task.ts`/`subagent-permissions.ts`;界面文案;审批卡 | 矩阵与入口测试先红后绿;`alpha-composer-tiers.test.ts` 仍绿 | M · 难(四个入口语义、接管文件)· 无 · **独立 PR**(安全) | 两个新测试;composer 命令请求体用例;T23-P1、P2、P6 | 否 |
| C2 | `[REQ-236][CODE] 审批按钩子之后的参数生效,批准后复核停用与服务变更,会话内放行随服务定义和设置变化失效` · alpha-code | AC1 · T03(绑定、撤权)、§2.4 P4 | `opencode/src/permission/alpha-tool-policy-gate.ts`、`alpha-tool-policy.ts`(`revision`)、`session/tools.ts`(五个分支)、`tool/code-mode.ts`、`session/prompt.ts:299` 一带 | 卡片 UI;能力轴语义;生命周期 #1563 的执行入口本身 | I3–I5 测试先红后绿;只更新断言旧 patterns 的用例,风险与零副作用断言保留;风险不变对照绿 | M · 难(接管文件、七个落点、时序)· 无 · **独立 PR**(安全 + 引擎接缝) | 新 `alpha-approval-binding.test.ts`;T23-P4 | 否 |
| C3 | `[REQ-236][CODE] 审批卡的「始终允许」按授权种类可用并只对当前账户生效,三档菜单说明真实边界` · alpha-code | AC1 · T01(说明)、T03 | `app/src/context/permission-v1-adapter.ts`(补丁 round-trip)、`ui-mac/src/renderer/alpha-ui/PermissionDialog.tsx`、`permission-watcher.tsx`、档位菜单、`i18n`;`ui-mac/src/main` fork env(`ALPHA_POLICY_ACCOUNT`)与 `sidecar-env.ts`;`opencode/src/permission/alpha-tool-policy.ts:238` | 颜色(#1550);引擎闸 | I6、I7 测试;`PermissionDialog.test.ts` 置灰用例改写为四种种类;生产装配换账户用例;`frontend-patch-roundtrip.test.ts` 绿;对照批准稿 | M · 常规 · C2、设计稿批准 · 否 | 上述测试;T23-P4、P5;UI 对照批准稿 | **要**:审批卡五态(能力轴「本次会话内允许」含「将记住」;身份轴「在此项目中始终允许」;档位要求每次确认;委派卡的披露行;写入失败);三档菜单每档一两句与「任何档都越不过」一句 |
| C4 | `[REQ-236][CODE] 云工具来源在真实注入下显示为已验证的 Code Puppy 云,来源分三类并显示真实执行位置` · alpha-code | AC1 · T04 | `plugin/src/alpha-cloud-authority.ts`、`schema/src/tool-identity.ts`(`location`)与 SDK 生成类型、`session/tools.ts` 注册处、`ui-mac/.../cards/tool-card-model.ts`、`tool-cards.tsx`、步骤行文案、`i18n` | 品牌改名;Office(C5) | §2.6 第 2 条四个用例与 I2 三个用例先红后绿;云卡覆盖断言 | M · 常规 · 无 · 独立 PR(来源证明) | 上述测试;T23-P3;UI 对照批准稿 | **要**:来源 × 位置组合(内置·本机、云·云端、第三方·本机/远端主机、位置未知)、开发者详情证据行 |
| C5 | `[REQ-236][CODE] Code Puppy 随包文档工具显示为内置来源` · alpha-code(**owner 裁决后才开**) | AC1 · T04 | `schema/src/tool-identity.ts`、`schema/src/alpha-tool-policy.ts`、`mcp/index.ts` `authorityForMcp`、`settings-tools.tsx`、`tool-card-model.ts` | 文档工具启动与运行环境(生命周期 #1563–#1565) | 声明定义成立 ⇒ `alpha-bundled`;差一个 token 或 sha 不符 ⇒ `not-asserted`;分类撤回后含该记录的策略文档仍可读 | S · 常规 · 生命周期 #1565、owner 裁决 · 否 | `alpha-tool-identity.test.ts` 两臂;策略存储回退用例;UI 对照批准稿 | **要**:设置 → 工具「Code Puppy 文档工具」组 |
| C6 | `[REQ-236][CODE] 未经信任的项目配置不能改写助手的权限和模型` · alpha-code | AC1 · §2.4 P1 | `ext/src/project-config.ts`、`project-config.test.ts` | W3(D3) | I9 两臂先红后绿 | S · 轻 · 无 · 否 | `project-config.test.ts` | 否 |

所有打包证据进共享 RC 回归 T23;父票 AC1 不因任何子票合并而关。

## 方案审记录

Codex 方案审一轮(唯一一轮,对 `bceeed2f1`):6 Major + 1 Minor 全部接受,结论回写如下 —— F1 → §2.4 第 1 条、§2.5 第 3 条、§2.2 R9–R11;F2 → §1.3、§2.3、§2.2 R6a–R6d;
F3 → §1.8、§2.4 第 4 条;F4 → §2.5 第 2、4 条;F5 → §1.8、§2.4 第 5 条;F6 → §2.6 第 4、5 条;F7 → §2.6 第 7 条;Q1 → §2.5 第 1、5 条;Q2 → §2.5 第 3 条;
Q3 → §2.6 第 1 条;Q4 → §2.3;ARCH-NOTE(ADR-041 新 authority kind)→「待 owner 裁决」。

## 待 Codex 征询

无(本轮唯一一次方案审已完成)。

## 待 owner 裁决

1. **要不要让 Code Puppy 自带的文档工具(PDF / Word / Excel / PowerPoint)显示为「Code Puppy 内置」。** 今天它们在对话里被标成「第三方工具」、收发内容全部隐藏。
   要改,得在工具来源的记录格式里新增一种「随应用安装、本机运行、已校验」的来源;工具来源规则(ADR-041)写明新增这类来源必须由你裁决。
   选项:A 新增(C5,依赖文档工具改造先合):对话和设置里显示为内置、权限默认仍是每次询问;以后撤回只撤显示与分类,已存的设置照常可读。
   B 不新增:文档工具继续显示为第三方,说明里不再补救。推荐 A。拖着的代价:文档工具在对话里看起来像外部服务,用户无从判断它是否可信。

## 仍是推断、没跑过的断言

- 委派绕过(R6a–R6d):由 `task.ts`/`subagent-permissions.ts`/`agent.ts`/`prompt.ts` 规则推导,没有跑真入口;C1 的入口测试是第一条证据。
- `task: {"*":"deny","alpha-readonly":"allow"}` 下 `task` 工具仍在表里、按 pattern 判:依 `permission/index.ts:381-382` 读码,未跑。
- P1/P2 的配置变异确实被 `Agent.Service` 读到:依 `agent.ts:267-294` 与 REQ-060 已出货功能推断。
- 生产分支装载后的 entry 只在 Authorization 值上与 DEF 不同:依 schema 无默认值与注入代码推断;未读 owner 机配置。
- owner 会话里四个云调用为 `not-asserted`:取自 #118 评论 2,本 lane 未复读会话库。
- 修改后的铸币在两个分支都成立;策略修订号进 pattern 后跨实例失效;批准后复核拦住挂起期间的停用与重绑;拆分后一次调用恰好一问 —— 均为设计推导,待 C2/C4 测试证明。
- v1 session grant 随 token-only 换代丢失:取自生命周期 lane 日志计数;「本次会话内允许」在 #1562 落地后活到结构性换代或退出,未验证。
- 登录/登出/切账户都走 structural 换代、新进程读到新的 `ALPHA_POLICY_ACCOUNT`:依生命周期方案的恢复范围表,未跑。
