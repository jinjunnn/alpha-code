---
id: B20
title: 弱网降级 UX(中国区核心):超时/重试/状态/骨架/websearch 降级
type: ux
priority: P1
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.2 / R2(websearch 上游)
---

## 背景/证据
首条消息 send 无超时无 spinner,卡住只能重启;model/tool 错误(含 401)只显原始红卡无重试/重登 CTA;websearch keyless 限流时上游 `core/websearch.ts:244` orDie 硬失败(R2:上游,ADR-009 keyless-for-all 是放大器);60s splash 无状态文字;`Skeleton.tsx` 死代码,catalog 慢加载误显「无匹配模型」。

## 验收标准
1. 首条消息:超时 + spinner + 失败重试(部分已修 PR #24,补超时);
2. 401/model 错误卡片带行动 CTA(重试/重新登录);
3. splash 有阶段状态文字;picker 慢加载显真骨架而非误导空态;
4. websearch 限流优雅降级:env 关闸或自建 tool 替代(不裸 orDie 到用户);**含 ADR-009 🔭:keyless 限流行为运行时实测**;
5. 弱网模拟(限速/断网)走查主路径,无永久卡死。

## 关联
B11(底座,先做)、C20/C21(S8 同批)、REQ-003(流中断呈现联动)。
