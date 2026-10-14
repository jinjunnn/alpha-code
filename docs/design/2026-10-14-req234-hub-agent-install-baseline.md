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
需要 owner 拍板的点单列第五节,仍是推断的断言列第六节。

**读法**:alpha-code 坐标以 `origin/alpha@74482625a`(2026-10-14)为准,写作 `文件:行`;
alpha-work 坐标以 `origin/main` 的 `governance/customization-center-target-architecture.md`
(下称「目标架构」)为准。第一节只陈述**读过、跑过**的事实,不含设计;设计从第二节起。

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
| IPC 写通道 | 全部生产写通道经 `buildGatedWriteChannels` 构造,**「新写通道必须先进表登记,不得直接 `ipcMain.handle`」**;`installCatalog` 挂在 `:1283` | `packages/ui-mac/src/main/ext-ipc.ts:1166-1176`、`:1283-1292` |
| main 安装体 | `runCatalogInstallWithPackagePreflight` → `installCatalog(legacy)` 或 `admitPackage`;全局 MCP 成功后 `reloadInstalledMcp(name)`;package 按 `activateMcp` 逐组件重载 | `ext-ipc.ts:1183-1240` |
| main 重载 | `global.dispose()` → `mcp.status()`;结果四态 `connected / disabled / failed / reload-pending`;**不查任何会话是否在流式输出** | `packages/ui-mac/src/main/ext-mcp-activation.ts:184-228` |
| renderer 重载 | `refreshEngine()` = `global.dispose()` 5 s 超时 + `connectOutcome` 判 HTTP 错误;**不查会话** | `use-extensions.ts:987-997` |
| renderer 重载的调用方 | 22 处(`use-extensions.ts` 内 19 处;`extension-hub.tsx:847,1984`;`extension-detail.tsx:178`;`builtin-controls-panel.tsx:83,169`) | `grep -rn "refreshEngine()" packages/ui-mac/src/renderer` |
| 项目作用域重载 | `refreshProjectEngine(dir)` = `instance.dispose({directory})` 并等 `server.instance.disposed` 事件 | `use-extensions.ts:1000-1024` |
| 信任门后的重载 | 用户点「信任项目」/ 外部导入成功后 renderer 直接 `global.dispose()` | `packages/ui-mac/src/renderer/alpha-ui/ext-trust-watcher.tsx:52,61` |
| 安装成功 ≠ 已启用 | `desiredState` 由审核策略决定:`session-grant` 恒 disabled;有前像沿用;否则按初始策略 | `packages/ui-mac/src/main/ext-install-policy.ts:33-41` |
| 「待重载」今天不是状态 | 只是动作返回里的 reason 字符串(`"reload-pending"`),**不落盘、不显示在已安装列表** | `use-extensions.ts:699,972,1149,1166,1257,1266` |
| 引擎侧无文件监听 | 配置/技能/命令加载器范围内 `chokidar / fs.watch / watchFile` 零命中;生效只靠显式 dispose | 地面真相 K8 |

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

**工具回调主进程 / 弹窗:今天没有任何 ext → main 的请求通道。** 逐条核过:

| 方向 | 通道 | 坐标 |
| --- | --- | --- |
| main → ext | 只有 fork 时的环境变量:`ALPHA_GLOBAL_DIR`、`ALPHA_FACTORY_SKILL_DIRS`(`index.ts:784`)、`ALPHA_FACTORY_DENY_SKILLS`、`ALPHA_CLOUD_MCP_DEF`、`ALPHA_BASE_URL` 等(`grep -rhoE "process\.env\.ALPHA_[A-Z_]+" packages/ext/src`) | `packages/ui-mac/src/main/alpha-config-injection.ts`、`index.ts` |
| main → ext(文件) | main 写、引擎读的真源目录已有先例:`<casBaseRoot>/mcp-servers/<env>.json`,只有 main 写得了(围栏 W2 只放行 `env/<env>`),读端进 sidecar 闭包、写端不进 | `packages/ui-mac/src/main/mcp-server-truth.ts:1-27`、`mcp-server-truth-write.ts:1-7` |
| ext → main | **无**。引擎树出网只能到 loopback 策略代理(`N4`),代理只做 `CONNECT` 隧道、明文 HTTP 一律 405 | `packages/ui-mac/src/main/process-fence-profile.ts:174-178`;`network-egress-proxy.ts:1-30` |
| ext → 引擎 | `input.client`(SDK v1,同进程 HTTP) | `packages/plugin/src/index.ts:56-64` |
| 引擎 → renderer | SSE 事件流;v1 审批请求 `permission.asked` 经 v1 适配器投影到 alpha 审批面 | `packages/app/src/context/permission-v1-adapter.ts:1-15` |
| main → renderer | `webContents.send` 共 12 个频道(`alpha-recovery-incident`、`sidecar-generation`、`ext-session-grants-ended`、`cloud-run-saved`、`automation-event`、`alpha-contract-failure`、`alpha-catalog-failure`、`auth-state`、`auth-error`、`menu-command`、`zoom-factor-changed`、`pinch-zoom-enabled-changed`) | `grep -rn "webContents.send(" packages/ui-mac/src/main` |
| main 订阅引擎 | main 已长期订阅 `/global/event`(带 `directory` 的信封),今天只消费 `session.idle` | `packages/ui-mac/src/main/chat-archive-uploader.ts:360-392`;`index.ts:1004` |

**插件工具能向用户「问一句」的唯一现成机制是 `ctx.ask`**(`packages/plugin/src/tool.ts:3-20`,
`AskInput = { permission, patterns, always, metadata }`):

- 接线:`packages/opencode/src/tool/registry.ts:166-170` 把宿主的 `ask` 桥成 Promise;
  `packages/opencode/src/session/tools.ts:151-158` 补上 `sessionID / tool{messageID,callID} /
  ruleset = merge(agent.permission, session.permission)` 后进 `Permission.ask`。
- `Permission.ask`(alpha 自有、L3 接管,ADR-033/ADR-038;`packages/opencode/src/permission/index.ts:159-245`):
  先按 ruleset 逐 pattern 判 —— `deny` ⇒ `DeniedError`;`allow` ⇒ **不发布、直接返回**;
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

**今天的「确认框」**:renderer 自有的定制中心安装确认框 —— `extension-hub.tsx:468-490`
(`openInstallConfirmation`、`envValues` 遮罩密钥、`#348` 两阶段 authz 状态机),授权视图
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

AC1 要的四项信息在目录里的落点(以随包快照实读):

| 信息 | 来源 | 实况 |
| --- | --- | --- |
| 是否已装 / 是否启用 | 账本 `installs.json`(`desiredState`)经 `ext-inventory.ts` 聚合为 `availability / activation / health` 三维 | `packages/ui-mac/src/main/ext-inventory.ts:1-20`;`packages/ui-mac/src/shared/ext-states.ts:17-63` |
| 需要什么授权 | legacy 条目 `installSpec.requiredEnvVars`(`catalog-types.ts:25-26`);签名包 `prerequisites[].prerequisiteId`(`shared/catalog-package-view.ts:47-50`);mcp-remote 档案 `auth.kind ∈ {none, mcp-oauth, alpha-connection}`;云能力 = 登录 CodePuppy 账号 | 快照里带 `requiredEnvVars` 的只有 `mcp:github`、`mcp:dbhub`,且两条都带 `_verify`、被可安装视图隐藏 |
| 云能力的价格说明 | **快照里没有任何价格字段**:cloud 条目的 `installSpec` 键只有 `kind / pipelineKind / inputContract / budgetDefaults / budgetLimits / tier / upstreamData`;全目录 `price` / `pricing` 零命中 | `python3 -I` 解析 `alpha-catalog.json` 实测;目标架构 §2.1 把价格说明放在第 4 步的 `cloud` 档案(REQ-235) |

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

### 1.5 旁路现状(只陈述事实,设计见第三节)

| # | 事实 | 坐标 |
| --- | --- | --- |
| F1 | 围栏可写集 W2 = `<alphaGlobalRoot>`,`alpha.jsonc` 在其中,**引擎树自己写得了** | `process-fence-profile.ts:155`;`#1383` 基线 §1.1 |
| F2 | 治理集 = `alpha.jsonc` 里的**非远程** MCP 条目 ∪ 本轮注入名;远程条目自 `#1381` 起不算治理凭据、压成 `enabled:false`;**本地条目一字不动** | `packages/ui-mac/src/main/mcp-default-deny.ts:55-66` |
| F3 | `persistMcp`:远程 → 真源文件;**本地 → 仍写 `alpha.jsonc mcp.<name>`**(注释原话「本地 MCP 维持现状」) | `packages/ui-mac/src/main/ext-config.ts:542-570` |
| F4 | 引擎经 `OPENCODE_CONFIG = alpha.jsonc` 原生合并该文件(main 只在缺席时 seed `{$schema}`) | `alpha-config-injection.ts:85-92`;`engine-config-truth.ts:1` |
| F5 | `plugin[]` 加法一律被咽喉拒(ADR-040 执行面) | `packages/ui-mac/src/main/engine-plugin-seal.ts:1-20` |
| F6 | 上游项目配置发现(`<project>/opencode.json(c)`、`.opencode/`)在生产**未关闭**:`OPENCODE_DISABLE_PROJECT_CONFIG` 只出现在一份测试用例的 env 里 | `packages/opencode/src/config/config.ts:425-429`;`grep -rn OPENCODE_DISABLE_PROJECT_CONFIG packages/ui-mac/src packages/ext/src` 仅 `use-extensions-recovery.cases.ts:104`;ADR-040 后果 4 已登记为上游边界 |
| F7 | 项目 `.code-puppy/plugins/*.js` 在引擎进程内 `import()`,门 = `.code-puppy/prefs.json` 的 `extensionsConsent.granted`(**整项目一次性**,不按文件) | `packages/ext/src/plugin.ts:412-425`、`:432-449` |
| F8 | `alpha_register type=mcp` 写项目 `alpha.jsonc`,受同一条 consent 门 | `plugin.ts:274-345` |
| F9 | 普通 MCP 密钥 = `<userData>/alpha-mcp-secrets/...` 0600 明文(W3,引擎可读可写);官方连接器运行期解密到临时目录 | 地面真相 §4;`official-connector-resources.ts:214` |
| F10 | 目录缓存 `<userData>/remote-catalog.json` 在 W3,引擎写得了;main **读回重验签名**,伪造的缓存进不了已验 catalog | 地面真相 §1(`remote-catalog.ts:48`) |
| F11 | 出厂技能 `customize-code-puppy` 今天教:全局改动「直接编辑 `$ALPHA_GLOBAL_DIR/alpha.jsonc` 再 `alpha_reload`」(`:34-35`);「套件 = MCP + 技能 + 插件」(`:55-57`);「插件必须是自包含 ESM」(`:70`) | `packages/ui-mac/resources/factory-skills/customize-code-puppy/SKILL.md` |

## 二、选定方案与被否决的替代

**一句话:主进程是唯一权威;agent 只发请求、只读结论;确认框是定制中心自己的那一个;
没有任何新的 ext → main 通道。** 对基线要求的反问「能不能让主进程成为唯一权威,agent 只发请求」——
**能,而且这正是最简解**:安装的权威今天已经在 main(renderer 只运输 `catalogId` + grants,main 从已验
catalog 重新派生一切),缺的只是「agent 怎么把请求递到那个确认框」和「agent 怎么读到 main 的结论」。
前者用引擎自己的审批请求当运输;后者用 main 写、引擎只读的一份投影文件。两样都是现成形状。

### 2.1 三个 agent 工具的输入输出

工具文字全部登记进 `TOOL_TEXT`(1.2)。三个工具**都没有密钥类型的字段**。

| 工具 | 输入 | 输出 | 数据来源 |
| --- | --- | --- | --- |
| `hub_search` | `query: string`(关键词或用途;空串 = 全部) | 匹配条目列表,每条:`id`、显示名、类型、一句话说明、`installed`、`enabled`、`state`(四态,见 2.5)、`authorization`(`none` / `secret:<VAR,…>` / `mcp-oauth` / `platform-login`)、云能力的 `priceNote`(目录给什么就透传什么;没有就写「目录未提供价格说明,费用以服务端为准」) | 投影文件(2.2);只含**可安装视图 ∪ 已安装**的条目 |
| `hub_install` | `catalogId: string` | 六种之一,逐字固定:`declined`(用户拒绝)/ `installed; reload pending`(已落盘,待重载)/ `installed; available`(重载已完成)/ `installed; disabled by policy`(按审核策略装完即停用,不承诺可用)/ `not installed: no confirmation box ran`(请求被规则自动放行、确认框根本没出现;见 I3)/ `unknown entry`。外加一句固定提示「下一条消息开始前重载完成就是可用;不会在本条回答里生效」 | `ctx.ask` 运输 + 事后重读投影 |
| `hub_status` | `catalogId: string` | 同 `hub_search` 单条;`reload-pending` 时带上 main 记录的原因(`waiting: N session(s) busy` / `last reload failed: <reason>`) | 投影文件 |

`hub_install` **不在当前回答里等重载**(约束 5;等重载会和当前回答互相等,见被否决的 D)。

### 2.2 agent 读结论:main 写、引擎只读的投影文件

- 路径:`<casBaseRoot>/hub-view/<env>.json`,与 `mcp-servers/`、`custom-providers/`、`cas/` 同级,
  **不在任何 W 行之下**(`#1383` 基线 §1.1 的 18 条静态行;W1 由 `#1390` 的排除规则兜住)。
  main 经 fork 时的环境变量 `ALPHA_HUB_VIEW_FILE` 把路径交给 ext(与 `ALPHA_FACTORY_SKILL_DIRS` 同一通道)。
- 形状:`{ v: 1, generatedAt, entries: [{ id, kind, name, displayName, summary, installed, enabled,
  state, stateReason?, authorization, priceNote? }] }`。**不含任何密钥值**(只含变量名)。
- 写端只有 main(写模块不进 sidecar 的 import 闭包,`mcp-server-truth-write.ts` 同一纪律,
  由 `process-fence-write-sites.tsv` 登记为 `main-only`);原子写(tmp + rename)。
- 读端(ext)**严格**:缺失 = 「定制中心暂不可查」;解析失败 / 版本不认识 / 多余键 ⇒ 拒绝并说原因,
  不猜、不修(`readMcpServerTruth` 同形,`mcp-server-truth.ts:112-140`)。
- 刷新时机:已验 catalog 刷新后;**每一条 gated write channel 完成后**(安装 / 卸载 / 启停 / 回滚);
  重载调度器每次状态迁移后。它是派生缓存,不是第二份真源:真源仍是已验 catalog + 账本 + 调度器状态
  (「一个事实只放一处,其余生成」)。

为什么不让 ext 直接读账本和目录:`ext-receipt-v2`、`catalog-installable-view` 都住在 ui-mac,
ext 的依赖只有 `@alpha-code/contracts-consumer` 与 `@opencode-ai/plugin`(`packages/ext/package.json`),
在 ext 里再写一份解码 = 「手写别人文法的替身」;而且账本与缓存都在引擎可写集里(F1、F10),
ext 自己读到的东西**无法证明**与定制中心一致,AC3 的「一致」就没有判据。

### 2.3 确认框:由谁弹、怎么把用户决定回传给工具

```
hub_install(catalogId)
  └─ ctx.ask({ permission:"hub_install", patterns:[catalogId], always:[], metadata:{ alphaHub:{ catalogId } } })
        │ 引擎:ruleset 判 → 发布 permission.asked(300 s 期限)
        ▼
  renderer 审批面订阅 permission.asked
        ├─ metadata.alphaHub 缺席 → 既有 PermissionDialog(行为一字不变)
        └─ metadata.alphaHub 在场 → 新的 hub-install 守望者接手(通用对话框不呈现它):
              按 catalogId 在 renderer 的已验目录源里找到条目/包视图 →
              弹**定制中心自己的安装确认框**(从 extension-hub.tsx 抽出的同一份确认 + authz 两阶段控制器;
              标题多一行「由对话中的 agent 请求」;密钥仍在这个框的遮罩输入里填)
              ├─ 用户确认 → 既有出站:ext.installCatalogIntent / installSkill / addMcp(→ IPC installCatalog)
              │       ├─ main 提交成功 → 投影刷新 + 调度器登记待重载 → renderer 回 permission reply `once`
              │       └─ main 拒绝 / 失败 → 在框里显示原因 → 回 reply `reject`(带 message = 原因)
              └─ 用户取消 / 关闭 / 300 s 无人应答 → reply `reject`(期限到时引擎自己广播 reject 回执,框随之收起)
        ▼
  工具恢复:重读投影文件 → 按 2.1 六种之一返回
```

- **回传载体就是审批应答**:`once` = 已安装并落盘;`reject` = 拒绝或失败。应答命令没有自由载荷
  (`PermissionDialog.tsx:19-30`),所以**结构上**不可能把密钥或别的东西顺手塞回工具。
- `always: []` + v1 适配器不投影 `save`(1.2)⇒ 没有「始终允许」;每一次安装都要一次确认(I7)。
- 守望者必须登记进呈现面唯一挂载判据(`permission-mount-ratchet.test.ts`、`permission-single-surface.test.ts`),
  通用对话框按 `metadata.alphaHub` 过滤 —— 否则同一个请求会弹两个框。
- 审批面按当前路由的会话取请求(1.2)。agent 的请求发生在用户正在看的那个会话里(用户刚发的消息),
  与今天 bash / webfetch 的审批可见性**完全相同**,本票不新造跨会话呈现。

### 2.4 密钥只在确认框输入:证明它不进工具参数、返回值、会话记录

| 位置 | 内容 | 判据 |
| --- | --- | --- |
| 工具参数 schema | `hub_install` 恰好一个参数 `catalogId: string`;`hub_search` / `hub_status` 同样只有字符串标识 | 测试:三个工具的 zod schema 键集合精确相等,且不存在任何名字含 `secret / token / key / password / dsn` 的字段 |
| 工具返回值 | 2.1 的固定字符串 + 投影里的字段(只含变量名) | 测试:返回值里不含投影之外的任何字节 |
| 会话记录 | 工具 part(参数 + 输出)+ `permission_request / permission_decision`(`metadata = { alphaHub:{catalogId}, alphaRisk }`、`decision`) | 打包 RC e2e:用一个金丝雀密钥值安装一个带 `requiredEnvVars` / prerequisite 的条目后,在会话消息、审批表、投影文件、ext 日志里 grep 该值 ⇒ **零命中**;对照组:同一 grep 在 `<userData>/alpha-mcp-secrets/` 或 `connector-secrets/` 的落点上**必须命中**(证明 grep 本身能看见它) |
| 密钥的真实路径 | 确认框 → `extIpc.installCatalog({ grants:{ secrets } })` → main `{file:}` 落盘 —— **与今天定制中心的路径逐字相同**(`use-extensions.ts:653-676`) | 不新增任何密钥通道 |

### 2.5 三档状态:权威与显示

| 状态 | 含义 | 由谁判定 | 怎么得出 |
| --- | --- | --- | --- |
| `not-installed` | 目录里有,本机账本无 | main(账本) | `ext-inventory` 的 `availability ≠ installed` |
| `installed` | 账本已落盘(`desiredState` 任意);若 `disabled` 则投影 `enabled:false`,工具说「装完即停用,不承诺可用」 | main(账本) | 账本 upsert 成功那一刻 |
| `reload-pending` | 已落盘且 `enabled`,但引擎还没重建成功:排队中(等会话空闲)**或上一次重载失败**(带原因) | main(重载调度器) | 调度器登记 / 重载失败 / 核验失败 |
| `available` | 重载完成**且**引擎核验通过:MCP `mcp.status[name] === "connected"`;skill 出现在 `GET /skill`;agent 出现在 `GET /agent`;command 出现在 `config.get().command`;cloud = 收据在 + 本轮 fork 云 MCP 以 `enabled:true` 注入(`alpha-config-injection.ts:103-109` 的 `platformPays`) | main(调度器核验) | 一次 dispose 之后逐项核验 |

- **权威只有一个:main。** 定制中心已安装列表与 agent 工具读的都是同一份投影(定制中心经新 IPC
  `ext-hub-view` 读,ext 经文件读),因此 AC3 的「一致」是结构性的,不靠两边各算一遍。
- 定制中心今天对 MCP 另有实时的连接状态徽标(来自引擎 `mcp.status`),**保留**;它回答的是
  「此刻连着吗」,不是三档里的任何一档;重载后断连由它和 agent 自己的调用失败各自呈现,不在 AC3 之内。
- 「下一条消息可用」只对 `available` 承诺(约束 5)。

### 2.6 统一重载调度

新增 main 侧 `reload-scheduler`(单例,纯 main):

- **输入**:`request({ scope: "global" | { directory }, items: [{kind, name}], reason })`;同一 scope 的多次请求
  **合并成一次** dispose(一次安装多个组件只重载一次;套件安装就是多个 items 一次 request)。
- **会话忙闲**:从 main 已有的 `/global/event` 订阅(1.2)多消费一种事件 `session.status`:`busy / retry` 入
  忙集 `(directory, sessionID)`,`idle` 出忙集(`session.idle` 已标 deprecated,不再新增消费者)。
  global scope 等**整个忙集为空**;directory scope 只等该目录的那部分为空。
- **触发**:队列非空 ∧ 对应忙集为空 ∧ 短去抖(数百毫秒,防止用户连发两条消息之间抢跑)⇒ 一次
  `global.dispose()`(或 `instance.dispose({directory})`)⇒ 逐项按 2.5 核验 ⇒ 写状态 ⇒ 刷新投影 ⇒
  `webContents.send("ext-hub-view-changed")` 让定制中心重读。
- **失败**:dispose 或核验失败 ⇒ 项目留在 `reload-pending`,`stateReason = last reload failed: …`,
  下一次忙集清空再试;连败 3 次停止自动重试但**状态不变**(仍是待重载,原因写明「需要重启应用」)——
  不降级成「可用」,也不悄悄清掉。
- **会话一直忙**(例如 5 分钟仍非空):只记一行日志,**继续等**;不强行打断(约束 4)。用户若要立刻
  生效,定制中心已安装列表给一个「现在重载(会打断正在输出的回答)」按钮 —— 这是用户的显式选择,
  不是调度器的决定。
- **三条路的归口**:
  1. 定制中心按钮(1.1 的 22 处 `refreshEngine()` 调用点)⇒ 改为新 IPC `ext-reload-request`(登记进
     `ext-write-channels.ts` 的表)⇒ 调度器;`refreshEngine` 本身只剩「现在重载」按钮一个调用方。
  2. main 内部(`reloadInstalledMcp`、package 的 `activateMcp` 逐组件重载)⇒ 调度器;`ext-ipc.ts` 的
     安装体不再直接 dispose。
  3. ext 的 `alpha_reload` / `alpha_register`(项目作用域、引擎侧):**没有 ext → main 通道**,不改道;
     把它的触发条件从「登记会话 idle」改为「`input.client.session.status()` 显示**本实例全部会话** idle」,
     与调度器**同一条规则**。这是本基线对目标架构 §2.5「三条路统一进一个调度」的唯一偏离:
     两处实现、一条规则。要做成字面上的一个调度,代价是一条新的 ext → main 通道(见被否决的 B、G),
     而 `alpha_register` 本来就不在 AC1–AC4 之内。

### 2.7 `customize-code-puppy` 技能改写要点(AC5)

- 继续默认开启(`factory-skills.ts:47-55`);`customize-opencode` 的隐藏/永久禁用/占位指向归 `#1522`,本票不碰。
- **删**:「全局改动直接编辑 `$ALPHA_GLOBAL_DIR/alpha.jsonc` 再 `alpha_reload`」(F11)—— 这正是要堵的旁路,
  技能不能再教;「套件 = MCP + 技能 + 插件」改为「技能 + agent + 命令 + 连接器」;「从目录装插件」的任何措辞。
- **加**:定制中心有哪些类型;缺能力先 `hub_search`;要装就说明装什么、为什么,用 `hub_install` 请用户在
  **软件弹出的确认框**里同意;需要密钥时让用户在框里填,**绝不在聊天里要、绝不替用户编造或猜测密钥**;
  装完告诉用户「显示可用以后,下一条消息就能用;不用重启」;`hub_status` 查「待重载」为什么还没好;
  `alpha_register` 只用于项目作用域、且可执行连接器要过项目信任门。
- **如实讲信任边界**:项目里的 `.code-puppy/plugins/*.js` 在用户信任该项目后**会被加载并以引擎同等权限执行**,
  信任是整项目一次性的;目录里的可执行插件被拒装(ADR-040)。
- 判据(技能内容测试):断言必须出现的句子(三个工具名、「确认框」、「不在聊天里要密钥」、「下一条消息」、
  信任边界那句)与**必须不出现**的句子(直接编辑 `alpha.jsonc`、`plugin` 作为套件成员、从目录装插件);
  改掉任一句测试即红。

### 2.8 被否决的替代

| # | 替代 | 否决理由 |
| --- | --- | --- |
| A | ext 直接读账本 / 目录缓存算视图 | 2.2 末段:重写解码器;账本与缓存都在引擎可写集,一致性没有判据 |
| B | main 开一个 loopback 控制端点供 ext 调用 | 围栏只放行代理端口(`N4`),代理只做 CONNECT;要么给围栏加一行(安全咽喉,18 行逐条断言的面),要么让策略代理兼做控制面;再加鉴权令牌与新服务器 —— 比「审批请求 + 投影文件」多出整整一个攻击面,换来的只是少写一个文件 |
| C | 用引擎的 `question` 工具 / 路由当确认框 | 没有遮罩密钥输入;没有审批那套期限、回执与持久化;呈现在上游 `packages/app/src/pages/layout.tsx`,改它要走 ADR-034 补丁 roundtrip |
| D | `hub_install` 同步等到重载完成再返回 | 死锁:调度器等本会话空闲,本会话等这个工具返回(目标架构 §2.6、R1 第 7 条已否) |
| E | 把确认做成通用 `PermissionDialog` 的 once / reject | 没有密钥输入,AC2 做不到;而且确认之后仍得有人去调安装 —— 等于 2.3 少了确认框 |
| F | agent 写 `alpha.jsonc` 装 MCP(今天技能教的) | 就是要堵的旁路本身 |
| G | ext 的 `alpha_reload` 也走 main 调度 | 需要 ext → main 通道,见 B;`alpha_register` 不在 AC 内 |
| H | 文件轮询 / `fs.watch` 作 ext → main 请求通道 | 请求目录在引擎可写集里,引擎树任何进程都能刷请求;轮询与竞态;比 B 更差 |
| I | 投影改为 ext 每次调 main 的 IPC | ext 没有 IPC 面(IPC 是 renderer ↔ main) |

## 三、安全面

### 3.1 整类安装旁路与边界

| # | 旁路 / 边界 | 今天 | 本方案后 | 处置 |
| --- | --- | --- | --- | --- |
| S1 | agent 写全局 `alpha.jsonc` 的 `mcp.<name>`(本地 type)再触发重载 ⇒ 引擎起一个持久的、**定制中心看不见**的可执行连接器(F1–F4) | 成立 | 本机 MCP 记录搬进 main 才写得了的真源;`alpha.jsonc` 里的本机条目不再是治理凭据,注入面压成 `enabled:false` 并 log(与 `#1381` 对远程的处理同形) | **待 owner 裁决 D1**(第五节);是 I1 成立的前提 |
| S2 | 同上但写 `mcp.<name>`(remote) | 已堵(`#1381`) | 不变 | — |
| S3 | 写 `plugin[]` | 已堵(F5,ADR-040) | 不变 | — |
| S4 | 写用户全局 `~/.config/opencode/*.json` 的 `mcp` | 已默认拒(`#535`) | 不变 | — |
| S5 | 写 `<project>/opencode.json(c)` / `.opencode/` 让上游原生加载 MCP / 插件(F6) | 上游行为,未关 | 不变 | **登记为已知边界**(ADR-040 后果 4 同类);关它 = `OPENCODE_DISABLE_PROJECT_CONFIG`,会同时关掉用户自己的项目配置,不在本票 |
| S6 | 项目 `.code-puppy/plugins/*.js`(F7)与 `alpha_register type=mcp`(F8) | 整项目一次性信任门 | 不变(目标架构 §2.6「项目范围的 `alpha_register` 保留」) | AC5 如实讲;**不承诺**按文件/按次确认 |
| S7 | shell 直接运行任意程序 | 由 `#1413` 权限分层把关 | 不变 | 它不是「安装」:不持久、不进工具表、不出现在定制中心;AC2 管的是受管安装 |
| S8 | 确认框被规则放行替代:agent 往 `alpha.jsonc` 写 `permission.hub_install: "allow"`(W2 写得了;`session/tools.ts:156` 的 ruleset 含它)⇒ `Permission.ask` 不发布直接返回 | — | 安装**只**由 renderer 守望者在**呈现过确认框并被点击**之后发起;规则放行 ⇒ 没有框 ⇒ 没有安装 ⇒ 工具重读投影后如实返回 `not installed: no confirmation box ran` | I3 |
| S9 | renderer 自动放行总闸 / 「始终允许」 | 总闸默认关;v1 无「始终」按钮 | `always: []`;即便总闸开着,自动应答只作用于审批通道,同样「没有框 ⇒ 没有安装」 | I3、I7 |
| S10 | 合成点击 / 无障碍自动化点确认框 | OS 级,任何对话框同样 | 不在本票 | 如实不承诺 |
| S11 | 提示注入诱导 agent 调 `hub_install` | — | `catalogId` 由 main 从已验签 catalog 重新派生(`ext-ipc.ts:1189-1194`),装不了目录外的东西;用户在框里看到来源与权限;伤害上限 = 「装了一个用户当场同意的、经签名与审核的条目」 | I8 |
| S12 | 伪造投影 / 伪造目录缓存 | — | 投影在围栏写不到的目录(I6);缓存读回重验(F10) | I6 |
| S13 | 运行时密钥对 agent 可见(F9) | 可见 | 可见 | **不承诺**(约束 2) |

### 3.2 实现必须守住的不变量(咽喉点形态;每条由子票各自落判据)

- **I1 受管安装唯一通路**:到达账本与引擎 MCP 表的唯一通路是 main 的 gated write channel 表
  (`ext-write-channels.ts`);agent 侧 `hub_install` 只能到达 `ctx.ask`;**其余**(引擎树写进 `alpha.jsonc`
  的本机 MCP 条目)在注入面**响亮失败**(`enabled:false` + 一行原因)。判据端到端:在围栏内往 `alpha.jsonc`
  写一条本地 MCP 并 dispose ⇒ `mcp.status` 里它不是 connected,日志有那一行;删掉压制 ⇒ 该用例红。
  **前提是 D1 采纳;D1 不采纳则 I1 改写为「…其余在定制中心与 agent 工具里都看不见」并对外如实说明确认框不是唯一通路。**
- **I2 密钥零进入引擎**:三个工具的参数 schema 键集合精确为 `{catalogId}` / `{query}`;审批应答命令无自由
  载荷;投影写端剥离一切密钥值(金丝雀测试,2.4)。
- **I3 确认框不可被规则放行替代**:安装只能由 renderer 守望者在呈现确认框并被用户点击后发起;
  `ruleset.hub_install = allow` 的夹具下:账本零变化、工具输出为 `not installed: no confirmation box ran`。
- **I4 三档状态唯一权威**:定制中心与 ext 读同一份投影;同一夹具两侧得到同一档;重载失败两侧都显示
  `reload-pending` 与同一原因。
- **I5 重载不打断**:忙集非空 ⇒ 零 dispose;忙集清空 ⇒ 对 N 个排队项恰好一次 dispose(假事件流夹具)。
- **I6 投影路径不在可写集**:对围栏 18 条静态 W 行逐条断言不覆盖 `<casBaseRoot>/hub-view/`
  (`mcp-server-truth.test.ts` 同形);真 `sandbox-exec` 裁决由 `custom-provider-truth-fence.test.ts` 对同一父目录给出。
- **I7 每次安装一次确认**:`always: []`;回复 `always` 不产生任何能抵消后续 `hub_install` 的 grant。
- **I8 只认签名目录**:投影只含可安装视图 ∪ 已安装;`hub_install` 对不在已验 catalog 里的 id 由 main 拒绝。

## 四、子票切分

| 子票 | 边界(具体文件) | 负责 AC | 不做 | 退出条件 | 规模 |
| --- | --- | --- | --- | --- | --- |
| **C1 `[CODE]` 重载调度器 + 三档状态 + 投影写端**(main 为主) | 新 `packages/ui-mac/src/main/reload-scheduler.ts`;新 `hub-view.ts`(严格读 + 形状,electron-free,可进 sidecar 闭包)与 `hub-view-write.ts`(只 main);`ext-ipc.ts`(新 IPC `ext-reload-request`、`ext-hub-view`,安装体改走调度器);`ext-mcp-activation.ts`(`reloadInstalledMcp` 改为核验器,不再 dispose);`chat-archive-uploader.ts` 或新共享 tap 多消费 `session.status`;`index.ts`(`ALPHA_HUB_VIEW_FILE`);renderer `use-extensions.ts`(22 处 `refreshEngine()` 改走 IPC,只留「现在重载」)、`extension-hub.tsx` / `extension-detail.tsx`(已安装列表显示三档 + 原因 + 「现在重载」按钮);登记 `scripts/gate-files.tsv`、`scripts/process-fence-write-sites.tsv` | AC3;AC4 的前提 | 工具、技能、本机 MCP 真源 | I4、I5、I6 判据绿;真机:一个会话流式输出时从定制中心装 MCP,输出不断、列表先「待重载」后「可用」 | L |
| **C2 `[CODE]` 本机 MCP 真源搬家(堵 S1)** —— 以 D1 采纳为前提 | 新 `mcp-local-truth.ts` / `-write.ts`(与 `mcp-server-truth` 同形、**不同文件**,记录含 `command / environment`);`ext-config.ts`(`persistMcp` 本地臂、`removeMcp`、`readMcpLeaf`);`mcp-default-deny.ts`(本地条目不再是治理凭据);`alpha-config-injection.ts`(从真源注入本地 MCP);`ext-disabled-injection.ts` 若涉及;旧条目处置按 `#1383` I3(忽略 + 一行日志,不迁移、不建待确认面);围栏静态行断言 | AC2 的「唯一通路」半边(I1) | 项目作用域、密钥存储 | I1 端到端判据绿;定制中心重装一次本地 MCP 后与搬家前行为一致 | M |
| **C3 `[CODE]` 三个 agent 工具 + 确认框接线** | `packages/ext/src/plugin.ts`(3 个 tool)、`context-injection.ts`(`TOOL_TEXT` + 快照重生)、新 `packages/ext/src/hub-view-read.ts`(严格读;与 ui-mac 写端的往返由 ui-mac 侧测试直接 import ext 源码证明);renderer 新 `alpha-ui/hub-install-watcher.tsx`;从 `extension-hub.tsx` 抽出安装确认 + authz 两阶段控制器为可复用模块(Hub 与守望者共用**同一份**);`permission-watcher.tsx` 按 `metadata.alphaHub` 分流;`permission-mount-ratchet.test.ts`、`permission-single-surface.test.ts` 登记新消费者 | AC1;AC2 的确认框与密钥半边(I2、I3、I7、I8);AC3 的 agent 侧;AC4 | 新 IPC 写通道(复用既有 `installCatalog`);任何新的 ext → main 通道 | I2、I3、I7 判据绿;2.4 的金丝雀 e2e 绿且对照组红 | L |
| **C4 `[CODE]` `customize-code-puppy` 改写 + 内容测试** | `packages/ui-mac/resources/factory-skills/customize-code-puppy/SKILL.md`;`factory-skills.test.ts`(新增 2.7 的正反断言);涉及文案则 `visible-brand-copy.test.ts` | AC5(`customize-opencode` 部分引用 `#1522`) | 技能之外的任何代码 | 内容测试绿;反向:删掉任一必含句或加回任一禁句即红 | S |
| **V1 `[VERIFY]` 打包 RC 对话记录** | 打包 RC;owner 本机;记录:`hub_search` → `hub_install` → 确认框(含一次密钥输入)→ 「可用」→ 下一条消息调用成功;2.4 的 grep 正反两组 | AC2 e2e、AC4 | — | 记录进 `docs/verification/` | S(需要 owner 动手,见记忆「桌面端打包版取证要 owner 动手」) |

**先后与冻结面**:C1 → (C2 ∥ C3) → C4 → V1。C1 合并后冻结:投影形状 `v:1`、三档状态词、
`ALPHA_HUB_VIEW_FILE` 这个名字;C3 不得新增写通道。C2 与 C3 互不依赖,但**对外说「确认框是唯一安装通路」
必须等 C2 合并**;C2 若因 D1 不采纳而不做,C3 的工具描述与技能文案都按「主要通路」措辞,不说「唯一」。

## 五、待 owner 裁决

**D1 —— 本机 MCP 的记录要不要像远程 MCP 那样搬进 main 才写得了的真源?**

前因:`#1381` 把远程 MCP 搬进真源是因为出网围栏不敢照引擎自己写得了的文件放行;本机 MCP 不出网,
当时**刻意不动**(`ext-config.ts:552` 注释「本地 MCP 维持现状」,`mcp-default-deny.ts:62`「本地条目一字不动」)。
目标架构 §2.6 已写「本机 MCP 照同一做法处理」并被 owner 批准,但那一句没有写明代价,所以这里把代价摆出来再请你确认。

| 选项 | 做什么 | 后果 |
| --- | --- | --- |
| **A(推荐)** 搬 | C2:本机 MCP 记录进 `<casBaseRoot>/mcp-local-servers/<env>.json`,`alpha.jsonc` 里的本机条目不再加载 | ✅ 「确认框是唯一安装通路」成立(I1);✅ agent 装不出定制中心看不见的连接器。⚠️ **不可逆的一次性代价**:升级后 `alpha.jsonc` 里现有的本机 MCP 条目(经定制中心装的会被重写进真源;**手工编辑进去的**不会)停止加载,日志说明原因,用户在定制中心重装一次。本机零租户,代价 = 你重装一次;⚠️ 多一份真源文件与一处注入 |
| **B** 不搬,定制中心把 `alpha.jsonc` 里的本机条目显示成「未经确认」 | 列表里多一类行,等人点 | ❌ 等于把被否决的「待确认面」常设化(`#1383` 基线 I3 的理由原文:引擎随时往配置里写一块,UI 就多一行等人点),而人会点「允许」 |
| **C** 不动 | 什么都不改 | 确认框不是唯一通路;技能与工具描述只能说「主要通路」;S1 对所有用户长期开着 |

拖着的代价:C2 排不进去,C3 的对外措辞只能按「主要通路」写;其余子票不受影响。

## 六、仍是推断、没跑过的断言

1. `session.status` 事件会随 `/global/event` 送到 main(今天 main 只消费过 `session.idle`,schema 上两者同一发布点 `status.ts:46-50`,但没有在 main 侧实测过 `busy` 的到达)。
2. `permission.asked` 的 `metadata` 自定义键在 ui-mac 审批面一路保留到 `PermissionDialog`(适配器 `:107` 透传;`permissionRequestFacts` 只核 `subject / action / resources / scope / expiry` 五个事实,`:474`,没有实测过带 `alphaHub` 键的请求)。
3. 300 s 期限到时引擎广播的 reject 回执能让新的守望者收起确认框(通用对话框靠 `replied` 收卡,`permission-watcher.tsx:24`;守望者沿同一 feed 应当同样收到,未实测)。
4. `GET /skill` 与 `GET /agent` 在 dispose 后的首次调用会触发惰性重建并反映新内容(S12 spike 对 skill 实测过 100–300 ms 重建,`use-extensions.ts:979-983`;command 经 `config.get` 的那条没实测)。
5. 从 `extension-hub.tsx` 抽出确认框控制器后,Hub 自己的安装流程行为不变(纯重构,靠既有 Hub 测试兜底;文件 3000+ 行,抽取面要在 C3 方案里先画)。
6. 投影文件按「每条写通道完成后刷新」能跟上定制中心的每一次状态变化(写通道表是唯一出口这一点有 `ext-ipc.ts:1166-1176` 的纪律背书,但没有枚举过表外是否还有改账本的路径)。
7. 价格说明:目录今天没有该字段(实测),REQ-235 的 `cloud` 档案落地前 `hub_search` 只能透传 `tier` 与预算、并说「目录未提供价格说明」—— 这是 AC1 在今天的可达上限,不是本基线能改的。
