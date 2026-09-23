#!/usr/bin/env python3
"""known-fails-compare — base fail-set 棘轮的判官(#1086)。

被 scripts/bun-test-floor.sh 在 ALPHA_KNOWN_FAILS_FILE 置位时调用(今天只有两处:
alpha-check.sh 第 [5/10] 步的 ui-mac 全量,与 alpha-ci `bun test (ui-mac)` —— 同一条命令)。
职责只有一个:回答「这次运行的红,是不是全部落在仓内那份静态清单里」。

  · 清单内的红 → 容忍(放行,但逐条打出来 + 附清单里的理由);
  · 清单外的红 → exit 1,逐条点名(AC2/AC3①);
  · 清单里登记、但本次没失败 → 不拦,提示清单可缩短(AC3②,棘轮只朝收紧方向自动走);
  · **整份文件加载期夭折** → exit 1,**按文件点名**,且清单结构上不吸收(`#1423`,见下);
  · 其余「无法逐测试归因」的失败 → exit 2 测量作废,拦住(fail-closed)。

`#1423`:一个测试文件在**链接期/模块顶层**就抛,bun 不会为它写任何 junit `<testsuite>`,
console 里也不会有 `(fail) ` 行 —— 它只让 `N fail` 与 `N errors` 各加一,并打印一段
`# Unhandled error between tests`。此前判官因此只能落到「junit 失败数 ≠ console 总结」那条
作废分支:**拦住了,但说不出是哪个文件**,于是这一类状态对棘轮是结构性失明的
(三个 ui-mac 文件在这个状态里躺了很久,几十条断言一条没跑而没有任何东西点得出它们的名字)。
现在 console 里的夭折块按「紧邻其上的文件头行」归因,进入判决并**逐个点名**。

为什么夭折**不许**被 scripts/known-fails.tsv 吸收:一个加载不起来的文件里**没有**可归因的用例,
登记它等于让棘轮对整份文件永久失明 —— 比今天的「拦住但说不出名字」更坏。所以它是一条
独立的、不可登记的拦截路径。

失败名的权威来源是 junit XML(--reporter=junit),不是 console 文本 —— 本仓的 host 测试
会把子进程 bun run 的 `(fail)` 行与 summary 原样回显进外层日志(实测 base 上就有一条
`Ran 14 tests across 1 file / 1 fail` 嵌在 ui-mac 全量输出里),裸 grep console 会把
子进程的红当成外层新红。junit 只由外层进程写,结构上没有这个污染面。
但观测手段自己要先被证明(《观测手段自己有盲区》),所以有两条交叉轴,任一不合即作废:
  ① junit 失败条数 == console 最后一行 `N fail` 总结(外层 summary 恒最后打印);
  ② junit 重建出的每个显示名,必须能在 console 的 `(fail) ` 行里找到 ——
     bun 1.3.14 的 junit classname 是**内→外倒序**且把 `>` 双重转义成 `&amp;gt;`
     (实测,勘破记录见 alpha-code#1086),重建做了反转与二次反转义;bun 换版本后
     这两个怪癖若变,这条轴当场把测量判作废,而不是安静地重建出错误的名字。

本脚本对清单**只读**。没有 --update、没有任何写回:清单加长只能发生在人手写的 diff 里
(AC4 —— 运行时收编新红 = 棘轮反向,比没有清单更坏)。

用法:known-fails-compare.py <junit.xml> <known-fails.tsv> <bun-exit-code> <console.log>
退出码:0 = 零清单外新红(可继续走条数下界);1 = 清单外新红;2 = 测量作废/清单不合形。
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


# `#1423`:整份文件加载期夭折的显示名。它不是 bun 给的名字(bun 一个名字都没给),
# 而是本判官为「这个文件本次一条用例都没执行」造的一个**稳定**的点名标签。
LOAD_ABORT_DISPLAY = "<整份文件加载期夭折:一条用例都没执行>"

ABORT_MARKER = "# Unhandled error between tests"
# bun 在每个**产生过输出**的测试文件前打一行 `<相对路径>:`。夭折块紧跟在它自己那一行之后
# (实测 bun 1.3.14:链接失败的文件连自己的 console.log 都来不及打,所以这一行之后就是夭折块)。
# 只认 bun 自己认的测试文件名形(.test./.spec./_test_/_spec_),不认任意以冒号结尾的日志行。
FILE_HEADER_RE = re.compile(r"^(\S*(?:\.test\.|\.spec\.|_test_|_spec_)[cm]?[jt]sx?):$")


def die(code: int, msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(code)


def void(msg: str) -> None:
    die(2, f"测量作废:{msg}")


def parse_list(path: str) -> dict[tuple[str, str], str]:
    """三列 TAB:<file> <test 显示名> <为什么还红着/对应 Issue>。AC5:第三列不许空。"""
    p = Path(path)
    if not p.is_file():
        void(f"known-fails 清单不存在:{path}")
    entries: dict[tuple[str, str], str] = {}
    for ln, raw in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        cols = raw.split("\t")
        if len(cols) < 3 or not cols[0].strip() or not cols[1].strip() or not cols[2].strip():
            void(
                f"清单第 {ln} 行不合形:需要 TAB 分隔的 <file> <test> <why/issue> 三列且逐列非空"
                f"(AC5:不许只有测试名)—— {raw!r}"
            )
        key = (cols[0].strip(), cols[1].strip())
        if key[1] == LOAD_ABORT_DISPLAY:
            void(
                f"清单第 {ln} 行登记了「整份文件加载期夭折」({key[0]})—— 这一类结构上不许登记(`#1423`):"
                "那个文件里一条用例都没执行,登记它等于让棘轮对整份文件永久失明。修掉加载错误本身"
            )
        if key in entries:
            void(f"清单第 {ln} 行重复登记:{key[0]} :: {key[1]}")
        entries[key] = cols[2].strip()
    return entries


def parse_aborts(log_text: str) -> tuple[list[tuple[str, str]], int]:
    """console 里的「整份文件加载期夭折」块 → [(file, 首行错误)],外加归因不到文件的块数。

    归因规则:紧邻其上的那一行文件头。归因不到 ⇒ 计入 orphan,由调用方判作废(fail-closed)——
    「数出来几个」和「说得出是谁」是两件事,后者才是本函数存在的理由。
    """
    lines = log_text.splitlines()
    current: str | None = None
    aborts: list[tuple[str, str]] = []
    orphan = 0
    for i, line in enumerate(lines):
        m = FILE_HEADER_RE.match(line.strip())
        if m:
            current = m.group(1)
            continue
        if line.strip() != ABORT_MARKER:
            continue
        detail = ""
        for nxt in lines[i + 1 : i + 8]:
            t = nxt.strip()
            if not t or set(t) == {"-"}:
                continue
            detail = t
            break
        if current is None:
            orphan += 1
        else:
            aborts.append((current, detail))
    return aborts, orphan


def parse_junit_suites(path: str) -> dict[str, int]:
    """[(file → 该文件落进 junit 的用例数)]。夭折的文件在 junit 里**连 testsuite 都没有**。"""
    p = Path(path)
    if not p.is_file() or p.stat().st_size == 0:
        return {}
    try:
        root = ET.parse(p).getroot()
    except ET.ParseError:
        return {}
    return {
        (ts.get("file") or ts.get("name") or ""): len([c for c in ts if c.tag == "testcase"])
        for ts in root.iter("testsuite")
    }


def report_aborts(aborts: list[tuple[str, str]], suites: dict[str, int]) -> None:
    print(f"::error::整份文件加载期夭折 {len(aborts)} 个 —— 这些文件本次**一条用例都没执行**:")
    for f, detail in aborts:
        ran = suites.get(f)
        where = "junit 里完全没有它" if ran is None else f"junit 里只有 {ran} 条"
        print(f"::error::  ✗ {f} :: {LOAD_ABORT_DISPLAY}  ({where})")
        if detail:
            print(f"::error::      ↳ {detail}")
    print(
        "::error::这一类**不被 scripts/known-fails.tsv 吸收**:加载不起来的文件里没有可归因的用例,"
        "登记它等于让棘轮对整份文件永久失明。修掉加载错误本身(#1423)。"
    )


def unescape_gt(s: str) -> str:
    # bun 1.3.14 把 classname 里的分隔符 `>` 写成 `&amp;gt;`;ET 解析剥掉一层,这里剥第二层。
    return (s or "").replace("&gt;", ">")


def parse_junit(path: str) -> list[tuple[str, str]]:
    """返回 [(file, 显示名)]。显示名 = describe 链(外→内)+ 测试名,与 console (fail) 行同形。"""
    p = Path(path)
    if not p.is_file() or p.stat().st_size == 0:
        void(
            "junit 报告缺失/为空 —— bun 没有完成一次可逐测试归因的运行"
            "(模块加载崩溃就是这个形状,实测它 console 报 `1 fail` 而 junit 一个字节不写)。"
            "清单不吸收这种失败。"
        )
    try:
        root = ET.parse(p).getroot()
    except ET.ParseError as e:
        void(f"junit 报告解析失败:{e}")
    fails: list[tuple[str, str]] = []
    for tc in root.iter("testcase"):
        if not any(child.tag in ("failure", "error") for child in tc):
            continue
        name = unescape_gt(tc.get("name") or "")
        cls = unescape_gt(tc.get("classname") or "")
        segments = [s for s in (seg.strip() for seg in cls.split(" > ")) if s] if cls.strip() else []
        segments.reverse()  # bun 1.3.14:classname 内→外倒序(实测);交叉轴②盯着这一步
        display = " > ".join([*segments, name])
        fails.append((tc.get("file") or "", display))
    return fails


def main() -> None:
    if len(sys.argv) != 5:
        void(f"参数错误:期望 <junit.xml> <known-fails.tsv> <bun-exit-code> <console.log>,收到 {sys.argv[1:]}")
    junit_path, list_path, status_raw, log_path = sys.argv[1:5]
    try:
        status = int(status_raw)
    except ValueError:
        void(f"bun 退出码不是数字:{status_raw!r}")

    entries = parse_list(list_path)  # 清单不合形先于一切 —— 绿跑也要拦(默认拒不迟到)

    logp = Path(log_path)
    if not logp.is_file():
        void(f"console 日志缺失:{log_path}")
    log_text = logp.read_text(encoding="utf-8", errors="replace")

    # `#1423`:夭折先于 junit 解析 —— 整份文件夭折时 bun 可能**一个字节的 junit 都不写**
    # (夭折的是唯一那个文件时就是这样),而那正是最需要说出「是哪个文件」的一刻。
    # 归因不到文件的夭折块 ⇒ 仍然作废(fail-closed):数得出个数不等于说得出名字。
    aborts, orphan_aborts = parse_aborts(log_text)
    if orphan_aborts:
        void(
            f"console 里有 {orphan_aborts} 个「{ABORT_MARKER}」块归因不到文件 —— "
            "夭折块与其上的文件头行对不上(bun 输出格式变了?),本次测量作废"
        )
    junit_suites = parse_junit_suites(junit_path)
    junit_missing = not Path(junit_path).is_file() or Path(junit_path).stat().st_size == 0
    if aborts and junit_missing:
        report_aborts(aborts, junit_suites)
        sys.exit(1)

    fails = parse_junit(junit_path)

    # 交叉轴①:条数。外层 summary 恒最后打印(与 bun-test-floor.sh 取 pass 数同一条既有假设)。
    fail_counts = re.findall(r"^\s*(\d+) fail$", log_text, re.M)
    if not fail_counts:
        void("console 里没有 `N fail` 总结行 —— 观测手段自身失效,先证明手段再谈结论")
    console_fail = int(fail_counts[-1])
    # `#1423`:bun 把每个夭折的文件也算进 `N fail`(同时 `N errors` 加一),而 junit 里没有它 ——
    # 这条等式此前两侧不平就只能作废;把夭折算进来之后,剩下的不平仍然作废。
    if console_fail != len(fails) + len(aborts):
        void(
            f"junit 失败 {len(fails)} 条 + 整份文件夭折 {len(aborts)} 个 ≠ console 外层总结 "
            f"{console_fail} fail —— 两条测量轴打架(bun 输出格式变了?),不许拿其中一条下结论"
        )
    if status != 0 and not fails and not aborts:
        void(f"bun 退出码 {status} 但 junit 零条失败 —— 失败无法逐测试归因,清单不吸收")
    if status == 0 and (fails or aborts):
        void(f"bun 退出码 0 但 junit 报 {len(fails)} 条失败 / {len(aborts)} 个文件夭折 —— 仪器自相矛盾")

    # 交叉轴②:每个重建名必须真的出现在 console 的 (fail) 行里(名字保真度的活绊线)。
    fail_lines = [line for line in log_text.splitlines() if line.startswith("(fail) ")]
    for _file, display in fails:
        if not any(display in line for line in fail_lines):
            void(
                f"junit 重建的失败名在 console 的 (fail) 行里找不到:{display!r} —— "
                "倒序/转义重建与真实输出对不上(bun junit 格式变了?),本次测量作废"
            )

    # R1 Major-1(#1086 审计):junit fails 里同一 (file, display) 出现多条、而该键又登记在
    # 清单里 ⇒ 一条清单行会把同名的**全新**红一并吸收(set 去重塌缩,两条交叉轴都拦不住:
    # 条数轴两侧同为 2,名字轴两条 (fail) 行文本相同)。同名用例无法逐条归因 —— 测量作废,
    # fail-closed。自绕推演:改名逃逸 ⇒ 变 unlisted 照拦;保持重名 ⇒ 恒作废。
    dup_counts: dict[tuple[str, str], int] = {}
    for key in ((f, d) for f, d in fails):
        dup_counts[key] = dup_counts.get(key, 0) + 1
    for key, n in sorted(dup_counts.items()):
        if n > 1 and key in entries:
            void(
                f"同一 (file, test) 有 {n} 条失败且该键登记在清单里:{key[0]} :: {key[1]} —— "
                "同名用例无法逐条归因(一条清单行不得吸收多条同名红)。给用例改成可区分的名字再跑"
            )

    fail_keys = {(f, d) for f, d in fails}
    unlisted = sorted(fail_keys - set(entries))
    tolerated = sorted(fail_keys & set(entries))
    stale = sorted(set(entries) - fail_keys)

    if aborts:
        report_aborts(aborts, junit_suites)
    if unlisted:
        print(f"::error::清单外新红 {len(unlisted)} 条 —— 不在 base fail-set(scripts/known-fails.tsv)里,拦住:")
        for f, d in unlisted:
            print(f"::error::  ✗ {f} :: {d}")
        print(
            "::error::修掉它;若它确属既有基线,把它连同「为什么还红着」写进 scripts/known-fails.tsv "
            "并让评审在 diff 里读到 —— 清单只能人手加长,任何工具都不会替你收编(#1086 AC4)。"
        )
    if aborts or unlisted:
        sys.exit(1)

    if tolerated:
        print(f"⚠ 清单内已知红,容忍 {len(tolerated)} 条(判据 = 清单外零新红):")
        for f, d in tolerated:
            print(f"    {f} :: {d}")
            print(f"      ↳ {entries[(f, d)]}")
    if stale:
        print(
            f"✂ 清单可缩短:下列 {len(stale)} 条登记的红本次运行没有失败(修绿/被删/被 skip)。"
            "从 scripts/known-fails.tsv 删掉对应行,让棘轮收紧:"
        )
        for f, d in stale:
            print(f"    {f} :: {d}")
    sys.exit(0)


if __name__ == "__main__":
    main()
