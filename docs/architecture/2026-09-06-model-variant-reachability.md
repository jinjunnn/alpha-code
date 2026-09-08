# 推理档位(`variant`)的可达面:谁能设、设错了会不会被告知

> 2026-09-06 勘破,起因 [`#1249`](https://github.com/jinjunnn/alpha-code/issues/1249)
> 「`--variant` 打在没有档位的模型上静默无效」。全部坐标当日实读,命令附在每节。
> 结论落在这里是因为它决定了**这道缺陷要不要在 alpha 修、能在哪一层修** —— 而这个判断
> 不在票面里,票面只描述了症状。

## 1. 上游那条链:收得下,查不到,不吭声

```
packages/opencode/src/cli/cmd/run.ts:212-215
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
```

CLI 无条件收下任意字符串,**不对照模型的档位表**。值一路带到:

```
packages/opencode/src/session/llm/request.ts:84-87
  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
```

模型没有 `variants` ⇒ 取 `{}`;有 `variants` 但键不存在 ⇒ 取 `undefined`。两条都直接进
`mergeOptions`,**没有任何一处比对合法档位、没有一处报错**。档位表本身由
`packages/opencode/src/provider/transform.ts:711` 的 `variants(model)` 产出。

三处全在 `UPSTREAM_PATHS` 里。`request.ts` 虽然已由 ADR-041/REQ-134 逐文件收编
(`scripts/north-star-guard.sh:99` 的 exclude),**技术上改得动**,但见 §4:它修不到任何
一个我们的用户到得了的状态。

## 2. 第零问:走我们自己的代码和 runbook,到得了 `--variant` 吗?——到不了

| 问题 | 实读 | 结论 |
| --- | --- | --- |
| alpha 出 CLI 吗? | `packages/ui-mac/package.json` 无 `bin` 字段 | 否 |
| 安装包里带可执行 CLI 吗? | `packages/ui-mac/electron-builder.config.ts:79-133` 的 `extraResources` 共 8 条:`skills/` `factory-skills/` `office-mcp/` `agents/` `NOTICE.txt` `extension-seed/` `alpha-ext/` `db-expected-migrations.json` | 否 |
| 应用起引擎时传 argv 吗? | `packages/ui-mac/src/main/server.ts:293-295`:`fork(sidecar, [], …)` | 传的是 `[]` |
| 那个 sidecar 是 CLI 吗? | `packages/ui-mac/src/main/sidecar.ts:118` `const { Server } = await import("virtual:opencode-server")` | 是**服务器**,不解析 argv |
| runbook 里有人用它吗? | `grep -rn -- "--variant" docs/ .claude/` → **0 命中** | 否 |

⇒ `--variant` 是**上游 CLI 的表面**,不是 alpha 产品的表面。用户拿不到那个二进制,
我们自己的 runbook 也一次都没提过它。开发机上 `bun run packages/opencode/src/index.ts run --variant …`
当然能复现 —— 那是**开发路径**,不是产品路径。

诚实边界:应用内有终端(`session-rail/terminal`)。用户如果**自己**另外装了 opencode,
可以在那里敲这条命令 —— 但那时跑的是他自己的那份二进制,不是我们发的。

## 3. 产品这一侧的对应表面:composer 的档位 chip

用户在 alpha 里表达「用高强度思考」的唯一入口是 composer 上那颗档位 chip。这条路径上
**结构性地发不出引擎不认识的档**:

| 位置 | 代码 | 作用 |
| --- | --- | --- |
| `alpha-ui/model-picker-core.ts:74-78` | `withModelVariant`:`variant && model.variants.includes(variant) ? variant : undefined` | 选档时就丢掉非法值 |
| `alpha-ui/composer-state.ts:232-233` | `setComposerModel`:换模型时 `m.variant && !m.variants.includes(m.variant)` ⇒ 清空 | 换模型不留下陈旧档 |
| `alpha-ui/composer-state.ts:318` | `buildPromptRequest`:`input.effort && input.model.variants.includes(input.effort) ? { variant: input.effort } : {}` | 发送前最后一道(C28) |
| 档位来源 | `model-picker-core.ts:70/109` `Object.keys(platform.variants)` | 只可能是该模型真有的键 |

**这一半已经有闸**:`composer-state.test.ts` 的「无档模型 → 绝不携带 variant(C28)」与
「模型有档但档名不存在 → 不携带」,以及 `model-picker-core.test.ts` 的
`withModelVariant(projected, "不存在").variant === undefined`。

## 4. 那为什么不去改上游那三处

- **改不到任何可达状态。** 我们自己发的产品结构上产不出「未知档位」这个输入(§3),
  在 `request.ts` 加一个 loud-fail 等于给一个到不了的状态立闸;而它守的那条 CLI 路径
  我们不发货(§2)。这正是 `CLAUDE.md`《第零问》点名的形状 ——
  **「在合成夹具里能复现 ≠ 在这个系统里到得了」**。
- **代价是真的。** `transform.ts` 自 2026-06-01 有 24 个上游 commit、内容全是推理档/采样参数
  (见 `docs/design/req-153-output-capability.md` §1.5),动它是「何时冲突」而不是「会不会冲突」。
- **`request.ts` 虽已收编,收编面是有边界的**:ADR-041/REQ-134 收它是为了 `{workspace}` 与
  工具身份,不是把它变成 alpha 想改就改的文件(ADR-029 §3:新增收编须自己的 ADR)。

## 5. 真正没被守住的那一半:「告诉用户为什么没生效」

`alpha-composer.tsx` 的 `EffortChip` 已经做了这件事:

- `:414-415` `supported() = variants().length > 0`;
- `:434` / `:441` / `:449` chip 上 `title` 走 `alpha.composer.effortUnsupported`、
  `data-muted={supported() ? undefined : ""}`、值位显示 `—`;
- `:501` 弹层里 `alpha.composer.effortUnavailableHint` **点名那个模型**
  (zh:「「{{model}}」未提供推理档位;请换用带档位的模型。」)。

**但这一半在 2026-09-06 之前没有任何判据。** 而它不是边角:`packages/ui-mac/src/main/alpha-models.json`
当天 12 个平台模型里,只有 `claude-opus-4.8` 与 `gpt-5.4-mini` 有 `variants`,**另外 10 个没有**。
把 `supported()` 改成恒真、或把弹层那段 hint 换成空,用户点开档位入口看到的就是一片空白 ——
和票面描述的沉默同形,而当时没有任何东西会变红。

判据因此补在 `packages/ui-mac/test-component/alpha-composer-model.cases.ts`
(真挂 `AlphaComposerRuntime`,由已登记的 `alpha-composer-model.component.test.ts` 起子进程跑):
无档位模型 ⇒ chip muted + `—` + title 说明原因 + 弹层点名模型 + **零个可点档位**;
同一条用例里以**有**档位的模型作控制组(否则「弹层根本没渲染」也能满足全部否定断言)。
变异实测(2026-09-06):拿掉 `data-muted` / `supported()` 恒真 / hint 置空,三条各自变红。

## 6. 处置

`#1249` 描述的「静默无效」在 alpha 产品上**到不了**,而它在产品上的对应表面
(档位 chip 的不支持态)**行为已正确、现在也有闸了**。上游 CLI 的那条路径按
「已知不修」记在本文件 §1/§4,前提是「alpha 不发 CLI」——
**这个前提若变(哪天我们真的发一个命令行入口),本条必须重开。**

## 7. 追记(2026-09-06 同日,`#1266` / `#1267`):chip 的档位从哪来,以及它与引擎请求体的对账

§5 写的「12 个平台模型里只有 2 个有 `variants`」是当日上午的地面真相;`#1239` 矩阵随后翻出
它的另一面 —— **有徽标的模型在 chip 上选不到档**(`deepseek-v4-pro`、`glm-5.2`,平台与直连都是),
以及**没徽标的模型在悄悄推理**(`gpt-5.4-nano` 默认 `reasoning_effort: medium`)。修法与判据:

- **档位的唯一 alpha 侧来源仍是 `alpha-models.json` 的 `variants`**(ADR-014 的 config 杠杆)。
  平台条目补齐:`gpt-5.4-nano`(`reasoning: true` + 低/中/高)、`deepseek-v4-pro`(低/中/高/最高)、
  `glm-5.2`(高/最高);wire 值(`reasoningEffort`)逐条对照上游 `transform.variants()` 对
  `@ai-sdk/openai-compatible` 的派生表写,不发引擎不认识的值。
- **BYOK 行不再写死 `variants: []`**:与 `reasoning`/`name` 一样经 `byokModelMeta` 从平台**同名**
  条目派生,同一份数据同时进 sidecar 注入(config `models.<id>.variants`)与 picker 行、会话投影
  (`composerModelFromRef`)、自动默认(`model-default-core` 第③级)。引擎侧(`provider.ts:1503-1507`)
  把 config 档位表与自己按 npm 派生的表 mergeDeep,所以 chip 上每个标签 `model.variants[variant]`
  都查得到。
- **为什么不改成「chip 读引擎清单」**(`#1266` 票面的非 AC 建议):桌面的模型清单来自 V2
  `model.list`,其档位由 `packages/core/src/plugin/variant.ts` `generate()` 产出 —— 只认 glm-5.2;
  而请求装配走 v1 `transform.variants()`(deepseek-v4 有 low/medium/high/max)。两份不是同一份
  (基线 `req-153-output-capability.md` §6.5),读 V2 清单会让 deepseek-v4-pro 在 chip 上仍然零档。
- **判据是双向的、走真引擎**:`packages/ui-mac/src/main/alpha-reasoning-badge-parity.test.ts`
  对生产 `buildModelPickerRows` 的每一行,用生产 `buildAlphaModelConfig` 的配置起本仓
  `packages/opencode/src/index.ts run`(与打包 sidecar 同一份 v1 装配)打到测试进程里的假上游:
  有徽标 ⇒ chip 每一档的主请求体带推理参数且 `reasoning_effort` 值逐字对上;无徽标 ⇒ 零档且默认
  请求不带。未修的树上它点名 5 行红(见 PR `#1266` 正文的变异输出)。
- **`zhipuai-byok/glm-4.5-air`(`#1267`,2026-09-06 已修)**:它是 BYOK-only 的 id,平台目录没有同名
  条目可派生,而 BYOK 目录 `models` 曾是纯 `string[]`,没有逐模型元数据槽 ⇒ 无徽标、零档,而上游
  `transform.options()`(`transform.ts:1184-1192`)对 `providerID` 含 `zhipuai` + `@ai-sdk/openai-compatible`
  **无条件**写 `thinking: { type: "enabled", clear_thinking: false }`。修法是目录 schema 扩面:
  `byokProviders[].modelMeta[<id>]`(`shared/alpha-model-types.ts` `ByokModelMeta`),仍由同一个
  `byokModelMeta` 派生(显式槽优先于平台同名条目;两者不得同时存在,alpha-models 套件钉着)。glm-4.5-air
  现在标徽标并给 `开` / `关` 两档:`开 = { thinking: { type: "enabled" } }`、`关 = { thinking: { type: "disabled" } }`,
  经 `request.ts:95` 的 mergeDeep 与上游默认合成 `{ type, clear_thinking: false }` 原样进请求体(假上游捕获实证)。
  原先 `KNOWN_UNFIXED` 登记已按其过期断言删除;判据扩为「显式关闭档 ⇒ 请求体 `thinking.type` 逐字 `disabled`
  且零推理控制参数」,并新增一条手段自证:硬塞不存在的档 ⇒ 上游默认 `enabled` 原样出现,交给「关」档判据必红。

## 5. 智谱直连对 `thinking.type` 的真实受理(2026-09-06 实打,`glm-4.5-air`)

`#1267` 的两条修法都要把 `thinking: { type: "disabled" }` 这个**上游 wire 形状**写进 alpha 自有文件;本 portfolio
记录在案最贵的返工形态就是「手写一个别人文法的替身」,所以先实打再落笔。`POST https://open.bigmodel.cn/api/paas/v4/chat/completions`,
`model: glm-4.5-air`,`max_tokens: 128`,同一句提问,只变 `thinking`(`clear_thinking: false` 随行,与引擎实际发出的一致):

| 发出的 `thinking` | HTTP | `message` 键 | `reasoning_content` | `completion_tokens` | `finish_reason` |
| --- | --- | --- | --- | --- | --- |
| `{ type: "enabled", clear_thinking: false }` | 200 | content / reasoning_content / role | 249 字 | 128 | `length`(全花在思考上,正文为空) |
| `{ type: "disabled", clear_thinking: false }` | 200 | content / role | **无** | 4 | `stop`(正文「等于2。」) |
| `{ type: "bogus", clear_thinking: false }`(已知的坏) | **200** | content / reasoning_content / role | 260 字 | 128 | `length` |

三条结论:①`disabled` **真的**关掉思考(无 `reasoning_content`,token 128 → 4);②`type` 写错**不报错**,上游静默
回落到思考 —— **HTTP 200 不是受理证据**,`reasoning_content` 有没有才是;③因此目录里的关闭档值必须逐字 `disabled`,
alpha-models 套件钉住每个 `thinking.type ∈ {enabled, disabled}`(变异实测:写成 `disable` 当场红)。
端到端复核:用生产 `buildAlphaModelConfig` 的配置起本仓引擎 `run --model zhipuai-byok/glm-4.5-air`,默认 / `--variant 开` /
`--variant 关` 三次都 rc=0 并拿到回答(3.5 s / 3.0 s / 2.4 s)—— 引擎实际发出的三种请求体上游都受理。
- **未验**:`deepseek-v4-pro` 直连与平台节点收到 `reasoning_effort: max` 的真实受理情况(无凭据;
  `#1239` 只对智谱回放过 `max`)。

## 8. 追记(2026-09-06 同日,`#1237`):黑名单模型的档位 —— 形状逐腿取自实打表,未实打的钉在无档

§7 说「档位的唯一 alpha 侧来源是 `alpha-models.json` 的 `variants`」。`#1237` 给上游黑名单族
(`transform.ts` `variants()` 的 `glm && !glm52` / `qwen`)里的三个平台模型补上档位,但**形状不是照
`reasoningEffort` 套的** —— 本票 v1 正是那样写的,被两条实测推翻后作废重写:网关曾整个丢掉推理字段
(`alpha-platform#423`,已修),智谱直连对非 5.2 的 GLM **不校验** `reasoning_effort`(`bogus-value`
照样 200,`none` 仍满额思考)。**受理 ≠ 有效**,且**同一模型经直连与经 OpenRouter 的受理面不同**。
逐格读数与网关的判定表(`VERIFIED_REASONING_WIRE`)都在
`alpha-platform/docs/architecture/openai-wire-reasoning-controls.md`(下称 DOC);这里只记桌面侧
据此做的决定。

### 8.1 桌面侧档位表(引擎 `<providerID>:<modelID>` → 形状 → 出处)

| 引擎 id | 走哪条腿 | 档位(逐字) | 出处与效果 |
| --- | --- | --- | --- |
| `alpha:glm-5-turbo` | `zhipu:glm-5-turbo`(`models.config.json` 首腿;OR 腿不认 `thinking` 形状 ⇒ 声明档位时被网关剔除,不换路) | `关 = {thinking:{type:"disabled"}}` · `开 = {thinking:{type:"enabled"}}` | DOC §3.2:`disabled` → reasoning_tokens **0**(非流式 completion=4;流式 4 帧无 reasoning delta),`enabled` → 182;`reasoning_effort` 在此腿 accepted-and-ignored(`bogus-value` → 200,`none` 仍 224)⇒ 网关拒转 ⇒ 桌面不用它 |
| `alpha:qwen3.7-max` | `openrouter:qwen/qwen3.7-max`(唯一腿) | `关 = {reasoningEffort:"none"}` · `开 = {reasoningEffort:"medium"}` | DOC §3.4 + §8.2:`bogus-value` → 400(OR 真校验);`none` → **0**(3/3);low/medium/high/max 与 baseline 无差别 ⇒ 只声明开/关 |
| `alpha:qwen3.7-plus` | `openrouter:qwen/qwen3.7-plus`(唯一腿) | 同上 | 同上 |
| `zhipuai-byok:glm-4.5-air` | zhipu 直连(`modelMeta` 槽,§5 / `#1267`) | **顺序改为** `关` / `开`(值不变) | 见 §8.3:上游把档位表第一项喂给辅助调用 |

不动的行(`#1266` 已声明,出处同 DOC):`alpha:claude-opus-4.8`(OR anthropic-wire `reasoning.effort`
低/中/高)、`alpha:gpt-5.4-mini|nano`(OR `reasoning_effort` 低/中/高)、`alpha:deepseek-v4-pro` 与其直连派生
`deepseek-byok:deepseek-v4-pro`(两腿 `reasoning_effort` 七值校验,`none` 真关)、`alpha:glm-5.2` 与其直连派生
`zhipuai-byok:glm-5.2`(`reasoning_effort` 高/最高:直连**受理已验、效果未证** —— DOC §3.1 `none` 仍 171、`max`=307
非单调;OR 腿 `none`=0)。**`zhipuai-byok:glm-5.2` 的高/最高在直连上是一份被受理但未证有效的表**,本票不改它,
记在这里等 owner 裁决要不要像 turbo 一样换成 `thinking` 开/关。

### 8.2 qwen 经 OpenRouter 的复打(本票,2026-09-06,N=3)

DOC §3.4 对 qwen 每档只有单样本且 `high`/`medium`/`max` 撞到 256 上限。本票用仓内 `OPENROUTER_API_KEY`
(owner 授权)复打:`max_tokens` 2048、同一道需要推理的题(三管注水,答 `36/7`)、**每发都带 `top_p: 1`**
(引擎对 qwen 实际就发这个,基线 §3.8b 要验的组合)、并发 3。先自检:坏 key → 401「User not found」,
`bogus-value` → 400「reasoning_effort: Invalid option: expected one of "max"|"xhigh"|…」(两模型文案逐字同)。

| model | effort | reasoning_tokens ×3 | completion ×3 | finish | 答对 |
| --- | --- | --- | --- | --- | --- |
| `qwen/qwen3.7-max` | (none) | 252 / 281 / 288 | 259 / 288 / 295 | stop | 3/3 |
| `qwen/qwen3.7-max` | `none` | **0 / 0 / 0** | 4 / 5 / 4 | stop | 2/3(一次答 36/17) |
| `qwen/qwen3.7-max` | `low` | 289 / 284 / 308 | 296 / 291 / 315 | stop | 3/3 |
| `qwen/qwen3.7-max` | `medium` | 277 / 248 / 301 | 284 / 255 / 308 | stop | 3/3 |
| `qwen/qwen3.7-max` | `high` | 279 / 266 / 282 | 286 / 273 / 289 | stop | 3/3 |
| `qwen/qwen3.7-max` | `max` | 296 / 255 / 252 | 303 / 262 / 259 | stop | 3/3 |
| `qwen/qwen3.7-plus` | (none) | 340 / 315 / 325 | 347 / 322 / 332 | stop | 3/3 |
| `qwen/qwen3.7-plus` | `none` | **0 / 0 / 0** | 4 / 4 / 4 | stop | 0/3(三次答 36/5) |
| `qwen/qwen3.7-plus` | `low` | 332 / 294 / 270 | 339 / 301 / 277 | stop | 3/3 |
| `qwen/qwen3.7-plus` | `medium` | 322 / 347 / 268 | 329 / 354 / 275 | stop | 3/3 |
| `qwen/qwen3.7-plus` | `high` | 323 / 347 / 333 | 330 / 354 / 340 | stop | 3/3 |
| `qwen/qwen3.7-plus` | `max` | 328 / 329 / 290 | 335 / 336 / 297 | stop | 3/3 |

结论(只写读数支持的部分):①`reasoning_effort` + `top_p:1` 30/30 受理(§3.8b 那格对 qwen 关闭);
②`none` 真关,而且关掉之后**答案质量可见地掉**(plus 3/3 答错)—— 这是用户选「关」时该知道的代价;
③其余四档与 baseline 在 N=3 下无可分辨差别 ⇒ **不声明 低/中/高**,只声明 关/开;`开` 取 OR 校验域内的
`medium` —— 它与其它三档、与不带字段在观察上等价,选它只是为了让「开」是一个显式的、被校验过的值,
不是在断言 medium 比 low 更努力。原始 JSONL 在本机取证目录,不含 key。

### 8.3 辅助调用取档位表第一项 —— 「关」必须排第一(基线 §3.8a 的实证)

`session/llm/request.ts:88-89` 对 `input.small` 的辅助调用(标题)走 `transform.smallOptions()`,首行
`Object.values(model.variants ?? {})[0]` —— **取档位表第一项,与用户选档无关**。用生产 `buildAlphaModelConfig`
起本仓引擎打到假上游,每次 run 捕到两条 POST(主请求 + 标题),8/8 次都捕到:

| run | 主请求体 | 标题请求体 |
| --- | --- | --- |
| `alpha/glm-5-turbo`(默认) | 零推理键 | `thinking:{type:"disabled"}` |
| `alpha/glm-5-turbo@关` / `@开` | `thinking.type` = `disabled` / `enabled` | `thinking:{type:"disabled"}` |
| `alpha/qwen3.7-max`(默认) | 零推理键,`top_p:1` | `reasoning_effort:"none"`,`top_p:1` |
| `alpha/qwen3.7-max@关` / `@开` | `reasoning_effort` = `none` / `medium` | `reasoning_effort:"none"` |

所以目录里凡有显式关闭档的模型,「关」一律放第一位:标题不思考。`#1267` 的 `glm-4.5-air` 原来是 `开`/`关`
⇒ 标题调用带 `thinking:enabled`(与上游对 zhipuai 的无条件默认相同,所以此前没有可观察的退化);本票调成
`关`/`开`,chip 顺序随之变。`alpha:glm-5.2`(高/最高)没有关闭档,标题调用带 `reasoning_effort:high` ——
基线 §3.8a 表里的 ❌ 行**仍在**,本票不动(要动就是给 5.2 加关闭档,那是另一张票的形状决定)。

### 8.4 未实打 ⇒ 显式无档(不是「没顾上」)

`minimax-byok:MiniMax-M2`、`alibaba-byok:{qwen3.8-max, qwen-plus, qwen3-coder-plus}`、
`moonshot-byok:{kimi-k3, kimi-k2.6}`(#1281:原 kimi-k2 / moonshot-v1-128k 上游已退役):本机没有 `MINIMAX_API_KEY` / `DASHSCOPE_API_KEY` /
`MOONSHOT_API_KEY`(alpha-platform `.env` 与 owner 本轮提供的 key 里都没有),一格没打。**不凭 models.dev 或
官网文案推断** —— 那正是 v1 作废的形态。alibaba 还有第二层:上游 `enable_thinking` 只对
`providerID === "alibaba-cn"` 严格等号写,`alibaba-byok` 永不匹配,猜着发会让整个节点报错(票面 Out of scope)。
换一台有 key 的机器照 DOC §3 的方法打一轮即可补表。

### 8.5 判据

- `packages/ui-mac/src/main/alpha-models.test.ts` 的 `#1237` 节:`VERIFIED_TIERS`(键 = 引擎侧 id,值 = 逐字档位表
  + 腿 + 出处)与 `UNVERIFIED_TIERLESS`;判官是纯函数,对生产 `buildAlphaModelConfig` 的产物判 ——
  表外声明即红、注入与表不逐字相等即红、无档清单里的模型必须**真的被注入且**无徽标无档(空集不算)、
  有关闭档而关不在第一位即红、表登记的档位从注入里消失即红。手段自证五种已知的坏各自点名(v1 的 GLM
  `reasoningEffort` 形状 / 给 MiniMax 补档 / 关档值写成 `off` / 开排第一 / 退回无档)。
- `alpha-reasoning-badge-parity.test.ts`:新三行由矩阵原判据逐档覆盖(主请求体 `thinking.type` /
  `reasoning_effort` 逐字对上);新增**标题辅助调用**判据 —— 有徽标的每一行,默认 run 的标题体必须带第一档;
  手段自证把 qwen「开」档的主请求体冒充标题体 ⇒ 点名 `medium ≠ none`。
