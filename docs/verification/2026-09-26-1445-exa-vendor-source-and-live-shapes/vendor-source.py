#!/usr/bin/env python3
"""alpha-code#1445(2026-09-26 补勘)—— 读 exa-mcp-server 各发行版的**构建产物**,回答三件事:

  ① 那句「free MCP rate limit」提示是怎么返回的(带不带 isError);
  ② web_search_exa 成功时渲染成什么(/context 整段 vs 逐条 Title:/URL: 行),带不带 _meta;
  ③ 零命中渲染成什么。

只读 npm 上真发过版的包(不看官网、不凭记忆)。用法:
    python3 vendor-source.py [版本 ...]   # 默认 3.1.9 3.2.1 3.4.0 3.4.1
不需要 Exa 额度,只访问 registry.npmjs.org。
"""
import io, re, sys, tarfile, urllib.request

VERSIONS = sys.argv[1:] or ["3.1.9", "3.2.1", "3.4.0", "3.4.1"]
NOTICE_HEAD = "You've hit Exa's free MCP rate limit"

def builds(version):
    url = f"https://registry.npmjs.org/exa-mcp-server/-/exa-mcp-server-{version}.tgz"
    with urllib.request.urlopen(url, timeout=60) as r:
        tgz = r.read()
    out = {}
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tf:
        for m in tf.getmembers():
            if m.isfile() and re.search(r"\.(c?js|mjs)$", m.name) and "node_modules" not in m.name:
                out[m.name] = tf.extractfile(m).read().decode("utf-8", "replace")
    return out

def excerpt(s, i, before, after):
    return s[max(0, i - before): min(len(s), i + after)]

for v in VERSIONS:
    files = builds(v)
    print(f"\n{'#' * 78}\n# exa-mcp-server {v}: {len(files)} 个构建文件 —— {', '.join(sorted(files))}\n{'#' * 78}")
    for name, s in sorted(files.items()):
        hit = s.find(NOTICE_HEAD)
        if hit < 0:
            print(f"\n[{name}] 无「{NOTICE_HEAD}」")
            continue
        # ① 提示文本的变量名,以及返回它的那一支带不带 isError
        m = re.search(r"(\w+)\s*=\s*`" + re.escape(NOTICE_HEAD), s)
        var = m.group(1) if m else None
        emit = re.search(r"text\s*:\s*" + re.escape(var) + r"\s*\}\s*\]\s*,\s*isError\s*:\s*(!0|true)", s) if var else None
        print(f"\n[{name}] ① 提示变量 = {var!r};返回支带 isError:true = {bool(emit)}")
        print("   文本:", repr(excerpt(s, hit, 0, 260).split("`")[0]))
        if emit:
            print("   返回支:", re.sub(r"\s+", " ", excerpt(s, emit.start(), 160, 60)))
        # ② 成功渲染
        title_lines = len(re.findall(r"Title: \$\{", s))
        context_uses = s.count('"/context"')
        meta_search = len(re.findall(r"_meta\s*:\s*\{\s*searchTime", s))
        raw_context = len(re.findall(r"text\s*:\s*\w+\.data\.context\s*\}", s))
        print(f"   ② 成功渲染:`Title: ${{` 模板 {title_lines} 处;`/context` 端点 {context_uses} 处;"
              f"`text: *.data.context` 整段直出 {raw_context} 处;`_meta:{{searchTime` {meta_search} 处")
        # ③ 零命中
        zero = [mm.start() for mm in re.finditer(r"No search results found\. Please try a different query\.", s)]
        print(f"   ③ 零命中文案出现 {len(zero)} 处", end="")
        if zero:
            z = excerpt(s, zero[0], 120, 100)
            print(";首处上下文(是否带 isError):", "isError" in z, "—", re.sub(r"\s+", " ", z))
        else:
            print()
