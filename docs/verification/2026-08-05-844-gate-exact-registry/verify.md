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

改前实测:**51 条恰好相等、35 条有余量(合计 131 条用例处于可静默删除态)、0 条低于下界**。
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

## 五、残留(诚实登记)

- 精确条数守「条数」,不守「内容」:把断言掏空留壳(条数不变)不会红 —— 本票范围外的已知边界。
- 两个在途 PR 给同一闸门文件加用例会在 TSV 列 1 冲突 —— 设计意图(登记簿必须跟上事实),
  解法是重跑 `--update`(runbook 已写)。
- 本文所有数字的终判是 alpha-ci 在 ubuntu 上复跑 `assert gate files`;若某行在 CI 上与本文
  不一致,即为真实的环境差异候选,应按 `>=N [例外:…]` 具名登记而不是调数字。
