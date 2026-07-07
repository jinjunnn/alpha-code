---
id: REQ-041
title: effort chip 对「上游英文 variant」模型失效(deepseek = cn 版默认模型:显示不符 + 切换失败)
type: bug
priority: P1
status: archived
repo: A
created: 2026-07-06
sprint: 2026-07-06-s20-realmachine-vnext
source: S20 真机批 finding F-2
---

## 背景/证据
S20 真机批(2026-07-06):deepseek-v4-flash(cn 版**默认**模型)的 effort chip 启用(title=「推理强度」非「不支持」)且显示「高」,但上游 `[data-action=prompt-model-variant]` 实际值 = 「low」→ **显示与引擎实际不一致**;点选任意档报「切换失败」。

根因:REQ-029 的 `EffortChip`(`composer-controls.tsx`)假设上游 variant 标签是 alpha 配置的中文 `低/中/高`(`alpha-models.json` 只给 claude-opus-4.8/claude-sonnet-4.6/gpt-5.4-mini 定义中文 variants)。deepseek 的 variants 来自**上游 opencode 模型定义、是英文 low/medium/high**——不在 `EFFORTS`(低/中/高/超高)集合 →
- `current()` 回退到默认 `effort()`=「高」(与引擎实际不符,破 REQ-029「观察源一致性」);
- `switchVariantTo(cmd,"高")` 逐 cycle 读英文标签、中文永不命中 → 转满一圈返 false → 「切换失败」。

实证:dev 下 deepseek-v4-pro variant trigger 文本 = `high`(英文);config/providers 含 low/medium/high token。影响一整类「上游提供 variant 且标签非中文」的模型;deepseek 是 cn 版默认模型 → cn 用户即见此不一致 + 无法切档。REQ-029 echo 实验只测了 3 个 alpha 中文 variant 模型,**漏了上游英文 variant 类**。

## 验收标准
1. 引擎 variant 英文标签(low/medium/high/max…)与 alpha 中文档(低/中/高/超高)**双向规范化**,chip 显示 = 引擎实际 variant(low → 显示「低」,不再回退默认档);
2. 点选某档:`switchVariantTo` 按规范化后比较 → 英文 variant 模型也能命中切换;模型确无该档 → 转满一圈**诚实失败**「该档不存在」;
3. 无法识别的档 → 显示原文(不假装成默认档);
4. alpha 配置的 3 个中文 variant 模型**不回归**;纯函数可单测。

## 处置(shipped,PR S20)
- 新增 `renderer/alpha-ui/variant-normalize.ts`(纯函数 `normalizeVariant` + `EFFORTS`/`Effort`,不引 Solid → 可单测);别名表:低/中/高/超高(自身)· low/minimal/min→低 · medium/mid→中 · high→高 · max/xhigh/highest→超高;
- `composer-controls.tsx`:`current()` 用 `normalizeVariant(label) ?? label ?? effort()`(显示规范化,未知显原文);`switchVariantTo` 按 `hit()`(原文相等 ‖ 规范化相等)比较;
- 单测 `variant-normalize.test.ts`(英文→中文/大小写/中文自身/同义词/未知→undefined);
- 零改上游。
- **真机确认**:dev deepseek-v4-pro variant=`high` → chip 显示「高」一致(修前 high∉EFFORTS 会回退);**switch 切换的打包态实拍**(多档模型 + 真 command 层)→ S20 重打包批。

## 关联
[[REQ-029]](effort variants 接真,本 REQ 补其英文标签盲区)· [[REQ-030]](cn 版默认模型 = deepseek)· audits/2026-07-06-s20-realmachine-vnext/verify.md §F-2。
