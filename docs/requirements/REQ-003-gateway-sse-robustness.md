---
id: REQ-003
title: 网关 SSE 流式健壮性:卡顿 / 断连 / 重连 / 心跳审查与加固
type: debt
priority: P1
status: ready
repo: X
created: 2026-07-03
sprint: —
---

## 背景(为什么)
用户关注:llm gateway 的 SSE 是否可能卡顿,连接中断等常见问题如何优雅处理,是否有 harness 优化空间。涉及**两条 SSE 链路**:
1. **模型代理流式转发**(A → B 网关 → 上游 LLM):`docs/platform-integration.md` 约束要求「透明流式」,需审查 B 侧是否有缓冲导致卡顿、上游断流处理、超时策略、心跳;
2. **云任务事件流**(alpha-cloud-events):已知 **C23**——200 流无终态帧结束时无退避直接重连、终态帧缺 `event:` 字段被漏判 → 紧凑重连风暴、`lastId` 非数字 id 丢失、job 终态后 `subs` 泄漏 + 重订空转(NEW-2/3)。

## 目标(做什么)
先审查后加固:产出两条链路的健壮性审查报告(file:line 取证),把修复项落册执行;A 侧同步补「流中断的用户呈现」。

## 验收标准(可验证,逐条)
1. 审查报告落 `docs/audits/`:B 侧 streaming 路径(缓冲 / flush / 心跳 keep-alive / 上游断流 / 超时 / 取消传播)+ A 侧消费端,逐项结论;
2. C23 关闭:退避重连(指数 + 抖动)、Last-Event-ID 正确重放、终态判定健壮、`subs` 不泄漏;
3. 弱网模拟(限速 / 断网 / 掐半流)下:模型流中断有明确 UI + 可重试,无永久卡死 / 无静默(联动 B20/B11);
4. 心跳或超时机制存在,悬挂连接可被检测并回收。

## 非目标
- 不重写 opencode 自身的 `/api/event` SSE(上游职责);
- 不做离线队列 / 消息持久化(超出健壮性范畴)。

## 方案 / 关联
- 收编 **C23**(NEW-2/3/4 云路径潜伏 bug);respawn 无互斥(NEW-4)与 B5 邻接,可同批修;
- B 侧代码在 `alpha-platform/packages/gateway`(用户已授权直接管理);
- 关联 REQ-002(联调时顺带做弱网用例)。

## 验证记录
_verify 时补。_
