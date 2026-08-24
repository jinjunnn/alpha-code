#!/usr/bin/env python3
"""known-fails-compare — base fail-set 棘轮的判官(#1086)。

被 scripts/bun-test-floor.sh 在 ALPHA_KNOWN_FAILS_FILE 置位时调用(今天只有两处:
alpha-check.sh 第 [5/10] 步的 ui-mac 全量,与 alpha-ci `bun test (ui-mac)` —— 同一条命令)。
职责只有一个:回答「这次运行的红,是不是全部落在仓内那份静态清单里」。

  · 清单内的红 → 容忍(放行,但逐条打出来 + 附清单里的理由);
  · 清单外的红 → exit 1,逐条点名(AC2/AC3①);
  · 清单里登记、但本次没失败 → 不拦,提示清单可缩短(AC3②,棘轮只朝收紧方向自动走);
  · 任何「无法逐测试归因」的失败 → exit 2 测量作废,拦住(fail-closed)。

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
        if key in entries:
            void(f"清单第 {ln} 行重复登记:{key[0]} :: {key[1]}")
        entries[key] = cols[2].strip()
    return entries


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
    fails = parse_junit(junit_path)

    logp = Path(log_path)
    if not logp.is_file():
        void(f"console 日志缺失:{log_path}")
    log_text = logp.read_text(encoding="utf-8", errors="replace")

    # 交叉轴①:条数。外层 summary 恒最后打印(与 bun-test-floor.sh 取 pass 数同一条既有假设)。
    fail_counts = re.findall(r"^\s*(\d+) fail$", log_text, re.M)
    if not fail_counts:
        void("console 里没有 `N fail` 总结行 —— 观测手段自身失效,先证明手段再谈结论")
    console_fail = int(fail_counts[-1])
    if console_fail != len(fails):
        void(
            f"junit 失败 {len(fails)} 条 ≠ console 外层总结 {console_fail} fail —— "
            "两条测量轴打架(bun 输出格式变了?),不许拿其中一条下结论"
        )
    if status != 0 and not fails:
        void(f"bun 退出码 {status} 但 junit 零条失败 —— 失败无法逐测试归因,清单不吸收")
    if status == 0 and fails:
        void(f"bun 退出码 0 但 junit 报 {len(fails)} 条失败 —— 仪器自相矛盾")

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

    if unlisted:
        print(f"::error::清单外新红 {len(unlisted)} 条 —— 不在 base fail-set(scripts/known-fails.tsv)里,拦住:")
        for f, d in unlisted:
            print(f"::error::  ✗ {f} :: {d}")
        print(
            "::error::修掉它;若它确属既有基线,把它连同「为什么还红着」写进 scripts/known-fails.tsv "
            "并让评审在 diff 里读到 —— 清单只能人手加长,任何工具都不会替你收编(#1086 AC4)。"
        )
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
