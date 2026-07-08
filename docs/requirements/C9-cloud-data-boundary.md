---
id: C9
title: 代码上云数据边界 mini-ADR(diff-only / secrets 过滤 / consent / 体积上限)
type: security
priority: P2
status: archived
repo: X
created: 2026-07-03
sprint: 2026-07-03-s11-cloud-loop
source: 册 §一 P2 / T4.5 / R7(B16 联动升级)
---

## 背景/证据
code-review pipeline(platform PA-22 已 live)必然要传代码;platform PA-7 已 flag 数据出境,A 侧无对应设计。与 B16 互补:C9=技术边界,B16=法律同意(parked,云派发上线前必须重启)。R7 提醒:登录默认 platform-pays → 每条 prompt 持续出境,边界设计不仅覆盖显式 dispatch。

## 验收标准
1. mini-ADR 落 `.claude/rules/adrs/`:diff-only 优先、secrets 过滤(密钥模式扫描)、consent 弹窗时机、传输体积上限;
2. 覆盖两条通道:显式云任务(dispatch)与隐式(platform-pays 模型代理的 prompt 上下文);
3. 与 B16 的分工/触发条件写明(B16 重启时直接可用);
4. B3 接线(T4.1)前完成,不阻塞后返工。

## 关联
B16(parked)、B3、platform PA-7/PA-22、REQ-001(edition 或涉数据驻留)。
