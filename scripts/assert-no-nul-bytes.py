#!/usr/bin/env python3
"""断言:版本控制下的源文件里没有**字面 NUL 字节**(0x00)。

为什么这是一道闸,而不是一次清理(#760)
------------------------------------------------------------------
字面 NUL 不会让运行时出错 —— 拿它当 `join` 分隔符或复合键分隔符是完全正常的选择。
坏掉的是**验证手段**:BSD grep / ripgrep / file(1) 一旦在文件里看到 NUL,就把**整个文件**
判成二进制,然后**静默地什么都不返回**。于是「我 grep 过了,没有」变成一句假话。

已实证四次(见 #760):

  · `#737` 的枚举因此被修正**两次**(15 → 17 → 18);
  · `#704` 一轮里同类出现两次(只修实例、没枚举整类);
  · 建 `#760` 这张票时,写建票命令又混进一个真 NUL,被工具拒绝;
  · `alpha-web#109` 的实现方 `grep "secret"` 得到 **0 命中**,差点据此断定「测试被删了」。

第四条是最危险的形态:**它不是让你漏看,是让你看到一个假的「没有」并据此下结论。**
本仓 `CLAUDE.md` 明写「大文件 Edit 后必须 grep + git show 双验」—— 而在这些文件上
`grep` 会安静地说「没有」。被破坏的东西,正是观测它所依赖的东西。

为什么扫全部文件,而不是一张源码扩展名允许清单
------------------------------------------------------------------
**枚举对新成员默认放行,咽喉对新成员默认拒绝。** `#760` 票面那张 7 个文件的清单,在写下
它的**同一天**就已经被 `#756` / `#763` 各加了一个新成员(`ext-transaction.ts`、
`ext-package-lifecycle.ts`)—— 枚举跑不过产生它的机制。

所以本文件扫的是 `git ls-files` 的**全部**内容,只放过下面 `BINARY_SUFFIXES` /
`EXCLUDED_PREFIXES` 里显式登记的二进制格式。新扩展名、新目录一律**先被扫**;真是二进制就
来这里登记一行,让它经过一次 review。反过来做(只扫 `*.ts` `*.tsx` `*.json` … 的允许清单)
会让第 8 个成员照旧静默溜过 —— 那正是这张票要终结的形态。

修法
------------------------------------------------------------------
把字面 NUL 换成转义写法 `\\u0000`。它在 TS/JS 的 `"..."`、`'...'` 与模板字面量 `` `...` ``
里都合法,运行时**逐字节等价**,而且 grep 看得见。

用法:python3 scripts/assert-no-nul-bytes.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile

# 0x00。全文件不出现任何字面 NUL 字节 —— 否则这道闸会把自己扫红,
# 而且写这份脚本的过程本身就是本类缺陷最常见的传播途径(见抬头第三条)。
NUL_BYTE = 0

# ── 二进制格式登记簿(默认拒:没登记的一律扫)────────────────────────────────────
# 这张表只登记**仓里今天真实存在**的二进制格式(2026-08-01 对 8467 个版本控制文件做
# 全量字节扫描得出)。刻意**不**预填 `.pdf` / `.wasm` / `.gif` / `.woff` 这类还没有的
# 格式 —— 预先放行等于替一个没人看过的输入做决定。新格式进来会先变红,加一行 + 一次
# review 才放行;那点摩擦正是想要的方向。
BINARY_SUFFIXES = frozenset(
    {
        ".png", ".jpg", ".ico", ".icns",  # 位图与图标
        ".woff2", ".ttf",                 # 字体
        ".mp3", ".aac", ".mp4",           # 音视频
        ".zip", ".tgz",                   # 归档
    }
)

# 目录级豁免。仓库相对路径前缀,写成显式清单而不是模式匹配。
EXCLUDED_PREFIXES = (
    # 内容寻址的 vendored 载荷:**文件名就是内容的 sha256**,完整性由文件名本身与
    # seed.lock.json 一起保证,内容也不是本仓作者写的(实测含 TrueType 字体与 UTF-8 文本)。
    # 它既不是「源文件」,也没人能在不改文件名的前提下往里塞东西。
    "packages/ui-mac/resources/extension-seed/blobs/",
)

# 扫描文件数的地板。当前实际约 7.3k;取 4000 留大余量,只抓**灾难性丢失**
# (`git ls-files` 失败、过滤器写反、仓库根解错、在空目录里跑)。
#
# 为什么必须有这一层:本仓已经犯过一次同型错误 —— `scripts/check-doc-links.py`
# **裸跑扫 0 个文件、退出码 0**。一个扫 0 个文件还报绿的步骤,比没有这一步更坏:
# 它会训练所有人相信「绿 = 验过了」。同 `scripts/bun-test-floor.sh` 的理由。
SCANNED_FLOOR = 4000

# 转义写法的**文本**,拼出来而不是写成字面量。
#
# 这不是洁癖:本文件第一版就是在这里被塞进一个真 NUL 的 —— 写的是转义,落盘成了 0x00,
# 于是这道闸的第一次自扫就把自己判红。抬头第三条讲的「建票命令又混进一个真 NUL」是同一件事。
# 凡是要在源码里**谈论** NUL 的地方,一律这样拼。
ESCAPED_NUL_TEXT = "\\" + "u0000"

FIX_HINT = (
    "修法:把字面 NUL 换成转义写法 " + ESCAPED_NUL_TEXT + " —— TS/JS 的 \"...\"、'...' 与"
    "模板字面量 `...` 里都合法,运行时逐字节等价,而且 grep 看得见。"
)

WHY = (
    "为什么这是红灯:BSD grep / ripgrep / file(1) 看到 NUL 就把**整个文件**判成二进制并"
    "静默返回空 —— 于是「我 grep 过了,没有」变成假话。危害不是漏看,是给出一个假的「没有」"
    "让人据此下结论(#760)。"
)


def repo_root() -> str:
    """仓库根 = 本脚本所在目录的上一级。

    刻意**不**用 `git rev-parse --show-toplevel`:git 钩子运行时会设 `GIT_DIR`
    (`#754` 就是这个坑),那时 `--show-toplevel` 与 cwd 都不可信。脚本自己的位置是可信的。
    """
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git_env() -> dict[str, str]:
    """跑 git 用的干净环境:剥掉钩子/上层脚本注入的仓库指针。

    留着 `GIT_DIR` 而没有 `GIT_WORK_TREE` 时,git 会把 **cwd 当工作树** —— 同一 lane
    刚因为这个把测试夹具的提交写进了真实仓库历史。这里一律显式清掉,只信 `git -C <root>`。
    """
    env = dict(os.environ)
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        env.pop(key, None)
    return env


def tracked_files(root: str) -> list[str]:
    """索引里的全部路径(= 已跟踪 + 已 staged 的新文件)。用 -z 以容忍任何文件名。"""
    out = subprocess.run(
        ["git", "-C", root, "ls-files", "-z"],
        capture_output=True,
        check=True,
        env=git_env(),
    ).stdout
    return [p.decode("utf-8", "surrogateescape") for p in out.split(bytes((NUL_BYTE,))) if p]


def should_scan(rel_path: str) -> bool:
    """默认扫。只有显式登记的二进制格式/目录才跳过。"""
    if any(rel_path.startswith(prefix) for prefix in EXCLUDED_PREFIXES):
        return False
    return os.path.splitext(rel_path)[1].lower() not in BINARY_SUFFIXES


def nul_offsets(data: bytes) -> list[int]:
    """`data` 里全部字面 NUL 的字节偏移。"""
    hits: list[int] = []
    at = data.find(NUL_BYTE)
    while at >= 0:
        hits.append(at)
        at = data.find(NUL_BYTE, at + 1)
    return hits


def locate(data: bytes, offset: int) -> tuple[int, int]:
    """字节偏移 → (行号, 列号),均从 1 起。"""
    line_start = data.rfind(b"\n", 0, offset) + 1
    return data.count(b"\n", 0, offset) + 1, offset - line_start + 1


def read_content(root: str, rel_path: str) -> bytes | None:
    """读工作树里的那一份;工作树没有(只在索引里)就读索引 blob。

    只读工作树会留一个洞:`rm <file>` 之后已提交的那份仍带着 NUL 被 push 出去。
    符号链接跳过 —— 它的「内容」是目标路径,跟着走会读到仓外(比如 node_modules)。
    """
    abs_path = os.path.join(root, rel_path)
    try:
        st = os.lstat(abs_path)
    except OSError:
        st = None
    if st is not None:
        import stat as _stat

        if _stat.S_ISLNK(st.st_mode) or _stat.S_ISDIR(st.st_mode):
            return None  # 符号链接 / 子模块 gitlink:不是本仓的源文本
        with open(abs_path, "rb") as handle:
            return handle.read()
    done = subprocess.run(
        ["git", "-C", root, "show", ":" + rel_path],
        capture_output=True,
        env=git_env(),
    )
    return done.stdout if done.returncode == 0 else None


def self_check() -> list[str]:
    """开扫之前先证明探测器**真的能探到**,以及默认方向没被写反。

    一个探不到东西的探测器,跑完 7000 个文件照样打印绿灯 —— 那是本仓「九种闸门失效形态」
    里的空闸门。所以这里先自己实施一遍绕过:造一个带真 NUL 的文件,断言它被抓到。
    """
    problems: list[str] = []
    with tempfile.TemporaryDirectory(prefix="alpha-nul-canary-") as tmp:
        planted = os.path.join(tmp, "canary.ts")
        with open(planted, "wb") as handle:
            handle.write(b"export const sep = " + bytes((NUL_BYTE,)) + b"\n")
        with open(planted, "rb") as handle:
            found = nul_offsets(handle.read())
        if found != [19]:
            problems.append(
                f"自检失败:探测器没抓到自己种下的 NUL(期望 [19],实得 {found})—— 这道闸是空的"
            )

        clean = os.path.join(tmp, "clean.ts")
        with open(clean, "wb") as handle:
            handle.write(b"export const sep = " + ESCAPED_NUL_TEXT.encode() + b"\n")
        with open(clean, "rb") as handle:
            if nul_offsets(handle.read()):
                problems.append("自检失败:探测器把转义写法 \\u0000 也判成命中 —— 它恒红,等于没有")

    # 默认方向:没登记的一律扫。任何一条变成 False,说明有人把默认拒改成了默认放行。
    for sample in ("packages/x/y.ts", "packages/x/y.tsx", "a.json", "a.md", "a.sh", "a.mjs", "a.brand-new-ext"):
        if not should_scan(sample):
            problems.append(f"自检失败:{sample} 被跳过了 —— 默认方向被改成了「允许清单」")
    if should_scan("packages/ui-mac/resources/icon.png"):
        problems.append("自检失败:.png 没被跳过 —— 二进制登记簿失效")
    return problems


def main() -> int:
    root = repo_root()
    if not os.path.exists(os.path.join(root, ".git")):
        print(f"::error::仓库根解析失败(没有 .git):{root}", file=sys.stderr)
        return 1

    for problem in self_check():
        print(f"::error::{problem}", file=sys.stderr)
        return 1

    scanned = 0
    skipped = 0
    unreadable = 0
    findings: list[tuple[str, int, int, int]] = []

    for rel_path in tracked_files(root):
        if not should_scan(rel_path):
            skipped += 1
            continue
        data = read_content(root, rel_path)
        if data is None:
            unreadable += 1
            continue
        scanned += 1
        for offset in nul_offsets(data):
            line, column = locate(data, offset)
            findings.append((rel_path, offset, line, column))

    if scanned < SCANNED_FLOOR:
        print(
            f"::error::只扫了 {scanned} 个文件,低于地板 {SCANNED_FLOOR} —— "
            "`git ls-files` 失败 / 过滤器写反 / 仓库根解错时,本步骤会一个文件都不看却退出 0。"
            "一个扫 0 个文件还报绿的闸,比没有这一步更坏。",
            file=sys.stderr,
        )
        return 1

    if findings:
        print(f"::error::{len(findings)} 处字面 NUL 字节(0x00)在版本控制的源文件里:", file=sys.stderr)
        for rel_path, offset, line, column in findings:
            print(f"    {rel_path}:{line}:{column}  (字节偏移 {offset})", file=sys.stderr)
        print(f"  {WHY}", file=sys.stderr)
        print(f"  {FIX_HINT}", file=sys.stderr)
        print(
            "  查看命中(普通 grep 在这些文件上会骗你):"
            "  rg -a --byte-offset --only-matching --text $'\\x00' <file>",
            file=sys.stderr,
        )
        return 1

    print(
        f"✓ {scanned} 个版本控制文件零字面 NUL 字节 "
        f"(跳过 {skipped} 个已登记二进制,{unreadable} 个非文本条目)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
