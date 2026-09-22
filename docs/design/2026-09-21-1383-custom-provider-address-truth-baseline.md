---
title: "#1383 方案基线:自定义节点的服务地址改存围栏写不到的真源"
kind: design
status: proposed
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-21
review_after: 2026-12-21
---

# `#1383` 方案基线 —— 自定义节点的服务地址改存围栏写不到的真源

票面 `alpha-code#1383`(L 级 DECIDE),被它挡着的是 `alpha-code#1381`(用户自配的远程 MCP
同样连不上)。本基线是那两张票**升 Ready 的门**。

**读法**:坐标以 `origin/alpha@129afb8ab`(2026-09-21)为准,写作 `文件:行`。第一节只陈述**读过、
跑过**的事实,不含设计;设计从第二节起。

## 一、只读勘破(地面真相)

### 1.1 围栏的可写集:三个"看起来像我们自己的地方"都在里面

权威在 `packages/ui-mac/src/main/process-fence-profile.ts`(文件头自称唯一权威,并写明"围栏装上
之后不能加宽")。`WRITABLE_ROOT_IDS`(`:44-64`)共 19 行,与本票相关的:

| 行 | 路径 | 结论 |
| --- | --- | --- |
| W1 | 用户打开的工作区(启动时并集) | 引擎可写 |
| W2 | `<alphaGlobalRoot>` = `<appData>/alpha-code-state/env/<env>` | **引擎可写 —— `alpha.jsonc` 就在这里** |
| W3 | `<userDataPath>` | 引擎可写 |
| W6 | `<XDG_CONFIG_HOME>/opencode` | 引擎可写 |
| W16 | `<HOME>/.opencode` | 引擎可写 |

渲染成 seatbelt 规则在 `:137-181`(W2 是 `:155` 的 `(subpath "<alphaGlobalRoot>")`),默认 `deny
file-write*` 兜底(`:152`)。`dropped` / `excluded` 只作用于 W1 的工作区并集(`:302-333`、`:367-394`),
与其它根无关。

**不在**可写集里的位置(逐条核过 19 行):app bundle 的 `Contents/Resources`(`process.resourcesPath`
仅在 `server.ts:182,424` 用于**寻址**原生模块,从不作为写入根);以及 `<appData>/alpha-code-state/`
这个**父目录本身** —— W2 只授到它下面的 `env/<env>`。

### 1.2 已经有一个"main 写得了、引擎写不到"的先例

`<appData>/alpha-code-state/cas/`(扩展 CAS 存储)是 `env/<env>` 的兄弟目录,**不在任何 W 行之下**。
sidecar 侧的写盘调用点登记簿 `scripts/process-fence-write-sites.tsv`(86 行,REQ-159 AC3 的判据)
里每一行都要点名自己落在哪个 W 根之下:实际分布是 W3×35、W2×14、W1×10、`arg`×7、W2+W6+W1×6、
W16×4,外加 **2 行 `main-only`**(都在 `alpha-environment.ts` 的 mkdir/rmdir)。**没有任何一行解析到
`alpha-code-state/cas`** —— 它的写入方是 main 侧(`ext-cas-gc.ts:266` 一带)与 main 派生的 GC worker,
不在围栏之内;引擎只**读**它(扩展从那儿装载),读在围栏里从不被拒。即:这个形状今天已经在生产里
跑着,不是新发明。

### 1.3 自定义节点今天怎么存

写入链:`model-picker-add.tsx` 的 `save()` → preload `providers.add`(`preload/index.ts:390`)→
`provider-ipc.ts:14-16` → `provider-lifecycle.ts`(先密钥、后配置)→ `ext-config.ts:1149-1157`
`persistProvider()`:

```ts
const block = { npm, name: input.name, options: { baseURL: input.baseURL, apiKey: PROVIDER_KEYCHAIN_MARKER }, models }
return writeKey(providerTargetPath(), ["provider", input.id], block)
```

落点 `providerTargetPath()`(`ext-config.ts:130-138`)→ `engine-config-truth.ts:19-20`
`alphaJsoncPath()` = `<alphaGlobalRoot>/alpha.jsonc` —— **即 W2 之下**。

字段清单(`ProviderInput`):`id` / `name` / `compat`(`openai` | `anthropic`)/ `baseURL` /
`apiKey` / `models: string[]`。

`#1343`(REQ-226)之后,**密钥**已经搬走:`alpha-byok-keys.ts` 用 Electron `safeStorage`
(`alpha-keychain-backend.ts:12-18`,仓内无 keytar)加密后落 `<userData>/alpha-byok-keys.json`,
再经 `syncSecretFiles` 物化成 `{file:}` 引用给引擎;**地址没有跟着搬**,仍在上面那一行。

### 1.4 出网围栏今天怎么算放行集合,以及为什么它不读配置文件

静态半场 `network-egress-registry.ts` 是编译进包的常量。动态半场
`network-egress-derived.ts:102-114` `deriveEgressDestinations()` 只从**注入面**
`buildAlphaModelConfig(userDataPath).provider` 派生;文件头 `:20-30` 与
`docs/architecture/2026-09-10-network-egress-on-process-fence.md:361-395` 记着为什么不读文件:

> 引擎树里任意一段代码(bash 工具、被打开仓库自带的 plugin、MCP stdio 子进程)只要写一行
> `{"provider":{"x":{"options":{"baseURL":"https://exfil.example"}}}}` —— 这个写操作在围栏内是被
> 允许的 —— 下一次 fork 后 `exfil.example:443` 就进了放行集合。

重算时机:每次 fork 前整份替换(`server.ts:442` → `:155-170`),日志即 `server.ts:159-160` 那句
`network egress: N configured model destination(s) authorized for this generation`。

注入面 `buildAlphaModelConfig`(`alpha-models.ts:48`)里,目录内 BYOK 供应商来自**编译进包**的
`CATALOG.byokProviders` + 密钥文件在场(`:68-69`),所以 `#1380` 之后它们恢复了;自定义节点不在
这条路上。

### 1.5 一个此前没被点名的同形面

`enabled_providers` 的注入用 `readUserProviderIds()`(`ext-config.ts:1164-1172`),它**读的正是
`alpha.jsonc` 的 `provider` 键名集合**。也就是说:引擎往配置里写一个 provider,它的 **id** 今天
会进 `enabled_providers`。它的调用**发不出去**(地址不在放行集合,`#1380` 之后由 1.4 挡住),但
"配置文件里的东西能影响注入面"这条缝是存在的,本基线的不变量必须覆盖它。

## 二、选定方案与被否决的替代

### 选定:把自定义节点的**记录整体**搬到围栏写不到的真源目录,注入面从它派生

- 真源:`<appData>/alpha-code-state/custom-providers/<env>.json`,与 `env/` 和 `cas/` 同级,
  **不在任何 W 行之下**(1.1/1.2)。只有 main 写,任何人可读。
- 内容:`{ v: 1, providers: [{ id, name, compat, baseURL, models }] }`。密钥**不进这里**,
  仍在 `#1343` 的钥匙串库(两者职责不变)。
- 注入面:`buildAlphaModelConfig` 从真源发出自定义节点,形态与目录内 BYOK 节点同构
  (`npm` / `baseURL` / `models` / `apiKey: {file:}`);`readUserProviderIds` 改为从真源取 id。
  **自定义节点不再依赖 `alpha.jsonc`** —— 一处真源,不留镜像。
- 出网:`deriveEgressDestinations` 因此自动把它们算进放行集合(它已经只读注入面,**这部分零改动**)。

为什么是它:
①"引擎改不到"由**文件系统边界**给出,一条 `grep` 就能复核,不依赖任何加密假设;
②生产里已有同形先例(`cas`);③egress 的派生代码一行不用改 —— 风险面只在写入与装载。

### 否决 A:把地址塞进 `#1343` 的 safeStorage 加密文件

看起来最省事(密钥已经在那儿)。否决理由:那个文件在 `<userData>`(W3)**之内**,引擎写得了。
它的完整性依赖"引擎伪造不出合法密文",而这条**我们没有验过**:sidecar 是同一个 bundle 的
`utilityProcess`,登录钥匙串里那把 safeStorage 密钥的 ACL 是否对它开放,仓内没有任何实测。
**把一条没跑过的假设放进安全边界的地基,正是 REQ-127 那次立错闸门的形状。** 若将来要用它,
先补一条实测(在围栏内尝试 `encryptString` / 读那把密钥),再谈。

### 否决 B:放进 app bundle `Contents/Resources`

引擎确实写不到,但**我们自己也写不到**(签名产物),存不了用户数据。

### 否决 C:地址仍留在 `alpha.jsonc`,靠"用户确认"把关

形态是扩展信任门那套(`ext-ipc.ts:483,545` 的原生对话框 + 版本化 consent)。否决理由:
它把"这个地址是不是你加的"变成一道**人工判断题**,而人会点"允许";且每次引擎改写配置都要再弹一次,
是把安全边界换成打扰。可以作为**选定方案之上**的加固(§3 不变量 I4 里留了口子),不作为真源。

### 否决 D:放宽围栏可写集,让派生重新读配置文件

票面 out-of-scope,`#1380` 的审计已按同一理由否过一次。

## 三、安全面:整类攻击与实现必须守住的不变量

| 攻击类 | 今天 | 选定方案下 |
| --- | --- | --- |
| A1 引擎自身(bash 工具)写配置新增 provider | 能写,且 id 进 `enabled_providers`;地址不放行 | 能写,但**注入面不再看它** |
| A2 被打开仓库自带的 plugin / `.opencode` 扩展写配置 | 同 A1 | 同 A1 |
| A3 MCP / LSP 子进程写配置 | 同 A1(继承围栏) | 同 A1 |
| A4 迁移期:旧 `alpha.jsonc` 里已有的 provider 块**可能已被上述任一方写过** | —— | **不得静默采信**(见 I3) |
| A5 篡改/删除真源文件 | —— | 围栏内写不到;main 写入用原子替换 + 解析失败 **fail-closed**(不放行、不注入) |
| A6 经 IPC 诱导 main 写入 | renderer 才有 IPC 面;引擎没有 | 不变,但写入点必须保持"只从 renderer 的用户动作进" |

不变量(实现票必须各有判据):

- **I1 单一真源**:自定义节点的 `baseURL` 只有一处权威 = 真源文件;`alpha.jsonc` 的 `provider.*`
  **不得**再参与注入面与放行集合的派生(含 `readUserProviderIds`)。
- **I2 真源路径不在可写集内**:一条判据枚举 `WRITABLE_ROOT_IDS` 的全部 19 行,断言真源路径不被
  任何一行覆盖 —— 将来有人加一行把它罩进去,这条测试要红。
- **I3 迁移不采信旧文件**:升级后,`alpha.jsonc` 里已有的自定义节点**一律标为待确认**(复用
  `#1343` 的 `needs-reentry` 形态,`model-picker-core.ts:194-201`),用户在 UI 里确认一次才进真源。
  本机零租户(owner 确认),代价 = owner 重点几下。
- **I4 拒绝优先**:真源缺失 / 解析失败 / 条目字段不合法 ⇒ 该条目既不注入也不放行,并**说得出原因**
  (`#1387` 刚教过:静默的失败路径事后无法与"正常"区分)。
- **I5 围栏语义不变**:本票不新增任何可写根,不放宽 egress 的静态半场。

## 四、子票切分(基线批准后才切)

1. `[CODE]` 真源存储与读写(新模块 + 原子写 + 解析 fail-closed);判据含 **I2** 那条路径断言。
2. `[CODE]` 注入面与 `enabled_providers` 改从真源派生,`alpha.jsonc` 退出这两条路径(**I1**);
   出网派生零改动,但要有一条"自定义节点的地址进了放行集合"的判据。
3. `[CODE]` 迁移与 UI:旧条目标 `needs-reentry`、确认一次写入真源(**I3**),失败可见(**I4**)。
4. `[CODE]` `#1381` 的远程 MCP:同一真源承载 MCP 服务器地址(形状相同,单独一票,等 1–3 落地)。

`#1381` 的关闭条件随第 4 票;本票在基线被批准后即可关(结论落文档)。
