---
type: design
slug: capability-authorize-dialog
date: 2026-07-15
status: approved(2026-07-15 用户批准:Q1 场景化文案、Q2 首装必弹、Q3 bundle 全有或全无均接受)
relates:
  - jinjunnn/alpha-code#348(REQ-100 capability→authorize 闸口,UI 部分)
  - 2026-07-04-extension-hub-v3-universal.md(approved-direction 基线)
  - ADR-030(安装恒 global,本稿不做 scope 分支)
---

# 扩展安装能力授权确认框(stage="authorize")设计稿

> **与上一稿的关系**:基线 = `2026-07-04-extension-hub-v3-universal.md`(status:
> approved-direction,D1–D5 已批)+ `2026-07-04-ext-hub-m2/design.html` 原型。
> 视觉语言**零改动**(全部复用 `--a-*` tokens 与 `alpha-ui/Dialog` house 模式);
> 本稿新增 = 引擎 `stage="authorize"` 返回后的**能力授权确认视图**——上一稿的
> §5.2 安装状态机与 §5.3「数据边界/权限档摘要/风险说明」词汇在此延伸到安装时刻。
> 上一稿没有「能力授权」章节(概念晚于该稿);最近的先例是 B16 原生信任门
> (per-project executable consent),本稿刻意**不用**原生对话框而用 alpha-ui
> Dialog,因为 authorize 是引擎事务内一个可重驱的阶段,需渲染结构化 diff。
> `2026-07-07-project-alpha-only-extensions.md` 的 per-project 授权前提已被
> ADR-030 取代,本稿不继承其 scope 语义,只继承「可执行类才是高风险」的分级观。

## 1. 背景与触发

引擎已有完整 authorize 闸口(`ext-transaction.ts:864-882`):事务在锁内评估
`CapabilityDiff`,需确认时**零副作用**返回
`{ ok:false, stage:"authorize", authorization: CapabilityDiff[] }`,
等调用方带 `TxAuthorizationDecision` 重驱。但 renderer 侧无任何 UI/IPC 承接
(#348)。本稿只定 UI;后端接线(planner 写 capabilities、IPC 透传、重驱字段)
按票面「后端可先行」独立推进。

## 2. 事实基线(file:line 证据)

| # | 事实 | 锚点 |
|---|------|------|
| F1 | `CapabilityDiff = { key, previous(null=首装), requested, added, removed, requiresConfirmation }` | `ext-capability-grants.ts:33-41` |
| F2 | 弹框条件:首装且 requested 非空,或 added 非空;纯收缩/不变**静默通过** | `ext-capability-grants.ts:90-103` |
| F3 | 确认语义 = **整集覆盖**(`requested ⊆ confirmed[key]`),无逐能力粒度;防 TOCTOU「展示什么确认什么」 | `ext-transaction.ts` `confirmationCovers`、`ext-capability-grants.ts:111-116` |
| F4 | 重驱 = 同一入口再调,`plan.authorization = { confirmed: Record<key,string[]>, decidedAt }` | `ext-transaction.ts:104-109` |
| F5 | authorize 返回时未写盘;grants 仅在 journal committed 后落盘 → 取消零副作用 | `ext-transaction.ts:702-730` |
| F6 | 能力集由 catalog entry 类型派生(6 个语义枚举),非作者自报 | `ext-install-planner.ts:256-266`、`ext-manifest-v2.ts:24-33` |
| F7 | 崩溃恢复沿 `journal.authorization` 前滚落收据,**无 UI 参与** | `ext-transaction.ts:943-947`、`:267-272` |
| F8 | house 确认框先例:`alpha-ui/Dialog` size="sm" + ghost 取消 + primary 确认,body `.alpha-ext-confirm`,风险行 `.alpha-ext-confirm-risk` | `extension-hub.tsx:1578-1676`、`extension-hub.css:848-935,1218` |
| F9 | 反馈层级:成功=toast、失败=inline、取消=静默 | v3-universal §5.6、`extension-hub.tsx:468-570` |
| F10 | ADR-030 后 UI 安装恒 `scope:"global"`,契约测试锁死 | `install-scope-wiring.test.ts:38-71` |

## 3. 设计决策

- **D1 宿主复用,不造新 Dialog**。授权视图是一个 body 组件:
  - MCP / plugin / bundle(已有安装前确认框)→ 作为**同一 Dialog 的第二阶段**
    原地切换(确认安装 → 按钮 loading → 首驱返回 authorize → body 换为授权视图),
    避免连环双弹框;
  - skill(现为直装无框)→ 授权视图**独立弹出**(同一 DOM,`Dialog size="sm"`)。
- **D2 整集确认,无逐能力开关**(F3)。视图只有「授权并继续 / 取消」两个出口;
  差异靠展示分层表达,不提供勾选。
- **D3 差异三分层**:`新增`(warning chip,视觉焦点)/`已授权`(muted,维持项)/
  `将收回`(muted + 删除线,信息性)。首装 = 全部「新增」。扩权文案明确
  「确认即授权**完整能力集**(含已授权项)」——对应引擎 silent-inheritance-refused。
- **D4 风险分级克制**:仅 `engine:plugin`、`process:spawn` 标「高风险」
  (warning 色 icon 方块 + chip);其余中/低风险不加色。任一高风险出现时
  复用 `.alpha-ext-confirm-risk` ⚠ 说明行(F8)。
- **D5 bundle 全有或全无**:只展开 `requiresConfirmation` 的项(每项一节:
  项头 + 能力行);自动通过项折叠为一行「其余 N 项能力无变化,无需确认」。
  确认 = 为**所有**需确认项按各自 `requested` 全集生成 `confirmed`(引擎无
  按项拒绝语义,部分拒绝 = 取消整个安装)。
- **D6 取消零副作用、静默**(F5+F9):关框回到原状态(卡片回「未安装」/
  「可更新」),不弹错误、不弹 toast。确认后重驱期间主按钮 loading;
  重驱成功走既有路径(成功 toast / 失败 inline)。

## 4. 交互流程

```
[skill 首装]   卡片「添加」→ 卡片 spinner(首驱)→ 授权框弹出 → 授权并安装
                → 按钮 loading(重驱)→ 关框 + 成功 toast
[MCP/plugin/
 bundle 首装]  卡片「添加」→ 既有确认框(密钥/清单)→ 确认安装(loading,首驱)
                → 同框切换到授权视图 → 授权并安装(loading,重驱)→ 关框 + toast
[扩权更新]     「更新」→(如有既有确认框则同上,否则直弹)授权视图(diff 分层)
                → 授权并更新 → 同上
[取消]         任一视图取消/Esc/背景点击 → 关框,零副作用,静默(D6)
[崩溃恢复]     前滚沿 journal.authorization 自动落收据,无 UI(F7)
```

计时预期:authorize 在计划后、写盘前返回(本地评估),首驱到弹框应 <1s;
两阶段切换用 `--a-dur-base`/`--a-ease-out` 横向滑入(原型已演示)。

## 5. 视觉规范(全 token 复用)

- Dialog:`.a-dialog-*` 原样(`size="sm"` 420px、`besideSidebar`、
  `--a-surface-raised` + `--a-shadow-overlay` + `--a-edge-light`)。
- 新增 CSS 类(均只消费 `--a-*`):
  `.alpha-ext-authz`(body 容器,复用 `.alpha-ext-confirm` 布局节奏)、
  `.alpha-ext-authz-box`(= `.alpha-ext-install-box` 同构框)、
  `.alpha-ext-authz-cap`(能力行:icon 方块 + 名称/说明 + code id + chip)、
  `.alpha-ext-authz-ic[data-tier=high]`(warning-subtle 底 + warning 描边)、
  `.alpha-ext-authz-chip[data-kind=new|granted|removed]`、
  `.alpha-ext-authz-item`(bundle 项头)、`.alpha-ext-authz-rest`(折叠行)。
- 能力 icon:22px 圆角方块内 14px 线性 SVG(与 `.alpha-ext-install-ic` 同规格)。

## 6. 能力词汇表(渲染映射,F6)

| capability | 中文名 | 一行说明 | 风险 | icon |
|---|---|---|---|---|
| `prompt:context` | 注入提示词上下文 | 向会话注入文本(skill/agent) | 低 | 对话气泡 |
| `engine:config` | 写入引擎配置 | 新增/修改引擎配置条目 | 中 | 齿轮 |
| `engine:plugin` | 在引擎进程内运行代码 | 与引擎同权限执行 JS | **高** | 代码括号 |
| `process:spawn` | 启动本机子进程 | 在你的电脑上运行本地程序(本地 MCP) | **高** | 终端 |
| `network:remote` | 连接远程服务 | 与外部服务通信(远程 MCP) | 中 | 地球 |
| `cloud:dispatch` | 派发云端任务 | 将任务发往云端管线(数据边界见 ADR-021) | 中 | 云 |

未知 capability(前向兼容):按原 id 展示,mono code + 中风险样式,不隐藏。

## 7. i18n keys(`alpha.ext.authz.*`)

| key | zh | en |
|---|---|---|
| `titleFirst` | 授权能力 | Authorize capabilities |
| `titleEscalation` | 能力变更需确认 | Capability change needs confirmation |
| `introFirst` | 「{name}」首次安装,请求以下能力: | "{name}" is being installed for the first time and requests: |
| `introEscalation` | 「{name}」的能力请求发生变化,请重新确认完整能力集: | "{name}"'s requested capabilities changed; re-confirm the full set: |
| `introBundle` | 「{name}」中 {n} 项需要能力授权: | {n} items in "{name}" need capability authorization: |
| `chipNew` / `chipGranted` / `chipRemoved` | 新增 / 已授权 / 将收回 | New / Granted / Revoked |
| `riskHigh` | 高风险 | High risk |
| `bundleRest` | 其余 {n} 项能力无变化,无需确认 | {n} more items unchanged, no confirmation needed |
| `note` | 确认即授权上述完整能力集;授权仅在安装成功提交后生效,取消不会改动任何文件。 | Confirming grants the full set above; grants take effect only after a committed install. Cancel changes nothing. |
| `riskLine` | ⚠ 含高风险能力:该扩展将能在本机运行程序/在引擎进程内执行代码。 | ⚠ High-risk capabilities: this can run local programs / execute code inside the engine process. |
| `confirmInstall` / `confirmUpdate` | 授权并安装 / 授权并更新 | Authorize & install / Authorize & update |

取消复用既有 `alpha.ext.cancel`。

## 8. 接线计划(实现票范围,不挡本稿评审)

renderer 能弹此框还差(审计结论,#348 后端部分):
1. planner 把 `capabilitiesFor(entry)` 写进 plan items(skill 单装 + bundle 子项);
2. `SkillGenerationResult` / `CatalogInstallOutcome` / preload `installCatalog`
   返回类型透传 `stage:"authorize"` + `authorization: CapabilityDiff[]`
   (现被折叠丢弃:`ext-skill-generations.ts:232`、`ext-install-planner.ts:769`);
3. install intent 增加 `authorization?: TxAuthorizationDecision` 字段过严格解码器
   (`ext-install-planner.ts:178-190`),复用 `ext-install-catalog` 通道重驱。

## 9. 范围外与开放问题

- 范围外:逐能力勾选(违背 F3)、scope 分支(F10)、原生对话框方案(见与上一稿
  关系)、详情页「已授权能力」基线展示(好增量,建议另开窄票挂 #348 之后)。
- Q1 扩权主按钮文案场景化(授权并更新)vs 统一(授权并继续)?稿采用场景化。
- Q2 所有类型首装必弹一次(含低风险 skill 的 `prompt:context`)——这是票面
  AC(首装确认永不触发即 bug)。若要低风险豁免需改引擎白名单语义,本稿不做。
- Q3 bundle 部分拒绝 = 整体取消(D5),接受否?
