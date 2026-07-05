---
id: REQ-029
title: composer effort 接入 model variants:逐模型参数档 + B 侧透传核实 + chip 驱动
type: feature
priority: P2
status: registered
repo: X
created: 2026-07-05
sprint: —
source: C28 拍板(2026-07-05,S17 T4)拆出
---

## 背景(为什么)
C28 实证:EffortChip 纯本地 signal 零引擎接线(选什么都不影响推理)→ 按拍板「改文案保留」,popover 已明示「预设 · 暂未接入」。**真通道已实证存在**:引擎 `llm/request.ts:80-91` 把 `model.variants[user.model.variant]` merge 进请求 options;上游有 `model.variant.cycle` 命令与 picker variant 层。缺口 = 当前 alpha 代理/BYOK 模型的 provider config **均未定义 `variants`** → 机制空转。

## 范围
1. **variants 定义**(A):alpha 自建 provider config(`buildAlphaModelConfig`)逐模型定义低/中/高/超高 → 对应 thinking/reasoning 参数(DeepSeek reasoner / Claude thinking budget / GPT reasoning_effort 等,逐模型核实参数名);
2. **B 侧透传核实**(B,硬前置):网关代理是否透传 thinking/reasoning 类 options → 不透传则先补透传或如实缩小支持面;
3. **chip 驱动**(A):EffortChip 接真状态(驱动/观察 `model.variant.cycle` 或 picker variant 层),移除「暂未接入」文案;home 无 session 态的行为定义。

## 验收标准
1. 选「高/超高」后请求**实际携带**对应参数(网关日志或 usage `reasoning` 计数出数,非 UI 自嗨);
2. 不支持 variants 的模型:chip 诚实降级(隐藏或禁用,不假装可选);
3. BYOK 直连与平台代理两路径都实测;
4. B 侧不透传的参数如实呈现为不支持。

## 非目标
真只读(→ [[REQ-028]]);自建第二套推理参数面(只走引擎 variants 原语)。

## 关联
[[C28]](拍板来源)· [[REQ-001]](模型白名单/edition)· B 仓网关 · debates/2026-07-05-c28-honest-controls-brief.md(F4b 实证)。

## 验证记录
_verify 时补。_
