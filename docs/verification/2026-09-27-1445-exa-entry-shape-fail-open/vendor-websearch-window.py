#!/usr/bin/env python3
"""alpha-code#1445(2026-09-27 勘破:条目形状 × fail-open)—— 精确到 **web_search 这一个工具的处理函数**:
从工具名字符串(0.1/0.2 叫 "search",0.3.0–0.3.6 叫 "web_search",之后 "web_search_exa")往后取 9000 字的窗口,
只在窗口里判成功渲染是哪一种。先跑 `vendor-all-versions.py` 把 tarball 拉进 <cache-dir>。
用法: python3 vendor-websearch-window.py <cache-dir> [要打印上下文的版本 ...]"""
import io, json, os, re, sys, tarfile
CACHE = sys.argv[1]; DUMP = set(sys.argv[2:])
meta = json.load(open(os.path.join(CACHE, "registry.json")))
versions = sorted(meta["versions"], key=lambda v: meta["time"][v])
def files(v):
    with tarfile.open(os.path.join(CACHE, f"exa-mcp-server-{v}.tgz"), "r:gz") as tf:
        return {m.name: tf.extractfile(m).read().decode("utf-8", "replace") for m in tf.getmembers()
                if m.isfile() and re.search(r"\.(c?js|mjs)$", m.name) and "node_modules" not in m.name}
WIN = 9000
for v in versions:
    fs = files(v)
    best = None
    for name, s in sorted(fs.items()):
        # 0.1/0.2 里工具叫 "search";0.3.0-0.3.6 叫 "web_search";之后 "web_search_exa"
        for tool in ("web_search_exa", "web_search", "search"):
            i = s.find(f'"{tool}"')
            if i < 0: i = s.find(f"'{tool}'")
            if i < 0: continue
            # 处理函数可能在 name 之前定义(0.x 的 build/tools/webSearch.js 是独立文件)—— 取文件里 name 之前 2000 + 之后 WIN
            w = s[max(0, i - 2000): i + WIN]
            f = {
                "title_tpl": len(re.findall(r"Title: \$\{", w)),
                "raw_context": len(re.findall(r"text\s*:\s*[\w.]*\.context\s*[,}]", w)),
                "json_stringify": len(re.findall(r"text\s*:\s*JSON\.stringify\(([^)]{0,80})", w)),
                "json_arg": re.findall(r"text\s*:\s*JSON\.stringify\(([^)]{0,80})", w)[:2],
                "meta": len(re.findall(r"_meta\s*:\s*\{\s*searchTime", w)),
                "zero": w.count("No search results found"),
                "ctx_ep": len(re.findall(r"['\"]/context['\"]", w)), "search_ep": len(re.findall(r"['\"]/search['\"]", w)),
            }
            cand = (name, tool, i, f)
            if best is None or tool == "web_search_exa": best = cand
            break
    if best is None:
        print(f"{v:8} {meta['time'][v][:10]}  (no web_search tool string found) files={sorted(fs)}"); continue
    name, tool, i, f = best
    kind = "title-lines" if f["title_tpl"] else "raw-context" if f["raw_context"] else "json-stringify" if f["json_stringify"] else "?"
    print(f"{v:8} {meta['time'][v][:10]}  tool={tool:15} render={kind:14} title={f['title_tpl']} rawctx={f['raw_context']} "
          f"jsonstr={f['json_stringify']} arg={f['json_arg']} meta={f['meta']} zero={f['zero']} ctxEP={f['ctx_ep']} searchEP={f['search_ep']}  [{os.path.basename(name)}]")
    if v in DUMP:
        s = fs[name]; w = s[max(0, i - 2000): i + WIN]
        for pat in (r"text\s*:\s*JSON\.stringify\(", r"text\s*:\s*[\w.]*\.context", r"Title: \$\{", r"No search results found"):
            for mm in list(re.finditer(pat, w))[:1]:
                a, b = max(0, mm.start() - 350), min(len(w), mm.end() + 350)
                print(f"   >>> {v} {pat}:\n   {re.sub(chr(10), ' ', w[a:b])}\n")
