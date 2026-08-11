# `detect` 失败时四道必需检查到底呈现成什么(`#895` 取证)

日期:2026-08-11 · 取证载体:PR [#908](https://github.com/jinjunnn/alpha-code/pull/908) ·
仓库:`jinjunnn/alpha-code` · 目标分支:`alpha`

## 为什么要做这次取证

`#895` 的怀疑是:`alpha-ci` 的四个必需 job 全部 `needs: detect`,而 `detect` 自己不在分支
保护的 required 名单里 ⇒ `detect` 一失败,四个必需 job 被折成 `skipped`,而 GitHub 把
`skipped` 当成「已满足」⇒ **一道闸门都没真跑,PR 也能合**。

这件事官方文档有说法,本仓的判据不认文档 —— 判据是「跑一遍那个装着的版本」。
所以这里在一条真实 PR 上,用真实的分支保护设置,把四种状态各量了一次。

取证时的分支保护(`gh api repos/jinjunnn/alpha-code/branches/alpha/protection`):
required contexts 恰为四条 —— `north-star guard (zero upstream edits)` /
`typecheck (alpha packages)` / `unit tests (alpha packages)` / `docs gate`;
`detect changes` **不在**其中;`strict=false`;`enforce_admins=false`;无 required reviews。

破坏手法:往 `detect` job 里插一条**无 name** 的 `- run: exit 1`。无 name 是为了不被
`local-gate-parity.test.ts` 的步骤解析器收录,免得引入与本题无关的红。取证结束后已从分支删除。

判据用 `mergeStateStatus` / REST 的 `mergeable_state`,**不是**「`--admin` 能不能合」——
`enforce_admins=false`,`--admin` 永远能合,量它等于什么都没量。

## 四次测量

| # | 树上是什么 | head | `detect changes` | 四格 required | `mergeable` | `mergeStateStatus` |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 同 ①,但四格尚未上报 | `3dd4c77d2` | in_progress | (未上报) | true | **BLOCKED** |
| 1 | 修复前(原拓扑) | `3dd4c77d2` | **failure** | **全 skipped** | true | **UNSTABLE** |
| 2 | 修复后 | `658f9faab` | failure | **全 failure** | true | **BLOCKED** |
| 3 | 绕过(只留 `!cancelled()`,摘掉守卫步) | `5da7b22ad` | failure | **全 success** | true | **UNSTABLE** |
| 4 | 修复后(outputs 恒空那一支) | `4cbc51b56` | failure | **全 failure** | true | **BLOCKED** |

行 0 与行 1 是**同一个 commit**:四格还没上报时 `BLOCKED`,四格变成 `skipped` 之后转
`UNSTABLE`。**这就是「GitHub 把 skipped 记成已满足」的直接证据** —— 中间没有别的变量。

`UNSTABLE` = 「可合,只是有非必需的 check 没通过」,合并按钮是开的;`BLOCKED` = 分支保护
拦住。两次读取相互独立且一致(GraphQL 的 `mergeStateStatus` 与 REST 的 `mergeable_state`)。

行 1 的原始输出:

```
$ gh api repos/jinjunnn/alpha-code/pulls/908 --jq '{mergeable, mergeable_state}'
{"mergeable":true,"mergeable_state":"unstable"}

$ gh api repos/jinjunnn/alpha-code/commits/3dd4c77d2/check-runs
north-star guard (zero upstream edits)   conclusion=skipped
docs gate                                conclusion=skipped
typecheck (alpha packages)               conclusion=skipped
unit tests (alpha packages)              conclusion=skipped
seed assets present                      conclusion=skipped
detect changes                           conclusion=failure
```

⇒ **票面的怀疑成立。** 而且下游并不是「拿不到结论」,它们拿到了一个叫 `skipped` 的结论,
并且这个结论算「通过」。

## 行 3 是本次最贵的一条:只加 `!cancelled()` 会让情况更坏

把四个必需 job 加上 job 级 `!cancelled()`、但**不加**判据步,四格从灰色 `skipped` 变成
**绿色 `success`**,PR 回到可合。原因:`detect` 没给出结论时 `needs.detect.outputs.code`
是空串,job 里挂在 `== 'true'` 上的步骤仍然一步不跑,于是 job 零工作量报绿。
`docs gate` 更隐蔽 —— 它的链接检查无条件跑,`MD` 为空时打印
`no Markdown changed — docs gate is a no-op` 直接绿。

**灰色的谎话换成绿色的谎话,是退步不是修复。** 所以 `!cancelled()` 必须与
[`scripts/assert-detect-classified.sh`](../../scripts/assert-detect-classified.sh) 成对出现:
让 job 跑起来,只为了让它诚实地红。

## 顺带勘破:job 失败时,它的 `outputs` **仍然读得到**

行 2 的破坏步排在 classify **之后**,行 4 排在 classify **之前**。守卫步打印的实测值:

```
# 行 2(classify 跑过了,job 才失败)
unit tests (alpha packages)   detect: result=[failure] outputs.code=[true]
typecheck (alpha packages)    detect: result=[failure] outputs.code=[true]

# 行 4(classify 从未跑)
docs gate                     detect: result=[failure] outputs.code=[]
north-star guard …            detect: result=[failure] outputs.code=[]
unit tests (alpha packages)   detect: result=[failure] outputs.code=[]
typecheck (alpha packages)    detect: result=[failure] outputs.code=[]
```

⇒ **「detect 失败 ⇒ code 一定是空的」是假的。** job 失败之后 `needs.<job>.outputs` 照样
可读,取决于设值的那一步跑没跑过。

这直接决定了判据的形状:**只看 `needs.detect.outputs.code` 的守卫会在行 2 那一支放行**
(它读到的是 `true`,一个 `detect` 已经失败、没人担保还作不作数的值);
**只看 `needs.detect.result` 的守卫会漏掉「detect 退出 0 却没往 `$GITHUB_OUTPUT` 写 code」**
—— 而那正是 `scripts/detect-changed-scope.sh` 用 `${GITHUB_OUTPUT:?}` 专门防的那件事。
两个都要判,所以脚本两个都判。

## 落地成了什么

- [`scripts/assert-detect-classified.sh`](../../scripts/assert-detect-classified.sh) —— 判据本体。
  四个必需 job 各自的第一步跑它;`result != success` 或 `code ∉ {true,false}` 即非零退出。
- [`.github/workflows/alpha-ci.yml`](../../.github/workflows/alpha-ci.yml) —— 四个必需 job 加
  job 级 `if: ${{ !cancelled() }}` + 上面那一步。`typecheck` / `test` 的 checkout 随之改成
  无条件(判据步要先有仓库才跑得起来,约 5 秒,与 `upstream-guard` 的 checkout 同理);
  真正花时间的 install / typecheck / 测试仍然挂在 `code == 'true'` 上,**docs-only 快路径不变**。
- `seed assets present` **刻意不动**:它不是必需 context,`detect` 失败时它显示 `skipped`
  不会让任何东西被误判成通过。
- [`packages/ui-mac/src/main/local-gate-parity.test.ts`](../../packages/ui-mac/src/main/local-gate-parity.test.ts)
  —— 两条新判据(行为闸真跑生产脚本;接线闸钉住 `!cancelled()` + 那一步存在),
  并更正了 `NOT_REQUIRED_JOBS["detect changes"]` 里那条**与实测相反**的理由。

## 已知不修 / 边界

- **没有把 `detect changes` 加进分支保护。** 那要写仓外的 GitHub 设置(生产合并闸),
  不在实现票的处置范围;而且真源在仓外、CI 够不着(fork PR 拿不到 secrets),
  它能被单方面撤掉而仓内无一处变红。本修复整个住在仓内,受仓内测试保护。
  两者不互斥 —— owner 若要加,是纵深防御,不是替代品。
- **`enforce_admins=false`**:owner 用 `--admin` 本来每次都绕过分支保护。所以这个缺陷的真实
  伤害不是「PR 被偷偷合进去」,而是**这四格作为「结论」结构上无效**,以及仓里曾经有一条
  测试在为它背书。
- 接线闸(`!cancelled()` + 那一步在不在)断言的是 YAML 文本,按本仓定义是**减速带**不是闸门。
  「GitHub 上真的会红吗」只有这份文档里的实测答得了。
