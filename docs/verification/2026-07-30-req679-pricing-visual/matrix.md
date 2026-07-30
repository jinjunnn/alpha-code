---
title: "REQ-127 #679 模型选择器计价二态 视觉矩阵(备料半场)"
kind: verification
status: draft
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-30
---

# REQ-127 #679 · 计价二态视觉矩阵(采集总表)

**备料半场产物:只建 harness 与矩阵,未采集任何截图。** 采集由主 session 在本机执行 ——
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
| V1-available-light | light | zh | available | 12 行各自显示自己那一对倍数;`claude-fable-5` 完整显示 `输入 71.4× · 输出 178.6×` 无截断无换行;组头下方一行基准说明,基准名为 `DeepSeek V4 Flash` | |
| V2-available-dark | dark | zh | available | 同 V1;暗色下计价文本与基准说明的对比度不低于原档位 chip | |
| V3-unavailable-light | light | zh | unavailable | 每行行尾均为 `计价信息暂不可用`;**画面内不出现任何数字与档位词**;基准说明整条不存在 | |
| V4-unavailable-dark | dark | zh | unavailable | 同 V3 | |
| V5-mixed-light | light | zh | mixed | 平台组与 BYOK 组同屏;**BYOK 行行尾既无倍号也无「计价信息暂不可用」**;未配 KEY 的行仍是「未配置 KEY · 点击配置」 | |
| V6-mixed-dark | dark | zh | mixed | 同 V5 | |
| V7-reason-light | light | zh | reason | 每个平台行同时显示 `余额不足` 与自己那一对倍数,两段并排靠右、都不换行;锁定态置灰不影响可读 | |
| V8-narrow-light | light | zh | narrow | 弹层压到 360px(生产最小值):最长串仍完整;被挤压的是模型名/ID 行而不是数字 | |
| V9-available-en | light | en | available | 英文最长串 `In 71.4× · Out 178.6×` 完整;基准说明英文版不溢出(它比中文长) | |
| V10-available-en-dark | dark | en | available | 同 V9 | |

## 不在本矩阵内(说明,不是遗漏)

- 真机打包 app 的截图:属 L3,随下一次签名版本 RC。
- 计价数据从网关拉取的端到端链路:已由 `models-catalog-v2.wiring.cases.ts`(#681)覆盖,不是视觉问题。
- 行为判据(两个数字是否同时进 DOM 与 `aria-label`、二态是否被运行态遮住)已由
  `test-component/alpha-composer-model.cases.ts` 的 #679 半场执行断言,**不靠看图**。
  本矩阵只判排版。
