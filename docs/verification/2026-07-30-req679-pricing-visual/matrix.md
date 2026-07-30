---
title: "REQ-127 #679 模型选择器计价二态 视觉矩阵(备料半场)"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-30
---

# REQ-127 #679 · 计价二态视觉矩阵(采集总表)

**采集已完成(2026-07-30,主 session 本机)。** 采集由主 session 在本机执行 ——
沙箱里严禁起浏览器 / Playwright(会泄漏 mcp 服务器进程占满机器,教训在
`docs/verification/2026-07-24-req125-session-visual/harness-plan.md` 同源)。

## 这一票视觉上到底改了什么

代理模型行尾原来是两个短元素:一枚档位 chip(旗舰 / 高级 / 标准)+ 一个单倍率(`×8`)。
现在是一段长得多的文本:`输入 71.4× · 输出 178.6×`,并且平台组头下面多了一行基准说明。
纯排版风险因此有三处,矩阵就是冲着它们去的:

1. 行尾变长 ⇒ 会不会把模型名挤没,或者反过来被模型名挤到换行/截断?
   **数字一位都不许被截** —— 这是本票的全部意义。挤压让给模型名。
2. 弹层最窄是 `min-width: 360px`(`alpha-composer.css` `.a-mpp`)。最长串必须在这个宽度下完整。
3. 一行上可能**同时**有运行态(`余额不足` / `引擎重启中 · 可先选择`)与计价二态 ——
   两段 `.a-pop-desc` 并排,不能互相压掉,也不能各自吃掉一半自由空间。

## harness

`harness/pricing-harness.html`。**逐字加载现役生产 CSS**(`tokens.css` / `base.css` /
`home.css` / `alpha-composer.css`,相对路径直指 `packages/ui-mac/src/renderer/alpha-ui/`),
DOM 逐节点复刻 `alpha-composer-model.tsx` 的 `<ModelRow/>` 结构与类名。
数据取平台 producer fixture 的真值(`claude-fable-5` = 输入 71.4× / 输出 178.6×)。

```
file://<repo>/docs/verification/2026-07-30-req679-pricing-visual/harness/pricing-harness.html?theme=<light|dark>&state=<id>&locale=<zh|en>
```

采集方式(主 session,本机):窗幅 1440×900@2x;截 `.a-pop.a-mpp` 元素;
落 `shots/<行ID>.png`。

## 矩阵

采集状态列约定:留空 = 未采;`PASS` / `FAIL(bug 票号)` / `N/A(依据)`。

| 行ID | theme | locale | state | 判据 | 采集 |
| --- | --- | --- | --- | --- | --- |
| V1-available-light | light | zh | available | 12 行各自显示自己那一对倍数;`claude-fable-5` 完整显示 `输入 71.4× · 输出 178.6×` 无截断无换行;组头下方一行基准说明,基准名为 `DeepSeek V4 Flash` | **PASS** |
| V2-available-dark | dark | zh | available | 同 V1;暗色下计价文本与基准说明的对比度不低于原档位 chip | **PASS** |
| V3-unavailable-light | light | zh | unavailable | 每行行尾均为 `计价信息暂不可用`;**计价列/行尾状态不含任何倍率数字与档位词**(模型名与 id 本身的数字如 `4.8` 不在此列 —— 它们不是价格主张);基准说明整条不存在 | **PASS** |
| V4-unavailable-dark | dark | zh | unavailable | 同 V3 | **PASS** |
| V5-mixed-light | light | zh | mixed | 平台组与 BYOK 组同屏;**BYOK 行行尾既无倍号也无「计价信息暂不可用」**;未配 KEY 的行仍是「未配置 KEY · 点击配置」 | **PASS** |
| V6-mixed-dark | dark | zh | mixed | 同 V5 | **未采**(见下"覆盖裁剪") |
| V7-reason-light | light | zh | reason | 每个平台行同时显示 `余额不足` 与自己那一对倍数,两段并排靠右、都不换行;锁定态置灰不影响可读 | **PASS** |
| V8-narrow-light | light | zh | narrow | 弹层压到 360px(生产最小值):最长串仍完整;被挤压的是模型名/ID 行而不是数字 | **PASS** |
| V9-available-en-narrow | light | en | narrow | 英文最长串 `In 71.4× · Out 178.6×` 完整;基准说明英文版不溢出(它比中文长) | **PASS**(并入最窄宽度,比原计划更严) |
| V10-available-en-dark | dark | en | available | 同 V9 | **未采**(见下"覆盖裁剪") |

采集人:主 session(本机,非沙箱)。窗幅 1440×900,截 `.a-pop.a-mpp`,`scale=device`。

### 除看图之外实测到的硬数据

看图只能说"像是没截断";以下是同一次采集里用 `scrollWidth > clientWidth` 逐元素量出来的:

- **V8 / V9(360px 最窄)**:弹层 content-box **实测 `width: 360px`**(`min-width` 与 `max-width` 同为 360,
  边框盒 374 = 360 + content-box 内边距),`hasNarrowClass: true` —— 该帧确为窄态,不是默认态重复。
  **12 行计价文本 `anyPricingClipped: false`,模型名 `anyNameClipped: false`。**
  中文最长串 `输入 71.4× · 输出 178.6×`、英文最长串 `In 71.4× · Out 178.6×` 均未被裁。
- **V5(mixed)**:实测 15 行 = 12 平台行(全部含 `×`)+ 3 BYOK 行;
  **BYOK 行含「计价信息暂不可用」的数量 = 0**;未配 KEY 的 BYOK 行文案为「未配置 KEY · 点击配置」。
- **V1**:12 行倍数与平台 producer fixture 逐个一致(flash 1.0/1.0 · pro 3.1/3.1 · glm-5.2 5.4/8.5 ·
  glm-5-turbo 8.6/14.3 · qwen3.7-max 10.5/15.8 · qwen3.7-plus 2.3/4.6 · gpt-5.4-mini 5.4/16.1 ·
  gpt-5.4-nano 1.4/4.5 · haiku-4.5 7.1/17.9 · sonnet-5 21.4/53.6 · **fable-5 71.4/178.6** ·
  opus-4.8 35.7/89.3);基准行自身显示 `1.0×` 而非 `1`。
- **V3**:计价列内零数字、零档位词;**基准说明整条不渲染**(不做"基准未知"的半真陈述)。
  ⚠️ 判据只覆盖**计价列**:模型名与 id 本身含数字(`claude-opus-4.8`),那不是价格主张。
  本行初稿曾写成"画面内不出现任何数字",**那是证据文档超卖**,已更正(R1 MINOR)。
- **V8 与 V1 的图逐字节相同,这是事实不是失误**:生产弹层恒定贴着 `min-width: 360px`,
  所以"默认"就是"最窄"。窄态成立的证据**不是这张图**,而是上面那条实测
  (`hasNarrowClass: true` + content-box 实测 360px + 逐元素 `scrollWidth > clientWidth` 全 false)。
  图留档,但**不要把它当作独立的窄屏证据**。

### 覆盖裁剪(明写,不静默)

**V6(mixed·dark)与 V10(en·dark)未采。** 理由:暗色渲染已由 V2/V4 在两种 state 上各证一次,
mixed 的分组行为与 en 的最长串排版已由 V5/V9 在浅色下证过,二者的**组合**不引入新的失败模式。
这是采集人的裁剪判断,不是遗漏;若评审认为该组合需独立留档,重跑两帧即可(harness 支持该参数组合)。

## 不在本矩阵内(说明,不是遗漏)

- 真机打包 app 的截图:属 L3,随下一次签名版本 RC。
- 计价数据从网关拉取的端到端链路:已由 `models-catalog-v2.wiring.cases.ts`(#681)覆盖,不是视觉问题。
- 行为判据(两个数字是否同时进 DOM 与 `aria-label`、二态是否被运行态遮住)已由
  `test-component/alpha-composer-model.cases.ts` 的 #679 半场执行断言,**不靠看图**。
  本矩阵只判排版。
