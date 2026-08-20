---
title: REQ-053 packaged incident regression (AC2 / AC5)
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-19
review_after: 2026-11-17
---

# REQ-053 packaged incident regression — alpha-code#470

规格来源:[`docs/design/2026-07-21-req053-bootstrap-loop-hardening.md`](../../design/2026-07-21-req053-bootstrap-loop-hardening.md) §AC5 订正块。父票 `#218` REQ-053。本目录只验证打包面 AC2/AC5;不修生产代码。

**本轮结论:`#470` 按 owner 裁决关闭。** `#1033`+#1036` 已闭合 boot sweep / XDG I1 / A2 exit 1。夹具 **A / A2 / C = PASS**。夹具 **B = FAIL**(70min live:日志不涨、无 strike-3/recovery)。**Owner waive(2026-08-20):** AC5 打包 live 断路证据本期不作为关票条件;速率规则认夹具 C,冷启动/fail-closed 认 A/A2。父票 `#218` 仍由 owner 逐 AC 勾选,本目录不 `Fixes #218`。

## 被测件

| 项 | 值 |
| --- | --- |
| git SHA | `9bcb82c923e7ff7727992ae5afe1555a39703529` |
| 产物 | worktree 内 `packages/ui-mac`:**`OPENCODE_CHANNEL=prod` 必须同时作用于 build 与 package**;否则 bundle id 落 `com.tide.alphacode.dev`,packaged 启动在 `app.whenReady()` 前挂起(9 行 main.log,零 sidecar)。 |
| 命令 | `OPENCODE_CHANNEL=prod bun run build && OPENCODE_CHANNEL=prod bun run package:mac` |
| 签名 | ad-hoc:`codesign --force --deep --sign - dist/mac-arm64/alpha-code.app`。**KNOWN GAP**:`ALPHA_SIGN=1` 在 `codesign --timestamp` 上失败(`The timestamp service is not available`)。 |
| `CFBundleShortVersionString` | `0.1.3` |
| `CFBundleIdentifier` | `com.tide.alphacode`(prod channel) |
| `app.isPackaged` | `true`(main.log:`packaged: true, onboardingTest: true`) |
| 隔离 | `OPENCODE_TEST_ONBOARDING=1` → `$TMPDIR/opencode-onboarding-<uuid>/`;真实 `~/.alpha` / `~/.opencode` / `~/.config/opencode` / `~/Library/Application Support/ai.opencode.desktop` inode+mtime 在夹具 A 中未变。 |

Runner:`bun docs/verification/2026-08-19-req053-packaged-incident-regression/run.ts --app <alpha-code.app> --fixture A\|A2\|B\|C`

## 四条夹具

### A 冷启动自愈 — **PASS**

命令:

```bash
cd packages/ui-mac
OPENCODE_CHANNEL=prod bun run build && OPENCODE_CHANNEL=prod bun run package:mac
codesign --force --deep --sign - dist/mac-arm64/alpha-code.app
cd ../..
bun docs/verification/2026-08-19-req053-packaged-incident-regression/run.ts \
  --app packages/ui-mac/dist/mac-arm64/alpha-code.app --fixture A
```

原始结果:[`results/fixture-a.json`](results/fixture-a.json)

| 判据 | 结果 |
| --- | --- |
| `grep -a -A4 "confirmed-absent Alpha config references stripped"` 且对象字段 `stripped: 4` | **PASS** |
| 引擎日志 `creating instance` 恰 1 次 / 无三行循环 | **PASS** |
| 两份配置悬空 plugin+`{file:}` 消失;活引用 / npm 包名 / 守卫根外路径保留 | **PASS** |
| 预置 XDG `opencode.jsonc` inode+mtime | **PASS**(`#1036` 路由 `OPENCODE_CONFIG_DIR`) |
| 真实 home 根未写 | **PASS** |

### A2 fail-closed — **PASS**

命令:同上,`--fixture A2`。

原始结果:[`results/fixture-a2.json`](results/fixture-a2.json)

| 判据 | 结果 |
| --- | --- |
| 不 spawn sidecar | **PASS** |
| `boot enforcement gap` 日志 | **PASS** |
| `refusing to spawn sidecar` 或 gap | **PASS** |
| 进程 exit 1 | **PASS**(`exitCode=1`;`#1036` onboarding 跳过 modal) |

### B 运行期断路 — **FAIL**

命令:同上,`--fixture B`。墙钟约 70 分钟(`2026-08-20T04:01Z`–`05:11Z`)。

原始结果:[`results/fixture-b.json`](results/fixture-b.json)

| 判据 | 结果 |
| --- | --- |
| strike-3 + `sidecar paused for explicit recovery` | **FAIL**(`recovery=false`,`strikeLines=0`) |
| 绝对帽 >512MB 或任一分 Δ>64MB | **FAIL**(70 样本;日志终态 11392B,仅 min61 Δ=541) |
| 断后 CPU <10% | **PASS**(`cpuSum=7.30`) |
| 日志目录有界 | **PASS** |
| 无第二实例风暴 | **PASS** |
| 逐分钟尺寸序列 | **PASS**(`n=70`) |

**根因形态(观测):** `server ready` 后 sidecar 仍活(health 401);每分钟注入悬空 plugin/`{file:}` **未能**再打出可持续 bootstrap 洪泛——`opencode.log` 几乎不涨,断路器无输入信号。与「旧事故 21GB 失控」不同:boot sweep(`#1033`)后,隔离口下「运行中再种悬空」灌不出 AC5 要的 live runaway。**不**据此宣称断路器坏;速率决策核仍由夹具 C 绿。AC5 打包面「recovery 卡可见 + 断路」仍缺证据。

### C 速率规则单独证活 — **PASS**(未重跑)

上轮 [`results/fixture-c.json`](results/fixture-c.json) 仍有效:`bun test src/main/engine-runaway-guard.test.ts` → 13 pass / 0 fail。基线明确:B 的 Δ 若永 <64MB,**不得**把 B 当 rate-rule 证据 —— 本轮正是该形态。

## 本地确定性门

| 门 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `cd packages/ui-mac && bun run typecheck` | exit 0 |
| unit(C) | (上轮) `bun test src/main/engine-runaway-guard.test.ts` | 13 pass / 0 fail |
| `alpha-check.sh` | 未跑(并行 lane 会写共享 `core.hooksPath`) | — |
| 未 `bun install` / `worktree-bootstrap` | 编排者已 bootstrap | — |

## FAIL → owner waive

- `#1031` / `#1033` / `#1034` / `#1036`:已闭合。
- **夹具 B FAIL(本轮):** sidecar 活着但洪泛灌不出来;断路器无输入信号。速率决策核仍由夹具 C 绿。
- **Owner waive(2026-08-20):** 不把 AC5 打包 live 断路(strike-3 / recovery 卡)作为 `#470` 退出条件。未开 CODE 改夹具。
- `#982` spawn 咽喉闩曾 blocked-by `#470`;本 waive 不代替 `#982` 自己的裁决。

## 主动没做

- 不改生产 `index.ts` / sweep / runaway-guard 实现(本目录只产证据)
- 不杀/不写入用户现役 `/Applications/alpha-code.app`
- 不 `Fixes #218`
- 不 `alpha-check.sh`(并行 lane 会写共享 `core.hooksPath`)
- Windows 半场
- 不把 `gate:waived` 贴到本票(`gate:waived` 只用于 Iteration 卫生闸,不是 AC waive)
