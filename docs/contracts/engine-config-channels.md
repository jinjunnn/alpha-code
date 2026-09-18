---
title: Engine config channels (v1/v2 dual-generation contract)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-17
review_after: 2026-12-17
---

# 引擎配置通道契约(v1/v2 双代)

上游 opencode 正处 v1→v2 架构迁移中途,引擎内**同时存在两代配置面**,读取来源与
能力互不相通。alpha 的一切引擎注入都必须同时喂对两代的**原生入口**,否则表现为
"某一代的消费面整体失明"(2026-07-23 全模型「当前不可用」事故,见下)。

## 两代配置面的地面真相

|                            | v1(`packages/opencode/src/config/`)                                                                                   | v2(`packages/core/src/config.ts`)                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 读取来源                   | `OPENCODE_CONFIG_CONTENT` env(merge 序最后)、`OPENCODE_CONFIG` 指向的文件(alpha.jsonc)、`Global.Path.config` 静态目录 | **只读文件**:`OPENCODE_CONFIG_DIR ?? ~/.config/opencode` 目录下的 `opencode.json` + `opencode.jsonc`(json 先、jsonc 后,后者压前者)+ 项目/`.opencode` 发现 |
| 变量解析                   | `{file:}` / `{env:}`(`config/variable.ts`)                                                                            | **无** —— 密钥引用原样成字面量                                                                                                                            |
| v1 形态兼容                | 原生                                                                                                                  | `isV1 → ConfigV1 decode → migrate → v2 decode`;**解码失败 = 整文件静默丢弃**                                                                              |
| 主要消费面                 | 推理(session prompt → v1 `Provider.Service`)、权限 deny、MCP、plugin、disabled 主权覆盖                               | `/api/model` catalog(模型选择器 list)、`v2.session.switchModel/get`                                                                                       |
| `OPENCODE_CONFIG_DIR` 影响 | 仅跳过默认 schema stub 落盘;全局读取仍走静态路径                                                                      | **决定唯一全局配置目录**(也影响 v2 的 `AGENTS.md` 全局查找)                                                                                               |

关键不对称:v2 **不读** `OPENCODE_CONFIG_CONTENT` 与 `OPENCODE_CONFIG`——alpha
经典的两条注入通道对 v2 完全不可见。

## alpha 的注入方案:单一真源、双投影

sidecar fork 时(`packages/ui-mac/src/main/sidecar.ts` → `prepareSidecarEnv` 调用
`packages/ui-mac/src/main/alpha-config-injection.ts` 的 `injectAlphaConfig`;#607 把注入
组合体从 sidecar.ts 抽出成独立模块,**只为让它可被测试真实执行** —— sidecar.ts 的首个
import 是 bun 未实现的 `node:module` registerHooks,顶层还有 `getParentPort()`),
同一个 config 对象(平台 provider + BYOK 节点 + 权限 + MCP + disabled 覆盖,源自
`alpha-models.json` + live allowlist + 钥匙串)一次产出、两路投影:

1. **v1**:`OPENCODE_CONFIG_CONTENT = JSON.stringify(config)`(原行为,密钥经
   `{file:}` 引用,fork 前由 main `syncSecretFiles` 物化)。
2. **v2**:`materializeV2EngineConfig` 物化 `<userData>/alpha-engine-config/`:
   - `opencode.json` ← alpha.jsonc 原样拷贝(用户自定义节点;先加载);
   - `opencode.jsonc` ← 注入配置的 `{ $schema, model, provider }` 子集,
     **剥除 apiKey**(v2 无变量解析,catalog 可用性判定走 no-integration 路径
     也不需要 key);后加载,压过用户同名项;
   - 设 `OPENCODE_CONFIG_DIR` 指向该目录。桥失败不自吞(#613 R1):picker 只经 v2
     目录读模型,丢 v2 = alpha/BYOK 模型全灰(票面事故症状),不是可忽略的局部降级
     —— 桥内不设 catch,抛错经 `injectAlphaConfig` 外层 catch 以 `{ok:false}` 上报。
     桥排在 v1 env 写出**之后**,抛错不撤销已就位的 v1 注入(顺序由反向闸门锁死)。

v2 catalog 的配置文件就位不等于每个 directory 的内存 catalog 已经收敛。`PluginInternal`
在后台依次装载 models.dev、provider、用户配置与 variant transform;中途读取曾把 6,132 行
models.dev 过渡态序列化给首屏,而同进程热路径只有 37 行(#857)。Alpha 模型治理开启时,现有
provider 投影已完整定义内建的可用 provider/model identity,因此同一桥目录会从**这份既有投影**
机械生成最小 models.dev base,并令现有 `OPENCODE_MODELS_PATH` 指向它;它只携带 identity、名称、
endpoint 和上游 schema 必填的保守零值,不复制 key、不制定第二份 allow/deny 策略。ConfigProvider
仍负责同源的丰富 metadata/variant 末序覆盖。`ALPHA_MODELS_DISABLE=1` 时不覆盖该路径,保留上游
catalog 逃生语义。

机械 base 同时带 `alpha-internal-catalog-ready` 记录(`env:[]`、零 models):它不进入可选模型集合。
上游 `PluginInternal` 原本把全部 internal plugin 包在同一个 `State.batch`;即使 ModelsDevPlugin
排在前面,它的 base/marker 也会被推迟到末序 ConfigProvider/variant 完成后才一起提交。Alpha 不改
受 north-star 保护的 core 源码,而在 `build-node` 后由
`packages/ui-mac/scripts/patch-plugin-internal-models.ts` 严格修改 gitignored 的 embedded-server
产物:只把唯一的 ModelsDevPlugin 注册移到该外层 batch 之前,其余 plugin 仍维持原顺序与单批提交。
补丁找不到唯一 `PluginInternal.boot` / ModelsDev 注册或遇到结构歧义就令构建失败,不得 warn/no-op。
renderer 的 typed model contract 在**同一 directory**先轮询 `provider.get(marker)`,再发首次
`model.list`,从而读取这次独立早提交,不再等待末序 ConfigProvider 才获得正确 identity 集。若
`enabled_providers` 含只存在于用户文件、无法由当前
内存投影完整表达的 provider,生成器就写 `{}` 且**不写 marker**;renderer 会保守等待普通
ConfigProvider 合并完文件来源,不得用局部 early set 冒充完整目录。这道 barrier 只等待本地插件
初始化,不读取 account summary、平台 bearer 或远端账户状态;登出/BYOK 目录仍与账户链并行。

正确的早提交仍不等于首个 HTTP 请求没有启动成本:`/api/provider` 与 `/api/model` 共用的
`LocationMiddleware` 会在首次目录请求时构建整张 per-location 服务图。首屏默认目录由 main 的
`alphaUserWorkspaceDir()` 唯一解析为 `~/code-puppy`;sidecar 把这个精确值随 start command 带入,并在
`Server.listen` 同时经引擎已有的 `Server.Default().app` 发一次带 sidecar Basic auth 的真实 V2
marker 请求。上游 `Default` 与 `listen` 原本各自调用 `createRoutes` 并使用不同 memo map,无法共享
`LocationServiceMap`;Alpha production prebuild 因而只对 gitignored embedded-server 生成物施加严格
补丁:仅 `cors=["oc://renderer"]` 的固定 Electron listener 复用 `Default` 的 singleton routes 和全局
memo map,其他调用仍走原 `createRoutes(opts)`。预热在 marker 证明治理提交后继续读取同目录真实
`/api/model`,把 renderer 的首个 handler 也在本地结算。这只是把同一张生产服务图及真实 handler
提前并与 listen 并行,不是另造 catalog API、缓存或 renderer 假数据。sidecar 在 listen 与预热都完成后才发布 ready,
避免 renderer 启动与首次服务图构建互相争用;这道本地门不读取账户,也不改变目录/账户并行。预热
失败只记具名诊断,renderer 仍保留上述 marker barrier 并照常 fail-closed。
这项预热保证只覆盖默认 `~/code-puppy` 首页流;任何其它 directory/workspace ref 都必须按真实冷路径
建立自己的 location graph,不得把首页一次预热宣称成全目录缓存。预热等待最多 2 秒,超时后
sidecar 仍发布 ready。renderer marker barrier 自身以 1.5 秒 wall-clock 为上限(包括挂起的
`provider.get`),不得被更宽的 model request abort budget 延长;时间线以
`error:catalog-not-ready` 区分本地 barrier 未收敛与普通模型请求错误。

同一次 fork 内同源产出,两投影无漂移面。推理密钥只存在于 v1 通道。

## 目录外自定义服务的密钥:同一条 `{file:}` 通道,引用只在 fork 时注入(REQ-226 `#1343`)

用户在选择器里「添加自定义节点」的密钥,与目录内 BYOK 走**同一条路**;差别只在定义来自
alpha.jsonc 而不是目录。方案基线
[`../design/2026-09-17-req226-custom-provider-keychain-baseline.md`](../design/2026-09-17-req226-custom-provider-keychain-baseline.md)。

| 层 | 事实 |
| --- | --- |
| durable(alpha.jsonc) | `persistProvider`(`ext-config.ts`)写 `provider.<id>.options.apiKey = "alpha-keychain"` —— 一个**常量标记**,不含密钥片段、路径或 id;密钥本身进钥匙串库(`alpha-byok-keys.json`,safeStorage 加密,`alpha-byok-keys.ts`)。durable 配置里**永远没有值、也永远没有 `{file:}` 路径**。 |
| fork(main,`spawnLocalServer`) | `syncSecretFiles(userData, env, extra)`,`extra` = alpha.jsonc 里的目录外 id ∩ 库键集,文件名 `custom-provider--<id>`(0600,目录 0700)。**不经 `process.env`**(A6 白名单不变;目录外 id 没有 keyEnv)。缺席 ⇒ 同一次 sync 清扫,与目录 BYOK 同一撤销语义。 |
| 注入(sidecar,v1 `OPENCODE_CONFIG_CONTENT`) | `buildAlphaModelConfig` 对每个 alpha.jsonc provider 块按 `options.apiKey` 三分类(`readConfiguredProviderKeys` 只返回分类,**不返回值**):K 托管(标记 / 字段缺席)且密钥文件在场 ⇒ `{file:<userData>/alpha-secrets/custom-provider--<id>}`;K 而文件缺席 ⇒ `""`;L 旧明文 ⇒ `""`(引擎不得使用);U 用户引用(`{file:` / `{env:`)⇒ 不动。mergeDeep 只压 `apiKey` 标量,`baseURL` / `models` 保留;`{file:}` 只在文件存在时发出 ⇒ 不会有悬空引用让整份 config 装载失败。 |
| v2 投影 | 与既有规则相同:注入表剥 `apiKey` ⇒ 该 id 在 `opencode.jsonc` 里成为 `{}`(2026-09-17 用真实 `ConfigV1 → migrate → Config` 链探针验证可解码);用户拷贝 `opencode.json` 仍带标记字面量(v2 无变量解析,列目录也不需要 key)。用户拷贝里的**旧明文不剥**:源文件仍在,剥拷贝不减少暴露;重填后随源消失(基线 I3,已知不修)。 |
| 状态面(`providers-key-status`) | 库有 ⇒ `keychain` + 末四位;标记块而库无 / 旧明文块 ⇒ `needs-reentry`(`configured:false`,无 hint);用户引用 ⇒ `config`(无 hint)。renderer / IPC 永远拿不到值;选择器把 `needs-reentry` 的行保留为不可用并提示「密钥需重填:重新添加同名服务即可覆盖」。 |
| fail closed | 钥匙串不可用 ⇒ 库拒写(不落盘、不退回明文)、`providers-add` 回错误且 alpha.jsonc 不写;库读到 `{v:1, plain}` 旧形态 ⇒ 视为不可解(空库 + 一条不含值的 warn);opencode `auth.json` **不再被读取**。目录内 BYOK 同受这三条约束。 |

## 不变量(实现与 review 都要守)

- **目录外自定义服务的密钥值只经 `custom-provider--<id>` 文件离开钥匙串库**(REQ-226 AC4 咽喉点):
  main 里**没有任何函数返回、使用或记录**配置文件里的明文密钥值(`readConfiguredProviderKeys` 与
  `retireLegacyProviderKeys` 都要 parse 同一份文件、因而明文会短暂进到 parse 结果里 —— 它们只
  **分类**,值不出函数、不进注入表、不进日志。「main 里没有任何函数把明文读进内存」是**假的**:
  `readUserProviderIds` 自己就在 parse 同一个文件,`#1359` 更正);
  注入表里目录外 id 的 `apiKey` 只可能是 `{file:…}` 或 `""`;durable 配置里没有 `{file:}`;
  启动迁移把 legacy / XDG 的 provider 块搬进 alpha.jsonc 时,`legacy-plaintext` 的
  `options.apiKey` 换成标记常量(`planConfigMerge` → `withoutLegacyPlaintextKey`,`#1359`)——
  状态面与注入面逐字不变(两类都判 needs-reentry / 都注入 `""`),变的只是值不再被复制一份。
  强制手段:`alpha-byok-keys.test.ts`(库在钥匙串不可用时拒写、不读 plain、不读 auth.json;先在旧代码上
  证明会红)、`alpha-secret-files.test.ts`(`extra` 写入 / 撤销 / 不被清扫)、`server.test.ts`(生产 fork
  路径上文件物化且 sidecar env 无值)、`alpha-models.test.ts`(三分类注入)、`ext-config.test.ts`
  (标记不写值、只返回分类)、`alpha-provider-status.test.ts`(状态面无值字段)、
  `engine-config-truth.test.ts` + `engine-config-truth-boot.test.ts`(启动迁移剥明文:断落盘后的
  **文本**里没有原值,不只断字段值)。

- **sidecar 进程内不得调用 main-only 单例**(`getAlphaEnvironment` /
  `catalogRegistryChannel`):sidecar 从不跑 `initAlphaEnvironment`,必抛;需要
  的值由 main 算好经 `StartCommand` 传入(如 `registryChannel`)。
- **`injectAlphaConfig` 内任何加固层/旁路步骤必须有自己的降级域**,不得借函数级
  catch 把 provider/权限注入一并炸掉。该条适用于排在 `OPENCODE_CONFIG_CONTENT`
  写出**之前**的步骤;排在其后的 v2 桥相反**必须**把失败交给函数级 catch 上报
  (#613 R1:桥自吞曾把「v1 成功 + v2 缺失 = 模型全灰」报成 `{ok:true}`,见下一条)。
  强制手段(#607,`packages/ui-mac/src/main/alpha-config-injection.test.ts`):正向闸门
  执行生产 composition 并锁住 content 里的 model / `enabled_providers` / provider /
  三个 alpha agent / `{file:}` ref;反向闸门用真实故障触发那层 catch,要求失败出声、
  且正向断言体在该路径上真的转红。**该闸门锁的是「注入整体不得静默失败」,
  不是「每个加固层都已各自分域」** —— 后者仍靠 review 逐处核。
- **注入失败在生产侧必须离开 sidecar 进程**(#613):`injectAlphaConfig` 返回结构化结果
  (含 v2 桥失败 —— R1 Blocker 1),sidecar 经 `buildReadyMessage`(`sidecar-ready-message.ts`,
  唯一的 ready 消息通路)随 ready IPC 上报 main;main 无条件 error 记日志(`server.ts`),
  终态生产者在健康通过时发布 `"injection-failed"`(与 `ready`/`failed` 并列的第三终态,
  同代仍恰好一个;引擎未就绪支配注入失败),renderer 据此区分「引擎未就绪」与
  「引擎就绪但注入失败」(picker 横幅)。函数级 catch 保留 —— sidecar 照常启动,
  fail-loud 不是裸崩溃。
  强制手段:`alpha-config-injection.test.ts`(返回值、v2 桥失败不得自吞、sidecar.ts 接线锚
  ——唯一通路 + 捕获值整体入参)、`sidecar-ready-message.test.ts`(**运行时**闸门:失败值
  真的在 ready 消息上;R1 实证纯文本锚可被 `injection.error && undefined` 等义变异绕过,
  故消息构造抽成 bun 可真执行的单元)、`server.test.ts`(ready IPC 透传)、
  `sidecar-generation.test.ts` / `sidecar-lifecycle.test.ts`(终态)、
  `test-component/alpha-composer-model.cases.ts`(renderer 区分,变异实跑已红)。
- **v2 文件必须能通过 `isV1 → migrate → decode` 链**:v2 解码失败是静默整文件
  丢弃,新增键前先以真实链验证(参照 2026-07-23 探针方法)。
- **v2 `model.list` 不得读取内部插件批次的中间态**:#857 以
  `packages/ui-mac/src/main/plugin-internal-boot-order.test.ts` 锁住 build output 的唯一注册被移到
  `State.batch` 前、compiled identifier 漂移可兼容而缺失/重复/歧义全部 fail-closed,并钉住
  production prebuild 接线;以
  `packages/ui-mac/src/renderer/alpha-ui/model-contract.test.ts` 锁住
  `provider.get(alpha-internal-catalog-ready) → model.list` 顺序、首读与热读集合相等,并先证明
  绕过 barrier 时替身确实暴露未治理集合。`alpha-config-injection.test.ts` 另锁 marker 在 v2
  config 投影中保持 keyless,并在 models.dev base 中只随完整 identity 投影出现;用户文件 provider
  缺投影时 base 必须无 marker、回到 late barrier。barrier 不得换成账户或网络门。
- **Alpha 治理目录不得物化全量 models.dev 快照或第二份策略真源**:
  `alpha-config-injection.test.ts` 锁定 `OPENCODE_MODELS_PATH` 指向桥目录中的最小机械 base、其
  provider/model identity 与既有 v2 provider 投影精确一致、全部条目通过上游 ModelsDev schema、
  且不含任何 key;同时锁定 `ALPHA_MODELS_DISABLE=1` 不覆盖 operator 提供的上游路径。可用
  provider/model 仍只来自既有完整配置投影,不得在 core/server 新增第二套过滤器。
- **首页目录预热必须复用真实 V2 handler 与共享 LocationServiceMap**:
  `sidecar-location-prewarm.test.ts` 锁住精确
  `/api/provider/alpha-internal-catalog-ready?location[directory]=<~/code-puppy>` → 同目录 `/api/model` 请求、与真实 sidecar
  password 对应的 `opencode` Basic auth、相对路径零调用、socket listen 前即启动、ready IPC 必须
  等它结束,以及任一 handler 非 2xx/异常只形成具名诊断。`sidecar-shared-location-map.test.ts` 锁住只有固定 Electron CORS shape 才复用
  singleton routes + 全局 memo map,其他 listener 保留 `createRoutes(opts)`;编译变量漂移可兼容,缺失、
  重复、半补丁或错 memo 一律让构建失败。不得把预热改成 main/renderer 自造模型 JSON,也不得为了
  计时跳过首次 `v2.model.list`。
- **密钥不落 v2 文件**:v2 无解析机制,写入即明文。

## 事故记录与收敛

- 2026-07-23:两层断层叠加致打包端全模型「当前不可用」——①sidecar 内调
  `catalogRegistryChannel()` 抛错炸掉整份 v1 注入;②picker 已切 v2 `/api/model`
  而 v2 读不到任何 alpha 注入通道。修复即本契约现行方案。
- 双通道是过渡态。收敛(撤 v1 注入、归一 v2 文件通道)由触发条件票跟踪:
  [alpha-code#523](https://github.com/jinjunnn/alpha-code/issues/523)——上游把
  推理与 secret 解析迁至 v2 之前不动手。
- 每次 rolling-pin 上游 sync 后,若 v1/v2 消费面分工有变(尤其推理链或变量解析),
  先更新本契约再改注入实现。
