# 直连 BYOK 腿的输出上限 —— 上游自报 + 实打受理

*2026-09-07 · REQ-156 · owner 授权实打(总生成 69 个 output token)*

判的是一件事:**每个直连 BYOK 模型,`max_tokens` 最大能发到多少。**

## 为什么必须实打,而不是抄文档页

REQ-153 基线 §1.2 记录过:「10 条直连腿的上限本机结构性探不了」—— 当时本机一把 provider key
都没有,基线因此**只采信 vendor 页当日实读,并按单渠道读数标注**。

那一条现在不成立了:本机 `alpha-secrets/` 里有 `ZHIPU_API_KEY` 与 `DEEPSEEK_API_KEY` 两把真实凭据。
而实打立刻推翻了文档页:**DeepSeek 端点自报 `393216`,而 vendor 定价页写的是「384K」、OpenRouter
目录写的是 `384000`。** 393216 = 384 × 1024;文档页那个「384K」是**四舍五入到千的口语值**,不是
端点的判据。抄它会永远少 9216。

同源的第二条:`glm-4.5-air` 是 **98304**,不是 glm-5.2 的 131072。同一个 provider 下的两个模型
上限不同 —— 任何「按 provider 发一个数」的修法都会在 air 上打出硬 400。

## 判据(三点,缺一不可)

| 探针 | 期望 | 它证明什么 |
| --- | --- | --- |
| `max_tokens: 99999999` | **400**,且错误正文里带合法区间 | 上游**自报**上限。零 token 生成 ⇒ 零费用 |
| `max_tokens: <自报值>` | **200** + `finish_reason=stop` | 那个数**真的被受理**,不只是「没被拒」 |
| `max_tokens: <自报值>+1` | **400** | 边界**就在**那个数上,不是探针恰好没碰到 |

第一点单独不成立:一个恒 400 的探针分不出「上游拒绝」与「探针自己坏了」。②③ 是它的自检 ——
**先证明这个手段能测出已知的坏(+1 必红),再用它判未知的好。**

原始输出见 [`results.txt`](results.txt),探针见 [`probe.py`](probe.py)(读本机 `alpha-secrets/`,不含任何密钥字面量)。

## 结果

| 引擎 provider | 模型 | 上游自报 & 实测受理 | 改前实发 | 倍数 |
| --- | --- | --- | --- | --- |
| `zhipuai-byok` | `glm-5.2` | **131072** | 32000 | 4.1× |
| `zhipuai-byok` | `glm-4.5-air` | **98304** | 32000 | 3.07× |
| `deepseek-byok` | `deepseek-v4-flash` | **393216** | 32000 | 12.3× |
| `deepseek-byok` | `deepseek-v4-pro` | **393216** | 32000 | 12.3× |

「改前实发 32000」的来源:`transform.ts:18` `OUTPUT_TOKEN_MAX = 32_000`,经
`maxOutputTokens = Math.min(model.limit.output, cap) || cap`,而 config 声明的模型 `limit.output`
缺省为 0 ⇒ `Math.min(0, 32000) = 0 || 32000`。定位过程见基线 §1.1。

## 第一个前提:裸 body 量出来的数,在**生产 body** 上还成立吗

对抗审计(2026-09-07)开的唯一一条 Major:上面那组探针发的是裸 body(`{model, messages,
max_tokens, stream}`),而 `transform.ts:1202-1209` 对 `providerID.includes("zhipuai")` +
openai-compatible 的模型**无条件**写 `thinking: { type: "enabled", clear_thinking: false }` ——
`zhipuai-byok` 命中,**默认档就到得了**。若 thinking 模式下 `max_tokens` 的合法区间不同,
glm 两个模型改完之后**每一发都是硬 400**,而改动前的 32000 不会。

这条 finding 是对的形状:**「在这个 body 上测出来」≠「在生产那个 body 上成立」。**
补测([`probe-thinking.py`](probe-thinking.py)):

```
glm-5.2      thinking:enabled  @131072 → HTTP 200  finish=stop
glm-5.2      thinking:enabled  @131073 → HTTP 400  限制数值范围[1,131072]
glm-4.5-air  thinking:enabled   @98304 → HTTP 200  finish=stop
glm-4.5-air  thinking:enabled   @98305 → HTTP 400  限制数值范围[1,98304]
```

**区间一模一样** —— `thinking` 不参与 `max_tokens` 的校验。读数在生产 body 下成立。
(DeepSeek 侧 harness 不写 thinking 类字段,裸 body 本身就更接近它的生产形状。)

## 第二个前提:`max_tokens` 是上限,不是预留

抬输出上限有一个**会把长会话变成硬 400** 的失败形态,必须单独证伪:如果上游校验的是
`prompt_tokens + max_tokens ≤ 上下文窗口`,那么 `glm-5.2`(上下文 202752、输出上限 131072)
只要 prompt 超过 71680 token,顶格发 131072 就会被拒 —— 而改动前发 32000 不会。
**「上限抬了」和「长会话还能用」是两件事。**

实测([`probe-context.py`](probe-context.py),2026-09-07):

```
prompt ≈ 80020 tokens + max_tokens=131072 = 211092  >  上下文 202752
→ HTTP 200  prompt_tokens=80020 completion_tokens=15 finish=stop
```

**上游受理。** 智谱把 `max_tokens` 当作输出的**上限**,不当作要从上下文里扣掉的**预留**。
DeepSeek 侧不存在这个问题:它的上下文是 1048576,393216 装得下(且顶格探针在小 prompt 下
已 200,说明它同样不做这项校验)。

⚠️ 这条只对**本次实读的这四个模型**成立。将来给 UNREAD 里的模型补读数时,这一问要重问一遍。

## 没量到的 6 个

`MiniMax-M2`、`qwen3.8-max`、`qwen-plus`、`qwen3-coder-plus`、`kimi-k3`、`kimi-k2.6`
—— 本机没有这三家的凭据,探不了。它们**保持 32000 不动**(少发不会错,多发是硬 400),并显式登记在
`byok-output-cap.ts` 的 `BYOK_OUTPUT_CAP_UNREAD` 里。要抬它们,需要 owner 提供对应的 key,
之后照本文档同一套三点探针重跑即可。

## 剩下 6 个:网查结论(2026-09-07,owner 授权按网查填)

owner 指出这些是**给第三方用的** —— 凭据本来就不在我们手上,不能拿"没 key"当停在 32000 的理由。
于是改用网查。先说手段的自检:**无 key 探针在这三家都无效** —— 合法与非法 `max_tokens` 回一模一样的
401(三家都先校鉴权后校参数),所以那是**探针瞎了**,不是"参数没问题"。

网查结果按原因分成三类,**「没量」不是同一件事**:

| 模型 | 结论 | 处置 |
| --- | --- | --- |
| `MiniMax-M2` | OpenRouter 目录 `minimax/minimax-m2` `max_completion_tokens=131072`(ctx 204800) | **已填 131072,标 `catalog` 级** |
| `kimi-k2` | **上游已退役** —— vendor 一手文档:kimi-k2 系列 2026-05-25 停用,调用返回 404 | 不需要上限,需要下架 → `#1281` |
| `moonshot-v1-128k` | **上游已退役** —— 同页:moonshot-v1 系列 2026-08-31 退役,调用返回 404「模型不存在」 | 同上 → `#1281` |
| `qwen3.8-max-preview` | 阿里当前清单**未列出**该 id(在列的是 `qwen3.8-max`) | id 待核实 → `#1281` |
| `qwen-plus` | 文档只给上下文(1M),**未公布最大输出**;目录无同名条目(滚动别名) | 停在 32000,等凭据 |
| `qwen3-coder-plus` | 同上 | 停在 32000,等凭据 |

### 为什么 MiniMax 用目录读数,而这不是双标

`probed` 与 `catalog` 是**两级证据**,代码里分字段记着,测试锁着不许混同。用 `catalog` 的风险是
**单向**的:目录值若**高于**端点真实上限 ⇒ 该模型每一发都是硬 400;低了只是输出短。

选 OpenRouter 目录而不是 vendor 文档页,理由来自 deepseek 那一课(`ap#426`):vendor 页给的是
口语值「384K」,目录给精确整数 384000,而端点自报 393216 —— **目录值低于端点自报**。
OpenRouter 要跨多家 provider 路由,公布的是**取底**后的值,结构上不会高于单一直连端点。
方向对我们有利。

拿到 `MINIMAX_API_KEY` 后照 [`probe.py`](probe.py) 跑三点探针,升级成 `probed`。

## 后续(2026-09-08,owner 裁决 #1281)

两个上游已退役的 id 已按 owner 裁决**替换成继任 id**(不下架):`kimi-k2` → `kimi-k3`、
`moonshot-v1-128k` → `kimi-k2.6`;`qwen3.8-max-preview` → `qwen3.8-max`(证据弱一档:只是
「当前清单里没有」,不是明文退役)。

并立了一道**持续判据**,让下次不必再靠人肉网查:`packages/ui-mac/scripts/verify-byok-catalog.ts`
(`alpha-check` 第 [11/11] 步)对**有 key 的** provider 拉 `GET <baseURL>/models`,断言目录里每个
id 都在上游在册清单中。三档结局照本仓 `#890` 形状:`0 已验证 / 1 真失守拦住 / 2 本次未验证不拦`,
未验证的 provider 与其每个 id 逐条点名。

可行性是勘破出来的,不是设想:2026-09-08 实打,智谱 / DeepSeek 的 `/models` 带 key 均回 200 并列出
真实 id。**替换后新 id 仍未被验证** —— 它们要等对应的 key 出现,那道判据当场给答案。

## 顺带的发现(不属于本仓)

**gateway 的两条 deepseek route 填的是 `384000`,比端点自报的 `393216` 低 9216。**
`ap#419` 的签核域原文写着依据是「vendor 定价页『MAXIMUM 384K』+ OpenRouter 目录 384000」——
两个渠道都是二手读数,而端点自己现在给出了精确整数。owner 的常设裁决是「全部 route 取上游允许的
最大值」,按这条,那两条 route 还差一次复签。已另开票,不在本仓处理。
