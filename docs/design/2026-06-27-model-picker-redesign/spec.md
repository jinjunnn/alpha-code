# 模型选择器 · 交互重设计规格（v1）

> 日期：2026-06-27 · 状态：`draft`（待审计）
> 配套原型：`./prototype.html`（浏览器打开,含浅/深色 + 4 种登录态 + 自定义流程,可交互）
> 取代:`docs/design/2026-06-25-composer-model-redesign/`(mockup/states 已过时,本稿为权威)
> 关联 ADR:[[ADR-016]](前端接管)、[[ADR-002]](后端只走 SDK/接缝)、[[ADR-009]](websearch)、[[ADR-017]](桌面授权深链)

---

## 0. 一句话

把当前「opencode 原生 popover + 薄装饰层」的扁平模型列表,重构成一个**登录态感知 + 分组清晰 + 可自助接入国内供应商**的模型选择器:代理模型(alpha-platform)永远可见、按登录/额度态分级解锁;国内四模型(DeepSeek / 智谱 / 通义千问 / Kimi)一键直连;其余任意 OpenAI/Anthropic 兼容端点可自定义输入。

---

## 1. 现状问题(对照截图 2026-06-27)

| # | 问题 | 证据 |
|---|------|------|
| P1 | **代理模型不可见 / 无登录态语义** | 截图只见 Zhipu / DeepSeek 直连模型,看不到 alpha-platform 代理的旗舰模型;banner「PRO 会员·本周期额度充足」与模型列表脱节,用户不知道哪些行是「代理付费」哪些是「自带 Key」。 |
| P2 | **信息架构扁平** | 供应商之间只有一个细灰组标题,代理 vs 直连无视觉分层;tier(标准 ×1)只在个别行出现,规则不可预期。 |
| P3 | **搜索框形同虚设** | 占满顶部却无过滤维度(类型/推理/代理)的快捷入口;右上「+ / 滑块」两个图标语义不明。 |
| P4 | **自定义接入是死胡同** | 底部「+ 添加自定义节点 / 供应商」当前只打开定制中心占位,没有「填 Key 即用」的真实表单;国内供应商需要手改 `opencode.jsonc`。 |
| P5 | **装饰层天花板** | 现实现是 MutationObserver 给原生 Kobalte popover 贴 badge(`model-picker-inject.tsx`),分组/锁定/二级表单这类结构化交互很难稳定挂上去。 |

---

## 2. 设计目标(承接用户三诉求)

1. **必须显示 alpha-platform 代理模型,且考虑登录状态** → §5 模型分组 + §6 登录态矩阵。
2. **UX 交互重构 + 自定义含国内四模型,其余可自行输入** → §3 IA + §7 自定义流程。
3. **产出完整可审计交互规格** → 本文 + `prototype.html`。

**北极星对齐**:本稿属前端(ADR-016 alpha 已接管前端,放弃前端升级隔离);**后端仍零改 upstream**——数据全走 `@opencode-ai/sdk` + 既有 `window.api.{auth,account}` IPC + `alpha-models.ts` 配置注入。唯一新增接缝见 §11(供应商持久化 IPC)。

---

## 3. 信息架构(IA)

> v1.1 修订(2026-06-27,据用户审计反馈):① 去掉过滤 chips,只留搜索;② 组标题统一表达「经 ALPHA 代理」,行内不再重复「经代理」;③ **一个 model id 一行**(不再「一供应商多 id 挤一行」);④ 国内直连**只显示已配置的 model**,未配置的供应商不出现在列表、改去「添加节点」配置;⑤ 去掉与底部按钮重复的组内入口,只留底部一个;⑥ 选择器宽高都约束(见 §10)。

```
┌ 模型选择器 popover (宽 380 固定, max-h min(560,72vh), radius-xl) ┐
│ ① 搜索栏   [🔍 搜索模型 / 供应商 ......................]      │  ← sticky 顶
│ ② 账户 banner  〔随登录态四选一,见 §6〕                       │  ← sticky
│ ─────────────────────────────────────────────────────────  │
│ ③ 组A  代理节点 · 经 ALPHA 代理             [推荐]  🔒?      │  ← scroll
│        α  Claude Opus 4.8     claude-opus-4.8   ● 旗舰  ×8   │
│        α  Claude Sonnet 4.6   claude-sonnet-4.6 ● 高级  ×3   │
│        α  GPT-5.4 Search      gpt-5.4-search    ● 旗舰  ×8   │
│        …                                                     │
│ ④ 组B  国内直连 · 自带 Key (BYOK)   〔只显已配置的 model id〕 │
│        D  deepseek-chat        DeepSeek            高级       │
│        D  deepseek-reasoner    DeepSeek · 推理   ● 高级       │
│        智 glm-5                智谱 GLM            高级       │
│ ⑤ 组C  自定义     〔自定义端点配置后的 model,一 id 一行,可空〕│
│ ─────────────────────────────────────────────────────────  │
│ ⑥ 底部  ＋ 添加自定义节点 / 供应商                          │  ← sticky 底(唯一入口)
└────────────────────────────────────────────────────────────┘
```

层级原则:**代理(平台付费,最强模型)置顶 → 国内直连(BYOK,本地已配置)→ 自定义**。banner 与组 A 在视觉上成对(都属「平台」语义)。

**行 = 一个可选 model**:proxy 行 name=友好名(Claude Opus 4.8)、副标题=model id;BYOK/自定义行 name=model id、副标题=供应商名。一个供应商配了 N 个 model id 就是 N 行,切换无需进配置页(承用户反馈:「配完一个 id 不方便切别的」)。

---

## 4. 组件解剖

| 区 | 元素 | 行为 / 规格 |
|----|------|------------|
| ① 搜索 | input + 🔍 | 实时过滤(模型名 / id / 供应商名,大小写不敏感);`Esc` 清空再关闭;占位「搜索模型 / 供应商」。**无过滤 chips**——分组本身承担「代理 / 直连」分类,且每行只一个 model id,搜索足够。 |
| ② banner | 见 §6 | sticky,四态;成为登录/充值/订阅的唯一行动入口。 |
| ③④⑤ 组 | header + rows | header:组名 + 可选 `推荐` tag + 锁标;组 A 标题 = 「代理节点 · 经 ALPHA 代理」(统一表达 ALPHA 提供,行内不再写「经代理」)。 |
| 行 row | pico · 名称/副标题 · 推理点 · tier badge · ×mult | 一行 = 一个可选 model;见 §4.1。 |
| ⑥ 底部 | ＋ 添加自定义节点 / 供应商 | sticky,**唯一**加供应商入口(去掉了组内重复提示);点击进入 §7 自定义视图(同 popover 内二级页,非新窗)。 |

### 4.1 模型行解剖(row anatomy)

```
[pico] 名称 (15/medium)              [●]  [tier]  [×mult]
       副标题 (11/tertiary)
```
- **一行 = 一个 model id**(硬规则):不再把一个供应商的多个 model id 挤进一行(避免「不知道用哪个」)。
- **pico**:24×24 圆角方块,品牌色背景 + 单字(α / D / 智 / 通 / K)。代理行统一 α + indigo。
- **名称 / 副标题**:**代理行** name=友好名(Claude Opus 4.8)、副标题=model id(`claude-opus-4.8`);**BYOK/自定义行** name=model id(`deepseek-chat`)、副标题=供应商名(DeepSeek,推理变体加「· 推理」)。选中行 `--a-accent-subtle` 底 + 左 2px indigo 标。
- **推理点 ●**:6px indigo 圆点,仅 reasoning 模型。
- **tier badge**:旗舰(amber-subtle)/ 高级(bg-inset)/ 标准(bg-muted);规则见 §5.3。
- **×mult**:`tabular-nums`,代理行才显示(计费倍率);BYOK / 自定义行不显示(用户自付,无倍率)。
- **不再有「配置 Key」chip**:未配置的供应商**根本不出现**在列表里(见 §5.2),所以行内无 key 缺失态。

---

## 5. 模型分组与数据来源

### 5.1 组 A — 代理节点 · ALPHA-PLATFORM(平台付费)
- **来源**:`alpha-models.ts` 的 `buildAlphaModelConfig()`,仅当 `ALPHA_BASE_URL` 注入(= 已登录平台模式)时存在;经 `provider.alpha`(`@ai-sdk/openai-compatible`,baseURL=平台 `/v1`)。
- **示例模型**:Claude Opus 4.8、Sonnet 4.6、Haiku 4.5、GPT-5.4 Search / mini、DeepSeek V4 Pro / Flash。
- **可见性**:**永远渲染**(承接诉求①);锁定与否由登录态决定(§6)。未登录也要让用户「看见有什么、值多少」。

### 5.2 组 B — 国内直连 · BYOK(自带 Key,只显已配置)
**只列「已配置」的 model id,一个 id 一行;未配置的供应商不在此显示**(承用户反馈:未配置的别堆在选择器里,去「添加节点」配)。四个国内供应商作为 §7 的**快速预设**(填 Key 即接入),不是默认就摆在列表里的占位行。

| 供应商(预设) | pico | 预设 model id | 兼容 | Key env |
|--------|------|---------------|------|---------|
| DeepSeek | D / `#2563eb` | `deepseek-chat`,`deepseek-reasoner` | OpenAI | `DEEPSEEK_API_KEY` |
| 智谱 GLM | 智 / `#16a34a` | `glm-5`,`glm-4.5-air` | Anthropic | `ZHIPU_API_KEY` |
| 通义千问 Qwen | 通 / `#7c3aed` | `qwen-plus`,`qwen3-coder-plus` | OpenAI(Dashscope) | `DASHSCOPE_API_KEY` |
| Kimi (Moonshot) | K / `#111317` | `kimi-k2`,`moonshot-v1` | OpenAI | `MOONSHOT_API_KEY` |

- **来源(真相)**:已配置 = 用户 `opencode.jsonc` 里有该 `provider.<id>`(经 §7 流程写入)+ 其 `model[]`。**每个 model id 渲染成一行**(配了 2 个 id → 2 行,方便切换)。
- **可见性**:BYOK 不依赖平台登录;但只有「配置过」的 model 才出现。一个都没配 → 组 B 为空,只剩底部「添加节点」入口引导接入。
- **配置入口统一在 §7**:不在行内做「配置 Key」——未配置的供应商压根不显示。

### 5.3 Tier / 倍率规则(明确化,修 P2)
沿用并收口现 `tierOf()` 启发式,**文档化为可预期规则**:
- **旗舰 ×8**:`opus` · `gpt-5.5/gpt-5-pro` · `grok-4` · `gpt-5.4-search`
- **高级 ×3**:`sonnet` · `gemini` · `gpt-5*` · `*-reasoner/-r1/thinking` · `deepseek-v4-pro` · `glm-4.6`
- **标准 ×1**:其余
- **仅代理组显示 ×mult**;BYOK 组只显示 tier(无倍率,因自付)。
> ⚠️ 启发式靠 model-id 子串,新模型自动归类;新增代理模型时须回归本表(见 §11 实现注记)。

---

## 6. 登录态矩阵(核心:诉求①「考虑登录状态」)

数据:`window.api.auth.subscribe()`(`AuthState.status/mode`)+ `window.api.account.summary()`(`AccountSummary.balanceFen / plan.status / window5h·7d`)。四态由 `deriveState()` 推导:

| 态 | 触发条件 | banner | 组 A 代理 | 主行动 |
|----|----------|--------|-----------|--------|
| **out 未登录** | `auth.status==="logged-out"` | 🔒 中性「登录解锁代理节点 · 平台计费」 | **锁定**(dim .5 + 行点击=登录) | `[登录]` → `window.api.auth.start()`(ADR-017 深链) |
| **member 会员** | `plan.status==="active"` 且 5h/7d 额度足 | ✓ 绿「Pro 会员 · 本周期额度充足」 | **解锁** | 无(可点 banner 看用量) |
| **balance 按量** | 已登录,`balanceFen>0`,无 active plan | 💳 中性「钱包余额 ¥X.XX · 未订阅,按量扣费」 | **解锁** | `[订阅]` 次要 |
| **empty 余额不足** | 已登录,`balanceFen===0` 且非 active | ⚠ amber「余额不足 · 充值后解锁」 | **锁定** | `[充值]`(主) `[订阅]`(次)→ 深链 `web/wallet` |

**锁定态视觉**(out / empty):
- 组 A header 追加 🔒 + 行 `opacity .55; pointer-events` 由「none」改为**可点=触发主行动**(比现实现的「死禁用」更可引导)。
- 组 A 顶部叠一条窄 CTA 条:「登录后解锁 8+ 旗舰代理模型 →」/「充值后继续使用 →」。
- BYOK 组(B)**不受锁定影响**,始终可选——保证未登录用户也能干活。

边界:
- **加载中**:account.summary 未返回时 banner 显骨架(shimmer),组 A 暂按 `auth.mode` 乐观渲染(platform→解锁占位)。
- **summary 报错**:banner 降级为「账户信息暂不可用 · 重试」,组 A 保守锁定。
- **token 过期**(`expiresAt` 过)→ 视作 out。

---

## 7. 自定义节点 / 供应商流程(诉求②)

底部 ⑦ 点击 → popover 内**滑入二级视图**(非新弹窗,保持上下文),两步:

### Step 1 · 选供应商
```
←  添加节点 / 供应商
   选国内供应商一键接入,或自定义任意兼容端点
   ┌───────────────────────────────────────┐
   │ D  DeepSeek         OpenAI 兼容    填 Key 即用 ›│
   │ 智 智谱 GLM         Anthropic 兼容              ›│
   │ 通 通义千问 Qwen    Dashscope               ›│
   │ K  Kimi (Moonshot)  OpenAI 兼容              ›│
   ├───────────────────────────────────────┤
   │ ＋ 其他 / 自定义端点  OpenAI · Anthropic 兼容 ›│
   └───────────────────────────────────────┘
```
- **四国内预设(已知供应商)**:点任一 → Step 2,**只需粘贴 API Key**。供应商名 / 兼容类型 / baseURL / **模型 id 全部来自 alpha 内置目录**(provider→model-id 映射),用户**不手输模型 id**。
- **其他 / 自定义**:点 → Step 2 空表单,**只有这里需要手填 model id**。

> 核心简化(v1.1,据用户提议):已知供应商有内置 `provider→model-id` 目录,填 Key 即用,模型自动列出——避免手输错 id;只有无目录的兼容端点才手填。

### Step 2 · 配置
| 字段 | 已知供应商(预设) | 自定义端点 |
|------|------------------|-----------|
| 供应商名称 | 内置只读(如「DeepSeek」) | 必填文本 |
| 兼容类型 | 内置只读(OpenAI / Anthropic) | 单选(OpenAI / Anthropic 兼容) |
| Base URL | 内置预填(可改) | 必填(校验 https;开发模式允许 localhost) |
| **API Key** | **必填**(`password`,可切明文)— 唯一必填项 | 必填 |
| 模型 ID | **只读预览**「将启用的模型 (N)」,由目录给出,不可手输 | **必填**,手输 chips(回车分隔多个) |
| 测试连接 | 「测试连接」按钮 → 探活 baseURL+Key+模型,返回 `✓ 已接通 · Nms` / `✗ 失败原因` | 同左 |
| 默认设为当前 | checkbox | checkbox |
- **保存** → 写用户 `opencode.jsonc` 的 `provider[]`(经新 IPC,§11)→ 即时 `provider.add`/重载 → 回 Step 1 列表;**该供应商的每个 model id 各成一行**进组 B/C(配 N 个 id → N 行)。
- **测试连接(已拍板:1-token chat)**:保存前可探活——主进程用 baseURL+Key 对(预设首个 / 自定义首个)模型发一次 `max_tokens:1` 的最小 chat 请求(**验真**,非仅 `/models`),回成功延迟或失败原因,避免「存了却用不了」。走主进程 IPC(Key 不入渲染层)。
- **校验**:必填、URL 协议白名单(沿用 ADR-014 §8 的 URL/命令/字段白名单纪律);Key 不入渲染层日志。
- **错误**:保存 / 测试失败内联红字,不静默(承 [[silent-failure]] 纪律)。

### 7.1 内置模型目录(provider → model-id 映射)
| 供应商 | 兼容 | 内置 model id(示例) |
|--------|------|----------------------|
| DeepSeek | OpenAI | `deepseek-chat`,`deepseek-reasoner` |
| 智谱 GLM | Anthropic | `glm-5`,`glm-4.5-air` |
| 通义千问 Qwen | OpenAI(Dashscope) | `qwen-plus`,`qwen3-coder-plus` |
| Kimi (Moonshot) | OpenAI | `kimi-k2`,`moonshot-v1` |
- **维护点**:目录存 `alpha-catalog.json`(离线优先,ADR-014;可由 alpha-web C 增量刷新)。上新模型 = 改目录,用户无感升级,无需重配。
- 目录是「默认全启用」;如需 power user 自选子集,可后续加每模型 toggle(本版默认全列,见 §12)。

---

## 8. 交互细节

- **搜索**:输入即过滤,空结果显「无匹配模型 · 试试添加自定义端点 →」。
- **过滤 chips**:与搜索叠加(AND);切 chip 不清搜索词。
- **键盘**:↑↓ 跨组移动(跳过锁定行或落在行上触发 CTA),`Enter` 选中,`Esc` 关闭/退二级视图,`/` 聚焦搜索。
- **hover**:行 `--a-overlay-hover`;**选中**`--a-accent-subtle` 底 + 左 2px indigo 标。
- **载入动效**:popover `--a-ease-out` 130ms 渐显 + 轻位移;组/行 stagger ≤ 5 项(`animation-delay`)。
- **锁定行点击**:不静默——触发 banner 主行动(登录/充值)并轻微高亮 banner。

---

## 9. 空 / 异常 / 加载态

| 场景 | 表现 |
|------|------|
| 无任何 BYOK Key 且未登录 | 组 A 锁定引导登录;组 B 全行「配置 Key」;底部 CTA 强调「先接入一个供应商」。 |
| 搜索无结果 | 空态文案 + 「添加自定义端点」直达。 |
| account 加载中 | banner shimmer;组 A 乐观渲染。 |
| account 报错 | banner 降级「暂不可用 · 重试」;组 A 保守锁定。 |
| 自定义保存失败 | Step 2 内联错误,保留已填。 |

---

## 10. 视觉规格(全部用 `--a-*` token)

- 容器(尺寸约束,答用户「宽高是否要约束」= **都约束**):宽 **`380` 固定**(dropdown 不随内容回流,行宽稳定可扫读);**`max-height: min(560px, 72vh)`**——超出时**仅模型列表(`.mp-scroll`)内部滚动**,搜索 / banner / 底部按钮 sticky 不动,保证永不超出屏幕。`--a-radius-xl`,`border 1px --a-border-faint`,`--a-shadow-overlay` + `--a-edge-light`,`--a-surface` 底。
- 搜索框:`--a-bg-subtle` 底,`--a-radius-md`,聚焦 `--a-ring-focus`。
- chips:未选 `--a-bg-muted`/secondary 文;选中 `--a-accent-subtle`/`--a-accent` 文。
- 组 header:`--a-text-2xs` 字号 / `--a-tracking-wide` / `--a-text-tertiary`;`推荐` tag = `--a-accent-subtle`。
- tier:旗舰 `--a-warning`(amber-subtle 底);高级 `--a-bg-inset`/secondary;标准 `--a-bg-muted`/tertiary。
- banner:member=`--a-success-subtle`;balance/out=`--a-bg-muted`;empty=warning-subtle。
- 字体:产品 UI 沿用系统栈(`--a-font-sans`);倍率/id 用 `--a-font-mono`。
- 深色:`[data-color-scheme="dark"]` 自动切(原型用 `[data-theme]` 演示)。

---

## 11. 实现映射 / 依赖 / 与现状差异

| 主题 | 现状 | 重设计 | 落地策略 |
|------|------|--------|----------|
| 渲染方式 | 装饰原生 Kobalte popover(P5 天花板) | **alpha 自有 popover 组件**(ADR-016 已授权前端接管) | 由 `ModelChip` 直接挂自有 `<AlphaModelPicker>`,数据自 SDK + `alpha-models` 配置;不再依赖 MutationObserver 贴 badge。**备选**:若想保留装饰路线,组/锁定/二级表单需另开 Portal,复杂度高,不推荐。 |
| 代理模型来源 | `alpha-models.ts`(`ALPHA_BASE_URL` 在才有) | 同 + 未登录也展示「占位代理目录」(静态 catalog 兜底) | 代理模型目录抽进 `alpha-catalog.json` / `alpha-models.ts` 常量,未登录用静态目录展示+锁定,登录后用真实可用列表。 |
| 登录/额度态 | `window.api.auth` + `account.summary`(已具备) | 复用,集中到 `deriveState()` | 无新 IPC。 |
| 自定义供应商持久化 | **缺**(底部仅开定制中心占位) | 新增 `window.api.providers.add()` IPC,写用户 `opencode.jsonc` 的 `provider[]` | **唯一新增后端接缝**:类比 ADR-014 §4 的 `persistMcp`(路径/字段/命令/URL 白名单 + realpath 防逃逸),改写 `provider[*]` 白名单字段;`provider.add` 即时生效免重启。 |
| 内置模型目录 | 无(用户手配 model id) | `provider→model-id` 映射,已知供应商填 Key 自动列出(§7.1) | 复用 `alpha-catalog.json`(ADR-014,离线优先 + alpha-web C 可刷新);`alpha-models.ts` 的 whitelist 已是雏形,抽成显式目录。 |
| 测试连接 | 无 | 配置页「测试连接」探活 baseURL+Key+模型 | 新增主进程 IPC(如 `window.api.providers.test()`):用兼容类型对应的最小请求(OpenAI `/models` 或一次 1-token chat)探活;Key 留主进程不回渲染层。 |
| 一 id 一行 | 一供应商多 id 挤一行(困惑) | 每个 model id 一行,只显已配置 | 列表数据源 = SDK `config`/provider 已启用模型展开为逐 model 行;未配置供应商不渲染。 |
| tier 规则 | `tierOf()` 启发式(无文档) | §5.3 文档化 + 仅代理显倍率 | 保留启发式,加单元/回归清单;新增代理模型回归本表。 |

**纪律**:以上全为**新增 alpha 文件 / 新增 IPC**,不改 `packages/opencode/*` 源码,北极星(file-diff 守卫)不破;Tier-3 行为层无关。

---

## 12. 待确认(审计后定)

1. **代理目录未登录展示来源**:静态内置目录 vs 调用平台「公开目录」端点(后者需 B 侧新接口)。
2. **组 C 自定义端点**是否也参与 tier/倍率(默认按 BYOK 不计倍率)。
3. **Kimi 真实 model id**:`kimi-k2` / `moonshot-v1-*` 以接入时官方为准(原型用占位)。

### v1.2 已拍板(2026-06-27)
- ✅ **倍率 ×N 对外展示**:代理行直接显示 ×8/×3/×1(给用户看)。
- ✅ **内置目录默认全启用**:已知供应商填 Key 后,内置目录的**全部** model id 自动列出(无每模型 toggle)。
- ✅ **测试连接 = 1-token chat**:用一次 `max_tokens:1` 的最小 chat 请求验真(耗极少额度),非仅 `/models`。

### v1.1 已据审计反馈解决(2026-06-27)
- ✅ 去掉过滤 chips(分组 + 搜索足够)。
- ✅ 组标题统一「经 ALPHA 代理」,行内不再重复「经代理」。
- ✅ 一个 model id 一行;BYOK 只显已配置,未配置去「添加节点」配。
- ✅ 已知供应商填 Key 即用(内置 `provider→model-id` 目录自动列出),只有自定义端点手输 id。
- ✅ 配置页加「测试连接」探活。
- ✅ 去掉与底部按钮重复的组内入口;选择器宽(380 固定)高(`min(560,72vh)` 内滚)都约束。
