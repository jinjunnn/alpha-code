---
id: ADR-044
title: north-star 守卫的辖区 = packages/ 全树,例外才是清单
status: accepted
date: 2026-09-06
related: [ADR-004, ADR-016, ADR-029, ADR-033, ADR-034, ADR-043]
---

## 背景(先跑,再写)

north-star 守卫(`scripts/north-star-guard.sh`)是 ADR-004「alpha 不改上游包」这条铁律的**唯一
机械判据**,也是 `alpha` 分支保护上的必需 context(`.github/required-contexts.txt` 第一条,
逐字 `north-star guard (zero upstream edits)`;CI 与本地 `scripts/alpha-check.sh` 跑的是同一份字节)。

2026-09-06 实测(命令与结果):

```
$ git ls-tree --name-only origin/dev packages/ | wc -l
32
$ # 辖区(scripts/north-star-guard.sh:39,本 ADR 之前)
packages/{opencode,core,server,tui,sdk,protocol,schema,client}      ← 8 个
```

⇒ **24 个上游包在辖区外**。其中 `app`/`ui` 由 ADR-034 的 pin+补丁 roundtrip 门盖住,
**其余 22 个零机制**。在真仓复现:

```
$ printf '\n// probe\n' >> packages/plugin/src/index.ts     # Hooks 契约本体
$ printf '\n// probe\n' >> packages/llm/src/index.ts        # provider 协议层
$ bash scripts/north-star-guard.sh
✓ zero upstream package edits (baseline origin/alpha; …)
rc=0
```

这不是少拦一个坏输入 —— 是这道门对一大半地盘**根本没在看**,而「北极星今天绿」这句话被
当作可以合并的依据。下一次 fork-sync 照样在那些文件上冲突。

累计的存量(`git diff --no-renames --diff-filter=DMR --name-only origin/dev...origin/alpha`):
新覆盖面里有 **21 个文件**已带 alpha 侧改动(`desktop` 8 / `llm` 8 / `httpapi-codegen` 2 /
`codemode` 1 / `plugin` 1 / `session-ui` 1)。它们**不会**因为本 ADR 变红:守卫的比较基准是
`origin/alpha...HEAD`(ADR-004 + `#889`),已合并的历史在基准里,窗口只装「这个 PR 自己改了什么」。
本 ADR 因此**不动**任何一条存量,也**不为了让门变绿而放宽辖区** —— 它们的处置(要不要按 ADR-029
逐条登记成收编)是各自的票,不是这一张。

## 决策

1. **辖区 = `packages/` 全树。** `UPSTREAM_PATHS="packages"`,不再是包名枚举。
2. **例外是清单,且默认拒。** 两张,各有独立理由,不许混:
   - `ALPHA_OWNED_PACKAGES="ext ui-mac alpha-contracts-consumer"` —— alpha 自有的 workspace 包,
     `origin/dev` 里**根本没有**这三条路径(2026-09-06 实测)。整包豁免而不走 ADR-043 的逐文件
     谓词:那个谓词要求每个文件自报家门,而这三个包里成千上万个文件全是 alpha 写的。
   - `ROUNDTRIP_PACKAGES="app ui"` —— 由 ADR-034 的 pin + SOT 补丁 roundtrip 门覆盖。
3. **`ALPHA_OWNED_PACKAGES` 有运行期自检。** 每条声明都拿上游镜像验一遍:镜像里存在 ⇒ 守卫
   **自己红**并点名那条声明。理由是它成了这道门的软肋 —— 辖区改成「全树减 carve-out」之后,
   往那张清单里加一个词就把一整个上游包移出辖区,而其余每一条断言照样绿。判据现成:alpha
   自有包按定义在上游镜像里查无此路径。镜像取不到时这一档跳过(已另有警告),辖区本身不依赖镜像。
4. **不改 ADR-020/027/034 已备案的冻结/pin 范围与定价,不改 ADR-033/035/038/041/042 的逐文件收编白名单。**

## 与 ADR-034 的关系:无空档,无重复覆盖

`packages/{app,ui}` 不由本门覆盖是**有意**的,两个方向都要说清:

- **无空档** —— `scripts/assert-frontend-patch-roundtrip.sh` 判的是「HEAD 的那两棵树必须能由
  `frontend/frontend-pin.lock` 的 pin + `frontend/alpha-patches/alpha-frontend.patch` **逐字节
  重建**」(比 tree sha)。它比本门**更强**:本门只判「有没有改」,它连「改了但没重生补丁」都
  当场红。它跑在 alpha-ci 的**同一个 job**(`upstream-guard`)里,且刻意用 `if: !cancelled()`。
- **无重复** —— 本门若也盖它们,ADR-034 §2 明写的日常工作流(改 seam = 改补丁 + 重生那两棵树)
  每一次都会被判成破北极星 ⇒ 恒红门 ⇒ `--no-verify` ⇒ 十道门一起关掉(`#754` 演过一遍)。

这段关系此前只写在守卫的注释里,是**散文**:有人把 roundtrip 门的 `PACKAGES` 改小(比如只留
`app`),`packages/ui` 从此两道门都不管而两边都不会红。现在它是断言 ——
`local-gate-parity.test.ts` 要求两处清单逐条相同(第十七条)。

## 为什么是「全树减例外」,不是「换一张更长的枚举」

枚举对**新成员默认放行**:上游每加一个包就多一个盲区,而没有任何东西会变红 —— 这正是本 ADR
在修的那个缺陷,换一张 32 项的枚举只是把它推迟到第 33 个包。ADR-043(`#1079` owner CHOICE=2)
在**文件**那一层已经因为同一条理由否掉过逐文件清单、改用结构性谓词;这里是把同一条纪律搬到
**包**这一层。判据里因此有一个守卫从没听说过的包(`brand-new-upstream-pkg`),专钉这一格。

## 判据(先证明它测得出已知的坏)

行为闸在 `packages/ui-mac/src/main/north-star-guard.test.ts` 的 `#1247` 一节,五条,每条正向
断言都带一个**控制组**(把生产脚本复制一份、只把被测那一格改回缺陷态):

| 条 | 输入 | 期望 | 控制组 |
| --- | --- | --- | --- |
| 1 | 每个上游包各改一行 | 逐个被点名 | 辖区换回那 8 个包 ⇒ 六个盲区包一个都不被点名 |
| 2 | 只改 `brand-new-upstream-pkg` | 红且点名 | (由 3/4 的绿向用例杀「恒红实现」) |
| 3 | 改 `ext`/`ui-mac`/`alpha-contracts-consumer` | 绿 | 抹掉 carve-out ⇒ 红且点名 |
| 4 | 改 `app`/`ui` | 绿且不点名 | 抹掉 carve-out ⇒ 红且点名 |
| 5 | 把 `plugin` 写进 `ALPHA_OWNED_PACKAGES` | 守卫自己红并点名那条声明 | 同一棵树在生产脚本下本来就红 |

**变异实测(改守卫之前跑这五条):`18 pass / 5 fail`**,其中第 2 条打印出的正是缺陷输出
`✓ zero upstream package edits`。改完 `23 pass / 0 fail`。真仓两次对照:同一份两行探针,
改前 `✓ / rc=0`,改后 `✗ upstream files modified` 点名两个文件 / `rc=1`;干净树仍 `rc=0`。

## 后果

- ✅ 22 个零机制的上游包进入辖区,含本轮方案重度依赖的 `packages/plugin`(Hooks 契约)与
  `packages/llm`(provider 协议)。
- ✅ 上游**新增**的包默认被覆盖,不需要任何人记得去登记。
- ⚠️ 新覆盖面里那 21 个存量改动过的文件,**下一次**再被改会红。方向是对的(它们确实是上游
  文件、确实会在 fork-sync 冲突),但那一刻的正确反应是走 ADR-029 逐条裁决,不是放宽辖区。
  实测摩擦很低:2026-07-01 以来 496 个 alpha 提交里只有 **4 个**碰过这些包,最近一次 2026-07-28。
- ⚠️ 新覆盖面里有 4 个 alpha 自己写的文件没有自报家门(`packages/desktop/src/main/markdown.ts`、
  `packages/llm/test/auth-fail-closed.test.ts`、`packages/session-ui/src/components/markdown-preload.test.ts`、
  `packages/session-ui/src/components/markdown-shiki.worker.ts`)。改它们会红,出口是 ADR-043 的
  两条(改名成 `alpha-*` 或写一行 `north-star:alpha-owned`),守卫的红字里已经写着这句话。
  本 ADR **刻意不预先给它们打 marker**:标记一个文件是主权声明,标错就是新的洞,而不标只是过报。
- 🔭 **未覆盖面(诚实登记,本 ADR 不做)**:① 辖区仍只到 `packages/`,上游的仓根文件
  (`package.json`/`turbo.json`/`sst.config.ts`/上游 workflow…)不在任何门里;② alpha-ci 的
  north-star 步挂在 `needs.detect.outputs.code == 'true'` 上,而 `*.md` 被 detect 判成 docs-only ⇒
  一个只改上游 `README.md` 的 PR 在 CI 上跳过这道门(本地 `alpha-check.sh` 无条件跑,故只是 CI
  兜底那一层的洞)。两者都是本 ADR 之前就存在的形状,各自开票。
