---
title: Packaged macOS RC smoke — #332 半场 + #367 L3
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-17
review_after: 2026-10-15
---

# Packaged macOS RC smoke —— alpha-code #332(macOS 半场)+ #367 L3

> RC 级 packaged 验证证据落点(distribution.md §5 步骤⑤ + §5 CAS GC 五步的权威结果落点)。
> **执行 = 2026-07-17**。Windows 半场未跑,#332 保持 open。

## 环境事实

- 产物:`alpha-code` **0.1.2**(prod channel),`OPENCODE_CHANNEL=prod bun run build && package:mac`,源码 = alpha `2db1619b`(#389 落主线后)。
- 签名/公证:`xcrun stapler validate` → *The validate action worked!*;`spctl -a -t install` → *accepted / source=Notarized Developer ID*(Beijing yuanyuji RQX6X6A635)。
- 运行态:直接跑 `dist/mac-arm64/alpha-code.app`(**未 install:local**,不覆盖在用的 dev-channel app)。
- 隔离:`OPENCODE_TEST_ONBOARDING=1` → 全部 XDG/alpha/opencode/CAS 根改道到 `$TMPDIR/opencode-onboarding-<uuid>/`(main/index.ts:197-215);`:memory` DB。CDP `--remote-debugging-port` 驱动 renderer 侧 `window.api.*` 做真 IPC。
- 环境解析实测:`{environment:"prod", registryChannel:"stable", updaterFeedChannel:"latest", rootOverridden:true, casBaseRoot=<隔离根>}`。

## #367 L3 —— CAS GC worker(五步,裁决 Q6)

| 步 | 判据 | 结果 |
|---|---|---|
| 1 | `app.asar/out/main/ext-cas-gc-worker.js` 存在 | ✅ `@electron/asar list` 命中 `/out/main/ext-cas-gc-worker.js` |
| 2 | packaged app 对隔离 heavy fixture 触发一轮 GC | ✅ 注入 heavy 档(gen 内容 620.6MB / 5040 文件 + 2000 个出宽限期 blob,78.1MB)入隔离 `alpha-home`;GC 首跑(启动 +5min)真触发 |
| 3 | 日志出 `gc-success` 结构化摘要(非 `gc-exception`) | ✅ `[cas-gc-scheduler] gc-success {"durationMs":4274,"marked":475,"blobsTotal":2000,"sweepable":2000,"swept":2000,"keptByGrace":0,"warningCount":0}` |
| 4 | main 事件循环最大延迟 **<100ms**(GC 期间 UI 无可感知冻结) | ✅ **max 20.5ms**(6592 次 50ms 间隔采样,覆盖整个 GC 窗口;>10ms 仅 2 次,>50ms=0,>100ms=0) |
| 5 | 结果落 `docs/verification/` | ✅ 本文件 |

采样法:CDP 每 50ms 测一次 `window.api.awaitInitialization()`(renderer→main IPC→renderer)往返,任何 main 线程停顿即体现为尖峰。GC 单轮在 worker 线程跑满 4.27s,主线程往返峰值仍 20.5ms → **worker 卸载成立,无同步 main 占用**。裁决 Q1/Q3/Q4 的 worker 拓扑与失败终态在此 RC 得到 packaged 侧确认。

## #332 五面 —— macOS 半场

| # | 面(父 REQ) | 判定 | packaged 证据 |
|---|---|---|---|
| 1 | 环境隔离(REQ-098) | ✅ PASS | 全根改道隔离 temp;seed 安装只落 `<隔离根>/alpha-home/ext-store/...`,真实 `~/.alpha` 零触碰(无 ext-store);updater feed = prod→`latest`(通道对齐);#255 越根探针挡住(见下)。 |
| 2 | 更新失败(updater + 扩展事务失败处理) | ✅ PASS | `updater.check()` 真达 GitHub feed →「0.1.2 up-to-date,downgrade disallowed」,状态机优雅、app 存活;扩展事务失败路径全 fail-closed 无残留(authorize 闸拒装、project-scope 拒装、rollback 坏 genId 拒绝、前代 generation 原样 current);`tx-committed` 日志证实事务引擎真跑。 |
| 3 | session journey(REQ-085/086) | ✅ PASS | alpha `home` surface 真渲染(DOM = 「ALPHA CODE / 欢迎来到 alpha-code 三步开始 / 定制中心·自动化·产物」,非 upstream 默认页;截图 `assets/2026-07-17-alpha-home-packaged.png`);home/newSession resolve = alpha(auto-fallback)。 |
| 4 | legacy rollback(REQ-088) | ⚠️ MIXED | 现役组合 crash-safe:auto-fallback 面(home/newSession)`reportFailure`→re-resolve 返回 `crash-fallback`→legacy ✅;**但 #334 现场复现**:env 强推 `session=alpha`(硬 alpha 态)后 `reportFailure(session)`→re-resolve **仍 alpha**(不降 legacy)——硬 alpha 态跳过 crash 记录(alpha-surfaces.ts:99 提前返回),= 崩溃回环风险。#334 保持 open。 |
| 5 | xlsx stdio(REQ-105) | ✅ PASS | Excel 闸:钉版本 local stdio(`excel-mcp-server@0.1.8`)→ `{ok:true}`;未钉版本+sse / 远程 transport / `FASTMCP_HOST=0.0.0.0` 三越界全 fail-closed 带正确 reason;main 强制注入托管 workspace(#254 fail-open 已修)。 |

### 关键探针明细

**#255 越根负向(面 1)**
- `importSkillFolder("/etc")`(裸字符串 target)→ `{ok:false, reason:"target: invalid install target"}`。
- `importAgentPreview("bogus-token","/etc/hosts.md")`(伪 picker token)→ `{ok:false, reason:"File was not selected by the picker"}`。
- 结论:renderer 无法注入任意源目录 —— target 必须是合法 scope 对象,agent 导入必须持真 picker token。

**seed 安装 + authorize 闸(面 1/2)**
- 首次 `installCatalog({source:"seed", assetId:"skill:conventional-commits", scope:{scope:"global"}})` → `{ok:false, stage:"authorize", reason:"…requires explicit re-confirmation (added: prompt:context)…"}`(#348 授权闸拒绝静默继承)。
- 带 `authorization.confirmed` 再驱 → `{ok:true, kind:"skill", name:"conventional-commits", files:[<隔离根>/…/gen-000001-…], manifestDigest:sha256:1dc4…}`;`listInstalls` 记 `origin:"catalog"`。

**扩展事务失败处理(面 2)**
- project-scope catalog/seed 装 → `{ok:false, reason:"project-scoped catalog/seed installation is unsupported…"}`(预检 fail-closed,无 tx)。
- `rollback(conventional-commits, "gen-999999-deadbeef")` → `{ok:false, reason:"rollback: target generation receipt snapshot unavailable — refusing…"}`,current 仍 `gen-000002`(advisory 闸拒绝不可验身份,状态不损)。

## 观察项(非阻断)

- **skill 同摘要重装非幂等**:`installCatalog` 同 seed(同 `manifestDigest`)重装开了新 generation(gen-000001→gen-000002,digest 不变、CAS blob 复用)。r21 幂等早退在 plugin/vendored/seed 有 `warning:"…nothing to replace"`,skill 走 generation 事务每次新代。非 fail-open、非安全面,记录待 REQ-102/103 复核是否收敛。

## 半场结论

macOS 半场:**5 面 4 PASS + 1 MIXED**(legacy rollback 现役组合安全,#334 硬 alpha 缺口 open);**#367 L3 全 5 步 PASS**。
Windows 半场(`package:win` + 同五面 + asar worker 存在性)未执行 → #332 **保持 open**,票面仅勾 macOS 行。
