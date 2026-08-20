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

**本轮结论:不能关 `#470`。** 夹具 C PASS;A / A2 / B 因生产接线与隔离口互斥而未给出 AC 所需的 PASS。FAIL 已转 [`jinjunnn/alpha-code#1031`](https://github.com/jinjunnn/alpha-code/issues/1031) 挂 `#218`。

## 被测件

| 项 | 值 |
| --- | --- |
| git SHA | `48bf3cd4bf5c1cb4fee099aaaccb8e4af1e632a9` |
| 产物 | worktree 内 `packages/ui-mac`:`OPENCODE_CHANNEL=prod bun run build && bun run package:mac`(未 `install:local`) |
| `CFBundleShortVersionString` | `0.1.3` |
| `app.isPackaged` | `true`(main.log:`packaged: true, onboardingTest: true`) |
| 签名 | **KNOWN GAP**:`ALPHA_SIGN=1` 在 `codesign --timestamp` 上失败(`The timestamp service is not available`)。本轮用 electron-builder 的 unsigned/`identity=null` 包 + `codesign --force --deep --sign -` 深 ad-hoc。不是 Developer ID / 公证包。未用 `bun run dev` 冒充 packaged。 |
| 隔离 | `OPENCODE_TEST_ONBOARDING=1` → `$TMPDIR/opencode-onboarding-<uuid>/`;真实 `~/.alpha` / `~/.opencode` / `~/.config/opencode` / `~/Library/Application Support/ai.opencode.desktop` inode+mtime 在夹具 A 中未变。 |

Runner:`bun docs/verification/2026-08-19-req053-packaged-incident-regression/run.ts --app <alpha-code.app> --fixture A\|A2\|B\|C`

## 四条夹具

### A 冷启动自愈 — **FAIL**

命令:

```bash
OPENCODE_CHANNEL=prod bun run build && bun run package:mac   # 在 packages/ui-mac
codesign --force --deep --sign - dist/mac-arm64/alpha-code.app
bun docs/verification/2026-08-19-req053-packaged-incident-regression/run.ts \
  --app packages/ui-mac/dist/mac-arm64/alpha-code.app --fixture A
```

原始结果:[`results/fixture-a.json`](results/fixture-a.json)

| 判据 | 结果 |
| --- | --- |
| `grep -a -A4 "confirmed-absent Alpha config references stripped"` 且对象字段 `stripped: 4` | FAIL: 零命中 |
| 引擎日志 `creating instance` 恰 1 次 / 无三行循环 | FAIL:`creating instance=4705`(同量级 `fromDirectory` / `bootstrapping`) |
| 两份配置悬空 plugin+`{file:}` 消失;活引用 / npm 包名 / 守卫根外路径保留 | FAIL:种子仍在 |
| 预置 XDG `opencode.jsonc` inode+mtime | FAIL:inode 同,mtime 被改 |
| 真实 home 根未写 | PASS |

**根因(源码,不是夹具写错):** `packages/ui-mac/src/main/index.ts` 把 REQ-059 reconcile、desired-state、**以及 REQ-053 boot `sweepEngineConfigDanglingUnlocked`** 整块放在 `if (!TEST_ONBOARDING) { ... }` 里。`OPENCODE_TEST_ONBOARDING=1` 是 packaged 隔离的唯一口子(packaged 拒绝 `ALPHA_ENV_BASE_DIR` / 外部 `ALPHA_GLOBAL_DIR`)。因此 **「隔离 + AC2 boot 自愈」结构上同时做不到**。同机复跑 `sweepEngineConfigDanglingUnlocked` 对残留种子给出 `stripped.length === 4`,说明 planner 本身会对这些路径剥引用;缺的是 boot 接线。

未在共享主 checkout 上跑;未杀用户正在用的 `/Applications/alpha-code.app`。

### A2 fail-closed — **FAIL**(未单独出 PASS)

同一 `if (!TEST_ONBOARDING)` 块包含 `bootEnforcementGap` 的 dangling 分支。隔离启动下这段不跑,删掉 `index.ts` 的 gap 闸夹具 A 仍可「看起来像启动成功」,正是基线要单独一格挡住的假绿。本轮不把 A2 报成 PASS。

### B 运行期断路 — **FAIL**(未采到 strike-3 尺寸序列)

在 TEST_ONBOARDING 下 boot sweep 被跳过,本可把悬空 `{file:}` 留在运行中造循环。实测 packaged 子进程在 `server ready` 后 sidecar 端口变为 Connection refused,`opencode.log` 停在 ~3KB、`creating instance=1`,**没有** 30MB/min 级洪水,因此没有逐分钟越过 512MB 帽的序列,也没有 `sidecar paused for explicit recovery`。

未默默改成 dev 进程冒充。未跑满 45–54 分钟,因为信号(日志增长)在第一分钟就不存在。

### C 速率规则单独证活 — **PASS**

```bash
cd packages/ui-mac && bun test src/main/engine-runaway-guard.test.ts
```

输出摘要(核对 `Ran 13 tests across 1 file` = 枚举的 13 条):

```
13 pass
0 fail
33 expect() calls
Ran 13 tests across 1 file. [16.00ms]
```

含 `two consecutive windows above 64MB produce one strike` 与 `the existing 30 MB/min path still stops at minute 54`。

绕过实验记录(基线要求;本 VERIFY 票禁止改生产 src,故**不**真删 `fastWindows >= 2` 再跑 54 分钟 B):夹具 B 若全程窗口 Δ<64MB,则 `fastWindows` 恒 0,删掉 `fastWindows >= 2` 后 B 的绝对帽路径仍全绿。因此速率规则**必须**由本格单测证活,不能指望 B。

## 本地确定性门

| 门 | 命令 | 结果 |
| --- | --- | --- |
| typecheck | `cd packages/ui-mac && bun run typecheck` | exit 0 |
| unit(C) | `bun test src/main/engine-runaway-guard.test.ts` | 13 pass / 0 fail |
| `alpha-check.sh` | 未跑(并行 lane 会写共享 `core.hooksPath`) | — |
| 未 `bun install` | 编排者已 bootstrap | — |

## FAIL → bug

见 [`jinjunnn/alpha-code#1031`](https://github.com/jinjunnn/alpha-code/issues/1031)(挂 `#218`):`OPENCODE_TEST_ONBOARDING` 跳过 REQ-053 boot dangling sweep,使 AC2 打包证据在隔离根下结构不可证。

## 主动没做

- 不改 `index.ts` 把 sweep 移出 `TEST_ONBOARDING` 守卫(那是 CODE 票,不是本 VERIFY)
- 不杀/不写入用户现役 `/Applications/alpha-code.app` 与 `~/Library/Application Support/ai.opencode.desktop`
- 不 `Fixes #218`
- 不 merge
- Windows 半场
