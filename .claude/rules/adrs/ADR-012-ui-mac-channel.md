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
