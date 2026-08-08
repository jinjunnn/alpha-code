---
title: "REQ-125 Alpha 时间线当前生产性能基线"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-07
---

# REQ-125 #866 · Alpha 时间线当前生产性能基线

本目录归档 #866 在 Alpha 自有 `SessionTimelineView` 上建立的第一份可复用当前基线。
它只为未来同 fixture、同采法的 delta 对比提供起点,不恢复不存在的 C5 合并前采样,
不把 #547 的历史 B1/B2/B3 FAIL 倒签为 PASS,也不关闭父票 #538。

数值依赖机器与运行时,是观测基线而非发布阈值。

## 测量身份

- measured commit:`80b42438a3386e26a36feb3a9d1f68c1de898852`。
- measured tree:`35547072d0907d7357e63f8084fec2b244a65682`。
- materialized fixture JSON sha256（`JSON.stringify(materializeTimelineBenchmarkFixture())`）:
  `9e58c9573f149d5c2a8505318df86c3e8f91534fee13748566da26d3f402a51f`。
- fixture source sha256（`packages/ui-mac/benchmarks/timeline/fixture.ts`）:
  `9d23753c4859ea397a4469b9752a4a22fb306053092f80780330743388ead60b`。
- 生产形态:真实 `SessionTimelineView`、真实 `MarkedProvider`、生产 CSS、Vite production
  build 与 loopback preview;没有复制生产 DOM 或另写时间线实现。
- 固定视口:1440×900,device scale factor 1;初始 561 行,历史前插 140 行,最终 701 行。
- 流式窗口:30,000ms,每 50ms 更新一次,每轮实际 600 次更新。
- 三轮严格串行,每轮新建 Bun/Playwright worker、headless browser 与浏览器上下文;
  Chrome for Testing `147.0.7727.15`,Bun `1.3.14`,darwin `25.3.0`,arm64,
  Apple M4 Pro,14 logical CPUs,48GiB RAM。
- 仅允许 `127.0.0.1`;三轮分别为 5、5、4 个 loopback 请求、0 个被阻断外网请求、
  0 个 renderer page error。未读取凭据、真实 API key 或账号,benchmark 自身未启动 Electron。

## 三轮中位数

| 指标                            | 中位数          |
| ------------------------------- | --------------- |
| 大会话冷开                      | 104.7ms         |
| 30s 流式 rAF gap p95            | 26.1ms          |
| 30s 流式 rAF gap max            | 29.0ms          |
| 30s 估算丢帧率                  | 10.2023%        |
| 30s long task 数/总时长         | 0 / 0ms         |
| 滚到顶触发延迟                  | 14.9ms          |
| 历史前插完成延迟                | 45.2ms          |
| 历史锚点位移                    | 58.875px        |
| 冷开后 renderer JS heap         | 7,541,820 bytes |
| 流式后 renderer JS heap         | 8,124,236 bytes |
| 历史前插后 renderer JS heap     | 8,936,040 bytes |
| 历史前插相对流式后的 heap delta | +812,192 bytes  |

每轮原始 rAF 时间戳/gap、long task、滚动/历史、DOM counter、event listener、JS heap 与
网络诊断保存在 [`raw/`](raw/);[`raw/summary.json`](raw/summary.json) 保存完整环境、
fixture、命令、中位数以及三份原始文件的 SHA-256 引用,不重复拷贝原始数组。

| 轮次 | 冷开    | 流式丢帧率 | 历史前插 | 锚点位移 |  历史后 JS heap |
| ---: | ------- | ---------: | -------- | -------: | --------------: |
|    1 | 161.3ms |   10.2023% | 58.7ms   | 58.875px | 8,917,068 bytes |
|    2 | 102.1ms |    9.3402% | 45.2ms   | 58.875px | 8,936,040 bytes |
|    3 | 104.7ms |   11.0785% | 38.0ms   | 58.875px | 9,325,924 bytes |

## 复跑

从仓库根切到 measured commit,安装锁文件依赖,然后从 `packages/ui-mac` 执行:

```sh
bunx playwright-core install chromium

CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
  ALPHA_TIMELINE_BENCH_OUTPUT=/tmp/req125-timeline-baseline/raw \
  bun run bench:timeline
```

runner 写入 `raw/summary.json.fixtureSha256` 的是完整 materialized fixture JSON 哈希,不是
`fixture.ts` 源文件哈希;同时写入 commit 与 tree,避免源码身份、测量输入和可达 provenance
混为一谈。

runner 拒绝脏工作树,先做 production build,再用三个独立 worker 串行跑三轮;navigation、
cold-open、streaming 与 history-load 均有 fail-fast 超时,context/browser close 各自最多
等待 10 秒。renderer page error 会先写入 raw diagnostics,再使该轮 fail-closed。每轮 worker 和
Chrome 都结束后才进入下一轮,最终关闭 preview server。归档本批后复核 4175 listener、
benchmark Bun 进程与其 Playwright headless Chrome 进程均为 0。

## 原始证据完整性

| 文件               | sha256                                                             |
| ------------------ | ------------------------------------------------------------------ |
| `raw/run-1.json`   | `12262eb20f213698d1864ba7bd61da452dfdb245b00f650ef4473eb68df66354` |
| `raw/run-2.json`   | `e1219796c83865f33b556b429eaad993195a8b9e405ee76f966c945b36cf8847` |
| `raw/run-3.json`   | `855cd685b68e82ec480874ffa9aa80c0b7e4d8935cff60f76d328633fb63f0f0` |
| `raw/summary.json` | `890c465fed836e3ca717c44072a41c7bb6867898f2cf07b9f0ed885879973070` |

未来变更只有在复用同一 fixture hash、视口、production build、三轮串行和同类机器环境时,
才可与本基线作 delta 判定;否则必须另立基线并明确不可比。
