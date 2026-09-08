### Issue for this PR

Closes #

### Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / code improvement
- [ ] Documentation

### What does this PR do?

Please provide a description of the issue, the changes you made to fix it, and why they work. It is expected that you understand why your changes work and if you do not understand why at least say as much so a maintainer knows how much to value the PR.

**If you paste a large clearly AI generated description here your PR may be IGNORED or CLOSED!**

### How did you verify your code works?

### Documentation impact

Choose exactly one and provide paths or a reason:

- [ ] Updated canonical docs: `docs/...`
- [ ] Added or superseded a decision/contract/runbook: `docs/...`
- [ ] Documentation impact is `none` because:

### 破坏性变更面(alpha 专有)

这四面的共同点:**改错了不会在本 PR 上红**,受伤的是已经装了产品的用户,或下一次 fork-sync。
逐条判「本 PR 碰没碰」;碰了就把它下面那件事一起做完并在这里写清楚做了什么。都没碰就勾最后一条。

- [ ] **收编面** —— `packages/` 下由 `scripts/north-star-guard.sh` 的 `UPSTREAM_EXCLUDES` 白名单
      放行的上游文件(**数一遍,别抄这里**:`grep -c "':(exclude)" scripts/north-star-guard.sh`;
      2026-09-08 实读 48 条)。
      → 新增收编要有**自己的 ADR**([ADR-029 主权阶梯](../.claude/rules/adrs/ADR-029-upstream-sovereignty-ladder.md) §3),
      不得静默往白名单里加一行。
      → 它其实是 alpha 自己写的文件?走
      [ADR-043](../.claude/rules/adrs/ADR-043-alpha-owned-files-under-upstream-paths.md) 的谓词
      (命名成 `alpha-*`,或在文件里写一行 `north-star:alpha-owned`),**不要**加 exclude。
      → 改的是**已经收编**的文件(白名单里已有的那几条):它在下一次 fork-sync 必然冲突、由我们手解。
      改动要落在对应 ADR 记下的接管面之内;越界 = 扩大收编 = 仍然要走新 ADR。

- [ ] **`alpha-package-envelope` 契约** —— `packages/ui-mac/src/shared/host-extension-package-contract/`
      的 schema / registry / decoder / 语料([宿主合同](../docs/contracts/host-extension-package-v1.md))。
      → 重生 artifact 清单并自检:
      `bun packages/ui-mac/src/shared/host-extension-package-contract/generate-artifact.ts` 然后 `--check`。
      → 这份 artifact 被 **alpha-web 反向 pin** 着(`host-contract-pin.v1.json` 里的 commit + `artifactSha256`)。
      改了它,`packages/alpha-contracts-consumer/src/extension-package-artifact.test.ts` 会红,
      直到 alpha-web 那边 bump pin、本仓 `bun run --cwd packages/alpha-contracts-consumer vendor` 重新 vendor。
      **破坏性改动必须与 alpha-web 同批安排,不能先合本仓这一半。**
      → `packages/ui-mac/src/main/ext-package-ledger-v3.ts` 带着 `PACKAGE_ID_RE` 的一份副本,
      与 schema 的 `packageId` pattern 同生共死。

- [ ] **主进程 ↔ renderer 的 IPC 通道** —— `packages/ui-mac/src/main/**` 的 `ipcMain.handle/on`
      与 `packages/ui-mac/src/preload/index.ts` 的 `ipcRenderer.invoke/send`。
      → **两侧同改**:renderer 是 `contextIsolation` + `sandbox`,里面没有 `ipcRenderer`,
      preload 那一行是唯一到达路径。只加 main 侧 = 写了一段长得像「已有能力」的死代码
      (`packages/ui-mac/src/main/ipc-channel-binding-census.test.ts` 会点名)。
      → 动 `window.api` 的形状还要看
      [ADR-034](../.claude/rules/adrs/ADR-034-frontend-rolling-pin.md) 钉住的前端:
      `packages/app/src/app.tsx` 里是 `window.api?.setTitlebar?.(…)` —— **可选链会让改名静默 no-op**,
      没有任何门会红。要动就重生 `frontend/alpha-patches/alpha-frontend.patch` 并跑
      `bash scripts/assert-frontend-patch-roundtrip.sh`。

- [ ] **从既有 ledger / receipt 恢复** —— 用户盘上 `<root>/installs.json` 的
      v1 receipts / v2 records / v3 `packageGraphs`+`claims`
      ([账本契约](../docs/contracts/extension-install-ledger.md);唯一物理写器是
      `packages/ui-mac/src/main/ext-receipt-v2.ts`)。
      → **拿一份升级前形状的账本跑一遍读取路径**,不要只测本次新写出来的形状。
      `parseLedger` 对读不懂的信封版本是 fail-closed:**整个文件拒碰**,
      用户看到的是已装扩展整片消失,而不是一条错误。
      → 存量条目的 owner token 是 `legacy-protected`,按设计**阻挡一切自动回收**
      (只有用户显式卸载能动它)。任何让它变得可被自动回收的改动都是破坏性变更。
      → 新增/改名 record kind 时,`ext-package-ledger-v3.ts` 的 `PACKAGE_LEDGER_KINDS`
      必须与 `ext-receipt-v2.ts` 的 `RECORD_KINDS` 逐字相等。

- [ ] 以上四面本 PR 都没碰。

### Screenshots / recordings

_If this is a UI change, please include a screenshot or recording._

### Checklist

- [ ] I have tested my changes locally
- [ ] I have not included unrelated changes in this PR
- [ ] I did not add local Issue, requirement, backlog, priority, owner, or Sprint status mirrors
- [ ] Any retired developer prose was reconciled through `docs/archive/DEPRECATED.md` before removal
- [ ] I did not delete or rewrite protected knowledge, design, audit, decision, or runtime-rule assets

_If you do not follow this template your PR will be automatically rejected._
