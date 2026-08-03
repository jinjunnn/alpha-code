---
id: ADR-040
title: 扩展安装唯一形态是 Bundle —— 封死「第三方插件装进引擎 plugin[]」这条路，profile 是载荷种类、Bundle 是包形状
status: accepted
date: 2026-08-03
kind: adr
owners:
  - alpha-code
last_reviewed: 2026-08-03
review_after: 2027-08-03
related: [ADR-028, ADR-014, ADR-002, "alpha-work:REQ-128", "alpha-code:#749", "alpha-code:#697", "alpha-web:#96", "alpha-web:#98", "alpha-code:#818"]
---

# 扩展安装唯一形态是 Bundle

## 背景

「一个外部生态的插件（Claude Code plugin / OpenAI Codex plugin）该怎么进 Alpha」这个问题
在 REQ-128 交付过程中被**反复重新推导**，每次都要从代码里重新读一遍才敢下结论。
根因是**两个正交概念长期被混用**：一个包**长什么形状**，与一份载荷**是什么种类**。

混用的直接代价是会自然想到「给 Claude 加一个 profile、给 OpenAI 加一个 profile」，
或者「把第三方代码装进引擎自己的插件机制」——两者都错，而且第二个更贵：
它把**任意第三方 JS 以引擎同等权限执行**变成了产品面。

## 实读依据（2026-08-03，`alpha-code@5ef04016`）

**一、信封的形状。** `alpha-package-envelope-v1.schema.json`：

```
{ schema, prelude, presentation, root, components[], capabilities }
```

`root` 是**字符串**（指向 `components[]` 中某个组件 id），**不是 profile**；
`components[]` `maxItems: 16`，**每个组件各带自己的 `profileId`**。
⇒ **「单组件包」只是组件数为 1 的 Bundle。Bundle 不是一种 profile。**

**二、容器已经存在。** `alpha-code#697` 已交付并测过**混合种类 Bundle**
（Agent + Skill + secret MCP：一次授权、一次事务、一个 root 账本 mutation）。

**三、引擎的 `plugin[]` 是第三方代码进入引擎进程的主通道，但不是唯一注入点。**

`plugin[]` 由上游加载器消费（引擎在 `UPSTREAM_PATHS`，north-star 保护，我们改不了它的装载语义）。
⇒ **「封死 `plugin[]`」与「支持第三方可执行扩展」互斥。本 ADR 选择前者。**

**但第二个注入点存在，而且是我们自己的代码**（2026-08-03 勘破实读修正，此前本节曾错写成「不存在」）：
`packages/ext/src/plugin-fanout.ts` 在引擎进程内 `import()` 用户项目的 `.alpha/plugins/*.js`，
而 `packages/ext` 是 **alpha 自有包、不在 `UPSTREAM_PATHS` 里**。
本 ADR 的封死条款**覆盖我们自己的安装路径**；`.alpha/plugins/*.js` 这条项目级扇出
**不是安装路径**（没有 catalog、没有账本、没有授权），但它同样让第三方 JS 以引擎同权限执行。
**处置另议**（见「后果」第 5 条），不在本 ADR 裁决范围。

**四、Alpha 自有 ext 接缝根本不写盘。**
`alpha-config-injection.ts` 只在内存里把 alpha 自己的 ext 合并进 `OPENCODE_CONFIG_CONTENT`，
**从不写 `alpha.jsonc`**。⇒ 咽喉可以做成**「往磁盘 `plugin[]` 加元素一律拒」**，
**不需要留任何合法加法通道** —— 比本 ADR 初稿设想的更干净。

## 决策

### 一、两层分开，永不混用

| 概念 | 回答的问题 | 表现 |
| --- | --- | --- |
| **profile** | 这一份字节**是什么种类**，宿主怎么装它 | `components[i].profileId` |
| **Bundle** | 这个包**是什么形状**，由哪些组件组成 | `root` + `components[]`（1..16） |

### 二、Alpha 的扩展安装唯一形态是 Bundle

**用户能装进 Alpha 的一切扩展，都以多组件 Bundle 表达。** 外部 provider 的插件
（Claude Code plugin / OpenAI Codex plugin）本质是「一个目录里装着 skills + commands +
agents + hooks + `.mcp.json`」——**多个不同种类的组件在一个 root 下**，是**形状**问题。

**禁止为 provider 新增 profile。** 判据：新增理由里若出现 provider 名字
（「Claude 的」「OpenAI 的」「某某生态的」），那一定是形状问题，不是种类问题。

**外部 provider 的接入点是发布端适配器**（`alpha-web#96` / `#98`）：
把外部插件适配为 **Alpha 声明 + 兼容报告**，声明经唯一 compiler 编译成多组件信封。
**宿主不需要认识任何 provider——它只认 profile。**

### 三、封死：任何扩展安装都不得写入引擎的 `plugin[]`

**`alpha.jsonc` 的 `plugin[]` 不是产品面。** 它是引擎的内部装载机制，
Alpha 对它的唯一合法用途是**注入 Alpha 自己的引擎侧接缝**（`@alpha-code/ext`，ADR-002/005 的 seam）。

**以下一律禁止，且必须 fail-closed 而不是静默跳过：**

1. **任何 catalog / package / Bundle 驱动的安装路径写 `plugin[]`** ——
   包括签名 package、legacy `entries[]`、seed、vendored。
2. **任何用户可达的「装一个 npm 包当插件」入口** —— 未策展 npm 导入逃生口一并关闭。
3. **为第三方可执行载荷新增 host profile** —— 含 `opencode-plugin`（见「被否决的方案 C」）。

**咽喉点**：写 `plugin[]` 的生产代码集中在
`packages/ui-mac/src/main/ext-config.ts` 与 `ext-install-planner.ts`。
收口要求：**只有 Alpha 自有 ext 注入这一条调用路径允许写入**；
其余调用点**具名拒绝**，并且**新增一个写入点时，默认被咽喉挡住**（穷举 + 未知即拒，不是黑名单）。

**判据**：构造一个「package 组件试图写 `plugin[]`」的输入 ⇒ **必须具名拒绝**；
删掉咽喉 ⇒ 该断言必须红。

### 四、只有出现宿主装不了的新种类时才加 profile，且理由不得涉及 provider

今天合法的 profile：`agent` / `mcp-local` / `mcp-remote` / `skill`。
新增必须同时满足：①现有 profile 无一描述得了这份字节的装载方式；
②理由与 provider 无关；③**不引入引擎进程内的第三方代码执行**。

## 被否决的方案

**A. 给每个 provider 加一个 profile（`claude-plugin` / `codex-plugin`）。**
否决：provider 数量会线性污染宿主合同的种类枚举，而该枚举有 exact-set 断言 + 跨仓 vendored pin，
每加一个都要重生 artifact、走一次三跳 pin 搬运；且宿主会因此需要认识 provider 语义。
同一个 Claude 插件里的 skill 与 Alpha 原生 skill **本来就是同一种东西**，
把它们分成两个 profile 是把**来源**当成了**种类**。

**B. 让宿主直接消费外部插件的原生目录结构。**
否决：那是「手写一个别人文法的替身」——本 portfolio 记录在案最贵的返工形态。
provider 的目录约定由 provider 定义、随时会变；正确做法是在发布端一次性适配成我们自己的声明。

**C. `opencode-plugin` profile（REQ-128 Phase 4 已实现，本 ADR 予以推翻并回滚）。**
它把「第三方 JS 以引擎同等权限执行」变成产品面，代价是一整套只为它存在的机制：
同权限执行的授权披露、ABI 预检、strict wrapper、双载闸、pre-switch probe。
**owner 裁决：Alpha 的扩展是声明式的（skill / agent / mcp / Bundle），不接受任意第三方代码在引擎进程里跑。**
⇒ 该 profile 与配套的 `engine:config` / `engine:plugin` host capability **全部回滚**，
宿主 profile 集合回到四个。

## 后果

**正面**：

- 宿主合同的 profile 集合只随**真实的新载荷种类**增长，与 provider 数量解耦；
  新增一个 provider 支持 = alpha-web 加一个适配器，**alpha-code 一行不改、无需 pin 搬运**。
- **整个「同权限执行第三方 JS」的安全面消失** —— 不再需要 ABI 预检、strict wrapper、
  pre-switch probe、双载闸与相应的授权披露。这是本 ADR 最大的收益。

**负面 / 必须处置**：

1. **REQ-128 父票 `alpha-work#49` 的 AC2 与 AC6 提及 managed OpenCode Plugin，必须改写。**
2. **Phase 4 已合并的代码要做外科式回滚**（不是四个 `git revert`）——
   那些 commit 里**混着与插件无关的真实修复**，必须保留。
   **2026-08-03 全相位勘破逐条核过后的名单**（本条初稿列错过一项，已修正）：
   - ✅ 必须保住：**kind 分流单点表与 `packageChildPreviewKeyV1`**
     （它修的是 `command:foo` 被强转成 `mcp--foo`、撞上真实 MCP 授权账 key）；
   - ✅ 必须保住：alpha-web 的 `buildPayload` 由隐式兜底改显式拒绝；
   - ✅ 必须保住：`aw#112` 的资产字节前移、host pin 与 `E_HOST_PARSER_DRIFT` 修复
     （该 red 曾让 alpha-web 主线连红一天多）；
   - ❌ **初稿错列**：「卸载目录删除失败不再谎报成功（`#809` M1）」**不需要抢救** ——
     实测回滚前的 `ext-package-uninstall.ts` 里 `rmSync` 与 `catch` **各零命中**，
     那个空 `catch` 是**同一个 PR 第一版自己引入的**，连同 plugin 臂一起回滚即可。
3. **REQ-128 Phase 3（本地 Claude 插件导入）不在 Bundle 这条路上** ——
   它是 owner 当时裁决的本地窄竖线（本机目录无 canonical HTTPS 地址、
   admission 唯一入口要求「你在已签名 Catalog 里」，本地导入**结构上进不了信封**）。
   实读：它落**同一个 V3 包图账本**，但**完全不走信封/admission**，且**只装 skills**。
   ⇒ **Claude plugin 的语义映射有被写两遍的风险**（本地 intake 一遍、`#98` 适配器一遍）。
   本 ADR **不**裁决如何收敛，但**要求**：动 `#96`/`#98` 之前先回答
   「本地 intake 与适配器如何共用同一份 provider 语义映射」，不得在两处各写一份。
4. **引擎自身对工作目录 `{plugin,plugins}/*.{ts,js}` 的自动发现不在我们控制内**（上游行为）。
   如实登记为已知边界：本 ADR 的封死覆盖**我们自己的安装路径**，不覆盖引擎的目录自动发现。

5. **`.alpha/plugins/*.js` 项目级扇出是我们自己的第二注入点，处置另议。**
   `packages/ext/src/plugin-fanout.ts` 在引擎进程内 `import()` 它，`packages/ext` 是 alpha 自有包。
   它不是安装路径（无 catalog、无账本、无授权），但同样让第三方 JS 以引擎同权限执行。
   **本 ADR 不裁决它**，但要求：任何「把它当成插件安装通道」的提议，直接撞判据①。

6. ⚠️ **「Bundle 是唯一形态」今天接不住约 11% 的真实输入 —— 这是一条待补的地基，不是可以忽略的边角。**
   2026-08-03 对本机 62 个真实 Claude 插件的实测：
   - **7/62 组件数超过 16**（最大 22），而信封 `maxComponents = 16`；
   - **40/162 的技能是多文件**（最多 18 个文件），而 `skill` profile 的 payload 只有**一个** markdown asset；
   - **`commands` 没有任何 profile**（22/62 个插件带，共 100 个文件，实测 100% 是 `.md`、可执行位 0）；
   - **`hooks` 在引擎里不存在这个概念**（12/62 个插件带，实测是 mode 755 的 `.sh`/`.py`）。

   ⇒ **在补齐容量与种类之前，`alpha-web#96`/`#98` 动笔就会撞墙。**
   本条属于本 portfolio 记录在案的「**前提为假的闸门比没有闸门更贵**」那一类：
   本 ADR 写下了一条全称前提，而实测证明它今天不成立。**必须先补地基，再谈收敛。**

7. **退休存量可执行载荷比看起来多一层。** 今天全 portfolio 只有一个：catalog 条目
   `plugin:opencode-notify` + 34 KB 随 app 发货的 `plugin.js`。它默认关着（`source=community`），
   所以「装了就在跑」不成立，但「**两次点击就在跑**」成立。
   ⚠️ **只删线上 catalog 是假退休** —— app 里还钉着一份自己的 catalog 快照
   （`renderer/extensions/alpha-catalog.json`），离线时当激活真源用。**必须重新出包才真正生效。**
   另：`seed` 通道今天没有可执行载荷是**巧合不是闸门** —— seed lock schema 的 type 枚举里有 `plugin`，
   构建器只按「有没有 remoteAsset」筛、零类型闸。

## 判据（新讨论进来时照这个走）

1. **它要不要在引擎进程里跑第三方代码？** 要 ⇒ **直接拒绝**，没有下一问。
2. **它是多个不同种类的组件吗？** 是 ⇒ **Bundle**，接入点在发布端适配器。
3. **都不是，且现有 profile 无一描述得了这份字节？** ⇒ 才考虑新 profile，
   且理由**不得出现 provider 名字**。
