# CI 规范(alpha-code)

> 一句话:**本地先跑,CI 兜底**。CI 不是你第一次看到失败的地方——它是 merge 前的强制关卡。
> 权威触发定义在 `.github/workflows/alpha-ci.yml`;北极星守卫语义见 ADR-004,fork 纪律见 ADR-005。

## 0. TL;DR — push 前一条命令

```bash
bash scripts/alpha-check.sh
```

绿了再 push。它跑的就是 `alpha-ci` 的三关(北极星守卫 / typecheck / 单测),本地几秒出结果,和 CI 1:1 一致。

## 1. 为什么 local-first(优先本地跑)

- **快**:本地三关秒级;CI 往返一轮 = 排队 + 起机 + 装依赖 + 跑,分钟级。
- **省往返**:把 CI 当"第一次跑"= 每个错都要等一轮红了才知道 → 慢、烦、还堵别人的队。
- **CI 的真正职责**是①**强制门禁**(branch protection:不绿不让 merge,挡手滑)②**中立环境兜底**(抓"在我机器上是好的"那类环境差异)——不是给你当调试台用的。
- 所以顺序永远是:**本地 `alpha-check` 绿 → push → CI 复核 → merge**。

## 2. 三关是什么(与 `alpha-ci` 1:1)

| 关 | 本地命令 | CI job | 失败含义 |
|---|---|---|---|
| **北极星守卫**(零改上游) | `scripts/alpha-check.sh` 内含;等价 `git diff --diff-filter=DMR --name-only origin/dev...HEAD -- <上游7包>` 必须空 | `north-star guard (zero upstream edits)` | 改了上游文件 → 下次 fork-sync 冲突,破北极星 |
| **typecheck**(三个 alpha 包) | `bun run --cwd packages/alpha-contracts-consumer typecheck` + `bun run --cwd packages/ext typecheck` + `bun run --cwd packages/ui-mac typecheck` | `typecheck (alpha packages)` | 类型不过 |
| **契约锁 + 单元测试** | `packages/alpha-contracts-consumer` 的 `check:vendor`/`bun test`,再从 `packages/ext`、`packages/ui-mac` 各跑 `bun test` | `unit tests (alpha packages)` | vendored hash、producer/consumer fixture 或运行时守卫回归 |

- **上游 7 包** = `packages/{opencode,core,server,app,ui,tui,sdk}`(见 alpha-ci.yml `env.UPSTREAM_PATHS`)。
- **bun 版本钉 `1.3.14`**(与 CI 一致,根 `package.json` 的 `packageManager`)。本机版本不同先对齐。
- 根 `bun test` 被故意禁用(`do not run tests from root`)——测试按包跑,别在根跑。
- Alpha Platform wire pin 不使用 `bun.lock`。`check:vendor` 要求
  `alpha-platform-contract.lock.json` 的 repo/commit/file set 与每个正式
  vendored 文件 SHA-256 一致；staged 源存在时还会逐文件与 staged bytes
  对比。固定命名测试 `contract lock resolves to the exact immutable
  alpha-platform commit` 与 `contract source lock matches vendored artifact
  hashes` 是 CI 证据。

## 3. GitHub 上只跑两个 workflow(其余上游的已禁用)

本仓是 opencode 的 fork,继承了 ~26 个上游 workflow。它们要上游订阅的 **Blacksmith 自建 runner**(如 `runs-on: blacksmith-4vcpu-ubuntu-2404`),本 fork 没有这种机器 → 一触发就永久 `queued` 挂死。**这是历史上"CI 一直卡 / 连不通"的真因**(不是 API、不是限流、不是 alpha-ci)。

2026-07-03 已 `gh workflow disable` 全部上游 workflow,**只保留**:

| workflow | 作用 | 触发 |
|---|---|---|
| **`alpha-ci`** | 本仓 CI(上面三关) | `push` / `pull_request` → `alpha`;也可 `workflow_dispatch` |
| **`sync-upstream`** | 每日上游 `dev → merge alpha` 同步 | 定时 + 手动 |

- **required check 只有 `alpha-ci` 的三个 job**;其它 workflow 一律**不影响 merge**(PR 上若看到别的 check = 历史残留,忽略)。
- **不要盲目 `gh workflow enable`** 上游那些——除非你真给 fork 接了对应 runner。要恢复某个:`gh workflow enable <name>.yml`(可逆,文件没删)。

## 4. 提交纪律

1. push 前 `bash scripts/alpha-check.sh` **必须绿**。
2. 需要新增能力 → 走 alpha 自有文件(`packages/ext`、`packages/ui-mac`)或接缝(tool/plugin/MCP/sidecar,ADR-002/005),**绝不改上游 7 包**(改了北极星守卫本地就红)。
3. 短命 `feat/*` / `fix/*` 分支 → PR → squash 合回 `alpha` → **合后即删分支**(ADR-005)。
4. 想把 local-first 变**强制** → 装 §6 的 pre-push 钩子。

## 5. CI 卡住了怎么办(排查手册)

1. **先分清谁卡**:`gh run list` 看是哪个 workflow。`alpha-ci` 卡 = 真问题;别的 = 已禁用的僵尸,忽略/取消。
2. **queued(排队) vs in_progress(在跑但慢)**:
   - 一直 `queued` = 等 runner(无匹配 runner / Actions 额度耗尽 / 并发上限);
   - `in_progress` 慢 = job 本身慢(装依赖 / 测试)——那才是 REQ-009 缓存优化的场景。
3. **命令**:`gh run cancel <id>` 取消 · `gh run watch <id>` 盯 · `gh run rerun <id>` 重跑 · `gh run list --workflow=alpha-ci.yml` 只看本仓 CI。
4. **别被堵**:本地三关已绿 = 代码没问题;required 只有 alpha-ci 三个。真急可 `gh pr merge --admin` 绕过(慎用,别养成习惯)。

## 6. pre-push 钩子 —— local-first 强制(2026-07-05 REQ-015 起默认开启)

`.githooks/pre-push` = 跑 `scripts/alpha-check.sh`(与 alpha-ci 1:1)。**默认开启**:`alpha-check.sh` 每次运行都会幂等重挂 `git config core.hooksPath .githooks`。

为什么不能用上游 husky 门(此前「配置过又失效」的根因,REQ-015):
- `.husky/pre-push` 跑**全量** `bun turbo typecheck`,在 ADR-020 冻结偏斜下 `session-ui` 恒红(上游叶子包,alpha 不 ship,权威门 alpha-ci 不含)→ 逼出 `--no-verify` 习惯;
- husky 的 `prepare` 在每次 `bun install` 后把 `core.hooksPath` 重置回 `.husky/_` → 手动 `git config` 一次性开启会被静默冲掉。alpha-check 的自愈重挂即对策;残余窗口(install 后、首次 alpha-check 前直接 push)会撞上游红门 → 跑一次 alpha-check 即恢复,**永不劣于旧状**。

```bash
# 逃生:
git push --no-verify                                # 单次绕过
git config --unset core.hooksPath                   # 关闭(需配合 export ALPHA_HOOKS_DISABLE=1,否则下次 alpha-check 重挂)
```
