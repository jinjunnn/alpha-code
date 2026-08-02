---
title: REQ-128 Phase 3 方案基线：本地 Claude 插件包导入（Skill 窄竖线）
kind: design
status: accepted
owners:
  - alpha-code extension maintainers
last_reviewed: 2026-08-02
review_after: 2026-11-02
---


> **v2 = v1 + Codex 方案审计 R1 九条 finding 全量闭合 + owner 七条裁决落实。**
> 与 v1 的关系：结构（§0–§12）逐节继承并原地更新，不重写；新增 §13 闭合对照。
> 勘破基准：`alpha-code@3a3f443d`（分支 `alpha`）/ `alpha-web@e614b5e`，只读 worktree
> `.worktrees/req128-p3-gt`。
> **本稿所有带 `file:line` 的断言与所有语料数字，均由本轮在该树 / 本机语料上实读实跑。**
> 凡沿用 v1 而本轮未重跑的，逐条标「v1 未复核」。本轮共**推翻 3 个数字**（见 §3 尾）。
> owner 已裁决的七条只实现、不重裁。

---

## 0. 大白话：这一期用户会看到什么

用户在扩展中心点今天就有的「从文件夹导入」，挑一个 Claude 插件目录。主进程自己去读那个目录，
**只认技能这一件东西**，逐个判「这个技能能不能装」，然后弹一张预览：

- **能装的**列出来；
- **装不上的**逐条说人话原因。原因现在有五类，全部具名，一条都不静默：
  1. 「你已经有一个同名技能了」（重名，owner 裁决 D）
  2. 「这个技能的说明写成了多行，我们读不了」（frontmatter 读不出）
  3. 「这个技能要用到它自己文件夹以外的东西，装过去会缺件」（**不自包含**，owner 裁决 A）
  4. 「这个技能带了我们这边没有对应功能的开关（比如只允许用户手动调用），装过去它的行为会变，
     所以不装」（**调用控制字段**，owner 裁决 C）
  5. 「这个文件夹里的技能摆放方式我们这一版还不认识」（**不支持的布局**，见 §3.2）
- 这个插件里我们这一版不支持的**组件类型**（commands / agents / hooks / .mcp.json）逐类具名列出。

用户点确认，这一包技能在**一次事务**里一起装进去——装成就全装成，中途挂就一个都不留；
账本同时记下「这是一个包、它由这几个技能组成、它们归这个包所有」。

**装完之后它们默认是「关着」的**（owner 裁决 B）。扩展中心多出一个「已装扩展包」区块，
看得见它、看得见里面每个技能的开关；用户自己打开某个技能，引擎当场重载，**下一条消息里就能用**。
区块旁边有「移除」，点一下整包连文件带账本一起消失，引擎同样当场重载。
而在包装着的时候用户想单独卸掉其中一个技能，系统会明确拒绝并告诉他「去卸这个包」。

**选的是路线 C（本地 prepared 包 + 复用既有事务引擎与 V3 包账本 + 不进 admission 的 catalog 门）。**
它一行冻结合同都不改，拿到原子性、崩溃恢复、包组成图、归属集合与整包卸载；它付出的代价是
诚实且可枚举的：**admission 那一整套「进包的保证」在这条路上没有替代品**，只由三件事兜底
——用户亲手选的目录、逐条告知、账本里恒为 user 的策展维。**这句话必须留在首页，不许挪进附录。**

**本期一个字节都不改写第三方内容**（owner 裁决 G）：读不了 / 不自包含 / 带我们兑现不了的
控制字段 ⇒ 一律不装 + 说人话原因。owner 裁决①「允许改写并留痕」是**许可，不是要求**，本期不行使。

---

## 1. 选路：为什么是 C，为什么不按某一份稿的字面推进

R1 审计对四条承重事实逐条复核，**四条均为真，路线 C 不翻盘**：`#306` 不需要改；generation / CAS
原语支持多文件（`ext-skill-generations.ts:252`）；事务硬上限确为 64（`ext-transaction.ts:650`）；
整包与直接卸载判决均不依赖 provider（`ext-package-uninstall.ts:225`）。
R1 的九条 finding **全部落在「Claude 插件目录 → 一组可用 Alpha Skill」这一层输入适配上**，不动选路。

三视角评判 3/3 推荐 C-hybrid。两份 C 稿各自在对方的半场上有一处会在真机上炸的错，本稿取交集：

| 来源 | 拿走什么 | 丢掉什么 |
| --- | --- | --- |
| C 稿（C 泳道） | 账本半场：图节点 digest 与 record digest 互不校验 ⇒ `#306` 一个字不用改；admission 十六条保证逐条点名；同名静默覆盖；合成 root 卸不掉 | 「复用 `buildSkillTxItems`」——它只装得下一个 SKILL.md（见 §7 K5） |
| C 稿（B 泳道） | 载荷半场：`collectImportSkillPayload` → `promotePayloadToCas` → 多文件 generation item；对 B 的结构性证伪 | 全部量化证据取自 `.codex-plugin` 语料，与本期 provider 无关（见 §7 K1） |
| A 稿 | 「装完打不打得开」必须有一道闸；改写留痕的判据必须是全量逐文件比字节 | 载荷寻址走信封 = 给一份跨两仓、带自证哈希的签名合同开第二种信任语义 |

### 为什么不走 A（包管线）

三堵墙一堵都绕不开，而且每一堵都是**已冻结的跨仓合同**：

1. 载荷必须是规范 https 引用。实读：`^https://` 在 vendored schema 里有**四个**站点
   ——`alpha-package-envelope-v1.schema.json:159`、`profiles/skill.v1.schema.json:60`、
   `profiles/agent.v1.schema.json:60`、`profiles/mcp-remote.v1.schema.json:27`。（v1 已跑，本轮未重跑）
2. `package-admission.ts:462` 要求 catalogId 出现在**已验签** Catalog 里（本轮实读确认，见
   `resolvePreparedPackage`，`package-admission.ts:450-462`）。
3. `package-admission.ts:631-632` 把 `origin` 硬写成 `"catalog"`，而
   `ext-receipt-v2.ts:227-236` 的 `#306` durable 不变量对 catalog 来源**允许**携带 manifest /
   payload / grant digest 且要求保留前缀 id。走 A 意味着给用户从磁盘挑的第三方字节盖上一个与
   已验签目录同形的 provenance，账本此后无法区分两者——那行错误信息的原文就是
   `catalog identity is not forgeable`。

**A 稿推荐 A 的唯一硬理由是假的。** 它写「C 也省不掉 `#306` 第三臂，所以 A 与 C 的账本改动量
相同」。实读证伪：`applyPackageMutation` 只对 child record 跑 `decodeRecordV2`
（`ext-receipt-v2.ts:1414`）；包的内容摘要存在**图节点**上（`PackageGraphNodeV1.manifestDigest`，
`ext-package-ledger-v3.ts:53`，只过 `/^sha256:[0-9a-f]{64}$/` 格式校验）；
`validateV3State`（`ext-package-ledger-v3.ts:534-556`，本轮逐行实读）从头到尾只校验
「图节点有没有 claim / claim 有没有对应 record / owner token 有没有孤儿」，**不拿图节点 digest
与 record 对照**。所以「子 record 走 `user:<name>` + 零 digest」与「图节点带本地摘要」可以合法
共存 ⇒ **C 的 `#306` 改动量是 0**。

> ⚠️ **同一次实读同时暴露了 R1-B1**：`validateV3State` 也**没有 record → 图**这个方向。
> 这条事实一体两面 —— 它让 C 便宜，也让 C 必须自己补一道双射闸（**G15**）。见 §6。

另有一条 A 没看见的代价：`renderer/alpha-ui/composer-autocomplete.tsx:155` 用
`r.origin.startsWith("imported")` 挑「用户导入的技能」进 composer 自动补全。A 提议的新 origin
`local-package` 不匹配 ⇒ 本地插件包装上的技能在 composer 里**不出现**，而 typecheck 不会红。
C 沿用 `imported-claude` 白拿这一条。

### 为什么不走 B（纯本地组件管线加一层分组）

B 的定义性部分是「不进 V3 账本」，而不进 V3 账本 ⇒ claims 恒空 ⇒
`ensureStandaloneClaims` 在 `claims.length === 0` 时早返回（`ext-receipt-v2.ts:995-1001`）⇒
`directUninstallVerdict(null)` 直接返回 `{decision:"delete"}`（`ext-package-ledger-v3.ts:410-411`）
⇒ **B 造出来的「包」可以被今天就存在的 `ext-uninstall-v2` 一个组件一个组件静默掏空**。
B 要堵这个口，唯一办法是造第二套 owner/claim 模型，届时「一个组件归谁所有」有两个答案，
而两者不一致时没有判据说哪个对——这正是 `ext-package-ledger-v3.ts` 抬头拒绝 refcount 的同一条
理由，也是本 portfolio 明令禁止的第二套 ABI。

B 唯一无可替代的贡献是它的**载荷半场**，本稿原样吸收。

---

## 2. 与 REQ-063 既有实现的关系（增量纪律，必写）

`main/ecosystem-import.ts` 抬头已经把这件事的语义定死：

> REQ-063(ADR-024)：外部生态继承 default-deny 的「同意 = 安装期转换导入」后端……产物为原生
> alpha 资产，与外部目录脱钩——快照语义，重导入是唯一更新通道；origin 标
> `imported-claude` / `imported-agents` 可溯源。

**本方案一个字都不改这条语义，只把它的粒度从「一个 skill」升到「一个包」。** 逐条：

| REQ-063 已交付 | 本期怎么处置 |
| --- | --- |
| 「同意 = 安装期转换导入」「产物与外部目录脱钩」「快照语义」「重导入是唯一更新通道」 | **原样沿用**，一字不改 |
| origin 词汇 `imported-claude`（`preload/types.ts:222`）、党派 `local-import`（`shared/ext-ownership.ts:46`） | **原样沿用，不发明新 origin** |
| flat 的 `importSkillFolder`（`ext-fs-installer.ts:670`） | **不用**。REQ-098 `#390` 已把 global 未策展导入挪到 `installUncuratedSkillImport`（`ext-install-planner.ts:2646`），本期接的是这一条 |
| 载荷采集 `collectImportSkillPayload`（`ext-fs-installer.ts:574-613`：realpath 圈禁 + `O_NOFOLLOW` + `O_NONBLOCK` + fstat 帽 + 定长读 + 增长探测 + **跳 symlink** + 10MB/500 条帽） | **一个字节不改地复用**，含它的多文件 `files[]` 返回。⚠️ 但**不得**把它的输出当作「源目录长什么样」的真源——见下方注与 **G16** |
| frontmatter 闸 `parseSkillFrontmatter`（`main/ext-import-validate.ts:7-24`） | **复用同一份**。本期只让它**把已经解析出来的完整键集交出来**（见 §5 与 **G17**），**不引 YAML 解析器** |
| `installUncuratedSkillImport` 的「一次一个 skill、一次一个事务」（:2646-2687） | **这是唯一要改的粒度**：N 份载荷 → N 条 generation item → **一次** `runExtensionTransaction` |
| 锁内 fresh-only 闸 `uncuratedSkillFreshGate`（`ext-install-planner.ts:2626`，**当前是模块私有**；`:2655` 锁外预检 + `:2675` 锁内 `precondition` 双调） | **导出并复用同一份**，为 N 个 accepted skill 建组合 precondition（**G4 重写**，R1-B2） |
| preview→confirm 两段式（agent 导入，`ext-ipc.ts:156-182`：previewId 由 main 持有、renderer 全程给不出写入内容、**写成功才消费**（`#351`）） | **照抄形状**。⚠️ 它的留存帽是**条数帽 16 + 每条 ≤256KB**（`:162`/`:167`），**不能原样套到包字节**——见 **G19**（R1-M1） |
| 5 张导入卡（`extension-hub.tsx:2264` 起） | **不新增第六张卡**。只在 **main 侧** picker 之后分流 |
| 安装成功后的引擎热重载：`use-extensions.ts:605/747/763/771` 一律 `refreshEngine()` 并透传 `reload-pending`；`:610-614` 生产注释原文「不触发重建就是 placebo 安装」 | **必须接上**。今天的整包移除（`extension-detail.tsx:165-183`）**只 `refetchInstalled()`，不 refresh** ⇒ 本期补（**G20**，R1-B6） |

> **注（本轮新发现，v1 与 R1 都没说）：`collectImportSkillPayload` 的输出不是源目录的忠实镜像。**
> `collectImportFiles`（`ext-fs-installer.ts:478-480`）**静默 `continue` symlink**，并静默跳过
> `.git` / `node_modules` / `__pycache__`；返回值也不携 mode（`:574`）。
> v1 的 **G3** 把「装完的文件集合」与「collector 采到的 `files[]`」比对 —— 那是**拿实现自己拼的
> 等价链当断言**（假闸形态⑧）：**凡 collector 悄悄丢掉的，G3 结构上永远不会红**。
> 因此本稿把两件事分开：**G3 比对源目录的独立扫描结果**；**G16 用独立 lstat 扫描做自包含判定**。

**新建平行路径的判据不是「有没有新文件」，是「同一个问题有没有第二个答案」。** 本方案里
「一个包由哪些组件组成 / 每个组件归谁所有 / 怎么整包卸载」这三个问题的答案继续由 V3 账本
**唯一**持有，落账走 `commitTransactionLedger`（`ext-package-ledger-commit.ts:20`）这**一个**入口，
整包卸载走 `uninstallPackageV1`（`ext-package-uninstall.ts:225`）原样。
新增的只有「怎么从一个本地 Claude 插件目录得出这份 mutation」——那是**输入适配**，不是第二个真源。

---

## 3. 本机真实语料（本轮亲测，是本稿一切数字的唯一基准）

### 3.1 语料边界（先说清楚，因为它推翻了一个数字）

- **`~/.claude/plugins/marketplaces`（排除 `.bak`）= 本稿的判据语料。** 62 个插件 / 162 个 SKILL.md。
- **`~/.claude/plugins/cache` 不是第二份语料，是同一批插件的版本仓。** 实测：121 份 `plugin.json`
  只对应 **26 个不同插件**（`remember` 9 版、`skill-creator` / `pr-review-toolkit` 等各 8 版）；
  318 份 SKILL.md 只有 **150 份不同内容**。**跨 `{marketplaces,cache}` 计数 = 把同一个技能数 8 遍。**
- `cache/temp_git_*` 27 个目录全是**裸 `.git` 克隆，无工作树**，SKILL.md 数为 0。
- `marketplaces/claude-for-financial-services.bak` 是一个**真实存在的普通目录**（另含 118 份
  SKILL.md）。对我们来说它就是个可被用户选中的文件夹，**没有任何判据能把它认成「备份」**——
  夹具不许依赖「排除 .bak」这个前提。

### 3.2 布局普查（R1-B5 的闭合证据。**证据来自本机语料，不是官网文档**）

> R1-B5 方向成立（v1 §12 风险 7 自己承认这是最弱前提），**但 Codex 的证据取自
> `code.claude.com` 官网文档**。本 portfolio 明令「不看官网、不凭记忆、不推断；执行装着的那个
> 版本」。以下全部由本轮在本机语料上跑出来。

**轴一（路径形态普查）**：对全部 162 份 SKILL.md，逐个向上找最近的带 `.claude-plugin/plugin.json`
的祖先目录，再看相对路径形状：

| 形状 | 数量 | 说明 |
| --- | --- | --- |
| `skills/<n>/SKILL.md` | **159** | v1 假定的唯一形态 |
| `.claude/skills/<n>/SKILL.md` | **1** | `claude-for-financial-services/claude-for-msft-365-install`。该插件根**没有** `skills/` |
| **没有任何祖先带 `plugin.json`** | **2** | `claude-plugins-official/plugins/{receipts,session-report}` |

**轴二（独立轴：从插件根出发数）**：62 个插件根按 v1 规则 `skills/*/SKILL.md` 数，
**37 个有 ≥1，25 个为 0**。而按路径归属数得到「40 个 owner」——**两轴差 3，差的正好就是上表
那 3 个异常布局**。两条互相独立的轴交叉验证到同一结论，不是巧合。

**四个必须写进 preview 的事实：**

1. **manifestless 的多 skill 插件是官方现役形态，本机就有。**
   `receipts` 与 `session-report` **没有** `.claude-plugin/plugin.json`，却**都是
   `.claude-plugin/marketplace.json`（276 条）里的一等条目**，作者 Anthropic，
   `"source": "./plugins/receipts"`。它们各有 `skills/<n>/SKILL.md`。
   按 v1 的识别规则它们会**落回单 skill 路径** ⇒ `collectImportSkillPayload` 要求所选根目录直接
   有 SKILL.md（`ext-fs-installer.ts:585`）⇒ 用户得到「文件夹内没有 SKILL.md」——
   **一句与真因毫无关系的错误信息**。这正是 v1 §12「保守方向，不是错误方向」不成立的地方。
2. **`plugin.json` 里的 `skills` 字段：本机 183 份 manifest（62 + 121）中出现 0 次。**
   manifest 的键全集实测只有 `{name 62, description 62, author 57, version 35, keywords 7,
   homepage 4, repository 2, license 2}`。⚠️ 顺带一条：**`version` 缺席 27/62**——
   intake **不得**把 version 当必填，否则 44% 的真实插件直接被拒。
   Codex 点名的这条布局**在本机不可达**：本稿据此**不实现**它，但按下面第 4 条具名。
3. **有一种布局 R1 没点名，本机有实例**：`workflow-skills/<n>/SKILL.md`——`figma` 插件
   （cache 的 2.2.81 / 2.2.87 两版，各 2 个）在 `skills/` **之外**另有一个 `workflow-skills/`
   目录装 SKILL.md，**而它的 `plugin.json` 没有任何 `skills` 声明**。
   我们无法（也不该）判断上游是否把它当技能加载 —— 但**两种可能指向同一个做法**：
   preview 必须说清「我枚举了哪个目录、忽略了哪些同样含 SKILL.md 的目录」。
4. **还有一种目录会撞进来：装成插件的 marketplace 仓。**
   实测 5 个目录带 `.claude-plugin/` 但里面**只有 `marketplace.json`、没有 `plugin.json`**
   （3 个 marketplace 根 + `atomic-agents` 的 2 个 cache 版本）。`atomic-agents` 还带
   `.claude/skills/release/SKILL.md`。v1 的探针（「`plugin.json` 存在且可解码」）会让它落回
   单 skill 路径 ⇒ 同样一句错误信息。**这是与第 1 条同类、但触发器不同的第三个入口。**

**本期实现范围（窄）**：只认 `<根>/skills/<n>/SKILL.md`（深度实测恒为 2，314 份无一例外）。
**其余全部布局必须在 preview 里以「不支持的布局」具名出现**，`{root-level, .claude/skills,
workflow-skills 等 skills 之外的 SKILL.md 目录, manifest 声明的自定义目录, 只有 marketplace.json}`
每一类一个原因码，**不许落回「没有 SKILL.md」、不许计成 0-skill、不许静默**。闸 = **G18**。

（顺带：`<插件根>/SKILL.md` 这种「根本身就是一个技能」的布局，在 marketplaces + cache
共 318 份 SKILL.md 里出现 **0 次**——本期不实现，但同样进「不支持的布局」枚举。）

### 3.3 语料统计（判据语料 = marketplaces，排除 .bak）

| 事实 | 数字 | 与 v1 的关系 |
| --- | --- | --- |
| Claude 插件（`.claude-plugin/plugin.json`） | **62** | 复核一致 |
| `skills/*/SKILL.md` | **162** | 复核一致 |
| 其中**多文件技能目录** | **40（24.6%）** | 复核一致 |
| 单插件 skill 数上限 | **13**（`financial-analysis`；次 11 / 10 / 10 / 9） | 复核一致 |
| **零 skill 的插件** | **25（40.3%）** | ⚠️ **推翻 v1 的「28（45%）」**。结论方向不变：仍是多数情形 |
| 带 `commands/` / `agents/` / `hooks/` / `.mcp.json` 的插件 | **22 / 20 / 12 / 22** | 复核一致 |
| 喂真 `parseSkillFrontmatter` 的通过率 | **161 / 162** | 复核一致 |
| 唯一失败者 | `math-olympiad`，理由「description 缺失」——实因是多行 YAML 折叠标量撞上我们的**行级正则**（`ext-import-validate.ts:16`） | 复核一致 |
| 不同技能目录名 | **106** | 新测 |
| **跨插件重名的技能名** | **34 组**（`xlsx-author` ×9、`audit-xls` ×7、`pptx-author` / `comps-analysis` 各 ×4） | 复核一致 |

### 3.4 自包含度（R1-B3 / owner 裁决 A 的判据语料）

判据（owner 裁决 A）：**引用了自己目录之外的资源 / 带可执行位 / 带符号链接 ⇒ 不装。**

| 轴 | 数字 | 备注 |
| --- | --- | --- |
| 带**任一** x 位的文件 | **25**，分布在 **9 个技能目录** | ⚠️ Codex 报的 **19** 用的是 `find -perm -111`（要求 u+g+o **同时**有 x）。「带可执行位」的正确语义是**任一** x 位 ⇒ **25 / 9 个目录** |
| symlink | **0**（marketplaces 与 cache 全域） | 真实语料零实例 ⇒ 这一臂只能靠**合成夹具**验。且 collector 本来就静默丢 symlink ⇒ 必须**独立 lstat 扫描**才看得见（见 §2 注） |
| SKILL.md 引用 `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_SKILL_DIR}` | **7** | 与 Codex 一致 |
| **引用兄弟技能**（`../` 路径） | **1** | ⚠️ **R1 没点名的一类**：`mcp-server-dev/skills/build-mcp-app` → `../build-mcp-server/references/elicitation.md`（目标文件真实存在）。按「一技能一 generation」的安装形态，这条引用装完必断 |
| 引用只在插件根解析得到的文件 | **3** | `commands/example-command.md`、`.claude-plugin/plugin.json` ×2、`./scripts/clear-addin-cache.sh` |
| **并集：不自包含的技能** | **18 / 162（11.1%）** | 集中在 `plugin-dev`（6 个）、`skill-creator`、`claude-security`、`hookify`、`codex` 等 |

两条独立检索轴：轴一 = 对 SKILL.md 正文 grep 环境变量名；轴二 = 抽取路径形 token 后
**在文件系统上实际 resolve**，判「技能目录里没有、插件根有」。两轴命中集**不重叠**
（轴一 7 个、轴二 4 个），说明单靠 Codex 那条 grep 会漏掉 4 个。

### 3.5 调用控制字段（R1-B4 / owner 裁决 C 的判据语料）

用**生产解析器的忠实复刻**（`ext-import-validate.ts:10-18` 的同一段逻辑）扫 162 份 SKILL.md，
只看 frontmatter 块内的顶层键：

| 顶层键 | 携带它的 SKILL.md 数 |
| --- | --- |
| `name` | 162 |
| `description` | 161 |
| `version` | 13 |
| **`user-invocable`** | **10** |
| `license` | 2 |
| `tools` | 2 |
| **`disable-model-invocation`** | **1** |
| **`argument-hint`** | **1** |
| **`allowed-tools`** | **1** |

- **带 ≥1 个调用控制字段（上表加粗四项）的技能：12 / 162。**
- **带任一「`name`/`description` 之外的键」的技能：29 / 162。**

> ⚠️ **本轮推翻两个数字，且两个都是同一个错法。**
> 编排者给的 **84** 与 Codex 报的 **16** 我都复现出来了：它们是**同一条 `rg` 整文件命令**，
> 只是语料范围不同（84 = `{marketplaces,cache}`，16 = `marketplaces`）。
> 两个都偏大，原因有两条互相独立：
> 1. **整文件 grep 会命中 markdown 正文里的示例。** 单看 `allowed-tools`：整文件 grep 报 11，
>    真在 frontmatter 里的只有 **1** —— 另外 10 处是 `plugin-dev` / `skill-creator` 这类
>    「教你怎么写 SKILL.md」的技能在正文里举的例子。
> 2. **`cache` 是版本仓**（见 §3.1）：同一个技能被数 8 遍。
> 同一条命令在 `{marketplaces,cache}` 上按解析器真值算是 **54**，按内容去重后是 **32**，
> 而**决定产品行为的那个数是 12**。
> **这正是 §8 纪律 1 的实例：拿一条正则替代真解析器，得到的是一个假的「有」。**

**引擎侧后果实读确认**（这是「用户可观察行为出错」的落点）：
`packages/opencode/src/skill/index.ts:37-42` 的 `Skill.Info` 只有 `{name, description?, location,
content}`；`skill/index.ts:310-315` 的 `available()` 把**全部**技能交给模型（只过 agent permission）；
`command/index.ts:134-140` 把**每一个**技能登记成用户命令。
⇒ 一个 `user-invocable: false` 的内部技能装进 Alpha 后，**既进模型可选集、又进斜杠命令表**。
字节没改，**运行语义变了**。本机真实受害者：`openai-codex/codex` 的 3 个技能全部
`user-invocable: false`。

### 3.6 「这个功能到底能装上多少」——合成结果（新测，owner 应知）

把 owner 裁决 A（自包含）+ C（控制字段）+ frontmatter 可读三条一起套到 162 份真实技能上：

- **从干净机器装第一个插件**：**135 / 162（83.3%）可装**；27 个被具名拒绝
  （12 控制字段、9 exec 位、7 插件根变量、3 根解析引用、1 兄弟技能引用、1 描述读不出，有重叠）。
- **40 个「有技能的插件」里，有 10 个（25%）一个技能都装不上**：
  `openai-codex/codex`（3/3 控制字段）、`external_plugins/{discord,imessage,telegram}`、
  `claude-security`、`hookify`、`math-olympiad`、`project-artifact`、`skill-creator`、
  `claude-for-msft-365-install`。
- 再叠加 owner 裁决 D（重名跳过）后的**连续安装**场景：可装数降到 56 / 162，全灭插件升到 22 / 40。
  （框定：重名只在装**第二个**重叠插件时才咬人，第一次装恒不受影响。）

**这三个数字必须进 owner 的验收视野**：本期交付的是一条**闭合但收得很窄**的竖线。
「装不上」是多数情形之一，所以 §0 的「逐条说人话」不是锦上添花，**它就是这个功能的主要产出**。

---

## 4. 用户可达路径逐跳点名票主

每一跳都必须有一张票拥有它。按层拆票切断用户竖线是 Phase 1（漏 renderer 半场）与 Phase 2
（漏三条跨仓竖线）各栽过一次的同一形态。

| # | 用户看到的这一跳 | 今天在哪 | 本期怎么改 | 票主 |
| --- | --- | --- | --- | --- |
| 1 | 点「从文件夹导入」，选一个目录 | `extension-hub.tsx:2268` 卡 → :440 `runImportFolder()` → `ext.importSkillFolder()` → `ext-ipc.ts:973`（main 自弹 picker，renderer 不传路径，`#255`） | **不新增按钮**。**main 侧**在 picker 返回后按 §3.2 的布局普查分流；不是插件目录 ⇒ 原路走单 skill，行为逐字不变 | `[新票:T1-intake]` / `[新票:T4-renderer]` |
| 2 | —（用户看不见）main 认包并清点，**零写盘** | 不存在 | 新增 `main/claude-plugin-intake.ts`：读 `plugin.json` 的 name/**version（选填）**/description；枚举 `skills/*/SKILL.md`；逐个跑 `collectImportSkillPayload` + `parseSkillFrontmatter`（**取完整键集**）+ **独立 lstat 自包含扫描**；`commands/` `agents/` `hooks/` `.mcp.json` 与**所有不支持的布局**一律具名列出 | `[新票:T1-intake]` |
| 3 | 预览屏：能装的 / 不能装的 + 五类人话原因 / 不支持的组件类型 / 不支持的布局 | 形状已有：`ext-ipc.ts:156-182` agent 导入两段式 | 新增 `ext-import-claude-plugin-preview`（**纯读，不进 gated 写表**）：main 侧 `issuedPluginImports` 持 previewId + 已收集载荷字节 + 逐条判决 + **包级字节/文件预算**（G19）。照 REQ-033 的「留字节」形状，**不做 confirm 期重扫** | `[新票:T3-channel]` / `[新票:T4-renderer]` |
| 4 | 点确认 → N 个技能一次事务装进去 | 引擎已有：`runExtensionTransaction`（`ext-transaction.ts:1055`，≤64 items :650，只允许 root item 携 `packageMutation` :654-656） | 新增 `main/claude-plugin-install.ts`：**由同一个 accepted 数组**派生四件东西（preview included 集 / 带 receipt 的 items / 图节点 / claim acquisition），**调事务前断言四个 key 集逐字相等**（G15）；锁内跑**导出的** `uncuratedSkillFreshGate` 组合 precondition（G4）；N 份载荷经 `promotePayloadToCas` → N 条**多文件** generation item → 一次 `runExtensionTransaction`。**不走 `buildSkillTxItems`** | `[新票:T2-install]` |
| 5 | —（用户看不见）落账：包图 + 归属 | `commitTransactionLedger`（`ext-package-ledger-commit.ts:20-64`）→ `applyPackageMutation`（`ext-receipt-v2.ts:1343`）。两者只看有没有 `packageMutation`，**不问来源**；`:47` 的 upsert 由**全部带 receipt 的 record** 派生，与图无关 | **零改动**，但 G15 的双射断言必须在**调用它之前**做——它自己不会替我们判 | `[新票:T2-install]` |
| 6 | 已安装列表里看得见「这是一个包」，**并看得见每个技能的启用开关** | **今天在 renderer 是断的**。唯一能看见已装包的地方是 `extension-detail.tsx:141` 的 `kind === "package"` 分支，只由**远程 catalog** 进得去；main 侧只读投影 `ext-package-installed`（`ext-ipc.ts:210-230`）是**按单个 packageId 查**，没有「列出全部」 | 新增一条只读 IPC：从 `readPackageLedgerStateV1` 列出本机 V3 图（packageId / 显示名 / version / 组件安全投影 / 来源）。Hub 增「已装扩展包」区块。**因 owner 裁决 B 默认 disabled，本跳必须同时呈现启用开关**——否则用户装完拿不到任何东西 | `[新票:T3-channel]` / `[新票:T4-renderer]` |
| 7 | 点「移除」，整包连文件带账本消失 | main 侧**已就绪且 provider 无关**：`uninstallPackageV1`（`ext-package-uninstall.ts:225-253`）；写通道已注册（`ext-write-channels.ts:31`）；preload 已暴露。**缺 renderer 入口** | main 零改动。挂到第 6 跳区块上 | `[新票:T4-renderer]` |
| 8 | 想单独卸掉包里某一个技能 → 被明确拒绝并指向整包卸载 | 已全有且已加固：`planDirectUninstall`（`ext-receipt-v2.ts:1068`）→ `directUninstallVerdict`（`ext-package-ledger-v3.ts:410-423`），判决在删任何实物**之前**做（`#757`） | **零改动**。选 C 而不是 B 的直接回报 | `[新票:T2-install]`（AC 里断言对本地包同样生效） |
| **9** | **装完显示「未启用」→ 用户拨开关 → 引擎当场重载 → 下一条消息里技能真可用** | `use-extensions.ts:136` 已把 `refreshEngine()` 放在 `ExtensionsApi` 上；`:605` 的启停路径已经在调它。**缺的是**：本地包 confirm 后没接、整包卸载（`extension-detail.tsx:165-183`）**只 refetch 不 refresh** | ①落账 `desiredState` 按裁决 B 为 `disabled`（落点见 §5）；②confirm 成功 **与** 整包卸载成功后都走既有 `refreshEngine()`，失败呈现 `reload-pending`；③**验收路径改成「显示未启用 → 用户启用 → refresh → 下一条消息可用」** | **`[新票:T2-install]` + `[新票:T4-renderer]` 共同拥有** |

**第 6/7/9 跳必须与第 4/5 跳同一 Iteration。** 它们是整条竖线里最容易被按层拆票切断的一段，
而第 9 跳在裁决 B（默认关）之下**跨了 T2 与 T4 两张票**——这正是 Phase 1/2 各栽过一次的形状。

---

## 5. 动到的已冻结合同 / 已交付不变量

| 动的是什么 | 位置 | 必要性 | 炸半径 |
| --- | --- | --- | --- |
| **`PackageGraphV1.envelopeDigest` 的语义**：今天恒来自一份已签名信封；本路线让它承载「本地插件目录的规范化载荷摘要」 | `ext-package-ledger-v3.ts:73`（类型）、:220-262（decoder，只校验 `^sha256:[0-9a-f]{64}$`，**不校验来源**） | **必要，且是本路线唯一真正动到的已交付不变量** | `ext-package-ledger-v3.test.ts`、`ext-package-ledger-uninstall.test.ts`。**renderer 面零影响**（本轮实读 `ext-ipc.ts:219-229` 的只读投影只回 packageId / installedGraphDigest / components，**不透 `envelopeDigest`**）。**处置 = §9 D3 已裁（保留字段名 + 测试钉死）** |
| **`grants.json` 里的 `manifestDigest` 语义**：本路线上它是**本机对本地字节算的哈希** | `ext-transaction.ts:904-911` | 结构性不可避免 | 不参与任何安全判定（授权闸只看 capabilities 集合，`ext-capability-grants.ts:88-101`），**不构成漏洞，但会被误读**。处置：本地包的值一律带 `sha256-local:` 前缀 |
| **新增两条 IPC**（**边界本稿钉死，修掉 v1 §5 与 T3 的自相矛盾，R1-M2**）：`ext-import-claude-plugin-preview` = **纯读，不进 `GATED_WRITE_CHANNELS`**；`ext-import-claude-plugin-confirm` = **必须进** | `ext-write-channels.ts:25-40`（写通道唯一注册表） | 必要且不可绕。**与既有先例逐字一致**：本轮实读该表，`ext-import-agent-confirm` 在表内、`ext-import-agent-preview` 不在 | `ext-write-channels.test.ts` 按真实表逐通道断言，会自动覆盖新通道 |
| **新增一条只读 IPC**：列出本机 V3 包图 | `main/ext-ipc.ts` | 必要。第 6 跳今天结构上不可达 | 返回必须是安全投影：**无绝对路径、无 owner token**（对齐 `ext-ipc.ts:207-209` 既有纪律）；「账本读不出来」与「没装」不许折叠（:214-216） |
| **`package-admission.ts` 加且只加一处命名空间拒绝**（R1-M2 闭合；v1 的「零改动」在此**显式让步一处**） | `resolvePreparedPackage`（`package-admission.ts:450-462`，本轮实读；当前 `PACKAGE_ID_RE`（`ext-package-ledger-v3.ts:45`）**接受** `local:x`） | 必要。只做本地铸造侧的单向闸 = 只挡自己人；而 `ext-package-installed`（`ext-ipc.ts:210`）是**纯按字符串查图**，catalog 详情页会命中本地图 | **一处**。用真实 admission coordinator 测。**这不开放本地 admission**——它是一条**更严的**拒绝，方向与 admission 的既有姿态一致 |
| **`parseSkillFrontmatter` 交出完整键集**（R1-B4 闭合的最小修法） | `ext-import-validate.ts:14-23`：解析器**已经**把所有顶层 `key: value` 收进 `fields`，只是 return 时丢掉了除 name/description 外的全部 | 必要。**零新增解析器**——该文件抬头（PR #73 教训）明写「刻意极简，不引 YAML 解析器，少一个解析器面」，**引 YAML 解析器等于推翻一条既有安全决策**。且同文件的 `parseAgentImport:114-118` **已经**是「未知键逐条具名不映射」的形状，本期是把同一形状复用到 skill | 返回类型加一个字段；既有两个调用点不受影响（结构化扩展）。**不许**改那条正则、不许解析嵌套 |
| **`shared/ext-ownership.ts` 的 `authored` 维**（owner 裁决 E） | `ownershipFromInstall`（`shared/ext-ownership.ts:232-252`）对一切非 catalog 一律 `authored: PARTY_USER` ⇒ Hub 告诉用户「这是你写的」 | 必要（裁决 E = 裁决①留痕的一部分） | ⚠️ **本轮实读把这条的代价改小了**：`OwnershipInstallLike`（`:216-221`）**已经带 `origin`**，而 `imported-claude` / `imported-agents` 已经是独立枚举值 ⇒ **不需要新增 provenance 输入，也不需要动签名**，只在 `:246` 那个非 catalog 分支里按 origin 分流即可。两个调用点（`ext-inventory.ts:139/164`）零改动。**裁决 E 的实质（如实说第三方/未知）全额保留，机制取更小的那个** |
| **`FreshIntakeFacts` 加一个判别维**（owner 裁决 B 的落点，**本轮新发现**） | `shared/ext-install-policy.ts:24-35` 的入参是 `{origin, source?, kind?, activationPolicy?, reviewExpired?}`；`:46` 的 `if (intake.origin !== "catalog") return "enabled"`（⚠️ v1 写的是 `:44`，实为 **`:46`**） | **必要**。裁决 B 要「本地**包**默认 disabled、本地**单** skill 维持 enabled」，而两者的 origin 都是 `imported-claude` ⇒ **今天的入参里没有任何东西能区分它们** | 该文件抬头明写「main 的落账决策与 renderer 的安装文案**共用此定义，不得各写一份**」⇒ **必须加在这个共享真源上，不许在 `ext-skill-generations.ts:271` 的调用点分叉**。链路：`installSkillGeneration` 的 spec 加一个布尔 → `:271` 透传 → `initialDesiredState` 消费。renderer 的「已安装但未启用」文案自动跟随 |
| **`InstallReceiptOrigin` 枚举：不改** | `preload/types.ts:222` | 不改是正确的，白捡两条：① `ext-install-planner.ts:4144/4188` 的 curation 闸只在 `origin === "catalog"` 时触发 ⇒ 简报 §5 那条「catalog-origin 启用路径缺口」在本路线上**到不了**；② `composer-autocomplete.tsx:155` 的 `startsWith("imported")` 继续命中 | **零** |
| **`uncuratedSkillFreshGate` 由模块私有改为导出**（R1-B2 闭合） | `ext-install-planner.ts:2626`（`function`，无 `export`） | 必要。**复用同一个闸**是这条 finding 的全部要点——自己写一个「查账本 record」的替身，会漏掉它已经在查的：损坏账本（`probeLedgerForWrite`）、v1/v2 record（`lookupForUninstall`）、**无账本的 flat 目录**、**残留 generation store** | 加 `export`，不改逻辑一个字。既有两个调用点（:2655 锁外预检、:2675 锁内 precondition）不动 |
| **信封 schema / decoder / Catalog / alpha-web 编译器与 curation gate / `generic-rules.v1.json`：一处不动** | — | 这是本路线相对 A 的全部价值 | **零**，且 `ac#769`（CI `check:vendor` 恒红）**不是本期前置** |
| **`#306` durable 不变量：不动** | `ext-receipt-v2.ts:227-236` | 不必动。见 §1 的实读证伪 | **零** |

---

## 6. 本方案立的闸

**每一道闸都必须能被实施一次绕过并因此变红。写不出绕过配方的闸判为假闸，不许留在表里充数。**
（v1 的 G7 按这条规矩自我否决 —— 见下方 G7 的重写。）

| 闸 | 断言什么（可观察结果） | 怎么绕过它，绕了必须变红 |
| --- | --- | --- |
| **G1 原子性** | N 个技能里第 k 个装不上 ⇒ `readLedgerV2` 的 records **零条**、盘上 `skills/` 与 `ext-store/` **零目录**、`readPackageLedgerStateV1` **零 graph 零 claim**。断言的是账本与磁盘，不是返回值 | 把 confirm 改回 `for` 循环逐个调 `installUncuratedSkillImport`（= B 的形状）⇒ 前 k-1 个已 durable ⇒ 红。若仍绿，说明断言只在数返回值 |
| **G2 分组不可被绕过** | 包装好之后，对包内任一 skill 走既有 `ext-uninstall-v2` 必须被**拒**，且实物一个字节不动。跑的是既有 `planDirectUninstall`/`directUninstallVerdict`，不是我们新写的检查 | 把 `packageMutation` 从 root item 上摘掉 ⇒ `ensureStandaloneClaims` 因 claims 为空而早返回（`ext-receipt-v2.ts:995-1001`）⇒ `directUninstallVerdict(null)` 返回 `delete` ⇒ 组件被静默卸掉 ⇒ 红。**绕过实施记录必须留在仓里** |
| **G3 载荷完整：多文件技能一个文件都不能少**（**R1-B3 收紧**） | 装完之后，每个技能 generation 目录里的**文件集合 + 相对路径 + 选定的 mode 语义**，与**对源目录的独立扫描结果**逐条相等。⚠️ **比较基准不是 `collectImportSkillPayload` 的返回值**——那是实现自己拼的等价链，凡 collector 静默丢掉的（symlink、`.git`/`node_modules`/`__pycache__`）结构上永远不会红 | ①把 item 的 `files` 从 `promoted.specs` 全量改成只取 `SKILL.md`（= `buildSkillTxItems` 的形状）⇒ 用真实语料任一多文件技能（40/162）⇒ 红；②**把比较基准改回 collector 输出** ⇒ 带 symlink 的合成夹具从红变绿 ⇒ 说明基准被换了 ⇒ 这条变异本身要被 G16 的用例抓住 |
| **G4 不静默改写/认领用户既有内容**（**R1-B2 重写**） | 安装前后两次跑**同一个导出的** `uncuratedSkillFreshGate`（`ext-install-planner.ts:2626`）：锁外对 N 个 accepted 逐个预检；**锁内 `precondition` 用同一个函数重验组合条件**。preview 之后状态变了 ⇒ **整次零写**返回「预览已过期，请重新预览」，**不许临时静默改 accepted 集** | ①换成自制的「只查账本 record」替身 ⇒ 四个负向夹具各自变红：损坏账本 / v1 record / **无账本 flat 目录** / **残留 generation store**；②把锁内 precondition 删掉只留锁外预检 ⇒ 「preview 后另一个安装占用同名 skill」的并发夹具变红；③把「预览过期 ⇒ 零写」改成「悄悄跳过那一个继续装」⇒ 账本零写断言变红 |
| **G5 `previousDigest` 自动派生不得撞 `#306`** | 先从 catalog 装一个 skill `foo`，再装含同名 `foo` 的本地包 ⇒ 必须在**建 mutation 之前**被 G4 具名拒绝，**不得**走到 `applyPackageMutation` | 删掉 G4 的预检 ⇒ `ext-receipt-v2.ts:1408` 的 `prev?.manifestDigest ? {previousDigest}` 自动派生 ⇒ `decodeRecordV2` 报「non-catalog origin must not carry supply-chain digests」⇒ 整次 mutation 被拒，而**错误信息指向一个与真因毫无关系的地方** ⇒ 红 |
| **G6 preview→confirm 绑定** | `previewId` 一次性；confirm 只收 previewId，renderer 全程给不出写入内容；**写成功才消费**（`#351` 语义）；未经 preview 直接 confirm ⇒ 拒 | 让 confirm 接受 renderer 传来的目录路径或内容 ⇒ 红。把「写成功才消费」改成「取出即消费」⇒「写锁 busy 后重点确认」用例必须红 |
| **G7 引擎授权闸在这条路上是空的**（**R1-M3 重写：改成生产变异，不再是删掉即无事发生的记录性断言**） | 把**本地计划**的 `capabilities` 从 `[]` 改成非空、且不给引擎 authorization ⇒ **真实 confirm 必须停在 authorize、零安装**（账本零 record、盘上零目录）。判据实读：`diffCapabilities` 的 `requiresConfirmation: prevSet === null ? reqSet.size > 0 : …`（`ext-capability-grants.ts:100`）⇒ 空集恒 false ⇒ `ext-transaction.ts:1088-1090` 的 authorize 循环全 `continue` | 这条闸的绕过配方就是它自己的变异：**把 capabilities 改成非空而安装照样成功** ⇒ 说明 authorize 根本没接上 ⇒ 红。（v1 版本的配方是「删掉它」，删掉不产生任何失败 ⇒ 按 §6 首句它是假闸，**已删除**） |
| **G8 命名空间双向闸** | ① 本地铸造器只准产 `local:` 前缀的 packageId；② `resolvePreparedPackage`（`package-admission.ts:450`）必须拒绝任何 packageId 以 `local:` 开头的 catalog 信封 | ①：让本地铸造器产 `mcp:markitdown` ⇒ 红。②：往 fake verified catalog 里塞一个 packageId 为 `local:x` 的信封，**用真实 admission coordinator 跑** ⇒ 红。**②是关键**：只做①等于只挡自己人，而 `ext-package-installed`（`ext-ipc.ts:210`）纯按字符串查图，命中即让 catalog 详情页长出「移除此扩展包」 |
| **G9 不认识的组件类型一律具名拒绝** | `commands/` `agents/` `hooks/` `.mcp.json` 一律以「本版本不安装 + 具名原因码」出现在 preview，且 TxPlan 的 item 数 **恰等于** 装的 skill 数（不是「≥」）；含 0 个 skill 的插件必须给具名结果**而不是空成功** | 删掉枚举 `commands/` 的那一行、或把 0-skill 分支改成 `return {ok:true, installed:[]}` ⇒ 用 `tide-plugin`（10 skills + 9 commands + 1 agent）与 **25** 个 0-skill 插件中任一个跑 ⇒ 红。把某个 command 悄悄转成 skill item ⇒ item 数断言红 |
| **G10 装完之后真的能用**（**R1-B6 + 裁决 B 重写**） | ①落账后 `readLedgerV2` 里这些 skill 的 `desiredState` **逐条等于 `disabled`**（裁决 B），且**不在** `enabledSkillKeysFromRecords`（`ext-receipt-v2.ts:585`）派生的允许集里；②用户拨开关后**进入**该允许集；③打包真机：装 → 显示未启用 → 启用 → **下一条消息里技能真被引擎注入** | ①把 `FreshIntakeFacts` 的新判别维删掉 ⇒ 落回 `ext-install-policy.ts:46` 的 `enabled` ⇒ 「装完默认关」断言红；②把 desiredState 改掉或把技能从允许集里漏掉 ⇒ 红。**不许用「返回了 ok」当断言** |
| **G11 事务规模界**（真界 64，**不是 16**） | ①合成 65 item 的目录 ⇒ **preview 期**具名拒绝，且事务函数**根本没被调用**（spy 断言调用次数 == 0）；②对真实语料全量跑 intake ⇒ 全部通过（最大 13） | ①把拒绝改成 `items.slice(0,64)` ⇒ 红（此时它静默装 64 个）；把上限判断从 preview 挪进事务 ⇒ spy 断言红。②把界改成 10 ⇒ 真实语料闸红（`financial-analysis` 13）。**不许拿 `maxComponents: 16` 立闸**（§7 K7） |
| **G12 载荷读取硬化没有被绕开** | 包路径读的**每一个**文件都经 `collectImportSkillPayload` | 在 intake 里把某一个文件的读改成 `fs.readFileSync` ⇒ 用含 symlink 逃逸 + 字面 NUL + 超长 frontmatter 的敌意夹具跑 ⇒ 红。枚举一律 `rg -a` |
| **G13 全部组件被跳过时不得半途炸** | 「一个都装不上」是**多数可达终态**（§3.6：10/40 个插件从干净机器起就一个都装不上）。此时必须在 preview 期给出具名终态、确认动作不可用，**且事务函数零调用**、账本零写 | 让 0 组件也去建 mutation ⇒ `validateV3State` 遍历 `[root,...children]` 逐个查 claim（:541-549）⇒ 要么造不出图、要么造出一张非法图 ⇒ 红 |
| **G14 root 必须是一个真被装的 skill** | 禁用合成的 `kind:"plugin"` root | 把 root 改成合成的 `kind:"plugin"` 节点 ⇒ 装得上（`PACKAGE_LEDGER_KINDS` 收了 `plugin`，`ext-package-ledger-v3.ts:33`）⇒ 但整包卸载时 `removePackageChildArtifactsV1` 对 skill/agent/mcp 之外的 kind **fail-closed 拒绝**（`ext-package-uninstall.ts:145`）⇒ **装得上、卸不掉** ⇒ 卸载用例红 |
| **G15 四集双射**（**新，R1-B1**） | 由**同一个 accepted 数组**派生 preview included 集、带 receipt 的 items、图节点、claim acquisition；**调事务前断言四个 key 集逐字相等**（不是「包含」，不是「数量相等」）。端到端补一条：整包卸载后 accepted 集的 record / generation 目录 / claim **全部归零** | 删掉一个图节点但保留对应 item ⇒ 四集断言红。**若不加这道闸**：`commitTransactionLedger:47` 把每个带 receipt 的 item 独立转成 upsert，`validatePackageMutationScopeV1:504` 只查 `remove`、`continue` 过所有 upsert，`validateV3State:534-556` 没有 record→图 方向 ⇒ 落一条**不在任何图里的 record**，`{ok:true}`，安装/账本/探针全绿，而用户看到 N−1 个组件、整包卸载后那一个继续存在且可单独卸载。**Codex 已用纯函数 case 实际构造并跑出 `{"ok":true}`** |
| **G16 自包含判定**（**新，R1-B3 + owner 裁决 A**） | preview 期用**独立于 collector 的 lstat 递归扫描**判每个技能：带任一 x 位 / 含 symlink / SKILL.md 引用 `${CLAUDE_PLUGIN_ROOT}`·`${CLAUDE_SKILL_DIR}` / 引用在本目录解析不到而在插件根解析得到的路径 / 引用 `../` ⇒ **不装 + 具名原因**。真实语料断言：**18/162 被拒**，逐个点名（`plugin-dev` 6 个等） | ①把扫描换成读 collector 输出 ⇒ **symlink 夹具**（真实语料 0 例，必须合成）与 `.git` 夹具从红变绿 ⇒ 红；②删掉 exec 位那一臂 ⇒ 真实语料的 9 个技能目录被放行 ⇒ 红；③把 x 位判据从「任一 x」收成 `-perm -111`（u+g+o 全有）⇒ 25→19 文件、9→5 目录 ⇒ 计数断言红。**加一条功能夹具**：一个真会调用支撑脚本的技能，装完后跑一次，脚本缺失/无执行权必须以具体失败出现，不许静默成功 |
| **G17 调用控制字段具名跳过**（**新，R1-B4 + owner 裁决 C**） | `parseSkillFrontmatter` 交出完整键集；出现 Alpha 无对应语义的控制字段（`user-invocable` / `disable-model-invocation` / `allowed-tools` / `argument-hint`）⇒ **具名跳过不装**。真实语料断言：**12/162 被拒**，且 `openai-codex/codex` 的 **3/3** 全被拒 | ①把解析器改回只返回 `name`/`description` ⇒ 12 个真实技能被放行 ⇒ 红；②把判据从「键在不在」改成「值等不等于 false」⇒ `user-invocable: true` 的 10 个被放行、断言数从 12 掉到 2 ⇒ 红；③**引一个真 YAML 解析器来做这件事** ⇒ 违反 `ext-import-validate.ts` 抬头的既有安全决策，PR 直接退回（这不是测试闸，是 review 判据，写在这里防止下一轮把它当「更完整」的方案重提） |
| **G18 布局识别与不支持布局具名**（**新，R1-B5**） | ①`plugins/receipts`（**manifestless，但在 `marketplace.json` 里是一等条目**）⇒ 必须给出「不支持的布局」原因码，**不许**是「文件夹内没有 SKILL.md」、**不许**计成 0-skill；②`.claude/skills/<n>/SKILL.md`、③`workflow-skills/<n>/SKILL.md`（与 `skills/` 并存）、④只带 `marketplace.json` 的目录、⑤根级 `SKILL.md`（本机 0 例，合成夹具）—— 五类各一个具名原因码 | 把分流规则改回 v1 的「有 `plugin.json` ⇒ 包，否则单 skill」⇒ 用 `plugins/receipts` 跑 ⇒ 落回 `collectImportSkillPayload`，`ext-fs-installer.ts:585` 报「文件夹内没有 SKILL.md」⇒ **断言原因码而不是断言 `ok===false`** ⇒ 红。（只断言 `ok===false` 的写法通不过——两条路径都 `ok===false`，那是假闸形态⑨） |
| **G19 preview 字节预算与释放**（**新，R1-M1**） | ①**包级**总字节帽 + 总文件帽（既有单 skill 帽是 10MB/500 条，`ext-fs-installer.ts:465`；事务允许 64 items ⇒ 无包级帽时单次预览可留 ~640MB）；②每个 renderer **只允许一个 active preview**；③取消 / 窗口销毁 / 新预览替换 ⇒ 立即释放。**用生产 handler 测，不是纯函数**：取消之后 confirm 必须被拒，且 retained bytes 归零 | ①删掉包级帽 ⇒ 合成的超预算目录被接受 ⇒ 红；②把释放改成「等下次预览时再覆盖」⇒ 「取消后 retained bytes == 0」断言红；③照抄 agent 的**条数帽 16**（`ext-ipc.ts:167`）当包字节帽 ⇒ 超预算夹具通过 ⇒ 红 |
| **G20 热重载真接上**（**新，R1-B6**） | confirm 成功 **与** 整包卸载成功后都调 `refreshEngine()`（`use-extensions.ts:136` 已在 `ExtensionsApi` 上）；失败呈现 `reload-pending`。**用生产 handler 测**（spy 断言被调用），不是自己拼一条等价链 | ①从 confirm 路径删掉 `refreshEngine()` ⇒ spy 断言红；②从整包卸载路径删掉（= 今天 `extension-detail.tsx:165-183` 的**现状**）⇒ spy 断言红 —— **这条闸第一次跑起来就是红的，因为它钉的是一个今天还没做的接线**；③把失败当成功（丢掉 `reload-pending`）⇒ 红。生产依据：`use-extensions.ts:610-614` 原文「fs 类安装不 dispose 就是 placebo 安装」 |

---

## 7. 每一条 killShot 的交代

三视角评判共开出 20 条 killShot（含重复）。逐条（**R1 之后有变的加 ⚠️**）：

| # | killShot | 处置 |
| --- | --- | --- |
| K1 | B 泳道 C 稿的量化证据取自 `.codex-plugin` 语料，与本期 provider 无关 | **修掉**。§3 每个数字由本 session 亲测重出，**并在 v2 重跑一遍**（推翻 3 个，见 §3 尾与 §13） |
| K2 | A 稿用假断言论证选 A | **修掉**。§1 给出实读证伪 |
| K3 | 三稿全漏：包安装会静默覆盖用户单装的同名技能 | **修掉**，立成 **G4**。⚠️ R1-B2 之后 G4 已重写为「复用导出的 `uncuratedSkillFreshGate` + 锁内组合 precondition」，比 v1 的「查账本 record」强四条 |
| K4 | `ext-install-policy.ts:46` 让非 catalog 一律 `enabled` ⇒ 一次确认 13 个第三方技能全开 | **已裁**（owner 裁决 B = D1）：本地**包** disabled、本地**单** skill 维持 enabled。落点见 §5 与 **G10** |
| K5 | 「复用 `buildSkillTxItems`、不改一行」会静默丢文件 | **修掉**。实读 `ext-package-tx-builders.ts:133-161`：`files: [{path:"SKILL.md"}]` 硬编码。改走多文件 generation item，立 **G3** |
| K6 | A 稿 G8 是死代码闸 | **不适用于本路线**。取其精神换靶子：**G9** 立在真到得了的输入上（22 带 `.mcp.json` / 22 带 `commands/` / 20 带 `agents/`） |
| K7 | 把发布端 `maxComponents: 16` 搬来当本路的闸 = 前提为假的闸门 | **修掉**。真界是 `ext-transaction.ts:650` 的 64。**G11** 立 64 + 合成 65 项负向夹具 |
| K8 | A 稿新 origin 会掉出 `composer-autocomplete.tsx:155` 的前缀过滤器 | **不适用**（不新增 origin）。作为「为什么不改枚举」写进 §5 |
| K9 | A 稿的 `#306` 第三臂会把「catalog 身份不可伪造」降级 | **不适用**（不动 `#306`） |
| K10 | A 稿编造的需求：「CAS blob 不 pin 会被 GC 回收」 | **拒掉，不抄**。实读 `ext-cas-gc.ts:5-9` + 6 小时宽限窗 + Bundle 锁互斥 |
| K11 | 铸了命名空间却没立**反向**闸 | **修掉**，立成 **G8** 两个方向。⚠️ R1-M2 之后 §5 显式让出 `package-admission.ts` **一处**改动，矛盾消除 |
| K12 | 「全部组件都被跳过」这个终态无人处置 | **修掉**，立成 **G13**。⚠️ §3.6 实测后它的地位升级：**不是边角，是 10/40 个插件的常态终态** |
| K13 | 没有一跳/一张票管「装完真能用起来」 | **修掉**。⚠️ R1-B6 之后第 9 跳改由 **T2 + T4 共同拥有**，闸是 **G10 + G20**，验收路径按裁决 B 重写为「显示未启用 → 用户启用 → refresh → 下一条消息可用」 |
| K14 | `applyPackageMutation` 自动派生 `previousDigest` ⇒ 与 catalog 同名 skill 相撞时错误信息驴唇不对马嘴 | **修掉**，立成 **G5** |
| K15 | 「confirm 期重扫目录再比摘要」比既有形状弱一档 | **修掉**：照 REQ-033 的「preview 期把字节留在 main」形状，不重扫。⚠️ R1-M1 之后加 **G19** 管住这条形状的代价（字节预算 + 释放） |
| K16 | `ownershipFromInstall` 对一切非 catalog 一律 `authored: PARTY_USER` ⇒ 装完被改写成「你自己写的」 | **已裁**（owner 裁决 E = D2）：如实为第三方/未知。⚠️ 实读后**机制改小**：`OwnershipInstallLike` 已带 `origin`，零签名改动（§5） |
| K17 | `envelopeDigest` 语义漂移；靠 packageId 前缀承载「不是策展来的」= 从 id 里读结构（`#737` 明令禁止） | **修掉一半 + 已裁一半**。纪律见 §8 纪律 2；字段处置见 §9 D3（编排者裁决 F：保留字段名 + 测试钉死） |
| K18 | `grants.json` 会长期携带「长得像供给链摘要、其实是本地内容哈希」的 `manifestDigest` | **修掉**：本地包的值一律带 `sha256-local:` 前缀 |
| K19 | 更新通道断层：第二次导入同一插件会撞 `uncuratedSkillFreshGate` 被拒 | **修掉**：preview 里在**确认之前**说清「要更新请先移除整包」。⚠️ R1-B2 之后这条与 G4 同源——**同一个闸**，只是一个是产品文案、一个是锁内 precondition |
| K20 | `ac#769` / `ac#772` / `aweb#115` 前置 | `ac#769` **不是本期前置**（零 re-vendor）。`ac#772`（graphBefore/AfterDigest 改名横穿 wire）与本期 preview 面撞同一批字段 ⇒ **禁止并行**（§10 硬约束）。`aweb#115` 的 NUL 闸是 G12 敌意语料前置（实况 3 文件 9 处，票面过期；`.ttf`/`.png` 合法含 NUL，闸必须排除二进制资产） |

---

## 8. 三条不可让步的实现纪律

1. **不解释别人的文法，也不给别人的文法造替身。**
   只消费 `plugin.json` 的三个标量（name / **version 选填** / description）与 `skills/` 目录；
   frontmatter 用 `parseSkillFrontmatter` 那**一份**，本期只让它把**已经解析出来的**完整键集
   交出来 —— **不引 YAML 解析器、不解析嵌套、不改那条正则**。
   出现我们不认识的必需结构 ⇒ 整包/该技能具名拒绝，**绝不猜**。
   > 本轮的实例代价：用一条 `rg` 正则替代真解析器去数控制字段，得到 84 / 16 两个都偏大的数，
   > 真值是 12（§3.5）。**同一个错法，在同一份稿子里出现了第二次。**
2. **`local:` 前缀是命名空间保留，不是行为判据。**
   G8 在**铸造期与 admission 期**用它做合法性校验（防两个来源撞进同一个 id 空间），这是校验；
   但**任何「这个包是不是本地来的」的问题，一律从 child record 的 `origin`（`imported-claude`）
   回答，绝不从 packageId 前缀读结构**。这条要写成注释 + 一条测试钉住，否则 `#737` 那个洞会在这里重开。
3. **降级只许写成降级。**（owner 裁决 G 的一般化）
   本期在三处**明确不如**正路：admission 的十六条保证没有替代品（§11 第 1 行）；引擎的 capability
   授权闸在这条路上是空的（G7）；binding 从五键降为一键本地 snapshotDigest。
   **任何把这三处写成「我们用别的方式提供了同等保证」的表述都是在造假闸**，
   review 里见到即退回。要写进代码注释与 AC，不能让读者以为还是原来那套。

---

## 9. 产品裁决（**全部已裁，实现方不得再默认掉**）

| # | 问题 | 裁决 | 出处 | 实现落点 |
| --- | --- | --- | --- | --- |
| **D1** | 装完之后第三方技能默认开还是默认关？ | **本地「包」装完默认 `disabled`；本地「单个」skill 维持现状 `enabled`。** | **owner 裁决 B** | `FreshIntakeFacts`（`shared/ext-install-policy.ts:24-35`）加一个判别维（**共享真源上加，不许在调用点分叉**，§5）；`installSkillGeneration` spec 透传；闸 = **G10**。⚠️ **连带**：第 6 跳必须同时呈现启用开关，第 9 跳验收路径改写（§4） |
| **D2** | 列表里要不要如实说「这是第三方写的」？ | **要。** 让 `imported-claude` / `imported-agents` 的 `authored` 如实为第三方/未知，**不再显示「这是你写的」**。这是 owner 裁决①（留痕）的一部分，不是新范围。 | **编排者裁决 E** | `ownershipFromInstall`（`shared/ext-ownership.ts:246`）的非 catalog 分支按 `origin` 分流。⚠️ 实读后**零签名改动**：`OwnershipInstallLike:216-221` 已带 `origin`（§5） |
| **D3** | `PackageGraphV1.envelopeDigest` 语义漂移怎么处置？ | **取选项①：保留字段名，填本地规范化载荷摘要，并加一条测试钉住「它不是信封摘要、provenance 从 `record.origin` 读」。不改名。** 理由：`ac#772` 正在同一区域改名（graphBefore/AfterDigest 横穿 wire），两次改名撞一起比一个名不副实的字段更贵。**不许靠注释解决——必须有测试。** | **编排者裁决 F** | `ext-package-ledger-v3.ts:73`；测试进 `ext-package-ledger-v3.test.ts`。renderer 面零影响（只读投影不透该字段，§5 已实读确认） |
| **D4** | 本期要不要真的开「改写第三方字节」的通道？ | **本期零字节改写。** 读不了 / 不自包含 / 带无法兑现的控制字段 ⇒ **不装 + 说人话原因**。实测技能改写触发率 **1/162**。**owner 裁决①「允许改写」是许可不是要求，本期不行使。** | **编排者裁决 G**（承 owner 裁决①） | §0 与 §11 各写一遍。落点设计已备但**本期不实现**：原始字节与报告各作为 CAS blob + `pinCasBlob(reason=…)`，报告为 `{path, ruleId, originalSha256, installedSha256}` —— 不碰 `#306`，也不给 V3 图加字段 |
| **D5** | 重名怎么处置？ | **不加命名空间前缀、不改字节；碰撞即跳过 + 显式告知。** | **owner 裁决 D** | 代价已量化：34 组跨插件重名；连续安装场景下可装数从 135 降到 56、全灭插件从 10 升到 22（§3.6）。替代方案（加前缀）会撞 shadowing 闸（`ext-skill-generations.ts:57` 要求 frontmatter name 逐字等于 key）⇒ 需改写 **100%** 的 SKILL.md 字节，与 D4 直接冲突 |
| **D6** | 不自包含的技能怎么办？ | **只装自包含的。** 引用了自己目录之外的资源 / 带可执行位 / 带符号链接 ⇒ **预览里逐条列出「本版本不装 + 原因」**，不装。 | **owner 裁决 A** | 闸 = **G16**；判据语料 = §3.4（18/162 被拒） |
| **D7** | 带 Alpha 无对应语义的调用控制字段怎么办？ | **具名跳过不装。** | **owner 裁决 C** | 闸 = **G17**；判据语料 = §3.5（12/162 被拒，`openai-codex/codex` 3/3 全灭） |

---

## 10. 票怎么拆（含重算后的依赖序）

**依赖序重算的三个原因**：①`[新票:D-owner]` 已全部裁完 ⇒ **该票消失，不再阻塞任何人**；
②裁决 B 让第 9 跳跨 T2/T4 ⇒ 两票必须同期且 T4 收口；③新增工作量集中落在 T1（B3/B4/B5）
与 T3（M1/M2）⇒ T1 变重、T3 从「通道」升为「通道 + 预算 + 双向闸」。

| 票 | 范围 | AC 要点 | 依赖 |
| --- | --- | --- | --- |
| `[新票:T1-intake]` **[CODE] 本地 Claude 插件读取与安装预览（纯读，零写盘）** | 新增 `main/claude-plugin-intake.ts`：**布局判定**（§3.2 五类不支持布局具名）；读 `plugin.json`（**version 选填**）；枚举 `skills/*/SKILL.md`；逐个跑 `collectImportSkillPayload` + `parseSkillFrontmatter`（**改为交出完整键集**，`ext-import-validate.ts`）+ **独立 lstat 自包含扫描**；产 `LocalPackagePreviewV1`（逐组件 `{name, disposition, reasonCode}` + 不支持组件类型 + 不支持布局 + snapshotDigest + packageId `local:<slug>`）；`ext-ipc` 在 `pickImportSkillDir` 之后加分流点 | ①对本机真实语料全量跑并断言具体数字：**62 插件 / 162 SKILL.md / 161 frontmatter 通过 / 25 个 0-skill 插件 / 18 个自包含被拒 / 12 个控制字段被拒 / 135 可装**，**夹具复制进仓，不依赖本机路径**；②**G18** 五类布局各一条（`receipts` 用真实结构复制）；③**G16**（含 symlink 合成夹具 + exec 位真实语料 9 个目录 + 功能夹具）；④**G17**（含「改回只返回 name/description ⇒ 12 个被放行」的绕过记录）；⑤**G9/G13** 具名结果；⑥**G12** 敌意夹具（symlink 逃逸 + 字面 NUL + 超长 frontmatter）；⑦**G11** 上限在 preview 期具名拒绝且事务函数零调用；⑧K19：重复导入在**确认之前**说清「先移除整包」；⑨本票执行前后 `installs.json` 与磁盘逐字节不变 | **无。可立即开工**（D4/D5 已裁，原 D-owner 阻塞解除） |
| `[新票:T2-install]` **[CODE] 一次事务装 N 个多文件技能 + V3 包图落账 + 默认关** | 新增 `main/claude-plugin-install.ts`：**四集同源派生 + 调事务前逐字相等断言**（G15）；导出并复用 `uncuratedSkillFreshGate` 建**锁内组合 precondition**（G4）；N 份载荷经 `promotePayloadToCas` → N 条**多文件** generation item → `packageMutation` 挂 root item → 一次 `runExtensionTransaction` → `commitTransactionLedger`。**加两处最小改动**：`ext-install-planner.ts:2626` 加 `export`；`shared/ext-install-policy.ts` + `installSkillGeneration` spec 加**一个**判别维（裁决 B）。**不改** `ext-transaction.ts` / `ext-package-ledger-commit.ts` / `ext-receipt-v2.ts` / `ext-package-ledger-v3.ts`（`envelopeDigest` 语义除外）/ alpha-web 任何一行 | ①**G15**（本票第一 AC，含「删一个图节点保留 item ⇒ 红」的绕过记录 + 整包卸载后三清零）；②**G3**（比较基准 = 源目录独立扫描）；③**G1** 原子性（含绕过记录）；④**G2**（含绕过记录）；⑤**G4 + G5**（四个负向夹具 + 并发夹具 + 「预览过期 ⇒ 整次零写」）；⑥**G7**（生产变异版：capabilities 非空 ⇒ 停在 authorize、零安装）；⑦**G10** 默认 `disabled` 逐条断言；⑧**G14** root 必须是真被装的 skill；⑨origin 恒 `imported-claude`、record 不携任何供给链摘要；⑩project scope **显式拒绝**（ADR-030）；⑪若改了 builders 或引擎任一行，PR 里必须说明为什么复用不成立 | T1 |
| `[新票:T3-channel]` **[CODE] 两段式通道 + preview 预算 + 命名空间双向闸 + 「列出已装本地包」只读 IPC** | preview→confirm 通道（照 `ext-ipc.ts:156-182` 的留字节形状）；**IPC 边界钉死：preview 纯读不进 gated 表，只有 confirm 进**（§5）；**包级字节/文件预算 + 单 active preview + 取消/销毁/替换即释放**（G19）；`local:` 双向闸，含 `package-admission.ts` **唯一一处**拒绝（G8②）；新增只读 IPC 列出 V3 图 | ①**G6**（一次性 + 写成功才消费 + renderer 给不出写入内容）；②**G19**（**生产 handler 测**：取消后 confirm 拒绝且 retained bytes 归零）；③**G8 双向**（②用真实 admission coordinator 测；只做单向视为未完成）；④只读 IPC 返回安全投影：无绝对路径、无 owner token；⑤「账本读不出来」显示「读不出」而不是「没装」；⑥`ext-write-channels.test.ts` 对新表逐通道断言，**preview 不在表内**也要被断言到 | T1（共享 preview 类型）。**与 T2 可并行** |
| `[新票:T4-renderer]` **[CODE] renderer 半场：分流 + 预览屏 + 已装扩展包区块（含启用开关）+ 移除 + 热重载接线** | `runImportFolder` 按 main 返回值分流（renderer 不判目录形态、不传路径）；预览屏逐条呈现装/不装/五类原因/不支持类型/不支持布局；Hub 新增「已装扩展包」区块 **+ 每个技能的启用开关**（裁决 B 的必然连带）；区块内挂「移除」；**confirm 成功与整包卸载成功后都调 `refreshEngine()`，失败呈现 `reload-pending`**（G20）。**含 UI 变更 ⇒ 先出设计稿走 design-loop，批准后实现；稿内与 UI 文案零票号零开发术语** | ①**九跳端到端可达**（第 1→9 跳，含「显示未启用 → 启用 → 下一条消息可用」）；②**G20**（生产 handler spy；**含「今天的 `extension-detail.tsx:165-183` 就是红的」这条基线记录**）；③既有 `importFolder` 卡对**非插件目录**的行为逐字不变（回归用例钉死）；④装完当场可见、卸完当场消失，不需退出重进（`extension-detail.tsx:187-189` 已确立的纪律）；⑤移除失败必须显示失败——`ok` 之外任何东西不许读成「已移除」（`:170-175`）；⑥包内单个技能点卸载 ⇒ 呈现 `directUninstallVerdict` 的拒绝文案，不是假成功；⑦取消 = 零写盘 **且 retained bytes 归零**（与 G19 对接） | **T2 + T3。T4 与 T2 必须同一 Iteration**（第 6/7/9 跳不得与第 4/5 跳跨期） |
| `[新票:T5-verify]` **[VERIFY] 真实语料回归夹具 + 敌意夹具 + 每道闸的绕过实施记录** | 把 §3 的统计固化成可跑的 case（`test-component/` 下，与 `package-admission.wiring.cases.ts` 同形）；**七份负向夹具**：合成 65 item、含 NUL 与 symlink 的敌意目录、坏 frontmatter、同名碰撞、0-skill 插件、**manifestless 插件（`receipts` 结构）**、**带控制字段的技能**；打包真机跑一次 | ①**G1–G20 每道闸都有一条「故意改坏 X ⇒ 它变红」的实施记录，写不出绕过的闸判为假闸并退回**；②真实语料闸与合成负向闸**分开断言**，禁止用「全合法」的退化夹具；③一切检索带 `-a`；④**真机 L2 按裁决 B 的完整路径**：装 `tide-plugin`（10 skills）→ 列表显示**未启用** → 用户启用 → **下一条消息里技能真被引擎注入**（不是查账本）→ 整包卸载 → 无残留且引擎当场不再暴露；⑤真实语料的三个合成数字（135 可装 / 10 个插件全灭 / 18 不自包含）作为回归断言 | 与 T2/T3 并行起草，随 T4 合并前收口 |

**硬约束**：`ac#772` 与本期 preview 面撞同一批 wire 字段，**排在 Phase 3 之前或之后，禁止并行**。

**依赖序**：`T1 → {T2, T3} → T4`，`T5` 全程并行、T4 前收口。原 `[新票:D-owner]` **已消解**。

---

## 11. 已知不修 + 理由

| 已知的事 | 不修的理由 |
| --- | --- |
| **admission 的整套保证在这条路上没有替代品**：已验签 Catalog 快照 + snapshotDigest（`package-admission.ts:454-458`）、catalogId 成员资格（:461-462）、逐组件载荷摘要（:500-506）、binding 五键（:562-576，本路降级为**一键**本地 snapshotDigest） | 本期就是要在不经 catalog 的前提下装一个本地目录。诚实的说法不是「我们用别的方式提供了同等保证」，而是「**这条路上不提供渠道保证**，改由三件事兜底：用户亲手选的目录（main 自弹 picker，renderer 拿不到路径）、逐条告知、账本里恒为 user 的策展维」。**任何把这句话写成「等价」的表述都是在造假闸。** binding 的降级要写进代码注释与 AC。<br>⚠️ **v2 加强**：本期 §5 让出了 `package-admission.ts` 的**一处**改动（G8②），那**只是一条更严的拒绝**，**不是**在 admission 上开了本地入口 —— review 里若出现「我们已经过了 admission」的表述，按 §8 纪律 3 直接退回。 |
| **引擎的 capability 授权闸在这条路上是空的** | 本地包没有能力声明，`capabilities` 恒 `[]` ⇒ 结构性无法恢复。能做的只有把「用户确认」挪到 G6 的显式两段式，并用 **G7 的生产变异版**把事实钉在仓里（capabilities 非空则必须停在 authorize —— 这证明接线是真的，只是这条路上永远喂空集） |
| **`imported-claude` 的技能不进 session-grant / boot 强制收敛 / 项目残留清理这些只管 catalog 的面** | 那些面按设计只管 catalog 记录（`ext-session-grants.ts:132`、`ext-install-planner.ts:4443`、`ext-project-residuals.ts:129`）。本期只做 Skill ⇒ 无用户可观察影响。**写明而不修**——不修的是范围，不是漏看 |
| **`ac#703` / MCP OAuth** | owner 已移出。本期只做 Skill ⇒ 不涉及；但 `.mcp.json` 是**真到得了**的输入（22/62 个插件带它，其中 11 个 `external_plugins` 是**纯 MCP、零技能**），所以 **G9** 给它显式具名拒绝点，不靠「没接线所以到不了」 |
| **组件数 16 上限** | 那是**发布端**约束（`generic-rules.v1.json`、declaration schema、`registry.v1.json:49`），本路线不经发布端。真界是 64（`ext-transaction.ts:650`）。**显式记下**，否则下一轮 review 会把它当漏掉的闸再开一次 |
| **本期零字节改写**（D4 已裁） | 触发率 1/162，而留痕落点与 `#306` 冲突。读不了的直接不装并说人话。**「允许改写」是许可不是要求。** |
| **不自包含的 18 个技能本期一律不装**（D6 已裁） | 支持它们要么改载荷模型（携安全 mode + 插件根资源），要么把「一个技能一个 generation」改成「一个包一棵树」—— 两者都超出这条窄竖线。代价已量化并写进 preview 文案 |
| **`workflow-skills/` 等自定义技能目录本期不枚举** | §3.2 第 3 条：本机唯一实例在 cache 的 figma 两版，且**上游 manifest 未声明**——我们无法判断上游是否把它当技能加载。**不猜**，按 G18 具名为「不支持的布局」。真要支持，前提是先勘破「上游到底按什么规则发现技能」，那是另一张票 |
| **`plugin.json` 的 `skills` 字段本期不实现** | §3.2 第 2 条：本机 183 份 manifest 里出现 **0 次**。Codex 的这条来自官网文档，**本 portfolio 明令不据文档立闸**。按 G18 具名为「不支持的布局」，等真语料出现再做 |
| **`alpha-web` 零改动，兼容报告不产生** | 宿主全仓对「兼容报告」零命中；alpha-web 那份报告顶层七键被 `assertExactKeys` + `additionalProperties:false` 锁死，finding 只有 `{code,disposition,path}`，**结构上写不下 before/after 摘要**。owner 裁决①里「进兼容报告」在本路对应的是**宿主侧 preview 的逐条清单**，不是发布端兼容报告——**必须写明，不许写成「已落裁决」** |

---

## 12. 本方案未解决的风险

1. **内容可信度这一维在这条路上是零。** 复用了 builders 与 V3 账本 ≠ 保证还在——它们是计划构造器
   与账本代数，**从来不是安全边界**；admission 才是，而 admission 被整个绕过。在的只有：原子性、
   崩溃恢复、图/claim 自洽性、卸载正确性。这句话在首页，不在附录。
2. **`envelopeDigest` 名不副实**（D3 已裁为「保留 + 测试钉死」）。残余风险：下一相位有人按字面
   理解它。缓解只有那条测试，**注释不算**。
3. **root 是被迫挑出来的。** Claude 插件里的 skill 彼此平等，没有天然 root；被选中的那个同时
   承担「包身份」（`bundleOwner` 内嵌 root 的 `manifestDigest`，`ext-package-ledger-v3.ts:137`）
   与「一个普通技能」两个角色。后果：重导入时若那个技能变了，owner token 就变、旧 claim 全要
   释放。缓解：root 选择确定性（按组件名字典序取第一个**通过判定**的），root 与 leaf 本期一律
   `required` 且行为对称。**一旦将来 root 开始有不同行为，这个决定就会变成洞。**
   ⚠️ **v2 新增的一层**：裁决 A/C/D 把「通过判定」的集合缩小了（§3.6）⇒ **root 的身份对判定规则
   敏感**。同一个插件在两个版本的 Alpha 上可能选出不同的 root ⇒ packageId 相同但 owner token 不同。
   本期靠「重导入必须先整包卸载」（K19/G4）挡住，**但这条挡法是产品约束，不是结构保证**。
4. **重名让第二个包大面积缺技能**（D5 已裁）。34 组重名是常态；连续安装场景下可装数 135 → 56，
   全灭插件 10 → 22（§3.6）。preview 里要说人话，但这是产品取舍不是实现细节。
5. **零真机证据是 Phase 2 遗留的三条边界之一。** 本竖线的关键断言在 bun 测试里都能跑，但
   「打包后的 mac 应用里点得动」是另一回事（packaged 环境已有两次栽记录）。`[新票:T5-verify]`
   的真机 L2 是硬要求，不是加分项。⚠️ **裁决 B 之后真机路径变长了**（装 → 显示未启用 → 启用 →
   refresh → 下一条消息可用），中间任何一环断掉都会让「装了但用不上」，**而账本全绿**。
6. **G11 的真实语料半场天然是恒真式。** 真实插件最大 13，界是 64 ⇒ 拿真实语料测这道闸期望值恒
   等于「全通过」。**必须配合成 65 项负向夹具**，否则它会作为「已有闸门」被记账而实际是空的。
   ⚠️ **同形态在 v2 新增的闸里还有两处**：**G16 的 symlink 臂**（真实语料 0 例）与
   **G18 的根级 SKILL.md 臂**（真实语料 0 例）——两者都**只能**靠合成夹具，
   **不许**用「真实语料全过」当作它们绿了。
7. ~~`.claude-plugin` 之外的 Claude 插件形态没有被枚举~~ ⇒ **本轮已枚举**（§3.2）。
   **残余风险改小但没归零**：普查只覆盖本机 `~/.claude/plugins/{marketplaces,cache}` 的
   62 + 26 个插件。**未观察到 ≠ 不存在**——`plugin.json.skills` 就是一个「文档里有、本机 0 例」
   的形态。本期的应对不是「假设它不存在」，而是 **G18 让任何不认识的布局都以具名原因码落地**，
   使得下一次遇到新形态时，用户看到的是「这一版还不认识这种摆法」，而不是一句错误的
   「文件夹内没有 SKILL.md」。**这一条从「最弱前提」降级为「已知边界」。**
8. **（v2 新增）自包含判定是启发式的，会有假阴。** G16 的第四臂（路径 token 在文件系统上 resolve）
   靠正则抽取 SKILL.md 里的路径形 token —— 它抓得到 `scripts/foo.sh`，抓不到运行期拼出来的路径、
   拼在多行代码块里的路径、或写在 `references/*.md` 而非 SKILL.md 里的路径。
   **方向是保守的**（漏判 = 装了一个可能缺件的技能，不是装了一个危险的东西），
   但**不许把它写成「我们保证装进去的都是自包含的」**——AC 的措辞必须是
   「命中以下五类特征之一即拒」，不是「保证自包含」。这是 §8 纪律 3 在本条上的具体落法。

---

## 13. R1 审计九条 finding 的闭合对照

| # | finding | 严重度 | 处置 | 落在哪一节 / 哪道闸 | 哪张票拥有 |
| --- | --- | --- | --- | --- | --- |
| B1 | 接受集、事务 items 与 V3 图没有双射闸，整包卸载可留下游离技能 | Blocker | **采纳，照 Codex 修法**：同一 accepted 数组派生四件东西，调事务前断言四个 key 集逐字相等；负向变异 = 删一个图节点保留 item | §4 第 4/5 跳、**G15**、§1（同一次实读的一体两面） | `[新票:T2-install]`（第一 AC） |
| B2 | G4 没继承既有锁内 fresh-only 闸 | Blocker | **采纳，照 Codex 修法**：**导出并复用** `uncuratedSkillFreshGate`（不写替身），为 N 个 accepted 建锁内组合 precondition；预览后状态变了 ⇒ 整次零写「预览已过期」 | §2 表、§5「改为导出」行、**G4**（含 K19 收编） | `[新票:T2-install]` |
| B3 | G3 的 payload 真源过窄（插件根依赖 / 可执行位 / symlink） | Blocker | **采纳，按 owner 裁决 A 闭合**：只装自包含的，其余逐条列「不装 + 原因」。G3 同时比对**源目录独立扫描**的字节摘要 + 相对路径 + mode 语义，并加真实调用支撑脚本的功能夹具 | §2 注（**新发现：v1 的 G3 是自指等价链**）、§3.4（18/162）、**G3 + G16** | `[新票:T1-intake]`（判定）+ `[新票:T2-install]`（G3） |
| B4 | Claude Skill 的调用控制被静默丢弃 | Blocker | **采纳，按 owner 裁决 C 闭合；修法改了**：❌ 不用完整 YAML 解析器（会推翻 `ext-import-validate.ts` 抬头的 PR #73 既有安全决策 + 新增解析器面）。✅ 那个极简解析器**已经**把全部顶层 `key: value` 收进 `fields`，只是 return 时丢了 —— 让它交出完整键集即可，**零新增解析器**。数字用实扫的 **12**（不是 84，也不是 16） | §3.5（含 84/16 的两条独立偏差归因）、§5「交出完整键集」行、**G17**、§8 纪律 1 | `[新票:T1-intake]` |
| B5 | 插件识别规则漏掉合法 Skill 布局 | Blocker | **采纳，方向成立；证据全部换成本机实测**（Codex 的取自官网文档，违反本 portfolio 明令）。实测五类：manifestless 官方插件 **2 个且在 marketplace.json 里是一等条目**、`.claude/skills` **1**、`workflow-skills` **4**（Codex 未点名）、只带 marketplace.json **5**、根级 SKILL.md **0**；`plugin.json.skills` 本机 **0/183** | §3.2（两轴交叉验证）、**G18**、§11「本期不实现」两行、§12 风险 7 降级 | `[新票:T1-intake]` |
| B6 | G10 没接生产热重载，且 D1=disabled 时与「真可用」验收自相矛盾 | Blocker | **采纳**：第 9 跳改由 T2 + T4 **共同拥有**；confirm 成功与整包卸载成功后都走既有 `refreshEngine()`。按 owner 裁决 B，验收路径改写为「显示未启用 → 用户启用 → refresh → 下一条消息可用」。v1 §6 那句「打包真机跑一次证明引擎侧真可见」在默认关之下自相矛盾，**已删改** | §4 第 9 跳、§2 表末行、**G10 + G20**、§9 D1、§12 风险 5 | `[新票:T2-install]` + `[新票:T4-renderer]` |
| M1 | preview 保留字节无包级预算与取消释放（单次预览可留 ~640MB） | Major | **采纳**：包级总字节/总文件帽；每 renderer 一个 active preview；取消 / 窗口销毁 / 新预览替换立即释放。**G19 用生产 handler 测**（取消后 confirm 拒绝且 retained bytes 归零），不是纯函数 | §4 第 3 跳、§2 表（agent 的 16 条帽不可原样套）、**G19** | `[新票:T3-channel]` |
| M2 | G8 要求改 admission，但方案同时声明零改动；且 §5 与 T3 对 IPC 是否进 gated 表自相矛盾 | Major | **采纳**：①明确允许 `package-admission.ts` **只有一处**保留命名空间拒绝，用真实 admission coordinator 测，**这不开放本地 admission**；②IPC 边界钉死：**preview/read 不进 gated 写表，只有 confirm 进**（与既有 `ext-import-agent-preview` / `-confirm` 的先例逐字一致） | §5 两行、**G8**、§11 第 1 行加强、`[新票:T3-channel]` AC⑥ | `[新票:T3-channel]` |
| M3 | G7 的绕过配方不会变红，按方案自己的定义就是假闸 | Major | **采纳，取 Codex 的第二个修法**（不降级为记录性断言）：改成**生产变异** —— 把本地计划的 `capabilities` 从 `[]` 改成非空且不给引擎授权 ⇒ 真实 confirm 必须**停在 authorize、零安装**。这样它才是真闸 | **G7 重写**、§11 第 2 行 | `[新票:T2-install]` |

**九条全部采纳，零条无声吞掉。** 其中两条的**修法**由编排者改过（B4 的解析器路线、M3 的取舍），
理由已写在对应行；B5 的**证据来源**由本稿整体替换（文档 → 本机实测）。

---

## 附：本轮推翻的数字（供复核）

| 出处 | 原值 | 实测 | 为什么错 |
| --- | --- | --- | --- |
| v1 §3 | 零 skill 插件 **28（45%）** | **25（40.3%）** | 两条独立轴交叉验证（按插件根数 / 按路径归属数）差 3，差值正好是 §3.2 的三个异常布局 |
| 编排者派单 | 控制字段 **84**（跨 `{marketplaces,cache}`） | **12**（marketplaces，解析器真值） | ①整文件 `rg` 命中 markdown 正文里的示例（`allowed-tools` 整文件 11 / frontmatter 1）；②`cache` 是版本仓（318 文件仅 150 份不同内容）。同口径中间值：`{mkt,cache}` 解析器真值 54、按内容去重 32 |
| Codex R1-B4 | 控制字段 **16** | **12** | 同上第①条（同一条命令，只是语料范围小一些） |
| Codex R1-B3 | 可执行位 **19** 个文件 | **25** 个文件 / **9** 个技能目录 | Codex 用 `find -perm -111`（要求 u+g+o **同时**有 x）；「带可执行位」的正确语义是**任一** x 位 |


---

## §14 R2 闭合判定与两条残余的处置（编排者裁决，最终）

方案审计 R2 判定：**B1 / B2 / B5 / B6 / M1 / M2 / M3 共 7 条 FIXED；B3 / B4 两条 PARTIAL。**

**轮数预算两轮已用尽，编排者裁决不加第三轮。** 两条残余的修法明确、验收可写死，
且会在实现阶段被**真测试**验证 —— 那比再来一轮纸面审计强。以下两条**并入本基线，
与 §6 的闸具同等效力**，实现方不得默认掉。

### R2-a（原 B3 残余）：collector 静默排除的目录，独立扫描看得见但闸不管

**问题**：G16 改用「对源目录的独立扫描」当比较基准之后，独立扫描会**看见**
`.git` / `node_modules` / `__pycache__`，而 `collectImportFiles`
（`ext-fs-installer.ts:478`）**必定静默跳过**它们 ⇒ 出现一类输入：
**preview 判为可装，装完必然缺件**，而 G3 的不相等只能在事后证明，
没有任何路径让 preview 具名拒绝或保真安装。

**编排者实测的可达性**：真实语料 **0 命中**
（`find ~/.claude/plugins/marketplaces -type d \( -name node_modules -o -name .git -o -name __pycache__ \) | grep '/skills/'` → 0）。
但用户可以手选**任意**目录 ⇒ **路径可达，只是不在现有语料里**。
按本仓纪律，「真实语料里没有」不等于「到不了」，必须有显式处置。

**处置（二选一，实现方在 PR 里说明选了哪个及理由）**：
- **首选**：把 collector 的排除集提升为**具名 preview 拒绝原因** ——
  技能目录内含任一被排除目录 ⇒ 该技能列为「本版本不装：目录内含构建产物 / 版本库数据」。
- 备选：独立扫描应用**同一份**排除集，并把该排除集**从两侧的单一真源导出**
  （禁止两处各写一份 —— 那正是「手写替身」形态）。

**闸（并入 G16）**：合成一个内含 `node_modules/` 的技能目录 ⇒
preview 必须给出**具名**结果（不是静默接受）；把处置逻辑删掉 ⇒ 必须变红。

### R2-b（原 B4 残余）：块式控制字段整个不进字典 —— 而真实语料里块式占多数

**问题**：`parseSkillFrontmatter`（`ext-import-validate.ts:16`）的行正则
**要求冒号后必须有非空标量值**。因此 `allowed-tools:` 后跟换行 YAML 列表这种**块式**写法
**根本不进 `fields` 字典**。§5「让解析器交出完整键集」这一条**不足以**闭合 B4：
交出来的字典里本来就没有这个键。Codex 实跑一个只含该控制字段的合成 Skill，
当前解析结果仍为 `ok:true`。

**编排者实测的可达性 —— 这条比 R1 报的更要紧**：
真实语料里**块式 7 个文件、标量式 4 个文件**
（`rg -a -l '^allowed-tools:\s*$'` → 7；`rg -a -l '^allowed-tools:\s*\S'` → 4）。
**即真实用法里块式占多数**，照 v2 原文实现会漏掉 11 个里的 7 个。

**处置**：控制字段的检测口径改为**「顶层键是否出现」**，与它有没有标量值无关 ——
在解析器里按**行**探测顶层键 token 并把**键名集合**（不是键值）一并交出。
**仍然零新增解析器**：不解析块式的值、不引 YAML、不解析嵌套；
只回答「这个顶层键在不在」。这与 `ext-import-validate.ts` 抬头
「只认顶层 `key: value` 行、少一个解析器面」的既有决策**不冲突** ——
它增加的是**键的存在性**，不是值的语法面。

**闸（并入 G17）**：负向夹具**必须同时包含块式与标量式两种写法**
（真实样本各取一个：`imessage/skills/configure`=块式、任一标量式）；
把检测口径改回「要求有标量值」⇒ 块式那一半**必须变红**。
**禁止只用标量式夹具** —— 那是假闸形态⑨（期望值恰好等于可硬编码的常量）
与「负向夹具用了最退化形状」的合体。

### R2 的两条 out-of-round 数字更正（非门控，一并采纳）

- §3.1：`318` 是 **marketplaces 162 + cache 156 的合计**，不是 cache 单独的数。
  §3.5 的合计 54 / 内容去重 32 / marketplaces 真值 12 全部不受影响。
- §3.5 变异数字：10 个 `user-invocable` 中 **7 个 `true`、3 个 `false`**，
  因此「只看 `false`」是从 12 降到 **3**（不是 2）。计数断言仍会变红，判据不变。

### R2 复核确认成立的部分（不再重开）

路线 C、§3.2 的布局两轴实扫（159 标准 / 1 `.claude/skills` / 2 manifestless /
5 marketplace-only / 4 `workflow-skills` / 根级 0）、v2 自提的 8 条新面
（默认关的共享落点、ownership 最小修法、`version` 选填、root 身份风险披露、
三组只能靠合成夹具的闸、`.bak` 是真实输入）、以及合成可装率
**135/162 与 10/40 全灭** —— 均由 R2 按稿内判据实跑复现。
