# REQ-153..156 方案基线:让模型按各自上限充分输出与思考,并让产出物真的可用

- 需求票:`jinjunnn/alpha-work#REQ-153`(输出与思考)、`#REQ-154`(产出物质量)、
  `#REQ-155`(文档链路)、`#REQ-156`(闸门与债务)。均 **L 级**(跨仓契约 + 上游隔离约束)。
- 状态:方案基线(升 Ready 的门)。
- 勘破输入:2026-09-06 五路并行只读勘破(S1 gateway 输出上限 / S2 harness 模型硬编码 /
  S3 上游隔离 / S4 提示词路由 / S5 技能与文档链路),原始笔记见 §5。全程只读,零凭证接触,
  两仓工作树在勘破前后 `git status` 无新增改动。
- 涉及仓:`alpha-code`(harness、桌面、出厂技能)、`alpha-platform`(gateway 目录与闸门)。
- owner 裁决(2026-09-06,记录于 §4):① 所有 route 的 `maxOutputTokens` 取上游允许的
  最大值;② **不另设输出量预算闸**;③ 需要 Claude/直连 provider 凭据才能验的格子本轮不做。

## 0. 一句话方案

**输出与思考被四层各自独立地压住,其中三层的开关在我们自己手里、且都不需要碰上游文件。**
逐层解开:harness 目录注入补 `reasoning` 字段(alpha 自有文件,一处)、gateway 目录抬到上游
上限、harness 侧 `max_tokens` 抬到 route 上限、被上游黑名单清零的模型走 config `variants`
补档位。产出物质量另走两条既有薄层(`instructions` 与 `agent.<name>.prompt`),文档链路则
是连接器没装 + schema 写死两件事。

**上游文件(`packages/{opencode,core,server,tui,sdk,protocol,schema,client}`)零改动** ——
这不是偏好,是 required check + ADR-029 的硬约束,见 §1.5 与 §2.1。

## 1. 只读勘破(地面真相;全称事实均已实跑)

### 1.1 输出长度:两层封顶,都低于上游允许值

实测捕获的 harness 请求体(假上游 + 生产函数 `buildAlphaModelConfig` + 本仓真 CLI):

```
{"model":"glm-5.2","max_tokens":32000,"tool_choice":"auto","stream":true}
```

gateway 侧唯一强制点是一条代数,两条 wire 一致 ——
`alpha-platform/packages/gateway/src/worker.ts:1117`
`Math.min(requestedMax, route.maxOutputTokens)`;openai 腿落 `lib/openai-wire.ts:231`,
anthropic 腿落 `worker.ts:1924`。实跑生产函数确认:客户端不传 → 上游收 `route.maxOutputTokens`;
传 200000 → clamp 到 8192;传 100 → 发 100。**客户端只能往低调,永远调不高。**

于是实际链路 = `harness 32000` → `gateway clamp 8192` → `上游允许 131072`。
**两层都低于上游,只抬一层会撞上另一层。**

`32000` 的来源(T3 `alpha-code#1238` 2026-09-06 实跑定位,单变量,假上游捕获本仓真 CLI):
`packages/opencode/src/provider/transform.ts:18` `OUTPUT_TOKEN_MAX = 32_000`,经 `:1394-1396`
`maxOutputTokens(model, cap = OUTPUT_TOKEN_MAX) = Math.min(model.limit.output, cap) || cap`,由
`session/llm/request.ts:133` 以 `flags.outputTokenMax`(env `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`,
`effect/runtime-flags.ts:52`)当 cap 调用;config 声明的模型 `limit.output` 缺省 0(`provider.ts:1497`)
⇒ `Math.min(0, 32000) = 0 || 32000`。它不是 `packages/llm/src/protocols/anthropic-messages.ts:509`
的 `outputLimit`(该缺省为 4096,不在这条路径上)。实测:`limit.output=100` → 100;
`limit.output=131072` → **仍 32000**(config 只能往低调,抬不上去);env 200000 + `limit.output=131072`
→ 131072;env 200000 单独 → 200000。**结论:config `limit.output` 单独做不到 T3;而全局 env cap 会同时
抬直连 BYOK 节点并改变 `session/overflow.ts` 的 compaction 阈值。** T3 的落点因此是 alpha 插件的
`chat.params`:对平台代理节点把 `maxOutputTokens` 置空(请求体不带 `max_tokens`),网关按上文
`min(客户端值(如有), route.maxOutputTokens)` 填 route 值 —— 零常量、零同步,网关抬多少 harness 跟多少
(上游同款先例 `plugin/cloudflare.ts:64-74`)。

### 1.2 `maxOutputTokens` 现值与上游允许值(2026-09-06 实读,exit=0,公开 GET,零费用)

判据脚本 `alpha-platform/scripts/verify-openrouter-capability.ts`。

| 模型 | config | 上游 live 允许 | 倍数 |
| --- | --- | --- | --- |
| `glm-5.2` / `glm-5-turbo` | 8192 | 131072 | 16× |
| `deepseek-v4-flash` | 8192 | 384000 | 46.9× |
| `fable` / `opus` | 32000 | 128000 | 4× |
| `claude-haiku-4.5` | 64000 | 64000 | 顶格 |

**12 个模型 11 个填低了。** 8192 的来历有原文且明说是自设:
`models-config-loader.ts:147-149`(owner 2026-08-13 裁决记录)「config maxOutputTokens=8192
**远低于任何可查同类值**…我们把输出上限卡得比允许的低,方向安全」;
`countersign-brief.md:26`「填小只限制输出长度,不产生资金风险」。
`grep -rn 8192 docs/ --include="*.md"` 零命中(已自检 grep 未瞎)——
**没有任何 ADR 解释过这个数**;四条 GLM 的 `verifiedBy` 原文签的是 W 与四个价桶,
**一个字未提输出上限**。

**10 条直连腿(含智谱两条)的上限本机结构性探不了**:`packages/gateway/.dev.vars` 只有
`PLATFORM_ENV/DEV_PLATFORM_TOKEN/JWKS_URL`,`node-keys.ts:9-14` 要的六把 provider key
本机一把没有(在 wrangler secrets)。**本基线对直连腿只采信 vendor 页当日实读,并按单渠道
读数标注** —— 与仓内既有 `verifiedBy`「一家之佐证,owner 知情采纳」写法一致。

### 1.3 reasoning:第一因在 alpha 自有文件,不在上游判定树

`alpha-code/packages/ui-mac/src/main/alpha-models.ts:95-97` 往 opencode 写模型配置时
**只写 `name` 与 `variants`,不写 `reasoning`**;而 `alpha-models.json` 里
`claude-opus-4.8` / `gpt-5.4-mini` / `deepseek-v4-pro` **标着 `"reasoning": true`**。
BYOK 段更窄(`:69` 只写 `{name}`)。

后果:harness 里**每个**模型 `capabilities.reasoning === false`,
`packages/opencode/src/provider/transform.ts:712` 第一行即 `return {}`。

**实测确证(单变量)**:基线 body 零 reasoning 控制;**只加 `reasoning:true` 一处**,
同一条命令立刻产出 `"reasoning_effort":"max"`。

渲染层读的却是 JSON 的 `reasoning`(`model-picker-core.ts:114,164`)⇒
**picker 打「推理」徽标的模型,引擎侧是 `false`** —— UI 对用户说了假话。

### 1.4 补完 `reasoning` 之后,仍被上游黑名单清零的那批

`transform.ts:763-775` 的完整条件是 `model.id`(**不是 `api.id`**)含
`deepseek-chat|deepseek-reasoner|deepseek-r1|deepseek-v3|minimax|glm(非5.2)|kimi|k2p|qwen|big-pickle`
→ 直接 `return {}`,switch 全不执行。

| 模型 | 补 `reasoning:true` 后 | 仍卡在哪 |
| --- | --- | --- |
| `glm-5.2`、`deepseek-v4-pro/flash`、`claude-*`、`gpt-5.4-nano` | 拿到档位 | — |
| `glm-5-turbo` | 仍无 | `:767` `glm && !glm52` |
| `qwen3.7-max/-plus` | 仍无 | `:770` `qwen` |
| `kimi-k2`、`MiniMax-M2` | 仍无 | `:767-771` |
| `alibaba-byok/qwen-*` | 仍无(双杀) | 黑名单 + `:1234` `providerID === "alibaba-cn"` **严格等号**,`alibaba-byok` 永不匹配 ⇒ DashScope 永不回 `reasoning_content` |

拿装着的 models.dev 快照实算:落到硬编码树的 622 个 reasoning 模型里,
**442 个(71%)被这一条清零**。

**三个逃生口且都不用改上游**:config `models.<id>.variants`
(`provider.ts:1507,1633-1646`)、config `models.<id>.options`(`llm/request.ts:94`)、
`options()` 的 provider 级注入。第一个 alpha 已在用(`alpha-models.ts:90-99`,REQ-029)。
另注:**config 声明的模型结构性走不到 `reasoningVariants()`**(它只在 `provider.ts:1252`
被调),而 owner 的 harness 100% 是 config 模型。

### 1.5 上游隔离:硬约束,实测会红

`UPSTREAM_PATHS` 唯一真源 = `alpha-code/scripts/north-star-guard.sh:39`
(CI `alpha-ci.yml:133` 跑同一份字节)。辖区:
`packages/{opencode,core,server,tui,sdk,protocol,schema,client}`。

判定:`provider/transform.ts`、`session/system.ts`、`session/prompt/*.txt`(含 `default.txt`)、
`core/src/plugin/variant.ts` **四者全在辖区内、全在 `origin/dev` 中存在、全不在 40 条
`UPSTREAM_EXCLUDES` 里 ⇒ 上游文件**。`packages/ui-mac/**` 不在辖区,alpha 自有。

**闸不是安慰剂(先证明它会红)**:临时 worktree 四方向实测 —— 四个目标文件逐个追加空行
→ 全部 `✗ upstream files modified` + 点名 + `exit 1`;干净树 `✓`;ui-mac factory-skill `✓`;
alpha 自有的 `session/tool-display.ts` → 显式报「alpha 自有」+ `✓`。
它是 `alpha` 分支的 required status check(`.github/required-contexts.txt` 第一条)。

治理侧更硬:**ADR-029 §决策2 原文「不存在 L4『直接编辑同步中的文件』——永不设立」**;
ADR-015 Tier 0 逐字禁改 `prompt/*.txt`。

**代价已量化**:模拟本方案两处最小改动 → 守卫 exit 1 点名;真 merge 后
**`system.ts` 真冲突**(上游在待合窗口改的正是那几行),冲突数 18→19。`transform.ts`
自 2026-06-01 有 **24 个上游 commit,内容全是推理档/采样参数** —— 即何时冲突,不是会不会。
`transform.ts` 的 alpha 自有行数 = **0**(blame 全部上游作者)。

**当前 `upgrade-isolation health`:UPSTREAM_PATHS 内 = 0(达标)**;整体 18 个冲突文件,
逐条落在 ADR-020/027 已备案已定价的 L3 冻结范围(`bun.lock` + `packages/app/**` 14 个 +
`packages/ui/…dialog-v2.tsx` + `packages/desktop/…index.ts`)。上次 sync `dc272a32a`
(2026-07-23),`origin/dev` 已到 2026-08-21。

**守卫盲区(新发现)**:守卫只盖 8 个包,`origin/dev` 有 32 个。22 个上游包在辖区外,
其中 `app`/`ui` 由 ADR-020 冻结 roundtrip 盖住,**其余 20 个零机制**。实测往
`packages/plugin/src/index.ts`(**Hooks 契约本体**)与 `packages/llm/src/index.ts`
各写一行 → 守卫 `✓ exit 0`。本方案重度依赖 hook 契约,该盲区必须堵。

### 1.6 可用的薄层(全部已有先例,不需要新机制)

| 目标 | 机制 | 坐标 | 既有先例 |
| --- | --- | --- | --- |
| 改 `maxOutputTokens`/采样参数 | `chat.params`(跑在 transform **之后**,五字段可写) | `session/llm/request.ts:118-136` | 上游 `plugin/cloudflare.ts:74` |
| 声明 `reasoning`/`limit.output`/`variants`/`options` | config `provider.<id>.models.<id>` | schema `core/src/v1/config/provider.ts:8-74`;消费 `provider/provider.ts:1457/1497/1504-1512` | `alpha-models.ts:90-99`(REQ-029) |
| 整段替换系统提示词 | `agent.<name>.prompt`(基座整个不跑) | `config/agent.ts:13-29`;`llm/request.ts:64` 二选一 | `alpha-prompts.ts`(general/explore) |
| 追加指令 | `instructions` | `alpha-config-injection.ts:105-120` | `alpha-behavior.ts:19-31`(已上线) |
| 删基座里某段 | `experimental.chat.system.transform` | `plugin/src/index.ts:291-296` | `ext/src/plugin.ts:206-222`(已在整块删除) |

**`chat.params` 做不到的唯一一格:`capabilities.reasoning`** ——
`ProviderTransform.options()/variants()` 在 `request.ts:88-95` 就跑完,`chat.params`
在 L118 才触发。⇒ 该格只能走 config(即 §1.3 的 T1)。

### 1.7 提示词路由与长度压制

`session/system.ts:29-42` 按 `model.api.id` 子串路由;`model.api.id` =
config `provider.<id>.models` 的 **KEY**(`provider.ts:1433`),alpha 注入时不写 `id`
(`alpha-models.ts:95-103`)⇒ 就是网关模型键。

**25 个网关模型中 16 个落 `default.txt`**;owner 真实 DB 实查:`opencode.db` **52/55
(94.5%)**、`opencode-alpha.db` **66/72(91.7%)**。不是偶发。

`default.txt:17` 的 `minimize output tokens as much as possible` 是**全仓唯一一条
没有 `not including tool use or code generation` 豁免的**;`:19`/`:84` 那两遍
"fewer than 4 lines" 反而**有**豁免语。

**与模型无关、所有模型都吃的一份**:`tool/write.txt:6,7,8` + `tool/edit.txt:6,7` ——
`NEVER write new files unless explicitly required` / `NEVER proactively create *.md`。
本 portfolio 的文档生成任务正落在它的射程里。

「别做 AI slop」的前端设计纪律全仓只在 `gpt.txt:47-54` 与 `codex.txt:26-36`;
**1256 行系统提示词零排版/视觉指导**。

`transform.ts:1290` 的 `textVerbosity:"low"` 确实上线(抓包见 `"verbosity":"low"`),
但 **alpha 网关白名单重组会剥掉它**(实跑 `rebuildOpenAIRequest` 输出只剩
`messages/temperature`)⇒ 目前不构成真实压制,**不作为本方案的改动面**。

### 1.8 技能装载与文档产出链路

被测对象 = owner 实跑的 `/Applications/Code Puppy.app` **0.1.9**(dev 渠道);
`office-mcp/server.py` 与 `office-docs/SKILL.md` 两边逐字节相同,结论踩的是装着的那份。

生效路径只有两条:`~/.config/opencode/skills/`(17 个,经 `config/paths.ts:26`)
+ `ALPHA_FACTORY_SKILL_DIRS` 注入的 7 个出厂技能,加内置 `customize-opencode`(被 deny)
= 25,与引擎日志 `message=init count=25` 算术吻合。
**`~/.claude/skills`、`~/.agents/skills`、项目 `.claude/` 默认不继承** ——
`ui-mac/src/main/ecosystem-import.ts:28-32` set-if-unset 注入 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`
(ADR-024 安全裁决;`ALPHA_ECOSYSTEM_INHERIT=1` 逃生;同意后的进入通道是安装期转换导入,
本机当前 dev 环境的迁移门 2026-07-23 已弹过并被选「不导入」)。本文首版写的「无条件注入」是误述,
勘破与裁决见 [`../architecture/2026-09-06-external-skills-inheritance-decision.md`](../architecture/2026-09-06-external-skills-inheritance-decision.md)(`#1243`)。

- **空壳技能 3 个**(`canvas-design`/`brand-guidelines`/`mcp-builder`,各 8 行,正文
  「请补充上游内容」)。system 段只注入 name+description+location(`skill/index.ts:321`),
  正文不进 ⇒ 合计 199 token = 技能块的 5.3%,**token 不是代价**;真代价是模型调用后
  拿到空的 `<skill_files>`,而空掉的两个正好管视觉。
- **live 的 24 个技能里管质量/审美的 = 0。**
- **四个 office connector 一个都没装**:app 2026-09-04 从 prod 切到 dev 渠道,
  dev `installs.json` = `{"receipts":[],"records":[]}`、`alpha.jsonc` 171 字节无 `mcp` 键;
  **prod 根里那四条仍指着 `/Applications/alpha-code.app`(该路径已不存在)**。
  ⇒ `office-docs` 技能生效、它推荐的连接器全不在,模型读到一份教它用不存在工具的说明书。
- **`write_docx` 真实 schema**(实跑生产命令取回 `tools/list`):
  `{path, title, paragraphs[string], append}`,`additionalProperties:false`。
  字号/字体/表格/分页/页眉/列表/图片/页边距/目录**全部不能**;多传 `font`/`size`
  服务端**静默丢弃**(返回成功,产物零 `rPr`)。同源:`write_xlsx` 只收 `{name, cells}`,
  而 SKILL.md 43-57 行整节 xlsx 惯例(数字格式/冻结/autofilter/图表)**一条也做不到**。
- **实跑产物**(生产命令 + 生产 `server.py` 造 `ws/recon.docx`,读回):
  US Letter(非 A4)、左右 1.25in、正文 Cambria 11pt、**`theme1.xml` 的 `eastAsia`
  是空字符串(中文字体压根未指定)**、`dcterms:created=2013-12-23`、零表格零页眉零页码;
  「一、总体情况」意图为小标题,**被降级成 Normal 正文**(connector 只有一个固定
  `level=0` 的 title 槽)。
- HTML 无专门通路,即 `write` 工具写文件。

## 2. 选定方案与被否决的替代

### 2.1 被否决:直接修改上游文件

删掉 `transform.ts:763-775` 黑名单、给 `system.ts` 加一条路由、改 `default.txt:17` ——
**否决**。理由是 §1.5 的三条实测:required check 会红;ADR-029 明令永不设立 L4;
`transform.ts` 上游一个季度 24 个 commit 全落在我们想碰的四个函数上,接管的定价是
**每次 sync 手工解冲突 + 放弃上游在推理档/采样参数这一格的全部升级**。

反问「能否让本系统成为权威、让外部无从覆盖」的答案是**不能,也不该** ——
这正是 ADR-005 / NON_GOAL #2 的立仓前提(不重建 harness,继承上游升级)。

### 2.2 被否决:靠 `chat.params` 统一解决 reasoning

`chat.params` 在 `request.ts:118` 才触发,而 `variants()/options()` 在 L88-95 已跑完 ——
它只能**手写等价 options**,不能让 transform 走「有 reasoning」的分支。手写等价 options
= §1.4 意义上的「手写别人文法的替身」,是本 portfolio 记录在案最贵的返工形态。
**选定 config 声明(`reasoning` + `variants`),让 transform 自己算。**

### 2.3 被否决:只抬 gateway 或只抬 harness

§1.1 实测两层串联取 min。只抬一层的可观察表现是「改了没用」,并会诱发对另一层的重复诊断。
**T2 与 T3 必须同批交付。**

### 2.4 被否决:逐句删改基座提示词

用 `experimental.chat.system.transform` 逐句删 `default.txt:17` 与 `write.txt` 那几条,
技术上可行(`ext/src/plugin.ts:206` 已在做整块删除),但**它是子串手术**:
`request.ts:62-70` 已把底座+environment+instructions join 成一个串,上游改一个字就失配,
且失配是静默的(删不掉 ≠ 报错)。

**选定 `agent.<name>.prompt`** —— 文档类任务走专用 agent,`request.ts:64` 二选一,
基座整个不跑,一次性甩掉 `default.txt:17` 与它同段的全部压制,不依赖上游字符串稳定。
`alpha-prompts.ts` 已对 general/explore 用过这条路。
`instructions`(`alpha-behavior.md`)保留为**全局补充**面,负责与模型无关的质量基线。

### 2.5 选定方案总表

| 层 | 动作 | 落点(全部 alpha 自有或 config) |
| --- | --- | --- |
| reasoning 第一因 | `alpha-models.ts` 转发 `reasoning`(含 BYOK 段) | `packages/ui-mac/src/main/alpha-models.ts` |
| 黑名单余量 | config `variants` 补档位 | 同上 |
| gateway 上限 | 22 条 route 取上游最大 + 指纹重算 | `packages/gateway/src/models.config.json` |
| harness 上限 | 定位 32000 来源后经 config `limit.output` 或 `chat.params` 抬到 route 上限 | `alpha-models.ts` 或 alpha 插件 |
| 全局质量基线 | `alpha-behavior.md` 扩写 | `alpha-behavior.ts` |
| 文档任务提示词 | 新增文档类 agent | `alpha-prompts.ts` |
| 文档链路 | connector 安装修复 + `write_docx` schema 扩面 | ui-mac / office-mcp |
| 闸门 | 上限核对闸进 CI 扩 22 腿;north-star 扩 32 包 | 两仓 CI |

## 3. 安全面:整类边界与必须守住的不变量

**类边界前置,不留给 review 逐实例修。**

1. **抬上限不得抬过上游允许值。** 不变量:任一 route 的 `maxOutputTokens` ≤ 该 route
   上游当日实读上限。守法:`deploy-worker.ts:165` 那道已精确到 ±1 的闸(实测 131072 绿 /
   131073 红)挪进 CI 并扩到 22 条腿(T10)。**当前它不在 CI 且只覆盖 12 条 OR 腿。**
2. **owner 已裁决不设输出量预算闸**(§4)。因此本方案**不引入**任何按 plan/租户的
   输出配额;`worker.ts` 现有 clamp 语义保持(客户端仍只能往低调)。
   风险敞口仅为 owner 自身花费 —— 前提是「除本机外零租户」(owner 2026-08-31 确认)。
   **该前提若变,本条必须重开。**
3. **config 注入不得放大凭据面。** `alpha-models.ts` 只增 `reasoning`/`variants`/
   `limit` 三类**能力声明**字段,不触碰 provider key、baseURL、auth。
4. **指纹重算不得伪造签核。** `routeTupleFingerprint()` 是自洽性闸不是签名(实测:
   抬值 + 重算 → 绿且 `verifiedBy` 原封不动)。不变量:**改值必须同时更新
   `verifiedBy` 的签核域与日期**,不得沿用旧签核文字。直连腿按单渠道读数显式标注。
5. **agent 提示词替换不得削弱工具权限或审批。** 新增文档类 agent 只改 `prompt`,
   `permission` 沿用默认;不得借机放宽 `bash`/`write` 审批。
6. **connector 修复不得放宽路径边界。** 沿用 REQ-133 已立的安全闸:仅 local stdio、
   钉版、禁网络 transport / host-port、路径不出工作区。schema 扩面只增**排版字段**,
   不增路径、命令、URL 类入参。
7. **上游隔离是硬不变量。** 任一子票的 diff 触碰 `UPSTREAM_PATHS` = 该票做错了,
   不是闸门太严。T11 扩守卫辖区后,该不变量的覆盖面从 8 包升到 32 包。

8. **本方案会激活两条此前的死代码路径 —— 必须同批验,不得事后补。**
   两者今天都无害,恰恰因为 `capabilities.reasoning === false` 让 `variants()`
   首行 `return {}`;而 T1 要做的事就是推翻这个前提。**用一个即将被自己推翻的前提
   去筛 finding,是本基线 §6 反复警告的同一个错。**

   **8a — 辅助调用的推理档位。** `session/llm/request.ts:88-89` 对 `input.small === true`
   的辅助调用(标题、摘要)改走 `ProviderTransform.smallOptions()`,其首行
   (`transform.ts:1304`)是 `Object.values(model.variants ?? {})[0]` —— 取档位表**第一项**,
   与用户选择无关。`request.ts:84-87` 的 `!input.small &&` 守卫是**故意**的,意图正确
   (辅助调用不该用贵档)。风险在"第一项是否便宜"随模型族而变:

   | 模型族 | 档位表 | 第一项 |
   |---|---|---|
   | OpenAI 系 | `[none, minimal, low, medium, high, xhigh]` | `none` ✅ |
   | 通用 | `[low, medium, high]` | `low` ✅ |
   | **glm-5.2 / openai-compatible**(`transform.ts:742-747`) | `{high, max}` | **`high`** ❌ |

   不变量:**辅助调用不得取到比用户主调用更贵的档位。** 判据落在 T1 的验收里
   (触发一次标题生成并捕获请求体);修法只能在 config 侧,不得改上游。

   **8b — 采样参数缺能力门。** `request.ts:129` 的 `temperature` 被
   `capabilities.temperature` 挡着,而紧邻的 `:131-132` 的 `topP`/`topK` **没有门**。
   取值见 `transform.ts:538-555`:qwen → `top_p: 1`(数学上空操作)、
   minimax-m2 / gemini / kimi-k2.5 → `0.95`;topK:minimax-m2 → 20/40、gemini → 64。
   T4 会让**恰好带 `top_p` 的那几族**(qwen / minimax / kimi)首次同时带上
   `reasoning_effort` —— 而推理模型拒收采样参数是常见行为,`temperature` 有门保护、
   它们没有。

   不变量:**任一模型不得同时收到它会拒绝的采样参数与推理参数。** 判据落在 T4 的
   验收里(每个新获推理档的在册模型实发一次真请求确认受理),**不得用合成夹具顶替**
   —— 要判的正是上游对这个组合的反应;凭据不可得的模型显式记为未验,不得默认通过。

   两者原先被记为「已知不修」(`alpha-code#1249`),该判断已于 2026-09-06 复核作废。

## 4. owner 裁决记录(2026-09-06)

1. **所有 route 的 `maxOutputTokens` 取上游允许的最大值。** 逐字:「全部都按照最大即可」。
2. **不设输出量兜底/预算闸。** 逐字:「这个我觉得可以不做输出量限制」。
3. **需要 Claude/直连 provider 凭据才能验的格子本轮不做。** 逐字:「如果涉及 claude api
   相关的内容可以暂时不做因为无法测试现在没有 apikey」。
   ⇒ 落到票面:Claude route 的 config 值仍随 T2 一起抬(判据是同一条 keyless 目录读数),
   但**不写任何需要真实 Claude 调用的 AC**;`alpha/claude-*` 发 `cache_control` 一事
   本轮不立票,记入 §6 待办。
4. **AC 必须务实,不写做不到的承诺。** 逐字:「开票的AC 必须务实，不可以写无法实现的承诺」。
   ⇒ 本基线下所有 AC 的证据面均限于:本机可跑的确定性检查、keyless 目录读数、
   已装应用的实跑探针。**不含**任何需要 provider key 的实调。

## 5. 勘破原始笔记

| Scope | 笔记 |
| --- | --- |
| S1 gateway 输出上限 | `recon-S1-gateway-output-cap.md`(546 行) |
| S2 harness 模型硬编码 | `recon-S2-harness-model-hardcoding.md`(382 行 + `recon/` 原始抓包) |
| S3 上游隔离 | `recon-S3-upstream-isolation.md` |
| S4 提示词路由 | `recon-S4-prompt-routing.md`(422 行 + `capture/` + 完整 system 段) |
| S5 技能与文档链路 | `recon-S5-skills-and-docs.md` |

五份均为 2026-09-06 会话内产物。**本基线承重的每条坐标已在 §1 逐条复述,
笔记仅作原始证据留存。**

## 6. 已知未验 / 本轮不做(前提被推翻即重开)

以下**不得**被当作已知事实使用,也**不得**写进任何 AC:

1. **`default.txt:17` 是否真压产出物** —— 只有文本与结构证据,**无 A/B 行为实测**。
   T5/T6 的收益建立其上,故两票的 AC 只承诺「文档任务不再走基座提示词」这一**结构事实**,
   不承诺「输出变长/变好」这一**行为结果**。
2. **GLM 的 thinking token 是否计入其 `max_tokens`** —— 仓内零勘破。若计入,T2/T3 的
   实际收益要打折。anthropic 腿计入是有据的
   (`docs/architecture/anthropic-messages-request-surface.md:144` 引官方)。
3. **直连腿真实受理上限** —— 本机无 key,结构性探不了(要一把 `ZHIPU_API_KEY`,
   `max_tokens=131072` 最小请求,费用上限 ~$0.31/次)。
4. **gateway 收到 `reasoning_effort` 转成什么、zhipuai 端点收到 `thinking:{enabled}`
   吐不吐** —— 未测,属 gateway 侧勘破。
5. **picker(V2 catalog)与引擎(v1)两份 variants 是否一致** —— 两份不是同一份
   (`provider.ts:1343` 走 `ModelsDev.Service` 而非 V2 catalog),未端到端验证。
6. **`alpha/claude-*` 因 `api.id.includes("claude")` 被判 anthropic 家族,
   真往网关发 `cache_control:{ephemeral}`** —— 需 Claude key 才能验后果,本轮不做(§4.3)。
7. **`worker.ts:1928` 把 `thinking` 原样透传而 `:1924` 强制下调 `max_tokens`**,
   gateway 会构造出 `max_tokens=32000` + `budget_tokens=60000` 这类组合;
   **上游对它回什么未实测。**
8. **skill permission 是否有额外过滤** —— S5 未实测(HTTP API 401),属推测。

## 7. 子票切分

见 §7 表;逐票 AC 与证据面写在 GitHub Issue 上,本节只定切分与依赖。

| 票 | 仓 | 复杂度 | 依赖 |
| --- | --- | --- | --- |
| REQ-153 T1 转发 `reasoning` | alpha-code | S | — |
| REQ-153 T4 config `variants` 补黑名单模型 | alpha-code | M | T1 |
| REQ-153 T2 gateway 22 route 抬上限 | alpha-platform | M | — |
| REQ-153 T3 harness `max_tokens` 抬到 route 上限 | alpha-code | M | 定位 32000 |
| REQ-154 T5 `alpha-behavior.md` 质量基线 | alpha-code | S | — |
| REQ-154 T6 文档类 agent | alpha-code | M | — |
| REQ-154 T9 office-docs 质量段 + 空壳技能处置 | alpha-code | S | — |
| REQ-155 T7 connector 渠道切换后失效 | alpha-code | M | — |
| REQ-155 T8 `write_docx` schema 扩面(含 `eastAsia`) | alpha-code | M | — |
| REQ-156 T10 上限核对闸进 CI + 扩 22 腿 | alpha-platform | M | T2 |
| REQ-156 T11 north-star 守卫扩到 32 包 | alpha-code | M | — |
| REQ-156 T12 upstream sync 欠账 | alpha-code | M | — |

附带发现的独立 bug 票见各父票 Delivery plan。
