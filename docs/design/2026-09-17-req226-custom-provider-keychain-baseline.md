---
title: REQ-226 方案基线:自定义模型服务密钥进 macOS 钥匙串,配置只留引用
kind: design
status: accepted
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-17
review_after: 2026-12-17
---

# REQ-226 方案基线 —— 自定义模型服务密钥进 macOS 钥匙串,配置只留引用

需求与验收在票面(`alpha-code#226`,owner 2026-09-17 裁决收窄为只做 macOS);实现票
`alpha-code#1343`。本基线是 `#1343` **升 Ready 的门**与其 Boundary 改写的依据。

**读法**:所有坐标以 `origin/alpha@8eb092b73`(2026-09-17)为准,写作 `文件:行`。第一节只陈述
跑过、读过的事实,不含设计;设计从第二节开始。owner 已定的结果是「存进钥匙串」;
「safeStorage 加密文件」还是「钥匙串条目」是本基线要裁的技术选型(§2)。

## 一、只读勘破(地面真相)

### 1.1 今天自定义服务的密钥怎么走(用户可达路径,逐跳)

| 跳 | 坐标 | 事实 |
| --- | --- | --- |
| 表单 | `packages/ui-mac/src/renderer/alpha-ui/model-picker-add.tsx:145-152` | 目录外「自定义端点」走 `window.api.providers.add({id, name, compat, baseURL, apiKey, models})`;目录内预设走 `:153` `providers.setKey(id, key)`(两条路**不同**) |
| IPC | `packages/ui-mac/src/main/provider-ipc.ts:14-16` | `providers-add` → `persistProviderAndRefresh` |
| 生命周期 | `packages/ui-mac/src/main/provider-lifecycle.ts:14-19` | 先 `persistProvider`,成功后 `refreshRuntime()`(= structural respawn,`index.ts:1511`) |
| 落盘 | `packages/ui-mac/src/main/ext-config.ts:1117-1129` | `:1128` 组块 `{npm, name, options:{baseURL, apiKey: input.apiKey}, models}`,`:1129` `writeKey(providerTargetPath(), ["provider", id], block)` |
| 目标文件 | `ext-config.ts:134-138` → `engine-config-truth.ts:20-22` | `providerTargetPath()` = `alphaJsoncPath()` = `<alphaGlobalRoot>/alpha.jsonc`(两个逃生 env 回 XDG) |
| **第二份明文** | `packages/ui-mac/src/main/alpha-config-injection.ts:499-508` | 每次 fork,v2 桥 `copyFileSync(alphaJsoncPath(), <userData>/alpha-engine-config/opencode.json)` **原样拷贝**;`:515` 只对注入表剥 `apiKey`,用户拷贝不剥 → 今天明文有**两份**,票面只写了一份 |
| 读回 | `ext-config.ts:1156-1173` | `readConfiguredProviderKeys()` 扫 `providerReadPaths()`(主文件 + legacy),对每个 `provider.<id>.options.apiKey` **连值返回** |
| 唯一消费方 | `packages/ui-mac/src/main/alpha-provider-status.ts:26,36,41` | `git grep readConfiguredProviderKeys` 全仓只此一处消费;以 `source:"config"` + `last4` 送 picker |
| 测试连通 | `packages/ui-mac/src/main/provider-test.ts:14-33` | main 内用原值发一次 `max_tokens:1` 请求;不落盘、不打日志;renderer 只收 `{ok,ms}` |
| 删除 | `ext-config.ts:1184-1199`;`provider-ipc.ts:26` | `removeProvider(id)` 从主文件 + legacy 删块。renderer 里 `providers.remove` 只有一处调用(`model-picker-add.tsx:174`),且只在**目录内预设**的 `source==="config"` 分支;`:165` 目录外节点直接 `return` —— **今天没有删除/编辑自定义服务的 UI**,删除只能改文件 |
| 展示 | `packages/ui-mac/src/renderer/alpha-ui/model-picker-core.ts:194-196` | 目录外 provider 只有在 `keyStatus[id].configured === true` 时才出现在选择器里;`configured:false` = **整组行消失**,不是「显示为不可用」 |

### 1.2 引擎怎么拿到密钥(上游只读;`scripts/north-star-guard.sh:84` 辖区 = 整棵 `packages/`)

- 引擎经 `OPENCODE_CONFIG` 加载 alpha.jsonc:`alpha-config-injection.ts:87` 置 env;
  `packages/opencode/src/config/config.ts:406-407` `loadFile` → `loadConfig` `:217-229` 先
  `ConfigVariable.substitute` 再解析。`packages/opencode/src/config/variable.ts:36-40` 展开
  `{env:VAR}` 与 `{file:path}`。
- **`{file:}` 指向不存在的文件 = 整个 config 装载失败**:`variable.ts:35` `missing` 缺省
  `"error"`,`:70-81` 抛 `InvalidError`。不是单个 provider 失败,是引擎起不来。仓内已知并写在
  `alpha-config-injection.ts:296-297`。
- 合并序(`config.ts`):XDG global → `OPENCODE_CONFIG`(alpha.jsonc,`:406`)→ 项目 →
  `OPENCODE_CONFIG_CONTENT`(**最后**,`:473-478`)。合并器 `mergeConfigConcatArrays` `:45-51`
  = remeda `mergeDeep`(装着的 `remeda@2.26.0`,`dist/mergeDeep.d.ts`:双方都是 plain object 的
  属性递归合并,其余 source 胜)。⇒ 注入表里的 `provider.<id>.options.apiKey` 标量会**压过**
  alpha.jsonc 同 id 的 `apiKey`,而同块的 `baseURL`、`models` 保留。
- 引擎装配 provider:`packages/opencode/src/provider/provider.ts:1451-1460` config 源进表
  (`options: mergeDeep(existing.options, provider.options)`),`:1617-1624` 再合一次;
  `:1751` 只在 `options.apiKey === undefined` 时才补 env 派生 key;config 源 `autoload:true`
  (`:479`)—— **没 key 的 config provider 照样列出,首次调用时由 SDK 报缺 key**。
- v2 面(`docs/contracts/engine-config-channels.md` 表「变量解析:无」):picker 的模型清单来自
  `<userData>/alpha-engine-config/` 目录,v2 不解析 `{file:}`,也不需要 key。
- 引擎 env:A6 allowlist `packages/ui-mac/src/main/sidecar-env.ts` 默认拒;`:12` 明写自定义
  provider 的 `{env:MY_VAR}` 已失效,**只剩 `{file:}` 一条通道**。

### 1.3 已有的钥匙串库与文件通道(目录内 BYOK 今天怎么走)

- 库:`packages/ui-mac/src/main/alpha-byok-keys.ts`。「钥匙串」= Electron `safeStorage` 加密的
  **一个 JSON 文件** `<userData>/alpha-byok-keys.json`(`:24`,`:44-50`)。
  - `:51-55` `safeStorage` 不可用时**落明文** `{v:1, plain}`;`:68` 读侧接受 `plain`;`:74-79`
    钥匙串可用时把 plain 重加密(自愈)。
  - `:93-118` `migrateFromOpencodeAuth()`:从 opencode `auth.json` 搬**目录内**密钥,`:124` 每次
    启动调用。它搬的不是 alpha.jsonc 里的自定义服务明文。
  - `:158-165` `setByokKey(id, key)` 不限 id;但 `:40-42` `keyEnvFor` 对目录外 id 返回
    `undefined`,`:134-135` `injectByokKeysIntoEnv` 静默跳过 ⇒ **今天就存在的暗门**:目录外 id
    存进这个库后,`alpha-provider-status.ts:40` 会显示「钥匙串·已配置」,而引擎永远拿不到。
  - 无自己的测试文件;`alpha-provider-status.test.ts:13` 用 `mock.module` 把它整个换掉。
    仓内 `mock.module("electron", …)` 先例:`alpha-auth.cases.ts:14`、`alpha-surfaces.test.ts:7`
    ⇒ 可用假 `safeStorage` 驱动**真实的** `alpha-byok-keys.ts`,不需要为可测性重构。
- 通道(A6,`packages/ui-mac/src/main/alpha-secret-files.ts`):
  - `index.ts:742-743` app ready 后 `initByokKeys` + `injectByokKeysIntoEnv`(解密后写进 **main**
    的 `process.env`);`:613-616` 注释记着为什么不能更早(ready 前 safeStorage 不可用 → 曾走明文兜底)。
  - 每次 fork `packages/ui-mac/src/main/server.ts:352` `syncSecretFiles(userDataPath)`:把
    `secretEnvVars()`(`alpha-secret-files.ts:36-39`,**静态清单** = 平台三项 + 目录 keyEnv)镜像成
    `<userData>/alpha-secrets/<VAR>`(0600 / 目录 0700);env 缺席则删文件;**目录里不在清单里的
    文件一律清扫**(`:88-93`)。写失败 = 拒绝 fork(`server.ts:353-365` 注释,fail closed)。
  - sidecar `packages/ui-mac/src/main/alpha-models.ts:69` 按 `hasSecretFile` 决定注入目录 BYOK
    节点,`:96` 写 `apiKey: secretFileRef(...)` = `{file:<abs path>}`;`:145-147` 把
    `readUserProviderIds()` 并进 `enabled_providers`(定义本身仍来自 alpha.jsonc)。
  - 改键即时生效:`index.ts:1514-1519` `setByokKeyDeps({onChanged: 重注 env + structural respawn})`。
- **诚实一句**:目录内 BYOK 的「钥匙串保护」= **静态副本加密 + 运行期 0600 明文镜像文件**。镜像
  不随退出删除,只在下次 fork 按 env 增删;`alpha-secret-files.ts:19-21` 自己写明这是 accepted
  residual risk(同 UID 进程主动去读仍读得到,A6 关的是被动继承通道)。自定义服务进钥匙串后与之
  **同等**,不更强。
- 清除:`packages/ui-mac/src/main/data-clear.ts:55-60` 凭证清单已含 `alpha-byok-keys.json` 与
  `alpha-secrets/`;`data-clear-boot.ts:182-183` 先清库再撤 env。
- 重签名:`ADR-017-desktop-auth-deeplink.md:31` —— ad-hoc 重打包后旧密文不可解 → 重录;
  `alpha-byok-keys.ts:82` 同款处理(起空库)。

### 1.4 本机 Electron 对钥匙串类方案的支持(读装着的那个版本)

- `packages/ui-mac/node_modules/electron/package.json` → **42.3.3**(`packages/ui-mac/package.json:69`
  钉死)。`electron.d.ts:11786-11849` 的 `SafeStorage`:`isEncryptionAvailable()`、
  `encryptString/decryptString`、`encryptStringAsync/decryptStringAsync`(后者回
  `{shouldReEncrypt, result}`)、`getSelectedStorageBackend()` 与 `setUsePlainTextEncryption()`
  (两者**仅 Linux**)。**没有**逐条目读写钥匙串的 API。
- macOS 上 safeStorage 的形态:Chromium 在登录钥匙串存一把「`<App> Safe Storage`」对称密钥,
  **密文由我们自己落盘**;密钥不随文件走 ⇒ 密文文件被备份/同步走了也解不开。
- 仓内**没有**逐条目钥匙串库:`ls node_modules/.bun | grep -i 'keytar\|@napi-rs\|keychain'` 零命中;
  `packages/ui-mac/package.json` 依赖里没有任何原生钥匙串模块。
- 现有 safeStorage 消费者两处,模式一致:`alpha-auth.ts:174-181`(同款 plain 兜底;但读侧
  `:202-204` 遇「有密文而 safeStorage 不可用」→ **保持登出,不降级**)与 `alpha-byok-keys.ts`。

### 1.5 全称事实核对(每条跑过)

- `readConfiguredProviderKeys` 的消费方只有 `alpha-provider-status.ts`(`git grep`,§1.1)。
- `providers.remove` 在 renderer 只有一处调用,且到不了目录外节点(§1.1)。
- 直接测 `persistProvider` 的用例:`ext-config.test.ts`(import 行 `:10`)与
  `alpha-models.test.ts:203-215`(`apiKey:"sk-test"`,只断言 `enabled_providers`)。
- id 字符集 `packages/ui-mac/src/shared/extension-name.ts:1`
  `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/` → 不含 `}` `/` 空白,可直接作文件名段与 `{file:}` 路径段
  (上游匹配器 `\{file:[^}]+\}`,`alpha-secret-files.ts:49-50`)。
- 目录外 id 由 renderer `slug(name)` 生成(`model-picker-add.tsx:128`),main 侧
  `persistProvider` 只校验 `isExtensionName`,**不排除**与目录 id(如 `deepseek-byok`)同名。

## 二、选定方案与被否决的替代

### 2.1 选定:复用 safeStorage 钥匙串库 + A6 `{file:}` 通道;durable 配置只写常量标记,`{file:}` 引用只在 fork 时按「密钥文件在场」注入

一句话:**让自定义服务与目录内 BYOK 走同一条路**,差别只在「定义来自 alpha.jsonc 而不是目录」。

1. **存**。`persistProviderAndRefresh` 拆成两步、先后有序:①密钥进 `alpha-byok-keys` 库
   (`providerId → key`,库内不区分目录内外);②alpha.jsonc 写
   `{npm, name, options:{baseURL, apiKey: "alpha-keychain"}, models}`。①失败(钥匙串不可用)⇒ **不写②**,
   把 reason 回给表单。`"alpha-keychain"` 是**常量**:不含密钥派生片段、不含路径、不含 id —— 引用的
   语义是「这个 provider id 的密钥去钥匙串找」,满足票面设计要点「reference 不包含 secret 衍生片段
   或可预测文件路径」。
2. **物化**。每次 fork 前(`server.ts:352` 那一处),main 从库里取「alpha.jsonc 里的目录外 id ∩ 库键集」
   的密钥,**直接**交给 `syncSecretFiles` 的新参数 `extra: Record<name, value>`(不经 `process.env`),
   文件名 `custom-provider--<id>`;这些名字并入 wanted 集(否则 `alpha-secret-files.ts:88-93`
   下一次 fork 就把它们扫掉)。缺席 ⇒ 同一函数删文件(与目录 BYOK 同一撤销语义)。
3. **注入**。sidecar `buildAlphaModelConfig`(`alpha-models.ts:145-147` 一带)对 alpha.jsonc 里每个
   目录外 id,按块内 `options.apiKey` 三分类决定注入表里的 `provider.<id>.options.apiKey`:

   | 类 | 判据(alpha.jsonc 块内 `options.apiKey`) | 密钥文件在场 | 注入 |
   | --- | --- | --- | --- |
   | K 托管 | `=== "alpha-keychain"` 或字段缺席 | 是 | `secretFileRef(userData, "custom-provider--<id>")` |
   | K 托管 | 同上 | 否 | `""`(压掉标记;引擎正常启动,该 provider 首次调用被远端 401 拒绝) |
   | L 旧明文 | 非空字符串,且不是标记、不以 `{file:` / `{env:` 开头 | 任意 | `""`(**压掉明文,引擎不得使用**);库里不建条目 |
   | U 用户引用 | 以 `{file:` / `{env:` 开头 | 任意 | 不动(power-user 逃生口,`sidecar-env.ts:12` 已文档化;本票不接管) |

   mergeDeep(§1.2)保证注入的标量压过 alpha.jsonc 的值而 `baseURL`/`models` 保留;`{file:}` 只在
   `hasSecretFile` 为真时发出 ⇒ **durable 配置里永远没有 `{file:}`,注入表里永远没有悬空引用**。
4. **状态**。`getProviderKeyStatus` 对目录外 id:库有 ⇒ `configured:true, source:"keychain", hint:last4`;
   块为 L、或块为 K 而库无(钥匙串不可用 / 重签后不可解 / 条目缺失)⇒
   `configured:false, source:"needs-reentry"`,**无 hint**(AC7「不读取」)。
   `readConfiguredProviderKeys()` 改成**只返回分类、不返回值**
   (`Map<id, "keychain-marker" | "legacy-plaintext" | "user-ref">`)—— 这样 main 里**再也没有一个函数**会把
   配置文件里的明文密钥读进内存,这是 AC7 的咽喉点。
5. **提示重填**(最小 UI,无新组件)。`model-picker-core.ts:194-196` 的过滤从 `configured` 改为
   「`configured` 或 `source==="needs-reentry"`」;`needs-reentry` 的行用**已有的**
   `availability:"unavailable"` + `reason` 形态,文案「密钥需重填:重新添加同名服务即可覆盖」
   (`i18n/zh.ts`、`en.ts` 各一条)。今天没有编辑/删除自定义服务的 UI(§1.1),重填 = 用同名重新
   添加,`slug(name)` 得到同一 id,`persistProvider` 整块覆盖,旧明文随之消失。
6. **库的 fail-closed**(AC6)。删 `alpha-byok-keys.ts:51-55` 明文写、`:68` plain 读、`:74-79` 自愈:
   `isEncryptionAvailable()===false` 时 `persist` 返回失败并**不落盘**,`setByokKey` 回
   `{ok:false, reason}`;读到 `plain` 形态 ⇒ 视为不可解 ⇒ 空库 + 一条 warn(值不进日志)。
   同库共用 ⇒ 目录内 BYOK 同受约束(票面 Boundary 已要求「一并处理」)。
7. **删 auth.json 迁移**(`:93-118` + `:124`)。它是 2026-06-29 设计 §0.4 的一次性迁移,已过 2.5 个月,
   除本机外零租户(owner 2026-08-31);留着它 = 每次启动读一个第三方明文文件。删后目录内某 key
   若只存在于 auth.json,需重填一次 —— 与本票「重填一次」口径一致。
8. **删除服务**。`providers-remove`(`provider-ipc.ts:26`)编排:先 `removeByokKey(id)`(库删 + 触发
   respawn),再 `removeProvider(id)`。任一半失败的终态都无泄漏:库删了配置没删 ⇒ 块带标记、状态
   needs-reentry;配置删了库没删 ⇒ 库里孤儿条目(密文,且因 id 不在 alpha.jsonc 不会被物化)。

**反问「能否让本系统成为权威、外部无从覆盖」**:能。引擎从不决定密钥来源 —— 它只消费合并序最后的
`OPENCODE_CONFIG_CONTENT` 里 sidecar 写的 `apiKey` 标量;alpha.jsonc 里无论是标记、旧明文还是
手写引用,K/L 两类**总是**被注入表压倒,引擎能用的密钥只来自密钥文件,密钥文件只来自钥匙串库。
U 类是刻意保留的逃生口,不是覆盖面。

**AC4 咽喉点**:原值离开钥匙串库的唯一通路 = fork 前 `syncSecretFiles(…, extra)` 写
`<userData>/alpha-secrets/custom-provider--<id>` → 引擎经 `{file:}` 读。其余读库的函数只返回
last4(`getProviderKeyStatus`)。

### 2.2 被否决的替代

| 替代 | 为什么否 |
| --- | --- |
| **A. 钥匙串逐条目**(`SecItemAdd`,经 keytar / `@napi-rs/keyring` / 自写 native addon) | 仓内没有该依赖,Electron 42.3.3 无此 API(§1.4);要新增原生模块 ⇒ electron-builder 重编译、签名/公证矩阵、fork-sync 面。**而且引擎仍只能经 `{file:}` 文件拿值** —— 条目并不消除运行期镜像。相对 safeStorage 的唯一差别是「密文放钥匙串数据库而不是我们的文件」,而 safeStorage 的密钥本来就不随文件走(§1.4)。收益零、成本大。 |
| **B. `{file:}` 引用直接写进 alpha.jsonc**(`alpha-mcp-secrets` 的写法) | 引用指向缺席文件 ⇒ **整个引擎 config 装载失败**(§1.2),AC6 要求的「该 provider 调用 fail closed」变成「整个应用失能,且进不了 picker 重填」;另在 durable 配置里埋绝对 userData 路径。 |
| **C. main 做本地反向代理**(引擎只拿 loopback URL + 假 key,真 key 只在 main 内存) | 真正让 main 成为唯一权威,但同 UID 进程可直接打 loopback 用密钥 ⇒ 仍需 per-fork 令牌经 `{file:}` 交给引擎 ⇒ 镜像文件没消失,只是内容从长期密钥换成会话令牌;另需 SSE 流式代理、TLS 出站、与 REQ-159 进程围栏网络面的互动。L 级新子系统换边际收益,owner 没要。将来若要收紧「运行期明文镜像」,这是方向。 |
| **D. 保持现状** | 两份明文(alpha.jsonc + v2 桥拷贝,§1.1)。 |
| **E. 引擎侧 `@alpha-code/ext` 自己解析** | ext 跑在引擎进程(utilityProcess)内,拿不到 safeStorage(`alpha-provider-status.ts:3-9` 记着的崩溃);仍需文件。 |
| **F. 复用 env 桥**(`injectByokKeysIntoEnv` 给目录外 id 派生 keyEnv) | 可行但多一层:密钥常驻 main `process.env`(main 派生的任何非 sidecar 子进程都继承),而目录外 id 没有「用户在 shell/alpha.env 自设 keyEnv」这个 env 桥存在的理由。直接库→文件更短、不变量更强。 |

## 三、安全面:整类边界与不变量

| # | 类 | 不变量(实现必须守住) | 判据 |
| --- | --- | --- | --- |
| I1 | 钥匙串不可用(headless / ready 前 / 重签后不可解 / 密文损坏) | 库在 `isEncryptionAvailable()===false` 时**拒写**(返回错误,不落盘)、**拒读** plain 形态(当作空库)、永不写 plain。目录内 BYOK 同受约束。`persistProviderAndRefresh` 在库失败时不写配置。 | `alpha-byok-keys.test.ts`(新,`mock.module("electron")` 驱动真库):**先**用旧代码证明 unavailable 会写 `plain`(已知的坏被抓到),再断言新代码 `{ok:false}` 且文件不存在;`plain` 形态输入 ⇒ 空库 |
| I2 | 密钥进日志 / 崩溃报告 / 导出 | `ProviderInput` / `ProviderTestInput` 整对象与 `apiKey` 字段不得作为任何 `getLogger()` 调用的参数;`syncSecretFiles` 只返回名字(已是,`alpha-secret-files.ts:61`;`server.ts:353` 打印名字);`exportDebugLogs` 打包 main.log(`index.ts:618`)。库解密后常驻内存 map(`alpha-byok-keys.ts:27`)与目录 BYOK 今天相同,minidump 面**不变、不收紧**(已知不修,同类风险目录 BYOK 已接受)。 | logger spy 用例:persist / test / remove / status 四条路径的 logger 参数序列化后不含输入密钥 |
| I3 | 旧明文(alpha.jsonc、legacy 路径、v2 桥拷贝) | main 不读值(`readConfiguredProviderKeys` 只返回分类);sidecar 对 L 类压 `""`;库不为 L 类建条目(不迁移)。v2 桥拷贝在用户重填前仍含明文 —— 源文件本身还在,剥拷贝不减少暴露,**不做**;重填后随源消失。 | `ext-config.test.ts`:`readConfiguredProviderKeys` 返回值类型不含字符串值;`alpha-models.test.ts`:L 类 ⇒ `apiKey:""`;`alpha-provider-status.test.ts`:L 类 ⇒ `needs-reentry` 且无 `hint` |
| I4 | 多个自定义服务 / 命名碰撞 | 文件名 `custom-provider--<id>`(id 已由 `isExtensionName` 限定,不与全大写的目录 var 名碰撞);物化集合 = alpha.jsonc 目录外 id ∩ 库键集。`persistProvider` **拒绝**与目录 `byokProviders[].id` 同名的目录外 id(§1.5:今天不排除;撞名 ⇒ 两条注入路径对同一 id 各写一份 `options`,谁压谁取决于对象键序) | `ext-config.test.ts`:id 撞目录 ⇒ `{ok:false}`;`alpha-secret-files.test.ts`:两个 extra 名各自写、缺席各自删、不被清扫 |
| I5 | 删除服务 | `providers-remove` 先库后配置;下次 fork 文件因不在 wanted 集被 `syncSecretFiles` 清扫;凭证清除(data-clear)已覆盖库文件与 `alpha-secrets/`(§1.3),**无新文件要登记** | `alpha-secret-files.test.ts`:extra 里不再有的名字 ⇒ 文件删除 |
| I6 | renderer / IPC 面(AC3) | 无任何 IPC 返回密钥值;`providers-key-status` 只回 `{configured, source, hint}`;不新增 IPC 通道(preload 不动;`ipc-channel-binding-census.test.ts` 因此不受影响)。renderer 持有的只有用户**正在输入**的值。 | `alpha-provider-status.test.ts`:目录外 id 的返回对象无值字段;`preload/index.ts` 零 diff |
| I7 | 引擎 env / 子进程继承 | 密钥不进 main `process.env`(库→文件直达)、不进 sidecar env(A6)、不进 `OPENCODE_CONFIG_CONTENT` 字面量(只 `{file:}`) | `alpha-models.test.ts`:注入表里目录外 id 的 `apiKey` 只可能是 `{file:…}` 或 `""` |
| I8 | 悬空引用(引擎整体失能) | `{file:}` 只由 sidecar 在 `hasSecretFile` 为真时发出;alpha 写入的 durable 块里永远不出现 `{file:}` | `alpha-models.test.ts`:文件缺席 ⇒ 注入表**无** `{file:` 子串;`ext-config.test.ts`:`persistProvider` 写出的文本无 `{file:` 且无输入密钥 |
| I9 | 测试假象(「绿但没测生产路径」) | 库的用例必须驱动真实 `alpha-byok-keys.ts`(mock 的是 `electron`,不是库);`alpha-provider-status.test.ts:13` 现有的整库 mock 只能覆盖状态逻辑,不得当作 I1 的证据 | 见 I1 判据的「先红后绿」 |

**已知不修、留痕**:`alpha-auth.ts:177-181` 的同款 plain 兜底(平台登录 token,不是模型密钥;
`:202-204` 读侧已 fail closed)不在本票;运行期镜像文件退出即删(会改所有密钥的行为,含平台
token)不在本票;自定义服务的编辑/删除 UI 不在本票。三者若要做,各自立新 REQ。

**给 owner 的一句非 AC 说明**(建议,不入票面):本方案交付后,自定义服务密钥的保护等级 = 目录内
BYOK 今天的等级(静态密文 + 运行期 0600 明文镜像),不高于它。这是 owner 裁决「与目录内服务一样
存进钥匙串」的字面结果;要更高需要 §2.2 C 那类新子系统。

## 四、子票切分与 `#1343` Boundary 改写

**一张 CODE 票够**(`alpha-code#1343`):一条可独立评审的变更线,同一子系统,无跨仓契约、无新
IPC 通道、无原生依赖。可以拆成两个 PR 但**必须先合库加固**(§2.1 第 6、7 条)再合自定义服务接线,
避免中间态「新密钥进了一个还会落明文的库」;第一个 PR 用 `Refs`,最后一个用 `Fixes`。

### 4.1 `#1343` 的 Boundary 应改成(指名文件与契约)

- `packages/ui-mac/src/main/alpha-byok-keys.ts`:删 `:51-55` 明文写、`:68` plain 读、`:74-79` 自愈、
  `:93-118` + `:124` auth.json 迁移;`persist` 失败可回传;新增「按 id 集合取密钥供物化」的只读接口。
- `packages/ui-mac/src/main/alpha-secret-files.ts`:`syncSecretFiles(userDataPath, env, extra)`,
  extra 名并入 wanted 集;文件名约定 `custom-provider--<id>`。
- `packages/ui-mac/src/main/server.ts:352`:调用点传 extra(= alpha.jsonc 目录外 id ∩ 库键集)。
- `packages/ui-mac/src/main/ext-config.ts`:`persistProvider` `:1117-1129` 写标记不写原值,拒绝撞目录 id;
  `readConfiguredProviderKeys` `:1156-1173` 只返回分类;`removeProvider` `:1184` 不变。
- `packages/ui-mac/src/main/provider-lifecycle.ts:14-19`:先库后配置,库失败不写配置。
- `packages/ui-mac/src/main/provider-ipc.ts:26`:`providers-remove` 先 `removeByokKey` 再 `removeProvider`。
- `packages/ui-mac/src/main/alpha-models.ts:145-147` 一带:目录外 id 的三分类注入(§2.1 表)。
- `packages/ui-mac/src/main/alpha-provider-status.ts`:目录外 id 的 `keychain` / `needs-reentry`;
  `packages/ui-mac/src/shared/alpha-model-types.ts:191-199` `source` 联合加 `"needs-reentry"`。
- `packages/ui-mac/src/renderer/alpha-ui/model-picker-core.ts:194-196`:`needs-reentry` 的行保留为
  `unavailable` + reason;`i18n/zh.ts`、`i18n/en.ts` 各加一条文案。无新组件、无设计稿。
- 测试:新 `alpha-byok-keys.test.ts`;改 `alpha-secret-files.test.ts`、`ext-config.test.ts`、
  `alpha-models.test.ts`、`alpha-provider-status.test.ts`、`model-picker-core.test.ts`。
- 文档:`docs/contracts/engine-config-channels.md` 加一段「目录外自定义服务密钥经同一 `{file:}` 通道、
  引用只在 fork 时注入」;本基线 `status: accepted`。
- **不动**:`packages/ui-mac/src/preload/**`(无新通道)、`alpha-auth.ts`、`alpha-mcp-secrets.ts`、
  `data-clear.ts`(无新文件)、`packages/opencode/**`(north-star 辖区)。

### 4.2 AC ↔ 证据(将来拿什么证明;只写名字)

| AC | 证据 |
| --- | --- |
| AC1 只存引用 | `ext-config.test.ts`:添加后 alpha.jsonc 文本含 `"alpha-keychain"`、不含输入密钥、不含 `{file:` |
| AC2 macOS 打包版由钥匙串保护 | 随下一次 RC 冒烟:打包版添加一次自定义服务,读回 alpha.jsonc 只见标记(票面已写,不挡本票) |
| AC3 renderer / IPC 读不到 | `alpha-provider-status.test.ts`:目录外 id 返回无值字段;`preload/` 零 diff |
| AC4 咽喉点 | `alpha-models.test.ts`(三分类注入)+ `alpha-secret-files.test.ts`(extra 写入/撤销/不被清扫)+ logger spy(I2) |
| AC6 fail closed + 提示 | `alpha-byok-keys.test.ts`(I1,先红后绿)+ `alpha-models.test.ts`(缺席 ⇒ `""` 且无 `{file:`)+ `model-picker-core.test.ts`(`needs-reentry` 行可见且不可用) |
| AC7 旧明文不读、不迁、不进日志 | `ext-config.test.ts`(只返回分类)+ `alpha-provider-status.test.ts`(L ⇒ `needs-reentry` 无 hint)+ `alpha-byok-keys.test.ts`(auth.json 在场 ⇒ 库不变)+ logger spy |

### 4.3 `#226` 复杂度建议

票面标 **L**(「凭据生命周期、跨 OS 安全存储和 packaged 验证」)。收窄后:单 OS、复用既有库与通道、
无原生依赖、无跨仓契约、无迁移(硬切)、无新 IPC ——剩下的是**在同一子系统里把已有安全机制扩到
第二类密钥**。建议**重评为 M**(涉外部系统真实行为的 M 级,本基线即其升 Ready 门;Codex 预算
≤2 轮)。若编排器坚持「安全面即 L」,差别只在预算(开发前 ≤3 + 合并前 ≤3),不影响本基线内容。

## 五、与本基线相关的既有文档

- [`2026-06-29-llm-auth-routing/design.md`](2026-06-29-llm-auth-routing/design.md) §0.4 / §3.2:
  「auth 全归 alpha」「BYOK key 存 safeStorage 钥匙串」—— 本基线把目录外节点并入同一决定。
- [`../contracts/engine-config-channels.md`](../contracts/engine-config-channels.md):v1/v2 双代与
  `{file:}` 通道的契约;实现落地时补一段(§4.1)。
- `packages/ui-mac/src/main/alpha-secret-files.ts:1-24` 文件头:A6 通道的设计与 accepted residual risk。
