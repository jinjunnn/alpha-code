---
id: ADR-043
title: UPSTREAM_PATHS 里的 alpha 自有文件 —— north-star 守卫改用结构性谓词,不建逐文件清单
status: accepted
date: 2026-08-23
kind: adr
owners:
  - alpha-code
last_reviewed: 2026-08-23
review_after: 2027-08-23
related: [ADR-004, ADR-005, ADR-029, ADR-033, ADR-035, ADR-038, ADR-041, "alpha-code:#971", "alpha-code:#1079", "alpha-code:#1085"]
---

> **状态:accepted(owner 2026-08-23 在 [#1079](https://github.com/jinjunnn/alpha-code/issues/1079)
> 拍 `CHOICE=2`「结构性规则」)。** 本 ADR 不新增任何上游接管、不放宽北极星:它修的是守卫
> **辖区**的一处错划 —— 一批**从来不是上游的**文件被当成上游文件在守。

## 背景:那个豁免只在落地那一刻成立

我们有一批自己写的文件住在上游包目录里,因为它们必须住在那儿:引擎侧的闸门测试要能 import
被测模块([[ADR-035]] 的 `alpha-websearch-failure.test.ts`、[[ADR-038]] 的
`alpha-ask-deadline.test.ts`)、[[ADR-041]] 的 `ToolAliasLedger` 本体是 `packages/schema` 的一个
导出、[[ADR-033]] permission 收编带进来两条 Drizzle 迁移。

守卫看的是 `git diff --diff-filter=DMR`(删除/修改/改名)。**新增是 `A`,不触发** —— 所以这些
文件**落地那一次**是绿的。[[ADR-035]] §1、[[ADR-038]] 的 exclude 注释、[[ADR-041]] 第 72 行都据
此写下「新增文件不需要排除」。

**那句话只在落地那一刻为真。** 文件一旦进了 `origin/alpha`,以后任何修改都是 `M`,守卫当场红。
`#971` 的实测(2026-08-14,只读、无变异):

```
$ sha=$(git log --diff-filter=M --format=%h -1 -- packages/opencode/test/tool/alpha-tool-identity.test.ts)
98acf36f8
$ git diff --diff-filter=DMR --name-only ${sha}^..${sha} -- $UPSTREAM_PATHS "${EX[@]}"
packages/opencode/test/tool/alpha-tool-identity.test.ts
```

后果不是「多红一次」。**它红在最不该红的地方**:今天 UPSTREAM_PATHS 下的 16 个成员里,6 个是
`scripts/gate-files.tsv` 登记在册的闸门文件 —— 我们最需要维护的那批判据,恰好是最难改的那批。
而门红时最省事的反应是 `--no-verify`,那会把**所有**门一起关掉(`#754` 已经演过一遍:一道恒假红
的本地门等于一道关着的门)。

## 决策

**north-star 守卫用一条结构性谓词识别 UPSTREAM_PATHS 里的 alpha 自有文件,不建逐文件 exclude 清单。**

谓词 = 两个因子的**合取**,缺一不豁免。实现在
[`scripts/north-star-guard.sh`](../../../scripts/north-star-guard.sh),CI 与本地
`alpha-check.sh` 跑的是同一份字节(`#889`):

| 因子 | 内容 | 它单独挡住什么 |
| --- | --- | --- |
| ① 出身 | 这条路径在上游镜像 `origin/dev` 里**不存在** | `dev` 是上游纯镜像([[ADR-005]]),真上游文件按定义在它里面 |
| ② 自报家门 | basename 以 `alpha-` 开头,**或**文件里写着 `north-star:alpha-owned` | 上游文件既不遵守我们的命名约定,也不会带我们的 token |

**为什么必须是合取。** 两个因子各自都有一条能骗过它的路,而彼此正好互相盖住:

- **只有①**:`origin/dev` 是个会陈旧的 ref(守卫开跑前那条 fetch 实测约 3 次失败 1 次)。
  上游在陈旧窗口里新增一个文件、sync 又把它合进 alpha ⇒ 那个**真上游**文件在本地 dev 里同样
  「查不到」,于是被放行。
- **只有②**:上游哪天新增一个 `alpha-*.ts`,或正文里恰好出现那个 token,就自动拿到豁免。
- **合取之后**:要骗过它得同时满足「dev 陈旧到看不见它」**和**「它叫 alpha-* / 带着我们的
  token」。把 token 抄进一个真上游文件不管用 —— ①会否掉它,因为 dev 里有这条路径。

**`--no-renames` 是判据的一部分,不是风格。** 默认开着的改名检测把一次改名压成一条 `R`,而
`--name-only` 对 `R` **只印目的路径**。于是「把上游文件改名成 `alpha-foo.ts`」在谓词里两个因子
全中、被当成 alpha 自有放行,而上游那条路径其实已经消失(fork-sync 照样冲突)。关掉改名检测后,
同一次改名回到 `D`(旧路径)+ `A`(新路径),`D` 落进 DMR 被点名,点的还正好是真正受害的那条路径。

**豁免必须被打印出来。** 一次静默的放行与一次没跑的门在输出上长得一模一样,而这道门的整个价值
就在于「它今天绿」这句话有确定含义(`#913` 同一条纪律)。守卫因此把每一条被判为 alpha 自有的
路径逐条印出来。

### 新成员怎么进来

- **命名成 `alpha-*`** —— 零仪式,零登记,谓词自动覆盖。新增闸门测试一律走这条。
- **名字不能改的**(Drizzle 迁移的时间戳名、被 import 的模块名)—— 在文件里写一行
  `north-star:alpha-owned` 注释。本 ADR 落地时给 6 个存量成员补了这一行:
  `packages/core/src/database/migration/2026072008*_permission-decision-receipt.ts` 与
  `…094009_permission-request-admission.ts`、`packages/opencode/src/session/tool-display.ts`、
  `packages/schema/src/agent-id.ts`、`packages/schema/src/tool-identity.ts`、
  `packages/sdk/js/test/permission-decision-command.test.ts`。
- 两条都不做 ⇒ 第一次修改就红,并在红的那一行告诉你这两条出路。**这是可操作的失败**,不是
  `#971` 描述的那种「在门红之前没有任何东西告诉你」。

### 判据(按 [[ADR-037]] 决策 4:只认端到端可观测行为)

`packages/ui-mac/src/main/north-star-guard.test.ts` 起**真 git 仓**、造**真的**改动、跑
**生产的那份脚本**,断言它的退出码与它点名了谁 —— 不断言脚本源码文本(按本仓定义那是假闸门)。
本 ADR 加 8 条,逐条对应一个方向,并做了反向变异实测:

| 变异(把实现改回错的形状) | 转红的用例数 |
| --- | --- |
| 谓词整体失效 | 3 |
| 只看因子①(出身) | 1 —— 「dev 里没有但没自报家门 ⇒ 红」 |
| 只看因子②(命名/marker) | 2 —— 「真上游 + alpha-* 名」「伪造 marker」 |
| 去掉 `--no-renames` | 1 —— 改名那条(该条自带控制组:去掉后的复制品必须**绿**,证明夹具测得出这个已知的坏) |
| 镜像 ref 取不到时改为放行 | 2 |
| 豁免不打印 | 2 |
| marker 的读法换回 `cat 文件 \| grep -q`(管道 + `pipefail`) | 1 —— 大文件里 `grep -q` 命中即退出、写端吃 SIGPIPE ⇒ 退出码 141 ⇒「找到了」被读成「没找到」(实测 141)。方向是假红不是放行,但它取决于文件多大、marker 在第几行,属于不可复现门,故该条夹具真的是 4MB |

登记在 `scripts/gate-files.tsv`(精确条数 18,不留余量)。

## 边界(诚实登记,不谎称穷尽)

1. **`origin/dev` 整个 ref 取不到 ⇒ 豁免整体停用(fail-closed)**,回到本谓词之前的行为:
   UPSTREAM_PATHS 下每一处改动都算上游改动。方向安全(过报,不漏报),且守卫会把这件事印出来。
   反方向(「查不到镜像就当 alpha 自有」)会让守卫对全部上游改动失明,是这道门能犯的最贵的错。
2. **`origin/dev` 陈旧**时因子①会误判**新来的**上游文件为「不在镜像里」。这正是因子②存在的
   理由;守卫在 fetch 失败时会把镜像的 sha 与年龄一并报出来,读得出这一跑的镜像有多旧。
3. **上游删掉、而 alpha 留着的文件**:①成立,所以它要拿豁免仍需②(得有人显式标记)。这是
   刻意的 —— 那种文件的处置该是一次显式决定,不是一条自动规则。
4. **谓词判的是路径,不是内容**:它回答「这条路径是不是上游的」,不回答「这次改动对不对」。
   alpha 自有文件的改动照常受 typecheck / 各自闸门 / review 管。
5. **它不是一次收编。** [[ADR-029]] §3 管的是「把**上游的**文件挪到 alpha 主权下」;本 ADR
   的对象是**从来不是上游的**文件,不放弃任何白嫖面、没有单向门、无需回退通道。真正的收编
   仍然逐条走 `UPSTREAM_EXCLUDES` + 自己的 ADR,**一条都没动**。

## 被否决的方案

- **逐文件 exclude 清单(`#1079` CHOICE=1)**:owner 否决。清单对**新成员默认放行** —— 每来一个
  新文件都要再走一轮「有 ADR 的收编」,而在有人去走之前,它的第一次修改照样红。它还会把
  `UPSTREAM_EXCLUDES` 这张「有意收编」的表稀释成两种语义混装(收编的上游文件 + 从来不是上游的
  文件),下一个读它的人分不出哪条是单向门。
- **只按命名(`alpha-*`)判**:上游新增一个同名形状的文件就自动获得豁免;守卫的辖区不该由一条
  我们单方面约定、上游不知道的命名规则单独决定。
- **只按 `origin/dev` 出身判**:陈旧 ref 会让新来的真上游文件走同一条路(见边界 2)。
- **把这些文件搬出 UPSTREAM_PATHS**:引擎侧闸门测试要 import 被测模块,`ToolAliasLedger` 是
  `packages/schema` 的导出,迁移必须在引擎的迁移目录里 —— 搬走等于把判据搬离被判对象。

## 后果

- ✅ 「给自己写的判据补一条用例」不再需要一轮 owner 级 ADR 修订,`--no-verify` 那条捷径的
  最大诱因消失。
- ✅ 新成员**默认被覆盖**:命名合约定的零仪式,不合的第一次修改就拿到一条可操作的提示。
- ✅ 守卫的输出第一次说得出「我把哪些路径判成了 alpha 自有」——豁免不再是静默的。
- ✅ 顺带修掉一个既有漏洞:`--no-renames` 之前,把上游文件改名后 `--name-only` 只印目的路径,
  报告点的是新名字而不是真正消失的那条路径。
- ⚠️ 守卫多了一个依赖:`origin/dev` 这条 remote-tracking ref。它在任何正常 clone 里都有
  (CI 的 `actions/checkout` 用 `fetch-depth: 0`),守卫自己也会 best-effort fetch 它;取不到时
  fail-closed 并说出来。
- ⚠️ [[ADR-035]] / [[ADR-038]] 的 exclude 注释里那句「新增文件不触发 `--diff-filter=DMR`,无需
  exclude」,自本 ADR 起才**永久**为真(它们点名的都是 `alpha-*` 命名的文件,因子②天然成立)。
  在本 ADR 之前,那句话只在落地那一刻成立 —— [[ADR-041]] 第 72 行已就此补上带日期的订正块。
