---
title: "#844 —— 闸门登记簿精确条数化的实施验证(含两个方向的绕过实验)"
kind: verification
owners:
  - alpha-code extension maintainers
last_reviewed: 2026-08-05
review_after: 2026-11-05
---

`#844` 的类级修复:`scripts/gate-files.tsv` 第 1 列从「留 ~20% 余量的下界」改为**精确条数**
(`scripts/bun-test-floor.sh` 新增 `=N` 精确模式;`scripts/assert-gate-files.sh` 默认精确、
`>=N` 为必须具名的例外、`--update` 单一写回入口)。本文记录完整枚举、写回、以及每一道新
判定的**实际绕过实验**(改坏 → 亲眼看红 → 恢复)。

## 环境与纪律(诚实声明)

- 基线:`origin/alpha` head `566b76a`(#739 merge),分支 `claude/issue-844-readonly-audit-d6fe00`。
- 所有测量与绕过实验跑在**同 commit 的隔离工作树**上、以**非 root 用户**执行(容器默认 root
  会让 `ext-config.test.ts` 的「chmod 000 后不可读 → fail-closed」用例前提失效;非 root 下
  87/87 全绿)。隔离树相对本分支只有两处**环境替身**,均与任何闸门无关且不进本 PR:
  `ghostty-web`(github 依赖,本会话无该仓访问授权;仅被上游终端组件 lazy import)与
  `@solidjs/start`(pkg.pr.new 依赖,仅上游 enterprise 叶消费)以空 stub 安装。
- 批跑纪律:一律 `bash -c` 起跑、日志一律 `grep -a`;每次全量扫核对
  `Ran N tests across M files`:**87 个 entry、87 条 summary、全部 `across 1 file`**。
- 权威终判 = alpha-ci 的 `assert gate files` 步在 ubuntu 上复跑同一登记簿。

## 一、完整枚举(#844 勘破第一步,87 条全量)

改前实测:**52 条恰好相等、35 条有余量(合计 131 条用例处于可静默删除态)、0 条低于下界**。
35 条余量清单即本 PR 中 `scripts/gate-files.tsv` 的 35 行数字 diff(从 +1 到 +11,最大
`ext-package-ledger-v3` 19→30 —— 该行 guarantee 此前明写「不留余量」;`ext-import-validate`
23→29 同为「不留余量」已食言行)。与 Codex 独立复算(2026-08-04,工作树 `47f929bb`)重叠的
11 个数字**逐个相等**,两条独立测量轴一致。

范围/环境例外判定:**零条**。87 个 host 文件对
`skipIf / .todo / process.platform / os.platform()` 全零命中;全部 `.each`/循环注册迭代的
是仓内数据(vendored 语料、源码扫描、固定 seed),条数逐 commit 确定;#777 平台档只改子
进程内自陈,host 条数不变。故登记簿当前没有任何 `>=N` 行 —— 例外语法与「必须具名」判定
仍实现并已验证(见 V3-D/V3-E)。

## 二、写回与全绿

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 写回 | `bash scripts/assert-gate-files.sh --update` | exit 0,`✓ 已按实测写回 35 行` —— 与枚举逐行一致 |
| 全绿(check 模式) | `bash scripts/assert-gate-files.sh` | exit 0,`✓ 87 个闸门文件全部在位且真的跑过(条数与登记精确一致)`;#828 的 7 条闸落在 `package-envelope-v1` 的精确 90 之内 |
| 幂等 | 未变树再跑 `--update` | exit 0,`✓ 登记簿与实测一致(87 条),零改动`;TSV sha256 前后逐字节相同(`1e51c464…`) |

## 三、绕过实验(每道判定各改坏一次,亲眼看红,随后恢复)

一次合并红扫同时施加 5 个互不干扰的 mutation,`bash scripts/assert-gate-files.sh` → **exit 1**:

| # | 改坏了什么 | 结果(日志原文摘录) |
| --- | --- | --- |
| A 删一条(方向一,ui-mac 包,#828 所在文件) | `package-envelope-v1.test.ts:743` 的 `test(` → `test.skip(` | `实际 89 条 < 登记 90 条:有用例被删除/清空/skip 掉了` —— 当场红。**级联纵深**:`req128-capability-matrix` 的「evidence 必须是真 test() 声明」闸同轮独立变红 |
| B 删一条(方向二,ext 包 —— 另一个包) | `prompt-rebrand.test.ts:35` 的 `test(` → `test.skip(` | `实际 25 条 < 登记 26 条` —— 当场红(两个方向都被执行过,不是只测了一半) |
| C 加一条不登记 | `alpha-contract-health.test.ts` 末尾追加一条恒过用例 | `实际 2 条 > 登记 1 条:新增用例还没登记,现在它们可以被静默删掉` —— **对新增默认保护**成立 |
| D 例外不具名 | contracts 行 `22` → `>=22`,guarantee 不加理由 | `登记为范围例外(>=22)但 guarantee 缺少 [例外:理由] —— 例外必须具名,不许静默退回下界` |
| E 例外具名(对照组,应绿) | `sidecar-ready-message` 行 `3` → `>=3` + guarantee 加 `[例外:…]` | 该行按下界语义照常**绿**(`✓ 3 条断言真的执行了`)—— 「什么都拒」的错误实现过不了这组 |

入口级判定(直接对 `scripts/bun-test-floor.sh`):

| 探针 | 命令 | 结果 |
| --- | --- | --- |
| 精确模式过滤器过宽 | `bash scripts/bun-test-floor.sh "=12" packages/ui-mac src/shared/route-` | exit 1,`精确模式要求恰好点名 1 个文件,实际匹配了 5 个` |
| 精确模式点名不存在的文件 | `… "=5" packages/ui-mac src/main/no-such-file-844.test.ts` | exit 1(bun 对无匹配报错;即便 exit 0 也会撞 M==1 判定) |
| `--update` all-or-nothing | 给 `contracts.test.ts` 追加一条必炸用例后跑 `--update` | exit 1,`--update 中止:… 测试失败 —— all-or-nothing,一条都不写回`;TSV sha256 前后相同 |

每次实验后以备份副本恢复被改文件,随后的幂等跑(上表)证明恢复干净。

## 四、兼容面(为什么现有闸不受影响)

- 裸数字 `N` 的下界语义与输出行**逐字未动**:受保护的 `gate-environment.test.ts:74-79` 直接
  调 `bun-test-floor.sh 3 …` 并断言 `Ran 3 tests across 2 files` + `3 条断言真的执行了`,
  在 V1 全绿扫里原样通过;CI 整包地板(3000/100/15)不受影响。
- 87 个受保护测试文件零改动(绕过实验的临时 mutation 均已恢复,只存在于隔离树)。
- `gate-file-registry.test.ts` / `req128-capability-matrix.test.ts` 对 TSV 只读
  workdir/path/delegates 列,列 1 语义变化不涉及;两者均在 V1 全绿扫中通过。

## R2(2026-08-05,Codex 二审 Blocker —— 测量路径漏了「恰好 1 个文件」判定,已修)

**Blocker 成立并已逐字复现**:R1 版把 M==1 判定只挂在 `=N` 精确模式上,而 `--update` 对精确行
以 `run_spec=0`(下界模式)测量 —— 过宽的路径过滤器会把**跨文件合计数**当单文件实测写回。
复现(修复前):`ALPHA_TEST_COUNT_FILE=/tmp/count bash scripts/bun-test-floor.sh 0
packages/ui-mac src/main/ext-package-lifecycle` → `47 pass` / `Ran 47 tests across 2 files`
(lifecycle 26 + permutations 21)、exit 0、count 文件被写成 47。

**修法**(`scripts/bun-test-floor.sh`):「恰好 1 个文件」判定上移为**精确模式 ∨ 测量模式
(count 文件置位)**共用,且判定失败先于写 count 文件(量错对象的数字零字节流出)。

**修复自身引出的第二个坑(P3 首跑抓到,一并修)**:`ALPHA_TEST_COUNT_FILE` 会顺着 env 继承进
被测用例自己 spawn 的 `bun-test-floor.sh` —— `gate-environment.test.ts` 形状 B 恰好以**双文件
下界模式**合法调用本脚本,于是 `--update` 量到它时其内部子调用被 M==1 误杀(受保护测试在测量
路径上假红)。修法:测量契约只属于本次调用,读入后立刻 `unset`,子进程零继承(顺带消除子调用
覆写父测量值的通道)。

复验(全部实施):

| 探针 | 结果 |
| --- | --- |
| P1 过宽路径测量(Codex 原式) | exit 1,`精确/测量模式要求恰好点名 1 个文件,实际匹配了 2 个`,count 文件**未写** |
| P2 `--update` 端到端(TSV 行 path 改成 `src/`,命中 3 文件) | 第 1 条即中止,`all-or-nothing,一条都不写回`,TSV sha 前后相同 |
| gate-environment 单条测量 | exit 0,count=1(受保护测试的合法双文件子调用不再被误杀) |
| P3b 全量 `--update` 幂等 | exit 0,`✓ 登记簿与实测一致(87 条),零改动`,sha 逐字节同 |
| P4b 全量 check 绿扫 | exit 0,`✓ 87 个闸门文件全部在位且真的跑过(条数与登记精确一致)`,87 条 summary 全部 `across 1 file` |

## R3(2026-08-05,Codex 三审 —— --update 从不查行级校验红,已修)

**发现成立**:行级校验失败(登记簿格式坏行 / delegates 列空 / `>=N` 无理由 / 条数列非法,
`assert-gate-files.sh` 四个校验点)只置 `failed=1` 就 `continue`,而 `--update` 分支在写回/
报成功前**从不看它** —— 末端的 `[ "$failed" -eq 0 ] || exit 1` 只在 check 模式可达。后果:
登记簿自身坏了一行时,`--update` 静默跳过该行、把其余行照写照报 exit 0。

**修法**:`--update` 分支在任何写回判断之前先查 `failed` —— 非法行存在即
`--update 中止:登记簿存在非法行 …… all-or-nothing,一条都不写回`,exit 1。

**复验(四个校验类全部实施,零写回逐一以 TSV sha256 证明)**:

| 探针 | 植入 | 结果 |
| --- | --- | --- |
| R3-probe(三类合并) | contracts 行 `>=22` 无理由 + git-cross-repo 行条数 `8x` + 坏行 `99` | exit 1;两条行级具名红(`例外必须具名` / `条数列非法:8x`)当场打印;TSV 零写 |
| R3-b(delegates 真空) | model-catalog 行截断成 4 列(尾随 tab) | exit 1;行级具名红 `delegates_to 列为空 —— 没有委派请显式写 '-'`;TSV 零写 |
| R3-d(坏行,直接命中新闸) | 追加仅有条数列的 `99` 行 | exit 1;87 条全量测量后行级红 `登记簿格式错误:99`,**新 post-loop 闸**以 `--update 中止:登记簿存在非法行 …… 一条都不写回` 收口;TSV 零写 |
| 干净幂等复跑 | 无 | exit 0,`✓ 登记簿与实测一致(87 条),零改动`,sha 逐字节同 |

**分层事实(如实登记,不装单层全能)**:bash `read` 以 tab 为 IFS 时**连续 tab 会折叠**,
「五列中间某列为空」在行内不可表示 —— 双 tab 形态的坏行会把 guarantee 读进 delegates 列,
脚本行级校验看不出;这类形变由**登记簿完备性测试**(`gate-file-registry.test.ts`,自身在册,
JS `split("\t")` 不折叠)在测量途中判红,经既有「测试失败即中止」路径同样收口(R3-probe 与
R3-b 的中止点即它)。两层合起来:任一形态的登记簿损坏在 `--update` 下都是 exit 1 + 零写回。

## R4(2026-08-05,Codex 四审 —— 零条登记与空理由例外可绕过,已修)

**发现成立**:行级校验只检查条数列是不是数字,因此人工登记 `0` 会把「空文件/零断言」
重新认证成闸门;范围例外又只查 guarantee 是否出现 `[例外:` 前缀,`[例外:]` 与未闭合的
`[例外:未闭合` 都会冒充「具名 + 有理由」。两条都违反本票自己的默认拒语义。

**修法**(`scripts/assert-gate-files.sh`):登记值统一要求 `> 0`;`>=N` 的 guarantee 必须含
完整且非空的 `[例外:理由]`。没有引入新模式,不改变精确/范围比较、`--update`、重试或
任何受保护测试。

**谓词探针**(以脚本同一 Bash ERE/数值条件执行):

| 输入 | 结果 |
| --- | --- |
| `[例外:跨平台条数会变化]` | accept |
| `[例外:]` | reject |
| `[例外:未闭合` | reject |
| 登记值 `0` | reject:空文件/零断言不能成为闸门 |

## R5(2026-08-05,Claude Web 独立审计 + Codex 终修 —— 主键唯一与例外理由收严)

独立审计在当前 PR 上发现两条可达的默认拒缺口,另抓到本文枚举算术笔误:

1. 登记簿若出现重复 `(workdir,path)`,`--update` 的 awk 会按同一 key 同时改写两行;若其中一行
   是 `>=N` 例外,还会被静默改成精确数字。
2. R4 的 `[例外:[^]]+]` 仍接受纯空白理由,也可能把后续无关的 `]` 当作当前 marker 的闭合。
3. 本文「51 + 35 + 0」与总数 87 不相等;基线实测的未变化行应为 52。

**修法**:`scripts/assert-gate-files.sh` 以 Bash 3.2 可用的临时文件钉住 `(workdir,path)` 唯一,
check / `--update` 两种模式都默认拒绝重复;`gate-file-registry.test.ts` 同时把仓内真实登记簿的
唯一性纳入自身闸(10 条)。例外 marker 改成不允许理由跨过 `[` / `]`,并要求捕获的理由至少含
一个非空白字符。本文枚举值同步更正为 52。没有改比较模式、重试策略或生产代码。

**独立最小 harness 反向探针**(stub 只回报 1 条,不依赖仓库其余 86 个闸门):

| 探针 | 结果 |
| --- | --- |
| 同一 `(workdir,path)` 同时登记 `1` 与 `>=1` 后跑 `--update` | exit 1,具名红 `登记簿重复路径`;TSV sha256 前后同为 `709fdf51…`,零写回 |
| `[例外:   ]` | exit 1,具名红 `理由有非空白字符` |
| `[例外:未闭合 [说明]` | exit 1,后续 marker 的 `]` 不再替前一个 marker 闭合 |
| `[例外:跨平台条数会变化]` 对照 | exit 0,26/26 放行 |
| 仓内登记簿完备性窄测 | 10 pass / 0 fail,含主键唯一性新断言 |

## 五、残留(诚实登记)

- 精确条数守「条数」,不守「内容」:把断言掏空留壳(条数不变)不会红 —— 本票范围外的已知边界。
- 两个在途 PR 给同一闸门文件加用例会在 TSV 列 1 冲突 —— 设计意图(登记簿必须跟上事实),
  解法是重跑 `--update`(runbook 已写)。
- 本文所有数字的终判是 alpha-ci 在 ubuntu 上复跑 `assert gate files`;若某行在 CI 上与本文
  不一致,即为真实的环境差异候选,应按 `>=N [例外:…]` 具名登记而不是调数字。
