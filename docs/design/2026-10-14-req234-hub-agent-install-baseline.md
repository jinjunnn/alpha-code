---
title: "#1521 方案基线:agent 能查定制中心、经你同意安装,下一句话就能用"
kind: design
status: proposed
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-10-14
review_after: 2027-01-14
---

# `#1521` 方案基线 —— 主进程是唯一权威,agent 只发请求、只读结论

票面 `alpha-code#1521`(REQ-234,L 级)。本基线是它**升 Ready 的门**;`requirement-management`
要求的四段(只读勘破 / 选定方案与被否决的替代 / 安全面 / 子票切分)在第一至第四节,
D1 的裁决与代价在第五节,仍是推断的断言在第六节,开发前对抗审计 R1 的逐条处置在第七节。

**读法**:alpha-code 坐标以 `origin/alpha@74482625a`(2026-10-14)为准,写作 `文件:行`;
alpha-work 坐标以 `origin/main` 的 `governance/customization-center-target-architecture.md`
(下称「目标架构」)为准。第一节只陈述**读过、跑过**的事实,不含设计;设计从第二节起。
**本版(R1 修订)**:第七节列出的 10 条审计发现已逐条并入正文;与初版相比,运输层从「投影文件」
改为 sidecar `parentPort` 窄消息,重载执行者从 main 改为 ext,堵旁路的机制从「本机 MCP 真源文件」
改为「`alpha.jsonc` 收紧出围栏可写集 + ext 在每次实例重建时治理 `cfg.mcp`」。

## 〇、约束(已裁决,不是选项)

| # | 约束 | 来源 |
| --- | --- | --- |
| 1 | AC1–AC5 原文不增、不放宽、不改写 | 票面 |
| 2 | 受管安装由用户在**软件界面里**点同意;密钥绝不经过聊天;加密只保护落盘,**不承诺**运行时密钥对 agent 不可见 | 目标架构 §1.4、§6 R1 第 2 条 |
| 3 | agent 写全局 `alpha.jsonc` 能加本机 MCP 这条旁路存在;**堵上之前不得对外说「确认框是唯一安装通路」** | 目标架构 §2.6、§6 R1 第 1 条 |
| 4 | 重载要等**同一引擎实例上所有会话**空闲;三条路统一进一个调度;多组件一次重载 | 目标架构 §2.5、§6 R1 第 6 条 |
| 5 | 状态三档「已安装 → 待重载 → 可用」;工具**立即返回**,不在当前回答里等重载;对外承诺只针对「可用」之后的下一条消息 | 目标架构 §2.5、§2.6、§6 R1 第 7 条 |
| 6 | 项目里的 JS 插件在用户信任该项目后**会被加载执行**,技能要如实讲;目录里的可执行插件被拒装 | 目标架构 §2.9、§6 R1 第 10 条;ADR-040 |
| 7 | `customize-opencode` 的处置归 `alpha-code#1522`(owner 2026-10-14:「本项目直接只使用 customize-code-puppy」);本基线对它**只引用、不设计** | 编排器横向通知 |
| 8 | 北极星:不改 `UPSTREAM_PATHS` 下的上游文件;新代码进 `packages/ext`、`packages/ui-mac` | ADR-043、ADR-044 |
| 9 | **D1 已按已批方案 §2.6 采 A:堵上「agent 写全局配置加本机 MCP」整类旁路**(编排器 2026-10-14 按目标架构 §2.6 代为采纳;代价见第五节) | 目标架构 §2.6 |

## 一、只读勘破(地面真相)

### 1.1 受管安装今天的完整时序

一次定制中心安装从点击到「下一条消息可用」,今天是这条链:

```
renderer use-extensions.ts  ──IPC gated write channel──▶  main ext-ipc.ts installCatalog body
   │                                                          │ 重新解析已验 catalog(loadVerifiedCatalog)
   │                                                          │ legacy planner / package admission → 事务 → 账本
   │                                                          │ 全局 MCP:reloadInstalledMcp()(global.dispose + mcp.status)
   ◀────────────────────────── 结果 ─────────────────────────┘
   │ 非 MCP:refreshEngine()(global.dispose,5 s 超时)
   ▼
引擎 InstanceState 惰性重建 → 下一条消息重扫 skills/agents/commands,MCP 重连
```

| 环节 | 实测 | 坐标 |
| --- | --- | --- |
| renderer 出站(MCP) | 只交 `catalogId / scope / grants(secrets, env, cnMirror) / authorization`;密钥在 grants 里经 IPC 进 main,落 `{file:}` 引用 | `packages/ui-mac/src/renderer/extensions/use-extensions.ts:653-676` |
| renderer 出站(skill / agent / package / cloud) | 同一个 `extIpc.installCatalog`;skill `:1132-1150`、agent `:1158-1170`、package/bundle `:1179-1190`(`installCatalogIntent`,**唯一**出站点)、cloud `:1267-1273`(receipts-only,不触达引擎) | 同文件 |
| IPC 写通道 | 全部生产写通道经 `buildGatedWriteChannels` 构造,**「新写通道必须先进表登记,不得直接 `ipcMain.handle`」**;`installCatalog` 挂在 `:1283`。表的**权威范围**是「会写 installs.json / 事务拥有的 config/store 的 **renderer 通道**」,表外另有写账本的生产者(见 1.6) | `packages/ui-mac/src/main/ext-ipc.ts:1166-1176`、`:1283-1292`;`ext-write-channels.ts:1-8` |
| main 安装体 | `runCatalogInstallWithPackagePreflight` → `installCatalog(legacy)` 或 `admitPackage`;全局 MCP 成功后 `reloadInstalledMcp(name)`;package 按 `activateMcp` 逐组件重载 | `ext-ipc.ts:1183-1240` |
| **MCP 配置真正的写入点是事务,不是 `persistMcp`** | 目录单装:planner 产出 `action:"config"`、`target = <globalRoot>/alpha.jsonc`、edit `mcp.<name>`(`:946-953`);项目/全局 MCP 的 `configTruthInRootGate` 要求配置真源**在事务根内**(`:1270-1278`);签名包 / 套件:`tx-builders` 同样写 `join(root,"alpha.jsonc")` 的 `mcp.<name>`(`:352-364`);事务层拒绝**任何逃出事务根的 config target**(`:673-678`);配置叶白名单只有 `mcp / plugin / provider / agent / command`(`ext-config-tx.ts:24`)。`persistMcp`(`ext-config.ts:542`)只服务**未策展自定义连接器**那条路 | `ext-install-planner.ts`、`ext-package-tx-builders.ts`、`ext-transaction.ts`、`ext-config-tx.ts` |
| main 重载 | `global.dispose()` → `mcp.status()`;结果四态 `connected / disabled / failed / reload-pending`;**不查任何会话是否在流式输出** | `packages/ui-mac/src/main/ext-mcp-activation.ts:184-228` |
| renderer 重载 | `refreshEngine()` = `global.dispose()` 5 s 超时 + `connectOutcome` 判 HTTP 错误;**不查会话** | `use-extensions.ts:987-997` |
| renderer 重载的调用方 | 22 处(`use-extensions.ts` 内 19 处;`extension-hub.tsx:847,1984`;`extension-detail.tsx:178`;`builtin-controls-panel.tsx:83,169`) | `grep -rn "refreshEngine()" packages/ui-mac/src/renderer` |
| 项目作用域重载 | `refreshProjectEngine(dir)` = `instance.dispose({directory})` 并等 `server.instance.disposed` 事件 | `use-extensions.ts:1000-1024` |
| 信任门后的重载 | 用户点「信任项目」/ 外部导入成功后 renderer 直接 `global.dispose()` | `packages/ui-mac/src/renderer/alpha-ui/ext-trust-watcher.tsx:52,61` |
| 安装成功 ≠ 已启用 | `desiredState` 由审核策略决定:`session-grant` 恒 disabled;有前像沿用;否则按初始策略 | `packages/ui-mac/src/main/ext-install-policy.ts:33-41` |
| 「待重载」今天不是状态 | 只是动作返回里的 reason 字符串(`"reload-pending"`),**不落盘、不显示在已安装列表** | `use-extensions.ts:699,972,1149,1166,1257,1266` |
| 引擎侧无文件监听 | 配置/技能/命令加载器范围内 `chokidar / fs.watch / watchFile` 零命中;生效只靠显式 dispose | 地面真相 K8 |
| **真源与拒绝名单只在 fork 时注入** | 远程 MCP 真源在 `prepareSidecarEnv` 里读一次、整条写进 `OPENCODE_CONFIG_CONTENT`(`:437-446`);账本禁用覆盖、用户全局 XDG 的默认拒绝(`injectMcpDefaultDeny`)同在此处(`:453-474`);引擎每次实例重建都重新合并 `OPENCODE_CONFIG`(文件,`config.ts:420-421`)与 `OPENCODE_CONFIG_CONTENT`(**环境变量,fork 后不变**,`:487-494`);`global.dispose` 只销毁实例、不重新执行注入(`server/global-lifecycle.ts:16-24`);未策展远程 MCP 添加后由 renderer **live `mcp.add`** 连上,而 `MCP.add` 的状态是 `InstanceState`(`mcp/index.ts:526`),dispose 即失 | `alpha-config-injection.ts`、`sidecar.ts:130-146`、`packages/opencode/src/config/config.ts`、`mcp/index.ts` |
| 目录里的远程 MCP 条目 | 随包目录 **0 条** `mcpType:"remote"`(12 条全 local);planner 的远程分支会把它写进 `alpha.jsonc`(`:472-484` → `:951`),而那里的远程条目会被默认拒绝压成 `enabled:false`(1.5 F2)—— 今天是空集上的潜在矛盾,登记不处理 | `python3 -I` 解析 `alpha-catalog.json` 实测 |

**dispose 的全部调用点(非测试)共 6 处**(`grep -rn "global.dispose()\|instance.dispose(" packages/ui-mac/src packages/ext/src`):
`ext-mcp-activation.ts:209`、`use-extensions.ts:991`、`:1018`、`ext-trust-watcher.tsx:52`、`:61`、`packages/ext/src/plugin.ts:389`。
其中**只有 `plugin.ts` 那一处等会话空闲**,而且只等登记它的那一个会话(见 1.4)。

### 1.2 扩展插件的工具注册方式,与它和主进程之间现有的通道

**工具表**:`packages/ext/src/plugin.ts:258-361` 的 `tool:` map 恰好 4 个 `tool({...})`
(`grep -c 'tool({'` = 4):`alpha_reload / alpha_register / alpha_echo / alpha_ping`。
ext 源码里 `catalog / installCatalog / hub_` 零命中(非注释、非测试)。
工具描述文字**不得内联**,必须来自 `packages/ext/src/context-injection.ts:283-313` 的
`TOOL_TEXT`,由 `toolFragments()`(`:319-326`)登记进带字节上限的注入簿(超限模块装载即抛,
`:156`;库存快照 `context-injection-inventory.snapshot.txt` 要随之重生)。

**ext 的 `config` 钩子在每次实例重建时、对最终合并后的配置执行**:引擎加载完插件后「Notify plugins of
current config」(`packages/opencode/src/plugin/index.ts:250-258`),插件状态按 directory 建实例
(`:141-164`);ext 已经靠它在每次重建时从盘上现读 skill generation 路径、合并项目配置、注入云 MCP 定义
(`plugin.ts:148-230`,注释原话「dispose 重建重触发 = 免重启」)。

**工具回调主进程 / 弹窗:今天没有 ext → main 的请求通道,但 sidecar ↔ main 之间有一条双向、带关联号的消息通道。** 逐条核过:

| 方向 | 通道 | 坐标 |
| --- | --- | --- |
| main → ext | fork 时的环境变量:`ALPHA_GLOBAL_DIR`、`ALPHA_FACTORY_SKILL_DIRS`(`index.ts:784`)、`ALPHA_FACTORY_DENY_SKILLS`、`ALPHA_CLOUD_MCP_DEF`、`ALPHA_BASE_URL` 等 | `alpha-config-injection.ts`、`index.ts` |
| main → ext(文件) | main 写、引擎读的真源目录已有先例:`<casBaseRoot>/mcp-servers/<env>.json`,只有 main 写得了(围栏 W2 只放行 `env/<env>`),读端进 sidecar 闭包、写端不进 | `mcp-server-truth.ts:1-27`、`mcp-server-truth-write.ts:1-7` |
| **main ⇄ sidecar(parentPort)** | sidecar 进程持 `process.parentPort`(`sidecar.ts:297-301`,取不到即抛);收 `start / stop / write-probe`,**其它 type 一律忽略**(`parseCommand` 对非这三种返回 undefined,`:255-259`、`:116-118`);`write-probe` 已经是一对**带 `id` 关联、带超时、子进程退出即「无法判断」**的请求/应答(main 侧簿记 `workspace-write-probe.ts:136-175`,接线 `server.ts:584-585`);sidecar 在围栏装上**之后**照常 `postMessage`(`sidecar.ts:134`→`:162`),所以这条通道不受围栏网络规则影响 | `sidecar.ts`、`server.ts`、`workspace-write-probe.ts` |
| ext → main(网络) | **无**。引擎树出网只能到 loopback 策略代理(`N4`),代理只做 `CONNECT` 隧道、明文 HTTP 一律 405 | `process-fence-profile.ts:174-178`;`network-egress-proxy.ts:1-30` |
| ext → 引擎 | `input.client`(SDK v1,同进程 HTTP);目录作用域的清单接口:`GET /mcp`、`GET /skill`(= `skill.all()`,**不按 agent 权限过滤**,`handlers/instance.ts:84-86`;按权限过滤的 `Skill.available(agent)` 只在进程内,`skill/index.ts:310-314`)、`GET /agent`、`GET /command`、`GET /experimental/tool/ids`(`sdk.gen.ts:379`);`GET /session/status` 列本实例非 idle 会话 | `packages/plugin/src/index.ts:56-64`、`packages/sdk/js/src/gen/sdk.gen.ts` |
| 引擎 → renderer | SSE 事件流;v1 审批请求 `permission.asked` 经 v1 适配器投影到 alpha 审批面 | `packages/app/src/context/permission-v1-adapter.ts:1-15` |
| main → renderer | `webContents.send` 共 12 个频道 | `grep -rn "webContents.send(" packages/ui-mac/src/main` |
| main 订阅引擎 | main 已长期订阅 `/global/event`;该流只有 `server.connected` + 实时事件 + 心跳,**没有初始快照、没有断线重放**(`handlers/global.ts:25-46`);`session.status` 事件经 `EventV2Bridge` 进全局流(`event-v2-bridge.ts:35-44`);今天只消费 `session.idle` | `chat-archive-uploader.ts:344-400`;`index.ts:1004` |

**插件工具能向用户「问一句」的唯一现成机制是 `ctx.ask`**(`packages/plugin/src/tool.ts:3-26`,
`AskInput = { permission, patterns, always, metadata }`,**返回 `void`**,不带请求 id):

- 接线:`packages/opencode/src/tool/registry.ts:166-170` 把宿主的 `ask` 桥成 Promise;
  `packages/opencode/src/session/tools.ts:151-158` 补上 `sessionID / tool{messageID,callID} /
  ruleset = merge(agent.permission, session.permission)` 后进 `Permission.ask`。
- **默认规则是 `*: allow`**(`packages/opencode/src/agent/agent.ts:119-135`),build agent = `merge(defaults, {question,plan_enter: allow}, user)`(`:141-151`);alpha 的「请求审批」档也只把 `edit / bash` 改成 ask(`alpha-config-injection.ts:270-281`)。
- `Permission.ask`(alpha 自有、L3 接管,ADR-033/ADR-038;`packages/opencode/src/permission/index.ts:159-245`):
  先按 ruleset 逐 pattern 判 —— `deny` ⇒ `DeniedError`;**`allow` ⇒ 不发布、直接返回**(`:167-180`);
  否则构造 Request(`metadata` 原样透传,`alphaRisk` 由引擎覆盖,`:196-199`)、发布 `permission.asked`、
  等应答,**300 s 期限到 ⇒ `UnansweredError` + 广播一条 reject 回执**(`:212-243`,不会自动放行)。
  应答 `reply`(`:247-310`):`reject` 连带拒绝同会话全部 pending(`:265-275`);`once` 放行一次;
  `always` 只在当前会话内记 grant。
- renderer:v1 适配器把 `metadata` 投影进审批面(`permission-v1-adapter.ts:94-110`),**刻意不投影
  `save`**,所以 v1 请求的「始终允许」按钮恒禁用(`:89-92`);`PermissionWatcher` 每次只呈现
  `requests[0]` 一个 `PermissionDialog`(`packages/ui-mac/src/renderer/alpha-ui/permission-watcher.tsx:16-50`);
  审批面按**当前路由的会话**取请求(`packages/app/src/context/permission-surface.tsx:46-60`);
  应答命令只有 `{ requestFingerprint, decisionID, decision }`(`PermissionDialog.tsx:19-30`),
  没有任何自由载荷;自动放行总闸默认关(`permission-auto-respond.ts:44-68`);
  呈现面唯一挂载由 `permission-mount-ratchet.test.ts` 钉住。
- 按 agent 钉权限规则的先例:`applyWebSearchDenies` 无条件写 `config.permission` 并对**每个** `config.agent[*].permission` 钉到末位(`cloud-web-search.ts:177-205`,理由「只写 `"*": "allow"` 的 agent 的 wildcard 排在全局规则之后就赢」)。

**今天的「确认框」**:renderer 自有的定制中心安装确认框 —— `extension-hub.tsx:468-490`
(`openInstallConfirmation`、`envValues` 遮罩密钥、`#348` 两阶段 authz 状态机;**「IPC 无取消能力」**,`:479-480`),授权视图
`ext-authz.tsx` 按已批设计稿 `docs/design/2026-07-15-capability-authorize-dialog/`;
package 首驱恒返回 `stage:"authorize"` 再带 `authorization` 重驱(`extension-hub.tsx:731-745`)。
main 自己弹的只有原生对话框两种:项目信任门(`ext-ipc.ts:483-500`)与出网放行(`egress-approval-dialog.ts`)。

### 1.3 可安装视图的单一权威

`packages/ui-mac/src/renderer/extensions/catalog-installable-view.ts:14-20`
`installableCatalogEntries(entries, advisoryBlocked)` 与 `:23-36` `installableCatalogPackages(...)`:
剔除带 `_verify` 的、curation 非法或非 `active` 的、退役 Office 连接器、成员不可用的套件
(`:48-81`)。它是**renderer 模块**,但 main 侧测试也直接 import 它当权威
(`alpha-skill-packaging-census.test.ts:31`)。catalog 本体:main 经签名渠道拉取、缓存读回重验、
随包快照兜底(地面真相 §1;`remote-catalog.ts`、`catalog-channels.ts`、`renderer/extensions/alpha-catalog.json`)。
安装身份是 **`(id, scope)`**:同名的 global 与 project 安装是两行(`ext-inventory.ts:14-17`、`:78-84`);
引擎状态属于具体 directory(`routes/instance/httpapi/middleware/instance-context.ts:23-32`);项目 MCP 已有
一支**按来源核验**的探针(`ext-mcp-activation.ts:36-127`:耐久叶 → 全局未遮蔽 → 有效配置逐字相等 → 该目录 `mcp.status`)。

AC1 要的四项信息在目录里的落点(以随包快照实读):

| 信息 | 来源 | 实况 |
| --- | --- | --- |
| 是否已装 / 是否启用 | 账本 `installs.json`(`desiredState`)经 `ext-inventory.ts` 聚合为 `availability / activation / health` 三维 | `packages/ui-mac/src/main/ext-inventory.ts:1-20`;`packages/ui-mac/src/shared/ext-states.ts:17-63` |
| 需要什么授权 | legacy 条目 `installSpec.requiredEnvVars`(`catalog-types.ts:25-26`);签名包 `prerequisites[].prerequisiteId`(`shared/catalog-package-view.ts:47-50`);mcp-remote 档案 `auth.kind ∈ {none, mcp-oauth, alpha-connection}`;云能力 = 登录 CodePuppy 账号 | 快照里带 `requiredEnvVars` 的只有 `mcp:github`、`mcp:dbhub`,且两条都带 `_verify`、被可安装视图隐藏 |
| 云能力的价格说明 | **目录与服务端都没有价格说明字段**:cloud 条目 `installSpec` 键只有 `kind / pipelineKind / inputContract / budgetDefaults / budgetLimits / tier / upstreamData`;`budget*` 是迭代/token/墙钟上限、`tier` 是执行分类(alpha-web `catalog-src/catalog.json:713-723`),服务端注册表只有字段说明(alpha-platform `pipeline-registry.ts:51-56`);全目录 `price` / `pricing` 零命中 | `python3 -I` 解析 `alpha-catalog.json` 实测;价格说明的落点是目标架构 §2.1 第 4 步的 `cloud` 档案 = REQ-235(`alpha-work#114`,open) |

### 1.4 会话空闲的判定从哪来,`alpha_reload` 现在怎么排队

- 引擎:`packages/opencode/src/session/status.ts:37-51` —— 每次 `set` 发布 `session.status`
  `{ sessionID, status: idle | busy | retry }`;转 idle 时**另**发一条 `session.idle`(schema 标 deprecated,
  `packages/schema/src/session-status-event.ts:43`);`GET /session/status` 列出**本实例**全部非 idle 会话
  (`routes/instance/httpapi/groups/session.ts:121-129`)。
- ext:`plugin.ts:43-56` `pendingReloads: Map<sessionID, {reason, at}>`;`alpha_reload`(`:258-272`)与
  `alpha_register`(`:329`)只登记;`event` 钩子(`:376-408`)在收到 `session.idle` 时,
  **仅当 idle 的正是某个登记会话**(或任一登记已陈旧 > 5 min)才 `instance.dispose()`;失败保留重试,
  连败 3 次 loud 放弃。它**不查同实例的其它会话是否正忙**。
- main:今天没有任何「会话正忙」的记录;`chat-archive-uploader.ts:385` 只看 `session.idle`。
- **引擎没有「暂停会话准入」的接口**:dispose(`global-lifecycle.ts:16-24`)与新会话的提示词准入之间没有互斥;
  查到「全部空闲」之后、dispose 之前仍可能有新回合开始。

### 1.5 旁路现状(只陈述事实,设计见第三节)

| # | 事实 | 坐标 |
| --- | --- | --- |
| F1 | 围栏可写集 W2 = `<alphaGlobalRoot>`,`alpha.jsonc` 在其中,**引擎树自己写得了**;登记在册的 sidecar 闭包内对 W2 的写只有:`alpha-config-injection.ts` 在文件缺席时 seed `{$schema}`(tsv 第 11、18 行)、以及 `alpha-installs.ts` / `ext-receipt-v2.ts` 的账本写(只由 main 执行) | `process-fence-profile.ts:46-64`、`:155`;`scripts/process-fence-write-sites.tsv` |
| F2 | 治理集 = `alpha.jsonc` 里的**非远程** MCP 条目 ∪ 本轮注入名;远程条目自 `#1381` 起不算治理凭据、压成 `enabled:false`;**本地条目一字不动**;枚举的用户全局文件只有 XDG 目录下三个 | `packages/ui-mac/src/main/mcp-default-deny.ts:38-74` |
| F3 | `persistMcp`:远程 → 真源文件;**本地 → 仍写 `alpha.jsonc mcp.<name>`**(注释原话「本地 MCP 维持现状」);但目录/套件/签名包的 MCP 配置由事务直接写 `alpha.jsonc`(1.1),不经它 | `ext-config.ts:542-570` |
| F4 | 引擎经 `OPENCODE_CONFIG = alpha.jsonc` 原生合并该文件(main 只在缺席时 seed `{$schema}`) | `alpha-config-injection.ts:85-92`;`engine-config-truth.ts:1` |
| F5 | `plugin[]` 加法一律被咽喉拒(ADR-040 执行面) | `packages/ui-mac/src/main/engine-plugin-seal.ts:1-20` |
| F6 | 上游项目配置发现(`<project>/opencode.json(c)`、`.opencode/`)在生产**未关闭**:`OPENCODE_DISABLE_PROJECT_CONFIG` 只出现在一份测试用例的 env 里 | `packages/opencode/src/config/config.ts:425-429`;ADR-040 后果 4 已登记为上游边界 |
| **F6′** | **`~/.opencode/opencode.json(c)` 被引擎无条件合并**:`ConfigPaths.directories` 从 HOME 自身找 `.opencode`,**不受** `OPENCODE_DISABLE_PROJECT_CONFIG` 门控;`~/.opencode` 是围栏可写集 W16;默认拒绝名单不枚举它 | `packages/opencode/src/config/paths.ts:23-40`;`process-fence-profile.ts:62`;`mcp-default-deny.ts:19` |
| F7 | 项目 `.code-puppy/plugins/*.js` 在引擎进程内 `import()`,门 = `.code-puppy/prefs.json` 的 `extensionsConsent.granted`(**整项目一次性**,不按文件) | `packages/ext/src/plugin.ts:412-425`、`:432-449` |
| F8 | `alpha_register type=mcp` 写项目 `alpha.jsonc`,受同一条 consent 门 | `plugin.ts:274-345` |
| F9 | 普通 MCP 密钥 = `<userData>/alpha-mcp-secrets/...` 0600 明文(W3,引擎可读可写);官方连接器运行期解密到临时目录 | 地面真相 §4;`official-connector-resources.ts:214` |
| F10 | 目录缓存 `<userData>/remote-catalog.json` 在 W3,引擎写得了;main **读回重验签名**,伪造的缓存进不了已验 catalog | 地面真相 §1(`remote-catalog.ts:48`) |
| F11 | 出厂技能 `customize-code-puppy` 今天教:全局改动「直接编辑 `$ALPHA_GLOBAL_DIR/alpha.jsonc` 再 `alpha_reload`」(`:34-35`);「套件 = MCP + 技能 + 插件」(`:55-57`);「插件必须是自包含 ESM」(`:70`)。其它出厂技能只教写**项目** `alpha.jsonc`(`alpha_register`)和 `$ALPHA_GLOBAL_DIR/skills/<name>/SKILL.md`(`agent-creator/SKILL.md:70`、`integrate-project/SKILL.md:22`),**没有任何出厂技能教引擎直接写全局 `alpha.jsonc` 的其它键** | `packages/ui-mac/resources/factory-skills/*/SKILL.md` |
| F12 | 引擎自己的配置写接口不碰 `alpha.jsonc`:`Config.update` 写 `<instance dir>/config.json`,`updateGlobal` 写 XDG 的全局文件 | `config.ts:644-662` |

### 1.6 写通道表之外会改账本的生产者

`GATED_WRITE_CHANNELS` 的权威范围是 renderer 通道(`ext-write-channels.ts:1-8`)。表外会改账本 / 账本投影的生产者,逐一核过:
`ext-trust-check`(renderer 打开项目时触发**项目账本 v1→v2 收编**,`ext-ipc.ts:486-501` → `ext-project-adopt.ts:47-53`)、
boot reconcile(启动期归位,`ext-boot-reconcile`)、恢复闸(`ext-recovery-gate`)、journal retire(`JOURNAL_ADMIN_CHANNELS`,刻意的表外例外)、
CAS GC(只删内容不改账本)。直接调用账本写原语的文件:`alpha-installs.ts`、`alpha-office-instance.ts`、
`ext-install-planner.ts`、`ext-skill-generations.ts`、`ext-uncurated-record.ts`、`ext-receipt-v2.ts`
(`grep -rln "upsertRecordV2(\|writeLedgerV2(\|writeLedger("`)。

## 二、选定方案与被否决的替代

**一句话:主进程是唯一权威;agent 只发请求、只读结论;确认框是定制中心自己的那一个;
ext ↔ main 之间只多一族 `parentPort` 窄消息,不开任何网络端点、不加宽围栏。** 对基线要求的反问
「能不能让主进程成为唯一权威,agent 只发请求」—— **能,而且这正是最简解**:安装的权威今天已经在 main
(renderer 只运输 `catalogId` + grants,main 从已验 catalog 重新派生一切),缺的只是「agent 怎么把请求递到
那个确认框」和「agent 怎么读到 main 的结论」。前者用引擎自己的审批请求当运输;后者用 sidecar 已有的
parentPort 请求/应答,由 main **即时**回答(不再有任何引擎可写的中间文件参与)。

### 2.1 三个 agent 工具的输入输出

工具文字全部登记进 `TOOL_TEXT`(1.2)。三个工具**都没有密钥类型的字段**;视图一律按
**当前会话的目录**(`ctx.directory`)取,安装行带 `(id, scope)`。

| 工具 | 输入 | 输出 | 数据来源 |
| --- | --- | --- | --- |
| `hub_search` | `query: string`(关键词或用途;空串 = 全部) | 匹配条目列表,每条:`id`、`scope`(global / project / 未安装)、显示名、类型、一句话说明、`installed`、`enabled`、`state`(四态,见 2.5)、`stateReason?`、`authorization`(`none` / `secret:<VAR,…>` / `mcp-oauth` / `platform-login`)、云能力的 `priceNote`(**只在目录提供时出现**;缺席就没有这个字段,并在输出末尾固定一句「本目录尚未提供价格说明;费用以服务端为准」—— 这句是如实报告缺项,**不**算 AC1 的价格部分已满足,见 §4 C5) | main 即时回答(2.2) |
| `hub_install` | `catalogId: string` | 七种之一,逐字固定:`declined`(用户拒绝)/ `installed; reload pending`(已落盘,待重载)/ `installed; available`(本目录已核验可用)/ `installed; disabled by policy`(按审核策略装完即停用,不承诺可用)/ `submitted; result pending`(用户已确认、主进程还在提交或结果未知,**不是拒绝**)/ `not installed: no confirmation box ran`(请求被规则自动放行、确认框根本没出现;见 I3)/ `unknown entry`。外加一句固定提示「显示可用以后,下一条消息就能用;不会在本条回答里生效」 | `ctx.ask` 运输 + 事后按 `requestId` 向 main 查本次请求的结局(2.3) |
| `hub_status` | `catalogId: string` | 同 `hub_search` 单条;`reload-pending` 时带 main 记录的原因(`waiting: N session(s) busy` / `last reload failed: <reason>` / `not loaded in this directory: <reason>`) | main 即时回答 |

`hub_install` **不在当前回答里等重载**(约束 5;等重载会和当前回答互相等,见被否决的 D)。
`process.parentPort` 取不到(CLI / 测试宿主)⇒ 三个工具一律回「定制中心在本引擎宿主不可用」,不猜。

### 2.2 agent 读结论:parentPort 请求/应答,main 即时计算

沿用 `write-probe` 的形制(1.2):一份合同、两侧共用;请求带自增 `id`、应答按 `id` 结算、超时与
子进程退出都答「无法判断」。本票新增的消息族(**穷举,未知 type 两侧都忽略**):

| 方向 | type | 载荷 | 处理 |
| --- | --- | --- | --- |
| ext → main | `alpha.hub.view.request` | `{ id, directory, query? }` | main 即时算视图(下文),回 `alpha.hub.view.reply { id, view | error }` |
| ext → main | `alpha.hub.request.request` | `{ id, requestId }` | main 回该次安装请求的阶段(2.3) |
| ext → main | `alpha.reload.report` | `{ generation, scope, outcome, directories, error? }` | main 记录并核验(2.5、2.6) |
| main → ext | `alpha.reload.request` | `{ generation, scope: "global" | { directory }, items, reason, force? }` | ext 调度器入队(2.6) |

- ext 侧:`process.parentPort.on("message")` 自己挂一个监听,只认 `alpha.*`;`sidecar.ts` 的 `parseCommand`
  对这些 type 返回 undefined、原样忽略(1.2),**两边都不改对方的分支**。
- main 侧:`server.ts` 现有的 `child.on("message")` 处旁挂一个 `alpha.*` 分发器,与 `writeProbes.receive`
  并列;sidecar 退出 ⇒ 全部在途请求结算为「无法判断」。
- **视图怎么算(main,即时,零缓存)**:已验 catalog 的可安装视图(`installableCatalogEntries`)∪ 该目录的
  安装行(`ext-inventory` 的 `collectInventory`:global 账本 + 该项目账本,行身份 `(id, scope)`)→ 对每一行按
  2.5 做目录作用域核验 → 组合成 `state / stateReason / authorization / priceNote`。没有任何中间文件,
  所以 1.6 那些表外生产者改了账本,下一次查询自然读到;main 重启后也不需要「首次重建」。
- **安全边界**:sidecar 进程里的任何 JS(含用户信任后的项目插件)都能发这些消息,所以 main 对它们的
  处理只有**只读查询**与**重载请求**(重载请求等价于今天 `alpha_reload` 已有的能力),没有任何一条能安装、
  启用或写盘;载荷严格校验,不合形状即丢弃并 log。

为什么不是投影文件(初版方案,已否决):它丢失 `(id, scope)` 与目录身份、依赖「每条写通道完成后刷新」
而 1.6 证明写通道表不是全部出口、main 重启后要首次重建 —— 三条都被 R1 第 6、9 条点中;而 parentPort
请求/应答是现成形制,main 即时回答天然没有这三个问题。

### 2.3 确认框:由谁弹、怎么把用户决定回传给工具

```
hub_install(catalogId)
  └─ requestId = 随机 id;ctx.ask({ permission:"hub_install", patterns:[catalogId], always:[],
                                     metadata:{ alphaHub:{ catalogId, requestId } } })
        │ 引擎:ruleset 判 → 发布 permission.asked(300 s 期限)
        ▼
  renderer 审批面订阅 permission.asked
        ├─ metadata.alphaHub 缺席 → 既有 PermissionDialog(行为一字不变)
        └─ metadata.alphaHub 在场 → 新的 hub-install 守望者接手(通用对话框不呈现它):
              ① 向 main 记 stage=confirming(IPC `ext-hub-request-stage`)
              ② 按 catalogId 在 renderer 的已验目录源里找到条目/包视图 →
                 弹**定制中心自己的安装确认框**(从 extension-hub.tsx 抽出的同一份确认 + authz 两阶段控制器;
                 标题多一行「由对话中的 agent 请求」;密钥仍在这个框的遮罩输入里填)
              ├─ 用户确认 → 记 stage=submitted → 既有出站:installCatalogIntent / installSkill / addMcp(→ IPC installCatalog)
              │       ├─ main 提交成功 → 记 stage=committed(main 侧由安装体自己记,带 (id, scope))
              │       │                 → 向 ext 发 alpha.reload.request → 回 permission reply `once`
              │       └─ main 拒绝 / 失败 → 记 stage=failed:<reason> → 框里显示原因 → 回 reply `reject`(message = 原因)
              └─ 用户取消 / 关闭 → 记 stage=declined → reply `reject`
                 300 s 无人应答 → 引擎自己广播 reject 回执,框随之收起;**守望者不记 declined**(已记的 stage 保持)
        ▼
  工具恢复(ask 成功、RejectedError、UnansweredError 三种都捕获)→ `alpha.hub.request.request { requestId }` →
  按 main 记录的 stage 返回 2.1 七种之一:
     committed → installed;… (按 2.5 的 state)      submitted → submitted; result pending
     declined / failed → declined(failed 带原因)      没有记录(ask 却成功了) → not installed: no confirmation box ran
```

- **回传载体有两层**:审批应答只负责「唤醒工具」;**结局以 main 记录的 `requestId` 阶段为准**。
  这就是 R1 第 8 条要的请求级关联:用户在期限内点了确认、IPC 还在跑、期限到了 —— 工具拿到的是
  `submitted; result pending`,不是「用户拒绝」;最终结果随后用 `hub_status` 查。阶段记录在 main 内存里
  (sidecar 一代之内有效;main 重启即失 ⇒ 查不到 = 「无法判断」,工具如实说)。
- 应答命令没有自由载荷(`PermissionDialog.tsx:19-30`),所以**结构上**不可能把密钥或别的东西顺手塞回工具。
- `always: []` + v1 适配器不投影 `save`(1.2)⇒ 没有「始终允许」;每一次安装都要一次确认(I7)。
- 守望者必须登记进呈现面唯一挂载判据(`permission-mount-ratchet.test.ts`、`permission-single-surface.test.ts`),
  通用对话框按 `metadata.alphaHub` 过滤 —— 否则同一个请求会弹两个框。
- **确认框一定会出现(R1 第 1 条)**:ext 的 `config` 钩子在每次实例重建时把 `permission.hub_install = "ask"`
  钉到 `cfg.permission` 末位,并对 `cfg.agent[*].permission` 逐个钉到末位(先例 `applyWebSearchDenies`,1.2);
  无人值守的自动化 agent(`alpha-automation*`,「零 ask 硬前提」)钉 `deny`。用户配置里写 `hub_install: allow`
  也压不过它(findLast)。I3 仍保留为纵深:万一规则把它放行了,也不会有任何安装发生。
- 审批面按当前路由的会话取请求(1.2)。agent 的请求发生在用户正在看的那个会话里(用户刚发的消息),
  与今天 bash / webfetch 的审批可见性**完全相同**,本票不新造跨会话呈现。

### 2.4 密钥只在确认框输入:证明它不进工具参数、返回值、会话记录

| 位置 | 内容 | 判据 |
| --- | --- | --- |
| 工具参数 schema | `hub_install` 恰好一个参数 `catalogId: string`;`hub_search` / `hub_status` 同样只有字符串标识 | 测试:三个工具的 zod schema 键集合精确相等,且不存在任何名字含 `secret / token / key / password / dsn` 的字段 |
| 工具返回值 | 2.1 的固定字符串 + 视图字段(只含变量名) | 测试:返回值里不含视图之外的任何字节 |
| parentPort 消息 | 视图与请求阶段(2.2)—— 只含变量名、状态、原因 | 测试:main 侧应答构造器对含密钥值的输入夹具输出零命中 |
| 会话记录 | 工具 part(参数 + 输出)+ `permission_request / permission_decision`(`metadata = { alphaHub:{catalogId, requestId}, alphaRisk }`、`decision`) | 打包 RC e2e:用一个金丝雀密钥值安装一个带 `requiredEnvVars` / prerequisite 的条目后,在会话消息、审批表、ext 日志、parentPort 消息日志里 grep 该值 ⇒ **零命中**;对照组:同一 grep 在 `<userData>/alpha-mcp-secrets/` 或 `connector-secrets/` 的落点上**必须命中**(证明 grep 本身能看见它) |
| 密钥的真实路径 | 确认框 → `extIpc.installCatalog({ grants:{ secrets } })` → main `{file:}` 落盘 —— **与今天定制中心的路径逐字相同**(`use-extensions.ts:653-676`) | 不新增任何密钥通道 |

### 2.5 三档状态:权威、作用域与核验判据

| 状态 | 含义 | 由谁判定 | 怎么得出(**都按查询时的目录**) |
| --- | --- | --- | --- |
| `not-installed` | 目录里有,本机(该作用域)账本无 | main(账本) | `ext-inventory` 该目录视图里没有安装行 |
| `installed` | 账本已落盘(`desiredState` 任意);若 `disabled` 则 `enabled:false`,工具说「装完即停用,不承诺可用」 | main(账本) | 安装行存在 |
| `reload-pending` | 已落盘且 `enabled`,但该目录的引擎实例里还没核验到:排队中(等会话空闲)、上一次重载失败、或重载过了但核验没过(带原因) | main(调度记录 + 即时核验) | 有在途 generation ⇒ `waiting…`;最近一次 report 失败 ⇒ `last reload failed`;否则即时核验未过 ⇒ `not loaded in this directory: <reason>` |
| `available` | **本目录**的引擎实例里核验通过(下表) | main(即时核验) | 见下表 |

核验判据按种类(全部带 `directory`,全部可失败;**核不了 = 不标 available**,原因写进 `stateReason`):

| 种类 | `available` 当且仅当 |
| --- | --- |
| MCP(global) | `mcp.status({directory})[name].status === "connected"` |
| MCP(project) | 复用 `probeProjectMcpActivation(name, directory)` = `"active"`(耐久叶 + 未被全局遮蔽 + 有效配置逐字相等 + 该目录 connected) |
| cloud | 收据在 ∧ 本轮 fork 云 MCP 以 `enabled:true` 注入(`platformPays`)∧ `mcp.status({directory}).cloud === "connected"` ∧ `GET /experimental/tool/ids?directory` 含该条目对应的云工具 id(条目 `pipelineKind` → `cloud_dispatch` 等,映射表来自 `cloud-contract-hook.ts` 已登记的 9 个工具) |
| skill | `GET /skill?directory` 列出同名且 **`location` 落在 main 为它安装的 generation 目录之下**(身份,不只名字)∧ 权限不拒:ext 在 `config` 钩子里留存本实例合并后的 `cfg.permission.skill` 与 `cfg.agent[<ctx.agent>].permission.skill`,只解释**精确名**与 `*` 两种 pattern(任何其它 glob ⇒ `unverifiable`,不标 available);会话自带 permission ruleset(`session.permission` 非空)⇒ `unverifiable`。**不**在 ext 里重写上游的通配文法 |
| agent | `GET /agent?directory` 列出同名且 `disable !== true` |
| command | `GET /command?directory` 列出同名 |

- **权威只有一个:main。** 定制中心已安装列表与 agent 工具读的都是 main 对同一个 `(id, scope, directory)`
  即时算出的同一档(定制中心经新 IPC `ext-hub-view` 读,ext 经 parentPort 读),AC3 的「一致」是结构性的。
- 定制中心今天对 MCP 另有实时的连接状态徽标(来自引擎 `mcp.status`),**保留**;本票的「可用」对 MCP 就是它。
- 「下一条消息可用」只对 `available` 承诺(约束 5)。`available` 判的是「这个目录的实例已加载/已连上且本会话
  的配置级权限不拒」;它**不**替代调用那一刻的 `ctx.ask`(技能工具自己仍会问一次,`tool/skill.ts:26-31`)。

### 2.6 统一重载调度:执行者是 ext,main 是请求方与记录方

**执行者只有一个:ext 进程内的模块级调度器**(`packages/ext/src/reload-scheduler.ts`;插件模块一个引擎进程
一份,`plugin.ts` 注释已登记这个事实)。理由:它在引擎进程里,能对**每个**实例直接查 `GET /session/status`
(权威,不靠 SSE 快照/重放,R1 第 4 条);`alpha_reload` / `alpha_register` 本来就在这里;其余入口全部改成
「请 ext 重载」。

- **实例登记**:每次 `AlphaExt(input)` 初始化登记 `{ directory, client }`;重建覆盖同目录旧项;
  `session.status()` 调不通的项视为已消失。
- **入队**:`request({ scope, items, reason, generation, force? })`,来源三种 —— ① `alpha_reload` / `alpha_register`
  (进程内);② main 经 `alpha.reload.request`(定制中心按钮、安装体、信任门/外部导入、`refreshProjectEngine`
  的目录作用域,**全部**先走新 IPC `ext-reload-request` 到 main);③ 用户在定制中心点「现在重载(会打断正在
  输出的回答)」⇒ `force:true`。同 scope 的请求合并成一次 dispose。
- **决定**:收到任一实例的 `session.status` 事件或任一请求时,若队列非空 ⇒ 逐实例查 `session.status()`
  (global:全部实例;directory:该实例)⇒ 全空闲 ⇒ **再查一次**(把「查到 dispose」的窗口压到同进程一次 HTTP
  往返)⇒ `global.dispose()` 或 `instance.dispose({directory})` 一次 ⇒ `alpha.reload.report`。
- **失败**:dispose 失败 ⇒ 保留队列、report 失败、下一次 idle 事件再试,连败 3 次停止自动重试(状态不变,
  原因「需要重启应用」);**绝不**降级成「可用」。
- **一直忙**(> 5 min 仍有会话 busy):只记日志、继续等;不强行打断(约束 4);用户要立刻生效走 `force`。
- **sidecar 重启**:队列随进程消失;main 在 sidecar ready 时把它记录中仍是 `reload-pending` 的 generation
  重新发一次 `alpha.reload.request`(幂等)。
- **main 的记录**:每个 generation 的 `requested / reported / verified` 三个时间点与结果;状态不持久化
  (main 重启 ⇒ 即时核验说了算,见 2.5)。
- **登记的接口缺口(R1 第 4 条)**:引擎没有「暂停会话准入」的接口(1.4),「两次查空闲 → dispose」之间
  仍可能有新回合被准入;后果是那一条回复像 X9 实测那样被打断(`plugin.ts:43-46`)。本票**不**假装这条窗口
  不存在:V1 要在重载进行中发一条消息,记录实际表现;若不可接受,下一步是向引擎加准入屏障 ——
  那是 `UPSTREAM_PATHS` 下的改动,按 ADR-029 另立票,不在本票。

旧的三处执行者的去向(R1 第 5 条):`plugin.ts:376-408` 的 idle 钩子 ⇒ 并入本调度器(保留「等空闲」语义,
改为查全部会话);`use-extensions.ts:1000-1024` `refreshProjectEngine` ⇒ 改发 `ext-reload-request { directory }`
再等 main 的 `ext-hub-view-changed` 通知;`ext-trust-watcher.tsx:49-61` 两处 `global.dispose()` ⇒ 同上
(global);`ext-mcp-activation.ts:184-228` `reloadInstalledMcp` ⇒ 只保留核验那一半(2.5),不再 dispose。
归属:前两处与 trust-watcher 在 C1,`plugin.ts` 在 C3。

### 2.7 `customize-code-puppy` 技能改写要点(AC5)

- 继续默认开启(`factory-skills.ts:47-55`);`customize-opencode` 的隐藏/永久禁用/占位指向归 `#1522`,本票不碰。
- **删**:「全局改动直接编辑 `$ALPHA_GLOBAL_DIR/alpha.jsonc` 再 `alpha_reload`」(F11)—— 这正是要堵的旁路,
  技能不能再教(C2 之后这样写也会被围栏拒);「套件 = MCP + 技能 + 插件」改为「技能 + agent + 命令 + 连接器」;
  「从目录装插件」的任何措辞。
- **加**:定制中心有哪些类型;缺能力先 `hub_search`;要装就说明装什么、为什么,用 `hub_install` 请用户在
  **软件弹出的确认框**里同意;需要密钥时让用户在框里填,**绝不在聊天里要、绝不替用户编造或猜测密钥**;
  装完告诉用户「显示可用以后,下一条消息就能用;不用重启」;`submitted; result pending` 与 `reload-pending`
  用 `hub_status` 查、不反复重试安装;`alpha_register` 只用于项目作用域、且可执行连接器要过项目信任门。
- **如实讲信任边界**:项目里的 `.code-puppy/plugins/*.js` 在用户信任该项目后**会被加载并以引擎同等权限执行**,
  信任是整项目一次性的;目录里的可执行插件被拒装(ADR-040)。
- 判据(技能内容测试):断言必须出现的句子(三个工具名、「确认框」、「不在聊天里要密钥」、「下一条消息」、
  信任边界那句)与**必须不出现**的句子(直接编辑 `alpha.jsonc`、`plugin` 作为套件成员、从目录装插件);
  改掉任一句测试即红。

### 2.8 被否决的替代

| # | 替代 | 否决理由 |
| --- | --- | --- |
| A | ext 直接读账本 / 目录缓存算视图 | 重写 ui-mac 的解码器;账本与缓存都在引擎可写集,一致性没有判据 |
| B | main 开一个 loopback HTTP 控制端点供 ext 调用 | 围栏只放行代理端口(`N4`),代理只做 CONNECT;要么给围栏加一行(安全咽喉),要么让策略代理兼做控制面;再加鉴权与新服务器 —— parentPort 是现成的、不经网络、不受围栏网络规则影响的同等通道 |
| C | 用引擎的 `question` 工具 / 路由当确认框 | 没有遮罩密钥输入;没有审批那套期限、回执与持久化;呈现在上游 `packages/app/src/pages/layout.tsx`,改它要走 ADR-034 补丁 roundtrip |
| D | `hub_install` 同步等到重载完成再返回 | 死锁:调度器等本会话空闲,本会话等这个工具返回(目标架构 §2.6、R1 第 7 条已否) |
| E | 把确认做成通用 `PermissionDialog` 的 once / reject | 没有密钥输入,AC2 做不到;而且确认之后仍得有人去调安装 |
| F | agent 写 `alpha.jsonc` 装 MCP(今天技能教的) | 就是要堵的旁路本身 |
| G | main 做重载执行者,用 `/global/event` 维护忙集 | 该流没有初始快照与断线重放(1.2),漏 busy 就误重载、漏 idle 就永远等;去抖不是互斥(R1 第 4 条) |
| H | 投影文件(main 写、ext 读;初版方案) | 丢 `(id, scope)` 与目录身份、依赖写通道表覆盖全部账本变更(1.6 证伪)、main 重启要首次重建(R1 第 6、9 条) |
| I | 本机 MCP 记录搬进独立真源文件(目标架构 §2.6 的字面做法) | 真实写入点是事务(1.1):要给事务加第二个根外 target、改 `ext-transaction` 的圈禁、`ext-config-tx` 的 image、planner/tx-builders/卸载/启停/恢复/boot reconcile 全套 —— 换来的不变量,用「`alpha.jsonc` 收紧出可写集 + ext 重建时治理」更少的改动就能得到,而且后者还顺带堵住 `~/.opencode`(F6′)这条同类路。保留为 C2 的**回退方案**(§4) |
| J | 文件轮询 / `fs.watch` 作 ext → main 请求通道 | 请求目录在引擎可写集里,引擎树任何进程都能刷请求;轮询与竞态 |

## 三、安全面

### 3.1 整类安装旁路与边界

| # | 旁路 / 边界 | 今天 | 本方案后 | 处置 |
| --- | --- | --- | --- | --- |
| S1 | agent 写全局 `alpha.jsonc` 的 `mcp.<name>`(本地 type)再触发重载 ⇒ 引擎起一个持久的、**定制中心看不见**的可执行连接器(F1–F4) | 成立 | ① `alpha.jsonc` 从围栏可写集里收紧出去(W2 之内对该文件单独 `deny file-write*`,只收紧不放宽);② ext 的 `config` 钩子在每次实例重建时对**最终合并的 `cfg.mcp`** 做治理:只保留 main 所有的来源(`alpha.jsonc` 自己的键、远程真源记录、云 MCP 定义、它自己经信任门合并的项目条目),其余一律 `enabled:false` + 一行原因 | C2(D1 已采 A) |
| **S1′** | 同上但写 `~/.opencode/opencode.json(c)`(W16,引擎写得了,被引擎无条件合并,默认拒绝名单不枚举它;F6′) | **成立,此前未被点名** | 被 S1 的 ② 同一条规则压住(它不是 main 所有的来源) | C2 |
| S2 | 写 `alpha.jsonc` 的 `mcp.<name>`(remote) | 已堵(`#1381`) | 不变;且 ② 使它在重建时也生效(不只 fork 时) | C2 |
| S3 | 写 `plugin[]` | 已堵(F5,ADR-040) | 不变 | — |
| S4 | 写用户全局 XDG `~/.config/opencode/*.json` 的 `mcp` | 已默认拒(`#535`) | 不变;改由 ② 在重建时执行 | C2 |
| S5 | 写 `<project>/opencode.json(c)` / `.opencode/` 让上游原生加载 MCP / 插件(F6) | 上游行为,未关 | **MCP** 部分被 ② 压住;**插件 / agent / command** 部分不变 | 登记为已知边界(ADR-040 后果 4 同类);关它 = `OPENCODE_DISABLE_PROJECT_CONFIG`,会同时关掉用户自己的项目配置,不在本票 |
| S6 | 项目 `.code-puppy/plugins/*.js`(F7)与 `alpha_register type=mcp`(F8) | 整项目一次性信任门 | 不变(目标架构 §2.6「项目范围的 `alpha_register` 保留」) | AC5 如实讲;**不承诺**按文件/按次确认 |
| S7 | shell 直接运行任意程序 | 由 `#1413` 权限分层把关 | 不变 | 它不是「安装」:不持久、不进工具表、不出现在定制中心;AC2 管的是受管安装 |
| S8 | 确认框被规则放行替代:默认 `*: allow`(1.2)本身就让 `ctx.ask(hub_install)` 直接返回;agent 还能往 `alpha.jsonc` / `~/.opencode` 写 `permission.hub_install: "allow"` | **默认配置下就不弹框**(R1 第 1 条) | ext 重建时把 `hub_install: ask` 钉到全局与每个 agent 的末位(2.3);即便被绕过,安装**只**由 renderer 守望者在呈现确认框并被点击之后发起 ⇒ 没有框 ⇒ 没有安装 ⇒ 工具按 `requestId` 查不到记录 ⇒ 如实返回 `not installed: no confirmation box ran` | I3、I9 |
| S9 | renderer 自动放行总闸 / 「始终允许」 | 总闸默认关;v1 无「始终」按钮 | `always: []`;自动应答只作用于审批通道,同样「没有框 ⇒ 没有安装」 | I3、I7 |
| S10 | 合成点击 / 无障碍自动化点确认框 | OS 级,任何对话框同样 | 不在本票 | 如实不承诺 |
| S11 | 提示注入诱导 agent 调 `hub_install` | — | `catalogId` 由 main 从已验签 catalog 重新派生(`ext-ipc.ts:1189-1194`),装不了目录外的东西;用户在框里看到来源与权限;伤害上限 = 「装了一个用户当场同意的、经签名与审核的条目」 | I8 |
| S12 | sidecar 进程里的任何 JS 向 main 发 `alpha.*` 消息 | — | 只有只读查询与重载请求(2.2);不能安装、不能写盘 | I6 |
| S13 | 伪造目录缓存 | — | 缓存读回重验(F10) | — |
| S14 | 运行时密钥对 agent 可见(F9) | 可见 | 可见 | **不承诺**(约束 2) |
| S15 | 伪造 `ext-store/skill--*/current.json` 让引擎加载一份引擎自己写的技能(W2) | 成立 | 不变 | 提示注入面、不是可执行面;本票只堵可执行安装旁路,如实登记 |

### 3.2 实现必须守住的不变量(咽喉点形态;每条由子票各自落判据)

- **I1 受管安装唯一通路**:到达账本与引擎 MCP 表的唯一通路是 main 的 gated write channel 表
  (`ext-write-channels.ts`)写 `alpha.jsonc`(围栏内写不到它)+ ext 重建时只保留 main 所有的来源;agent 侧
  `hub_install` 只能到达 `ctx.ask`;**其余**(引擎树写进 `alpha.jsonc` 的任何键、`~/.opencode` / XDG / 项目
  `.opencode` 里的 MCP)要么被内核 EPERM,要么在重建时 `enabled:false` + 一行原因。判据端到端、**同一进程**:
  ① 围栏内对 `alpha.jsonc` 写 ⇒ EPERM(真 `sandbox-exec`,同 `process-fence-apply.test.ts` 形制);
  ② 围栏内往 `~/.opencode/opencode.jsonc` 写一条 MCP 并 dispose ⇒ `mcp.status` 里它不是 connected、日志有那一行;
  ③ **同进程启动后**经定制中心装一条本地 MCP 并 dispose ⇒ connected;④ 启动后新增的名字(非 main 来源)⇒ 压住。
  删掉 ② 的治理 ⇒ 用例红。
- **I2 密钥零进入引擎**:三个工具的参数 schema 键集合精确为 `{catalogId}` / `{query}`;审批应答命令无自由
  载荷;parentPort 应答与视图不含密钥值(金丝雀测试,2.4)。
- **I3 确认框不可被规则放行替代**:安装只能由 renderer 守望者在呈现确认框并被用户点击后发起;
  把 ext 的 `hub_install: ask` 钉子拿掉(变异)⇒ `ctx.ask` 直接返回 ⇒ 账本零变化、工具输出为
  `not installed: no confirmation box ran`。
- **I4 三档状态唯一权威**:定制中心与 ext 读 main 对同一 `(id, scope, directory)` 的同一档;同一夹具两侧同档;
  核验失败两侧都是 `reload-pending` 与同一原因。
- **I5 重载不打断(有登记的窗口)**:任一实例 `session.status()` 非空 ⇒ 零 dispose;全空 ⇒ 对 N 个排队项恰好
  一次 dispose;判据用**真实例**的 `session.status`(造一个 busy 会话),不用假事件流;「查到 dispose 之间的准入」
  是登记在案的接口缺口(2.6),不在本判据里假装覆盖。
- **I6 parentPort 消息族封闭**:main 对 `alpha.*` 的处理只有只读查询与重载请求;未知 type、形状不对 ⇒ 丢弃 + log;
  sidecar 退出 ⇒ 在途请求全部「无法判断」。
- **I7 每次安装一次确认**:`always: []`;回复 `always` 不产生任何能抵消后续 `hub_install` 的 grant。
- **I8 只认签名目录**:视图只含可安装视图 ∪ 已安装;`hub_install` 对不在已验 catalog 里的 id 由 main 拒绝。
- **I9 请求级关联**:`requestId` 由 ext 生成、随 `metadata` 进审批请求、由 renderer **先**记阶段**再**回复审批;
  `submitted|committed` 之后的超时或 reject 回执**不得**被报成「用户拒绝」。
- **I10 可写集只收紧**:C2 对围栏的改动只有一条针对 `alpha.jsonc` 的 `deny`;18 条静态行与 W1 规则不变;
  `process-fence-write-sites.tsv` 里 sidecar 对 `alpha.jsonc` 的写(seed)迁到 main、登记为 `main-only`。

## 四、子票切分

| 子票 | 边界(具体文件) | 负责 AC | 不做 | 退出条件 | 规模 |
| --- | --- | --- | --- | --- | --- |
| **C1 `[CODE]` 重载请求面 + 三档状态 + 视图计算**(main 为主) | 新 `packages/ui-mac/src/main/hub-view.ts`(按 2.5 即时算 `(id, scope, directory)` 的档与原因,复用 `ext-inventory`、`probeProjectMcpActivation`、引擎目录作用域清单接口)与 `reload-coordinator.ts`(generation 记录、sidecar ready 时重发);新 `alpha-sidecar-messages.ts`(2.2 消息合同,两侧共用,形制同 `workspace-write-probe.ts`);`server.ts`(`child.on("message")` 旁挂 `alpha.*` 分发);`ext-ipc.ts`(新 IPC `ext-reload-request`、`ext-hub-view`、`ext-hub-request-stage`;安装体成功后发重载请求而不是 dispose);`ext-mcp-activation.ts`(`reloadInstalledMcp` 只保留核验);`ext-write-channels.ts`(`ext-reload-request` 登记;两条只读/记阶段通道仿 `LOCAL_PACKAGE_READ_CHANNELS` 登记为表外只读并在测试里断言互斥);renderer `use-extensions.ts`(22 处 `refreshEngine()` 与 `refreshProjectEngine` 改走 IPC,`refreshEngine` 只剩「现在重载」)、`ext-trust-watcher.tsx:49-61`(改走 IPC)、`extension-hub.tsx` / `extension-detail.tsx`(已安装列表显示四态 + 原因 + 「现在重载」);`index.ts`(`ext-hub-view-changed` 推送);登记 `scripts/gate-files.tsv`、`scripts/process-fence-write-sites.tsv` | AC3;AC4 的前提 | ext 侧调度器(C3)、工具、技能、围栏收紧 | I4、I6、I9(main 半边)判据绿;与 C3 联调后 I5 绿 | L |
| **C2 `[CODE]` 堵 S1 整类:`alpha.jsonc` 收紧出可写集 + ext 重建时治理 `cfg.mcp`** | **第一步(前置验证,结论写进票面)**:用真 `sandbox-exec` 证明在现有 profile 的 allow 块之后追加 `(deny file-write* (literal "<alphaGlobalRoot>/alpha.jsonc"))` 能拒掉该文件、不影响同目录其它路径;证伪 ⇒ 切到回退方案(2.8 I,规模 L,范围:`ext-transaction.ts:673-678` 圈禁、`ext-config-tx.ts` image、planner `:951 / :1270-1278`、`tx-builders :352-364`、卸载、`set-state`、恢复 `isFlipped / reconstruct / restore`、boot reconcile)。**主体**:`process-fence-profile.ts`(一条 deny 行 + 逐行断言)、`alpha-config-injection.ts:85-92` 的 `{$schema}` seed 迁到 main fork 前(`server.ts`)、`process-fence-write-sites.tsv` 第 11/18 行;`mcp-default-deny.ts` 与 `mcp-server-truth.ts`(读端)**迁入** `packages/ext/src/`,ext `config` 钩子在每次重建时执行治理(3.1 S1 ②,远程真源路径与 `alpha.jsonc` 路径经 fork 时 env 交给 ext),main 的 fork 时注入不再碰用户 MCP(云 MCP 定义照旧);旧 `alpha.jsonc` 内容**原样保留**(它一直是 main 信任的文件;收紧的是以后谁能写它) | AC2 的「唯一通路」半边(I1、I10) | 项目作用域、密钥存储、S5 的插件/agent 部分 | I1 四条端到端判据绿(含「同进程启动后安装」与「启动后新增名字」);真机:围栏内 `echo >> alpha.jsonc` 得 EPERM;定制中心重装一次本地 MCP 后行为与改前一致 | **L**(主体 M;前置验证失败则按回退方案 L) |
| **C3 `[CODE]` 三个 agent 工具 + 确认框接线 + ext 调度器** | `packages/ext/src/plugin.ts`(3 个 tool;`hub_install: ask` 钉子;`alpha_reload` / idle 钩子并入调度器)、新 `reload-scheduler.ts`(2.6)、新 `hub-bridge.ts`(parentPort 请求簿记,ext 侧)、`context-injection.ts`(`TOOL_TEXT` + 快照重生);renderer 新 `alpha-ui/hub-install-watcher.tsx`;从 `extension-hub.tsx` 抽出安装确认 + authz 两阶段控制器为可复用模块(Hub 与守望者共用**同一份**);`permission-watcher.tsx` 按 `metadata.alphaHub` 分流;`permission-mount-ratchet.test.ts`、`permission-single-surface.test.ts` 登记新消费者 | AC1(价格部分除外,见 C5);AC2 的确认框与密钥半边(I2、I3、I7、I8、I9);AC3 的 agent 侧;AC4 | 新 IPC 写通道(复用既有 `installCatalog`);任何网络通道 | I2、I3、I5、I7、I9 判据绿;2.4 的金丝雀 e2e 绿且对照组红;默认配置下真 `Permission.ask` 发布请求(同 `alpha-composer-tiers.test.ts` 形制) | L |
| **C4 `[CODE]` `customize-code-puppy` 改写 + 内容测试** | `packages/ui-mac/resources/factory-skills/customize-code-puppy/SKILL.md`;`factory-skills.test.ts`(新增 2.7 的正反断言);涉及文案则 `visible-brand-copy.test.ts` | AC5(`customize-opencode` 部分引用 `#1522`) | 技能之外的任何代码 | 内容测试绿;反向:删掉任一必含句或加回任一禁句即红 | S |
| **C5 `[CODE]` `hub_search` 透传价格说明** —— **依赖 REQ-235(`alpha-work#114`)交付 `cloud` 档案的价格说明字段** | `hub-view.ts`(字段透传)、`context-injection.ts`(工具描述提及)、测试:带价格说明的夹具条目 ⇒ 输出含它;不带 ⇒ 没有该字段且末尾固定缺项句 | **AC1 的价格部分**;AC1 整体只能在 C5 之后判 PASS | 定义价格字段本身(归 REQ-235) | 对线上目录里**至少一条**真实带价格说明的云条目实测透传 | S |
| **V1 `[VERIFY]` 打包 RC 对话记录** | 打包 RC;owner 本机;记录:`hub_search` → `hub_install` → 确认框(含一次密钥输入)→ 「可用」→ 下一条消息调用成功;2.4 的 grep 正反两组;**重载进行中发一条消息**,记录 2.6 登记的窗口的实际表现 | AC2 e2e、AC4 | — | 记录进 `docs/verification/` | S(需要 owner 动手) |

**先后与冻结面**:C1 → (C2 ∥ C3) → C4 → C5(等 REQ-235)→ V1。C1 合并后冻结:2.2 的消息族与载荷、
四态状态词、`requestId` 的形状与阶段词(`confirming / submitted / committed / failed / declined`)、
`ext-reload-request` 的 IPC 形状;C3 不得新增写通道。C2 与 C3 互不依赖,但**对外说「确认框是唯一安装通路」
必须等 C2 合并**;C2 第一步证伪而走回退方案时,C3 的工具描述与技能文案先按「主要通路」措辞。
AC1 的验收顺序:C3 合并 ⇒ AC1 除价格外的部分;C5 合并且线上目录有带价格说明的云条目 ⇒ AC1 整体。

## 五、D1 的裁决与代价(已裁决)

**D1 —— 本机 MCP 的旁路要不要堵:已按已批方案目标架构 §2.6 采 A(堵)**(编排器 2026-10-14 代为采纳)。
机制上本基线选「`alpha.jsonc` 收紧出围栏可写集 + ext 重建时治理 `cfg.mcp`」而不是 §2.6 字面的「本机 MCP
真源文件」,理由见 2.8 I 与 R1 第 2 条;字面做法保留为 C2 的回退方案。保留代价说明如下:

| 代价 | 内容 |
| --- | --- |
| 行为变化 | 升级后,围栏内的任何进程(引擎、bash、MCP 子进程、项目插件)写全局 `alpha.jsonc` 得 EPERM;`~/.opencode` / XDG / 项目 `.opencode` 里的 MCP 条目在每次实例重建时被压成 `enabled:false` 并记一行原因(XDG 那一类今天已如此) |
| 对现有文件 | `alpha.jsonc` 现有内容**原样保留**(不迁移、不清洗):它一直是 main 信任的文件,收紧的是以后谁能写它;用户用自己的编辑器改它仍然可以(编辑器不在围栏内) |
| 对出厂技能 | `customize-code-puppy` 里「直接编辑全局 `alpha.jsonc`」的教学必须删(C4);其它出厂技能只教写项目 `alpha.jsonc` 与 `$ALPHA_GLOBAL_DIR/skills/`(F11),不受影响 |
| 不可逆性 | 可逆:去掉那一条 deny 行即回到今天 |
| 不采 A 时 | 确认框不是唯一通路;技能与工具描述只能说「主要通路」;S1 / S1′ 对所有用户长期开着 |

本轮**没有**新的待 owner 裁决点。需要 owner **知情**的残留:2.6 登记的「查空闲到 dispose 之间无准入互斥」窗口,
由 V1 实测其表现后再决定要不要开引擎侧的票。

## 六、仍是推断、没跑过的断言

1. seatbelt 对同一路径「先 allow(subpath)后 deny(literal)」的裁决是**后者赢**(现有 profile 依赖的是反向:先 `deny file-write*` 再 allow;C2 第一步用真 `sandbox-exec` 验,证伪则走回退方案)。
2. `process.parentPort` 在 ext 模块里可直接取到(ext 由引擎在同一 sidecar 进程里 `import()`,`sidecar.ts:297-301` 已在该进程上取到它);Electron 的 `parentPort` 作为 EventEmitter 允许多个 `"message"` 监听者并存。
3. `permission.asked` 的自定义 `metadata.alphaHub` 一路保留到 ui-mac 审批面(适配器 `:107` 透传;`permissionRequestFacts` 只核 `subject / action / resources / scope / expiry` 五个事实,`PermissionDialog.tsx:474`,没有实测过带 `alphaHub` 键的请求)。
4. 插件工具内 `await ctx.ask(...)` 抛出的 `RejectedError` / `UnansweredError` 可以在插件代码里捕获并返回正常输出,而不被 `session/processor.ts` 的 blocked 分支抢先标为失败(2.3 依赖它来返回七种固定结果;若不成立,改为让错误透传、把结局放进 `hub_status`)。
5. `GET /skill` / `/agent` / `/command` / `/experimental/tool/ids` 在 dispose 后的首次目录作用域调用会触发惰性重建并反映新内容(skill 有 S12 spike 的 100–300 ms 实测,`use-extensions.ts:979-983`;其余三条没实测)。
6. 一条经 `persistMcp` 加进真源的远程 MCP,在同一次 fork 内经历任何一次 `global.dispose` 后会从运行配置里消失、直到下次 fork(由 1.1 的三条事实推出:真源只在 fork 时进 `OPENCODE_CONFIG_CONTENT`、该 env 不变、live `mcp.add` 是 `InstanceState`;未真机复现)。C2 的 ext 重建时治理顺带修它。
7. 从 `extension-hub.tsx` 抽出确认框控制器后,Hub 自己的安装流程行为不变(纯重构,靠既有 Hub 测试兜底;文件 3000+ 行,抽取面要在 C3 方案里先画)。
8. 云条目「对应调用工具」的映射(`pipelineKind` → `cloud_dispatch` 等 9 个工具 id)与 `cloud-contract-hook.ts` 登记的工具表一致,且 `/experimental/tool/ids` 在该目录会列出 MCP 工具(没实测该接口对 MCP 工具的覆盖)。
9. `session.permission`(`tools.ts:156`)能经 SDK `session.get` 读到(2.5 技能核验据此判「会话自带规则 ⇒ unverifiable」;读不到就一律 unverifiable,方向更严)。
10. 价格说明:目录与服务端今天都没有该字段(实测);REQ-235 交付前 AC1 的价格部分无法满足,C5 与验收顺序据此排。

## 七、开发前对抗审计 R1 处置(2026-10-14,Codex gpt-6-astra,只读;预算:方案 ≤3 轮)

10 条,建议 REVISE;编排器逐条过第零问与三问后全部接受,本版逐条并入:

| # | 发现 | 处置 |
| --- | --- | --- |
| 1 | [Blocker] 默认 `*: allow` 下 `ctx.ask(hub_install)` 不弹框 | 接受。1.2 补默认规则事实;2.3 增 ext 重建时钉 `hub_install: ask`(全局 + 每个 agent,自动化 agent 钉 deny);S8 改写;I3 改为变异判据;C3 增「默认配置下真 `Permission.ask` 发布请求」用例 |
| 2 | [Blocker] C2 漏了真实写入路径(事务直接写 `alpha.jsonc`,事务拒根外 target) | 接受。1.1 补事务写入点四条坐标;C2 改为「`alpha.jsonc` 收紧出可写集 + ext 重建时治理」,事务生产者零改动;字面的真源文件做法降为回退方案并写明全部范围(2.8 I、§4 C2);规模改 L |
| 3 | [Blocker] 真源与拒绝名单只在 fork 时注入,dispose 不重注入 | 接受。1.1 补事实(含 live `mcp.add` 是 `InstanceState`);S1 ② 把治理搬进 ext `config` 钩子、每次重建执行;I1 判据加「同进程启动后安装」「启动后新增名字」两条;§6 第 6 条登记顺带修掉的远程 MCP 消失问题 |
| 4 | [Major] SSE 忙集无快照/重放,去抖不是互斥 | 接受。1.2 补全局流无快照事实、1.4 补无准入互斥事实;执行者改为 ext、按实例直接查 `session.status()`(2.6);G 列为否决;接口缺口登记在 2.6 与 I5,V1 实测窗口表现 |
| 5 | [Major] 仍有多个重载执行者;子票漏接入口 | 接受。执行者唯一化为 ext 调度器;2.6 末段逐处写明三处旧执行者去向与子票归属;采纳 parentPort 窄消息(1.2 补 `write-probe` 先例坐标),B 的否决理由相应改写 |
| 6 | [Major] 投影丢作用域 | 接受。放弃投影文件(2.8 H);视图按 `(id, scope, directory)` 即时计算(2.2),工具按 `ctx.directory` 取;项目 MCP 复用 `probeProjectMcpActivation`(2.5) |
| 7 | [Major] `available` 判据弱于 AC4 | 接受。2.5 逐种类改写:云条目核验该目录云 MCP 连接 + 工具 id;技能核验加载身份(generation 目录)+ 配置级权限(只解释精确名与 `*`,其余 unverifiable);核不了不标 available |
| 8 | [Major] 审批回执与安装结果无请求级关联 | 接受。2.3 增 `requestId` + 五个阶段 + 「先记阶段再回复」;工具按阶段返回,新增 `submitted; result pending`;I9;阶段词进冻结面 |
| 9 | [Major] 写通道表不是全部账本变更出口 | 接受。1.6 枚举表外生产者;视图改为 main 即时计算、零缓存,不需要刷新点也不需要首次重建;不加文件监听 |
| 10 | [Major] 价格说明未实现却算进 AC1 | 接受。1.3 补目录与服务端都没有价格字段的坐标;C3 的 AC1 覆盖改为「价格部分除外」;新增 C5 依赖 REQ-235(`alpha-work#114`);AC1 验收顺序写进 §4;缺项句不算 PASS |

另按编排器指示:D1 改为「已按已批方案 §2.6 采 A」并保留代价说明(§5)。R2 若需要,只审上述 10 条的闭合与本次修改的差异。
