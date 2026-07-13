---
id: ADR-012
title: ui-mac 发布默认 prod 渠道;dev/beta 保留不删、非默认
status: accepted
date: 2026-06-18
related: [ADR-003, ADR-006]
---

## 背景
ui-mac 沿用 opencode `packages/desktop` 的三渠道(channel)发版模式:`CHANNEL = dev|beta|prod`(`src/main/constants.ts` / `scripts/utils.ts`),按渠道切图标(`icons/{dev,beta,prod}`)、app 名与 appId(prod=`ai.opencode.desktop`/"OpenCode";非 prod 加后缀如 `ai.opencode.desktop.dev`/"OpenCode Dev")、更新器(`UPDATER_ENABLED = CHANNEL !== "dev"`)、发布目标(beta/prod 各自 GitHub repo)。

**关键澄清(此前易混淆)**:这三个是**同一份 `alpha` 代码打包出的三个 app 版本**(只图标/名字/更新器不同),属**打包渠道**;与 `dev` **git 分支**(上游只读镜像,见 [[ADR-005]])是**两个正交概念**,仅碰巧都叫 "dev"。**自有代码只在 `alpha`**。单人只发一个 app(无 dev 模式、单一 Spotlight 入口),不需要多渠道。

## 决策
1. **正常发布 = prod**:`ship:mac` 发布意图固定 prod(`OPENCODE_CHANNEL=prod`,或等价 `latest`)。
2. **dev/beta 机制保留、不删**:渠道代码与 `icons/{dev,beta}` 全留(零成本休眠),仅非默认、不主动维护多渠道发布;将来要 beta 测试可随时启用。
3. **不删的理由**:删 = 无收益 churn(动 `constants.ts`/`copy-icons`/`copy-metainfo`/electron-builder + 删图标);留着不碍事,还保留未来选项。

## 后果
- ✅ 实际只发一个 app,落实"单一环境"(见 NON_GOALS「不引入的技术」);零改 upstream。
- ✅ 厘清「分支(代码版本)≠ build 渠道(app 版本)」,消除混淆。
- ⚠️ **代码默认 channel 仍是 `dev`**(`resolveChannel()` 未设 env 时回退 dev)。本 ADR 只定"发布走 prod"的策略,**未改**默认回退;真正发布时须由脚本/env 显式置 prod。若日后想让 prod 成为代码级默认,再单独改 `utils.ts`/`constants.ts` 并记一条修订。

## ✅ 已解决(2026-07-03,PR #32)—— 原「已知问题 / 待办(2026-06-24)」
按下方**待办①**落地:prod/beta `productName` → `alpha-code`;appId → **`com.tide.alphacode`**(非原提议的 `ai.opencode.desktop`,改取 tideapp 的 `com.tide.*` 约定);`install-local.ts` 改为按 `OPENCODE_CHANNEL` 解析 app 名/appId(不再写死 dev);updater feed → `jinjunnn/alpha-code`(B9,不再指 anomalyco)。`OPENCODE_CHANNEL=prod ALPHA_SIGN=1 … package:mac` 已端到端出**签名+公证** dmg 并发 **v0.1.0**(见 `docs/runbooks/distribution.md`)。**现在 ship/package 带 `OPENCODE_CHANNEL=prod` 是正确的**(旧「ship 不要带 prod」告诫作废)。下方保留历史。

### 历史(2026-06-24 实测 ship 暴露,已解决)
**"发布走 prod"从未接到品牌层,且 install-local 写死 dev 命名 —— 当前能产出 alpha 品牌 app 的反而是 `dev` 渠道。**
- `electron-builder.config.ts` 的 `productName`:**仅 `dev` 渠道 = `"alpha-code"`**;`prod` 仍是 `"OpenCode"`、`beta` 是 `"OpenCode Beta"`(品牌 rebrand 没覆盖 prod/beta)。
- `scripts/install-local.ts` **写死** `SRC=dist/mac-arm64/alpha-code.app`、`DEST=/Applications/alpha-code.app`、`APP_ID=ai.opencode.desktop.dev` —— 全是 **dev** 渠道命名。
- 后果:`OPENCODE_CHANNEL=prod bun run ship:mac` 会打出 `OpenCode.app` → install-local 找不到 `alpha-code.app` → **install 步失败**(实测)。**当前可用的 ship = 默认(dev)渠道**,产出 `alpha-code.app`(appId `ai.opencode.desktop.dev`),与 install-local 一致。
- **本轮 ship(2026-06-24)即用默认 dev 渠道成功**,装到 `/Applications/alpha-code.app`。
- **待办(二选一,改前确认)**:① 把 `prod` 渠道 `productName` 也 rebrand 成 `"alpha-code"`、appId 用 `ai.opencode.desktop`,并改 `install-local.ts` 按 `resolveChannel()` 算 app 名(不写死),真正落实"发布走 prod";或 ② 接受现状、把本 ADR 的"发布走 prod"改为"发布走默认(dev 渠道=alpha-code 品牌)",消除策略与代码的矛盾。**在没做①之前,ship 不要带 `OPENCODE_CHANNEL=prod`。**
