#!/usr/bin/env python3
"""alpha-code#1445(2026-09-27 勘破:条目形状 × fail-open)—— 读 npm 上 exa-mcp-server **全部 49 个**发行版的
构建产物,按整包聚合回答:成功渲染是哪一种(JSON.stringify / 直出 context / Title: 行)、带不带 `_meta.searchTime`、
限流提示带不带 `isError`、零命中文案在不在。只访问 registry.npmjs.org,不耗 Exa 额度。
整包聚合会被别的工具(company_research 等)的渲染污染,**精确到 web_search 处理函数的判定见 `vendor-websearch-window.py`**。
用法: python3 vendor-all-versions.py <cache-dir> <out-excerpts.txt>
    <cache-dir>/registry.json 缺席时自动从 registry 拉;tarball 缓存在 <cache-dir>/exa-mcp-server-<v>.tgz。
"""
import io, json, os, re, sys, tarfile, urllib.request

CACHE, OUT = sys.argv[1], sys.argv[2]
os.makedirs(CACHE, exist_ok=True)
REG = os.path.join(CACHE, "registry.json")
if not os.path.exists(REG):
    with urllib.request.urlopen("https://registry.npmjs.org/exa-mcp-server", timeout=120) as r:
        open(REG, "wb").write(r.read())
meta = json.load(open(REG))
versions = sorted(meta["versions"], key=lambda v: meta["time"][v])

NOTICE = "You've hit Exa's free MCP rate limit"
ZERO = "No search results found. Please try a different query."

def fetch(v):
    p = os.path.join(CACHE, f"exa-mcp-server-{v}.tgz")
    if not os.path.exists(p):
        url = meta["versions"][v]["dist"]["tarball"]
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read()
        open(p, "wb").write(data)
    return open(p, "rb").read()

def built_files(tgz):
    out = {}
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tf:
        for m in tf.getmembers():
            if m.isfile() and re.search(r"\.(c?js|mjs)$", m.name) and "node_modules" not in m.name:
                out[m.name] = tf.extractfile(m).read().decode("utf-8", "replace")
    return out

def cnt(s, pat, flags=0):
    return len(re.findall(pat, s, flags))

def feats(s):
    # 先定位提示文本,再往回看 60 字取变量名 —— 不用 (\w+) 全文扫描(minified 里的 base64 大块会让它 O(n^2))。
    hit = s.find(NOTICE)
    m = re.search(r"(\w+)\s*=\s*`$", s[max(0, hit - 60):hit]) if hit >= 0 else None
    var = m.group(1) if m else None
    emit = bool(re.search(r"text\s*:\s*" + re.escape(var) + r"\s*\}\s*\]\s*,\s*isError\s*:\s*(!0|true)", s)) if var else False
    return {
        "notice": s.count(NOTICE),
        "notice_isError": emit,
        "title_tpl": cnt(s, r"Title: \$\{"),
        "url_tpl": cnt(s, r"URL: \$\{"),
        "published_tpl": cnt(s, r"Published: \$\{"),
        "author_tpl": cnt(s, r"Author: \$\{"),
        "highlights_lbl": s.count("Highlights:"),
        "sep": s.count(r"\n\n---\n\n"),
        "context_ep": cnt(s, r"['\"]/context['\"]"),
        "search_ep": cnt(s, r"['\"]/search['\"]"),
        "raw_context_out": cnt(s, r"text\s*:\s*[\w.]*\.context\s*[,}]"),
        "meta_searchTime": cnt(s, r"_meta\s*:\s*\{\s*searchTime"),
        "json_stringify_text": cnt(s, r"text\s*:\s*JSON\.stringify\("),
        "zero_hit": s.count(ZERO),
        "tools": sorted(set(re.findall(r"\"((?:web_)?(?:search|fetch|crawl|research)[a-z_]*|[a-z_]*_exa)\"", s))),
    }

def merge(a, b):
    out = dict(a)
    for k, v in b.items():
        if isinstance(v, bool): out[k] = a[k] or v
        elif isinstance(v, int): out[k] = a[k] + v
        elif isinstance(v, list): out[k] = sorted(set(a[k]) | set(v))
    return out

def render_type(f):
    if f["title_tpl"] > 0: return "title-lines"
    if f["raw_context_out"] > 0: return "raw-context"
    if f["json_stringify_text"] > 0: return "json-stringify"
    return "?"

def excerpts(s, v, fh):
    fh.write(f"\n{'='*100}\n== {v}\n{'='*100}\n")
    for label, pat in [("Title tpl", r"Title: \$\{"), ("raw context", r"text\s*:\s*[\w.]*\.context\s*[,}]"),
                       ("JSON.stringify text", r"text\s*:\s*JSON\.stringify\("), ("zero hit", re.escape(ZERO)),
                       ("_meta searchTime", r"_meta\s*:\s*\{\s*searchTime")]:
        for mm in list(re.finditer(pat, s))[:2]:
            a, b = max(0, mm.start() - 300), min(len(s), mm.end() + 300)
            fh.write(f"\n-- {label} @ {mm.start()}\n{re.sub(chr(10), ' ', s[a:b])}\n")

rows = []
prev_sig = None
with open(OUT, "w") as fh:
    for v in versions:
        try:
            files = built_files(fetch(v))
        except Exception as e:
            print(f"{v}\tFETCH-FAIL\t{e}", flush=True); continue
        agg = None
        for name, s in sorted(files.items()):
            f = feats(s)
            agg = f if agg is None else merge(agg, f)
        agg = agg or {}
        rt = render_type(agg) if agg else "no-js"
        sig = (rt, agg.get("meta_searchTime", 0) > 0, agg.get("zero_hit", 0) > 0, agg.get("sep", 0) > 0,
               tuple(agg.get("tools", [])))
        changed = "" if sig == prev_sig else "  <-- CHANGED" if prev_sig is not None else "  (first)"
        prev_sig = sig
        rows.append((v, meta["time"][v][:10], rt, agg, changed, sorted(files)))
        print(f"{v:8} {meta['time'][v][:10]}  render={rt:14} meta={agg.get('meta_searchTime',0):2} title={agg.get('title_tpl',0):2} "
              f"rawctx={agg.get('raw_context_out',0)} jsonstr={agg.get('json_stringify_text',0)} ctxEP={agg.get('context_ep',0)} "
              f"searchEP={agg.get('search_ep',0)} zero={agg.get('zero_hit',0)} notice={agg.get('notice',0)}/{'E' if agg.get('notice_isError') else '-'} "
            f"files={len(files)} tools={','.join(agg.get('tools',[]))}{changed}", flush=True)
        # excerpts for a version whenever its signature changed
        if changed:
            for name, s in sorted(files.items()):
                excerpts(s, f"{v} :: {name}", fh)
json.dump([{"version": v, "date": d, "render": rt, "feats": a, "changed": c.strip(), "files": fl} for v, d, rt, a, c, fl in rows],
          open(os.path.join(CACHE, "vendor-all-versions.json"), "w"), indent=1, ensure_ascii=False)
