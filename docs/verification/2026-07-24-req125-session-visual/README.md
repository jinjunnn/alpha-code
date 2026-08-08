---
title: "REQ-125 会话视觉矩阵验证摘要"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-06
---

# REQ-125 #547 会话视觉矩阵验证摘要

本目录保存 seam 会话页与时间线组件对照已批设计的明暗视觉证据。终判基线为
alpha@`d3790e90b1e815001f8bb40f4ce8d15573c5de89`;逐行裁决以
[`matrix.md`](matrix.md) 为准,复跑方法以 [`harness-plan.md`](harness-plan.md) 为准。

## 终判

| 结果 | 行数 | 说明                                     |
| ---- | ---: | ---------------------------------------- |
| PASS |   58 | 可达形态符合当前判定合同                 |
| FAIL |   14 | 每行均已路由到 #538 下的实现票           |
| N/A  |    2 | J4/J7;#558/PR#571 已确认生产数据面不存在 |
| 合计 |   74 | 74/74 均已裁决,无留空、部分或待输入状态  |

72 个可达行均有明暗双主题证据,共 144 个终判帧。另保留批1–3 的历史局部帧和
C6 未知工具 fail-closed 回归帧;这些辅助文件不增加矩阵行数。

## FAIL 路由

| 矩阵行       | 承接票 |
| ------------ | ------ |
| E1           | #861   |
| E3 / E4      | #582   |
| F2           | #863   |
| F3 / F4 / F5 | #592   |
| G6           | #583   |
| G7           | #584   |
| G15          | #585   |
| G17          | #586   |
| G18          | #587   |
| H4           | #864   |
| I1           | #865   |

历史发现9/12/13/14 已分别由 #588/#591/#589/#590 修复。D6 的 production PTY
环境数据同步由 #579 承接;F9 的无副作用 resume 语义由 #620 承接。两者不改变本次
组件视觉终判。

## 2026-08-08 E5 #862 复验

- production Solid 时间线与现役 CSS 经 loopback-only Vite 装配,Google Chrome
  `151.0.7922.77` 以 `--headless=new` 重采明暗两帧;零 Electron、零账号/API key、
  零前台窗口。
- 非 hover 时脚注 `opacity=0`;hover 后两主题均为 `1`,并显示可读的
  `Build · GPT-5`、「复制消息」与「编辑重发」。
- 证据:[浅色](shots/E5-light-harness.png)
  `eb938d887ac164e5599d6d004822a20ee5326df95db1ac4944e3ec8a23bb755f`;
  [暗色](shots/E5-dark-harness.png)
  `d3a0ca1527e09ad00d828d51fe6f17439beefe48e611c0b58140e503d72caf5f`。

## 2026-08-06 headless 收口证据

- production baseline:`d3790e90b1e815001f8bb40f4ce8d15573c5de89`。
- 生产 Solid 组件与生产 CSS 经 loopback-only Vite 装配;没有复制生产 DOM 或改写
  production selector。
- Google Chrome `151.0.7922.75`,`--headless=new`,1440×900,明暗主题双通道同置。
- 新采 21 个状态、42 帧,包含 20 个历史缺对状态与 D9 完整终判补帧。
- 机读基点、harness/driver hash、每个 PNG 的 bytes/sha256 见
  [`harness/capture-metadata.json`](harness/capture-metadata.json)。
- `foregroundApplicationLaunches=0`,`electronStarted=false`,`credentialsUsed=false`。
- 采集结束后 loopback server、4173 listener 与本 harness headless Chrome 进程均为 0。

本批没有启动 Alpha Code/Electron、packaged app、deep-link 或可见 Chrome,也没有读取
账号、真实 API key 或 owner 桌面状态。

## 功能/安全与 benchmark 终判

- 24 个 production-component/happy-dom 测试文件:**294 pass / 0 fail**,1362 次断言,
  覆盖 I1–I8 与 5 组功能门。
- 静态复核:旧注入文件/符号、未经 sanitizer 的 HTML API、裸外开均为 0;唯一局部
  `querySelector` 不是上游 session DOM 访问。
- [`invariant-checks.md`](invariant-checks.md) 的 13 个功能/安全行全部 PASS。
- 3 个历史 before/after benchmark 行仍为 FAIL:C5 合并前没有 Alpha timeline 生产基线,
  且上游 timeline harness 不覆盖 C5 变更;不得倒签。#866 已建立
  [当前生产性能基线](../2026-08-06-req125-timeline-performance/README.md),供未来 delta
  对比;父票 #538 保持开放。

#547 的 VERIFY 范围至此全部获得终态结果;关闭本验证票不代表 #538 完成。视觉 FAIL
继续由上表实现票承接;#866 的当前基线不改变历史 before 缺失结论。
