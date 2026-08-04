---
title: 外部包适配为 Alpha 声明 —— 方案基线
kind: design
status: draft
owners:
  - alpha-code extension maintainers
  - alpha-web catalog maintainers
last_reviewed: 2026-08-04
review_after: 2026-11-04
---

# 外部包适配为 Alpha 声明 —— 方案基线

承接票:[`alpha-web#98`](https://github.com/jinjunnn/alpha-web/issues/98)(Claude Code 适配器)、
[`alpha-web#96`](https://github.com/jinjunnn/alpha-web/issues/96)(OpenAI/Codex 适配器)。
父需求:[`alpha-work#49`](https://github.com/jinjunnn/alpha-work/issues/49)。
权威裁决:[`ADR-040`](../../.claude/rules/adrs/ADR-040-extension-package-taxonomy.md)。

> 本稿是 REQ-128 Phase 4 被否决之后的新主线;被否决的那一份(Catalog 托管的 OpenCode Plugin)
> 已标 `superseded`,见 [`2026-08-03-req128-phase4-managed-npm-plugin.md`](2026-08-03-req128-phase4-managed-npm-plugin.md)。
>
> **本稿不引入迁移、v2、双读双写、兼容分支或旧车道并存。**
> 当前无租户、无历史账户、无历史数据 —— skills-only 的本地导入在**同一次 cutover** 里被替换掉。

## 1. 这一期做什么

今天用户想用一个 Claude Code 插件只有一条路:**本地导入,而且只装得了技能** ——
`commands` / `agents` / `hooks` / `.mcp.json` 全部具名跳过。

这一期把**一个外部 provider package 适配成一个 Alpha Bundle**:

- 发布者(或我们)把插件**适配**成一份 Alpha 声明,编译出来是一个多组件 Bundle
  (技能 + agent + MCP 一起,**一次授权、一次事务、一个账本包、整包卸载**);
- 用户在扩展中心装它 / 更新它 / 卸载它,和装一个 Alpha 原生包没有区别;
- **装不了的部分诚实阻断整包** —— 不静默丢弃,不部分安装。

**不做什么同样重要**:我们**不执行**外部插件的任何代码,**不写引擎 `plugin[]`**。
适配是纯转换 —— 读文件、产声明。ADR-040 已封死「第三方代码在引擎进程内以引擎权限运行」这条路。

## 2. 前置:已裁决,本稿不重新裁决

| 裁决 | 出处 |
| --- | --- |
| **扩展安装唯一形态是 Bundle**;任何安装路径不得写入引擎 `plugin[]` | ADR-040 决策二、三 |
| provider 语义映射走 **B 通往 A** —— 适配器抽成纯库、发布端产物化、alpha-code vendored,本地导入跑同一份 | ADR-040 后果第 3 条 |
| **`hooks` 后续会支持**,前置是一次引擎事件面勘破;在它落地前 hooks 实现票不得升 Ready | ADR-040 被否决方案 C 的补充裁决 |

三份已落地的勘破,本稿引用不复述:
[组件规模与口径](../architecture/claude-plugin-corpus-component-scale.md)、
[引擎 command 与事件面](../architecture/engine-command-and-event-surface.md)、
[宿主包合同与四个 profile](../contracts/host-extension-package-v1.md)。

## 3. 选定模型:一份映射,两处消费

```text
                 ┌────────── alpha-web(发布端,唯一真源)──────────┐
identity +       │  纯库 provider-adapter/claude-code.mjs           │
文件表      ───▶ │  无网络 · 无子进程 · 无 dynamic import · 不写盘   │
                 │  不求值模板 · 不跑 package script                │
                 │  输出:AdapterResultV1                           │
                 └───────┬──────────────────────────┬──────────────┘
                         │ 产物化 + 字节锁          │ 同一份字节(vendored)
                         ▼                          ▼
               发布端 compiler → 签名 Bundle   alpha-code 本地导入
                         ▼                          ▼
                用户从扩展中心安装            用户从本机目录导入
```

**为什么必须是纯库,而不是「两边各写一份 + 差异闸」**:两份别人文法的替身**一定会分叉**,
这是本仓记录在案最贵的返工形态。纯库 + 字节锁让漂移**结构上不可能**,不依赖「两边都记得改」这种纪律。

**为什么必须纯**:不纯就 vendored 不过来 ⇒ 当场退化成「两处各写」。纯不是代码风格,是这条路的生死线。

⚠️ **两条成本事实,排期照这个算**:①发布端今天**没有**「文件表 → 声明」这一段(现有的
`compileAlphaPackageDeclarationV1` 吃的是已有声明 + 资产表)⇒ **纯库是新写的,不是抽出来的**;
②`alpha-contracts-consumer/vendor/` 今天**零可执行代码**(全是 JSON / Markdown 数据)⇒
vendored 一份 `.mjs` 是**新的供应链形态**,要来源 / 版本 / hash pin、打包与模块加载合同、更新与审计规则。

## 4. 合同

### 4.1 输入

```jsonc
AdapterInputV1 {
  identity: { packageId, version, publisher },   // 全部必填
  files: [{ path, bytes, executable }]           // POSIX 相对路径 + Uint8Array + 可执行位
}
```

**identity 必填且不推导。** 实测 62 个真实 manifest 里 **27 个没有 `version`**,manifest 也不提供 `publisher`。
⇒ 缺失时由调用方(发布端表单 / 本地导入确认屏)显式补齐,补不齐就是 `blocked`;
**禁止从目录名、文件名或 `unknown` 生成 immutable identity**。identity **不建逐字段 provenance 合同**。

**`executable` 必须在输入里。** capture 之后 mode 位就没了,纯 adapter 结构上看不见它;
不带这一格,语料里 25 个可执行文件对 adapter 完全不可见。

### 4.2 输出

```jsonc
AdapterResultV1 {
  fileTableSha256: string,                          // 绑定规范化【文件表】,不是声明
  declaration: AlphaPackageDeclarationV1 | null,    // blocked 时为 null
  status: "ready" | "blocked",
  findings: [{ sourcePath, level: "warning" | "error", code }]
}
```

四条硬规则:

1. **每个被发现的组件恰好一条 finding。** 组件的 support 文件计入该组件的 assets,**不逐文件产 finding**
   (一个技能的 18 个文件是一条 finding,不是 18 条);未被任何组件认领的顶层条目各产一条。
   这是「未知语义不静默丢弃」可检验的形态。
2. **`sourcePath` 是源目录里的路径**,不是声明组件的 JSON 路径;
   `.mcp.json` 的每个 server 用 `.mcp.json#<serverName>` 保证唯一。
3. **`status: "blocked"` ⟺ 至少一条 `level: "error"`**,且此时 `declaration === null`。
   零可安装组件同样是 `blocked`,code = `no-installable-component`
   (声明必须有 root ⇒ 没有别的合法输出形状;实测语料里 8 个插件不含任何当前合法组件)。
4. **`warning` 只允许出现在不携带安装语义的条目上**(README / LICENSE、Alpha 不消费的展示性 manifest 字段)。
   **判不准就是 `error`** —— 这是 fail-closed 的位置,不是风格偏好。

> 现行 `CompatibilityReport` 是「可发布声明」的投影(`inputSha256` 绑规范化后的声明、finding 路径
> 必须是声明组件的 JSON 路径)⇒ **它承载不了源目录覆盖**,不得拿它冒充本合同。

### 4.3 第一版映射范围

**只映射宿主今天已经诚实支持的形状;其余任一存在就阻断整包。**

| 源目录里的东西 | 第一版处置 |
| --- | --- |
| `skills/<name>/` 且通过生产 intake | → `skill` 组件 |
| `agents/**/*.md` 且通过生产 `agentMdToEntry` | → `agent` 组件 |
| `.mcp.json` 里含 `command`(+`args`)的 server | → `mcp-local`,**逐 server 一个组件**;`args` 必须一起带 |
| `.mcp.json` 里含 `url`(+`type`/`headers`)的 server | → `mcp-remote`;Authorization → `headersTemplate + requiredSecrets` |
| `commands/**` | **error** —— 宿主三条路都没有安装腿(`ac#840`) |
| `hooks/**` | **error** —— 引擎事件面未勘破(ADR-040) |
| 文件表里任何 `executable: true` | **error** —— 执行位结构上穿不过安装链(`source 755 → cas 644 → materialized 644`) |
| `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` 等模板引用 | **error** —— 不求值模板 |
| 非法 JSON 的 `.mcp.json` | **error** + 具名 malformed;**不能当「不存在」,更不能修补后猜** |
| `.mcp.json` 其它形状 / `command` 与 `url` 同时出现 | **error**,具名 unknown,**不猜** |
| 其余未识别的目录 / 键 | **error**(未知安装语义),或 `warning`(证明得了不携带安装语义) |

⚠️ **诚实后果**:第一版能整包通过的插件是少数 —— 单是 `commands`(22/62 插件)、
`hooks`(12/62 有目录)、可执行位(9 个技能 / 25 个文件)三格各自都会整包阻断。
这是刻意的 fail-closed 起点,放宽走后续票,不靠部分安装换覆盖率。

⚠️ **「形状对得上」不等于可映射** —— 实测三条全是反例,**逐字段冻结表必须在实现开工前落定**:

| 类别 | 实测 |
| --- | --- |
| **agent** | 43 个真实 plugin-level agent 只有 **9** 个过生产 `agentMdToEntry`(拒因:`tools` 23、`effort` 7、块式 YAML 4);**宿主在 admission 期就调用该解析器并拒装**(`packages/ui-mac/src/main/package-admission.ts:561`),不是预览层差异 |
| **skill** | 159 个标准布局里生产 intake 拒 **27** 个(12 个含 Alpha 兑现不了的控制字段、18 个不自包含,重叠 3) |
| **MCP** | 19 个 server 三种形状;`.mcp.json` **有两种摆法** —— 9 份带 `mcpServers` 包裹、**12 份 server 直接摆顶层**、1 份非法 JSON ⇒ **只读 `mcpServers` 会把 19 个 server 数成 7 个** |

因此 `.mcp.json` 读取器至少要:严格 JSON parse(失败具名 malformed)→ 顶层须为非 null 非数组 object →
`mcpServers` 是 object 就取它(**空 object 是合法的零 server,不退回顶层**)→ 否则处理语料中真实存在的
bare 顶层 map → 逐 server 判形状。**冻结表不得复用 Alpha 自有的受限文法当作 Claude 的文法**
(那正是「手写别人文法的替身」)。

**容量**:按信封真正用的口径实测 0/62 超过 16、最大 13 —— 但最大那个插件靠一份**非法 JSON** 撑着,
修好就是 25。`ac#827` 定界时**必须显式回答「25 怎么办」**,答案落进代码或发布端的 error finding。

## 5. 本地落点

**扩展现有 local-package seam**(`main/local-package-install-port.ts`、`main/claude-plugin-install.ts`)。

**为什么是它**:这条车道**已经**落在同一套 V3 包图账本上(bundle / root owner claims,四集合双射在提交前校验),
**已经**有整包卸载(`ext-package-uninstall.ts`)。缺的只是它的输入还是 skills-only 的
`LocalPackagePreviewV1`,component 固定为 skill、capability 固定 `[]`。
本期把这个输入换成 **declaration component 列表** —— 同一次 cutover 替换掉 skills-only 通道,**不并存**。

最小新增:

1. **main-held preview**:vendored adapter 在**已捕获的文件表**上运行,renderer confirm 只回传 `previewId`;
2. **校验完整的 `AdapterResultV1`,不只是声明**:`status: "blocked"` ⇒ **零 preview-confirm、零事务、零写盘**;
   preview 绑定 `fileTableSha256` 与声明。
   不做这一条**发布与本地会分叉** —— 发布端拒 `blocked` 进 build/sign;本地若只看声明,
   一个含 `commands` 的包会拿到「映射组件声明 + blocked 结果」,本地照装子集 ⇒ 用户得到一个不完整的插件;
3. 对 vendored 声明做严格 schema / profile / graph 校验;**精确重算文件表 digest**;限制本地命名空间;
4. host 推导 capability 并绑定到确认屏;
5. **agent / MCP 复用既有 installer 的语义,不重写它们**。

**账与卸载**:复用 `commitTransactionLedger`,写同一套 V3 `packageGraphs` + bundle owner claims;
子记录须是 `user:` / local origin,**不得伪造 Catalog supply digests**
(`ext-receipt-v2.ts` 已具名拒绝非 catalog 来源携带 digest 族);卸载走 `uninstallPackageV1`。

两条明令禁止:

- ❌ **顺序调用三条 uncurated lane(skill / agent / MCP)来实现 Bundle。**
  它们是**各自独立的事务**(MCP 甚至是先写配置、再单独记 receipt)⇒ 第二 / 第三个组件失败会留下**部分安装**,
  而且**没有整包图可卸载**。**跨 kind 必须是一次事务、一个 package mutation。**
- ❌ **给 admission 增加 `source: "local"`。** 在 signed resolver 内把 verified Catalog、membership
  或摘要绑定改成可选,会同时削弱签名路径的真闸。本地必须是一条**完全不相交**的 main-minted 分支。

**对签名路径的影响:零。** 本期不修改 envelope schema、签名验证、verified Catalog membership
或 admission 摘要绑定中的任何一条;`local:` 命名空间在 admission 侧已被具名拒绝
(`package-admission.ts:491`),该拒绝保持不变。
**既有 signed gates 只许不放宽 —— 本期不重新证明它们。**

## 6. 安全不变量

1. **零执行**:适配器无网络、无子进程、无 `dynamic import`、不写盘、不求值模板、不跑 package script。
   输入是**已 capture 的**规范化文件表。
2. **symlink 圈禁与 mode 位属于 capture 层,不属于纯库。** adapter 只收到 `path + bytes + executable`,
   **结构上分不出**正常文件与被 wrapper 跟随的越界 symlink ⇒ realpath 圈禁必须由**两个 capture wrapper**
   (发布端与本地各一)各自持有、各自立门,并断言 adapter 从未收到树外字节。
3. **零信任外部路径**:相对路径过既有的路径文法所有者,**不在第二处复制一份路径判据**。
4. **每个被发现的组件恰好一条 finding**;`status` 由最强 level 决定;
   **`blocked` 的包既不进 build/sign,也不进本地安装** —— 两边都要执行。
5. **确定性 + 输入敏感性**:同输入双跑逐字节相同,**且**改变输入的任一维度时输出发生**预期变化**。
6. **不伪造 identity**;**不自行创造 optional** —— Claude 没有 optional 语义,映射组件一律 `required`。
7. **本地那条路不得放宽签名那条路的判据。**

## 7. 依赖序

**一条线,四跳**(`ac#826` 语料尺子已合,是它的起点):

1. **`ac#827` ⊕ `ac#828` 合并成【一次】跨仓 pin 搬运** —— 两票改同一个 registry 文件、同一个聚合 SHA,
   分两次搬,第一跳落地就把第二跳的 pin 打陈旧;
2. **`aw#98` Claude 适配器**(纯库 + 逐字段冻结表)+ 不可变 producer artifact;
3. **alpha-code 本地消费** —— vendor pin → capture → preview/confirm → 一次事务 → 整包卸载;
4. **`aw#96` 第二个 provider(Codex)** —— 验证纯库不是给 Claude 定制的。

阻塞关系只有这几条,其余一律不是第一版前置:

- **`ac#848`(语料补齐 agent 真字节)只阻塞 agent 映射** —— 没有真字节就写不出 agent 的冻结表。
  它**不阻塞** adapter 骨架、skill 与 MCP 映射,也不阻塞第 3 跳的本地消费。
- **`ac#840`(command 安装腿)与引擎事件面勘破(hooks)是后续支持,不是第一版前置** ——
  落地前 `commands` / `hooks` 恒 error。
- **`ac#843`(可执行位告知)是放宽「可执行位一律 error」的前置,不是本期前置。**

## 8. 退出门

通用:**绕过配方** —— 摘掉这票新增的那道闸 ⇒ 断言必须**当场变红**,实测输出进 PR 正文;
断言绑**用户可观察的结果**,不绑源码文本;**不断言错误码**(这条路今天只有 `reason` 字符串,没有稳定枚举码)。

| # | 门 |
| --- | --- |
| 1 | **纯度与确定性**:在没有 `fs` / `child_process` / 网络的隔离环境里**真跑** adapter(隔离 `vm.SourceTextModule` 或等价 isolate,自定义 linker 拒绝所有 builtin 与 dynamic import,context 不提供 `process` / `require` / `fetch`),并观测全局写入。⚠️ **双跑逐字节相同远远不够** —— 一个返回固定值的实现完全满足它。必须加**输入敏感性**:分别改 identity / 一个文件的字节 / 路径 / MCP `args` / MCP header / `executable` 位,断言**只有**对应的输出字段与 digest 发生预期变化;**期望值从独立 oracle 得出,不读 adapter 自己的输出回填** |
| 2 | **发现组件全分类**:真实语料全量跑过 adapter 再送进生产 host parser / decoder / builder(159 skill、43 agent、19 MCP server);**每个被发现的组件恰好一条 finding**,support 文件不产多余 finding;零可安装组件产 `blocked` + `no-installable-component` |
| 3 | **`blocked` ⇒ 零副作用**:含 `commands` / `hooks` / 可执行位的**真实**包既不进 build/sign,本地也零 preview-confirm、零写盘;**删掉 status gate ⇒ 发生写盘且测试变红**(走真实本地 IPC) |
| 4 | **ready Bundle 原子安装 / 卸载**:一份**多组件**本地声明装上后逐文件比对字节;卸载后全部消失;子记录是 `user:` / local origin 且不带 Catalog supply digests;**跨 kind 是一次事务、一个 package mutation** |
| 5 | **consumer pin 对 producer artifact**:比较对象必须是**固定 alpha-web commit 构建出的不可变 producer artifact**,**不能由 consumer 的 vendor 反向生成** |
| 6 | **生产调用路径确实调用 adapter**:对 packaged / main build 跑一个特征输入,经**真实本地 handler** 拿到特征输出;**把 adapter 从 bundle 移除、或删掉生产的调用 ⇒ 门必须红**。⚠️「vendored 字节等于旁边的 producer copy」是**假闸** —— Electron 只打包 `out/**` 与 `resources/**`,模块没进包或生产 handler 压根没调用它时,那条门照样全绿 |

## 9. 被否决的替代

| 做法 | 否决理由 |
| --- | --- |
| 给每个 provider 加 profile(`claude-plugin` / `codex-plugin`) | provider 数量线性污染宿主种类枚举(有 exact-set 断言 + 跨仓 vendored pin);且把**来源**当成了**种类**。ADR-040 方案 A |
| 宿主直接消费外部插件的原生目录结构 | 「手写别人文法的替身」;provider 的目录约定由它定义、随时会变。ADR-040 方案 B |
| `opencode-plugin` profile | ADR-040 方案 C,已回滚 |
| 两处各写映射 + 差异闸 | 两份替身一定分叉。ADR-040 后果第 3 条候选 D |
| 本地导入把目录发到 alpha-web 换回声明 | 装本机插件要联网 + 本地文件出机器;离线与隐私两头都坏。候选 C |
| 给 admission 加 `source: "local"` | 把签名路径的必需事实降级成 optional,削弱真闸。见 §5 |
| **部分安装**(装映射得了的子集、其余跳过) | 用户得到一个不完整的插件且**不知道**;违反「诚实阻断」。见 §5 第 2 条 |

## 10. 明确不做

publisher portal / open marketplace、root OpenAI Agent Plugins、MCP Apps UI、
Claude LSP / themes / monitors / channels、URL import、native/managed Plugin、sandbox、
nested Bundle、semver solver、**复制 Claude loader**、**provider CLI**。

以及 —— **迁移、v2、双读双写、兼容分支、legacy receipt 保留、旧车道并存**:
无租户、无历史账户、无历史数据,一条都不需要。
