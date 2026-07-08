---
id: C3
title: 日志治理:opencode.log 轮转 + netlog opt-in
type: debt
priority: P2
status: archived
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P2 / T2.5
---

## 背景/证据
`opencode.log` 145MB 无轮转(上游写,alpha 可在 app 启动时做体积治理);netlog 20MB 每次启动常开。

## 验收标准
1. app 启动时对 opencode.log 做体积上限归档(超限轮转/截断,保留最近 N 份);
2. netlog 改 `ALPHA_NETLOG=1` opt-in(默认关);
3. 长期运行日志总量有界(实测一周量级)。

## 关联
C16(卸载残留,日志是大头)、D6(log 目录增生)。
