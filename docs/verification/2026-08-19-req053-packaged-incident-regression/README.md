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

**本轮结论:仍不能关 `#470`。** `#1033`+#1036` 已闭合 boot sweep / XDG I1 / A2 exit 1。夹具 **A / A2 / C = PASS**(`9bcb82c92`);夹具 **B 仍 pending**(live runaway 45–54min,未在本轮重跑)。

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

### B 运行期断路 — **pending / KNOWN GAP**

未重跑(54 分钟;sidecar 未要求)。A/A2 已绿;B 仍为 `#470` 关票前缺口。

### C 速率规则单独证活 — **PASS**(未重跑)

上轮 [`results/fixture-c.json`](results/fixture-c.json) 仍有效:`bun test src/main/engine-runaway-guard.test.ts` → 13 pass / 0 fail。

## 本地确定性门

| 门 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `cd packages/ui-mac && bun run typecheck` | exit 0 |
| unit(C) | (上轮) `bun test src/main/engine-runaway-guard.test.ts` | 13 pass / 0 fail |
| `alpha-check.sh` | 未跑(并行 lane 会写共享 `core.hooksPath`) | — |
| 未 `bun install` / `worktree-bootstrap` | 编排者已 bootstrap | — |

## FAIL → bug

- `#1031` / `#1033`:已闭合;boot sweep 在 TEST_ONBOARDING 下会跑。
- **新开(待主 session 路由):**
  1. 夹具 A — 隔离 XDG `opencode.jsonc` mtime 被 boot 路径触碰(违反 I1)。
  2. 夹具 A2 — enforcement gap 后进程应 exit 1,实际弹窗阻塞。

## 主动没做

- 不改生产 `index.ts` / sweep 实现
- 不跑夹具 B(54 分钟)
- 不杀/不写入用户现役 `/Applications/alpha-code.app`
- 不 `Fixes #218` / 不 `Fixes #470`(A/A2 未全 PASS)
- 不 merge / 不开 draft PR(A/A2 FAIL)
- 不 `alpha-check.sh`
- Windows 半场
