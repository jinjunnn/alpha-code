#!/usr/bin/env python3
"""alpha-code#1445(2026-09-27 勘破:条目形状 × fail-open)—— 离线版:同一条命题跑仓里四种真实负载 + 变异臂。
生产路径版(经两份生产 parseResponse 取文本)见同目录 probe-entry-shape.ts;两版对四格的结论必须一致。
用法: python3 entry-shape.py [docs/verification]
命题:R(text) 为真 当且仅当 文本里能认出 ≥1 个条目
   (Exa 渲染:一行 `Title: ` 紧接一行 `URL: `;或 Parallel 渲染:文本是 JSON 对象且 results 是非空数组)。
   R 为真 ⇒ 附一条正向声称 {kind, entries};R 为假 ⇒ 放行,不附任何声称。**没有任何输入被拒。**
这里只看**行首标签与 JSON 结构**,不看任何词的语义;判据里不出现 rate / limit / key 这类词。"""
import json, re, sys
HERE = sys.argv[1] if len(sys.argv) > 1 else "docs/verification"

def sse_text(body):
    frame = next(l for l in body.split("\n") if l.startswith("data: "))
    return json.loads(frame[6:])["result"]["content"][0]["text"]

ticket = json.load(open(f"{HERE}/2026-09-24-1445-exa-mcp-response-shapes/results/ticket-payload.json"))
live = json.load(open(f"{HERE}/2026-09-26-1445-exa-vendor-source-and-live-shapes/results/live-shapes.json"))
row = {r["arm"]: r for r in live["rows"]}
D = ticket["minimalEnvelope"]["result"]["content"][0]["text"]
Z = "No search results found. Please try a different query."
A = sse_text(row["exa-nokey-search"]["body"])
P = json.loads(row["parallel-keyless-search"]["body"])["result"]["content"][0]["text"]

def entry_shape(text: str):
    lines = text.split("\n")
    exa_pairs = sum(1 for i, l in enumerate(lines) if l.startswith("Title: ") and i + 1 < len(lines) and lines[i + 1].startswith("URL: "))
    json_results = None
    if text.lstrip().startswith("{"):
        try:
            obj = json.loads(text)
            r = obj.get("results") if isinstance(obj, dict) else None
            if isinstance(r, list):
                json_results = len(r)
        except ValueError:
            pass
    return exa_pairs, json_results

def claim(text: str):
    """fail-open:只在认出时说话;认不出 ⇒ None(放行,不声称)。"""
    exa_pairs, json_results = entry_shape(text)
    if exa_pairs >= 1: return {"kind": "exa-entries", "entries": exa_pairs}
    if json_results: return {"kind": "json-results", "entries": json_results}
    return None

arms = [
    ("D  票面限流提示(#1433 实抓,246 字)", D),
    ("Z  Exa 真零命中(vendor 源码逐字)", Z),
    ("A  今日 Exa 真结果(live-shapes 原始 SSE)", A),
    ("P  今日 Parallel 真结果(live-shapes 原始 JSON)", P),
]
print("== 四格(生产四种真实负载)==")
for label, t in arms:
    c = claim(t)
    print(f"{label}\n   textLen={len(t)} exa_pairs/json_results={entry_shape(t)}  →  {'声称 '+json.dumps(c) if c else '放行,不声称'}")

# 先证明手段能测出已知的坏:变异臂
print("\n== 变异臂(证明识别器真的在看行结构,而不是恒真/恒假)==")
A_noTitle = "\n".join(l for l in A.split("\n") if not l.startswith("Title: "))
A_noURL = "\n".join(l for l in A.split("\n") if not l.startswith("URL: "))
A_indent = re.sub(r"^Title: ", " Title: ", A, flags=re.M)   # 标签不在行首(含第一行)
P_empty = json.dumps({**json.loads(P), "results": []})
P_notlist = json.dumps({**json.loads(P), "results": {"a": 1}})
D_wrapped = "Title: x\nURL: https://example.invalid\n\n" + D   # 托管端若把提示包成条目 ⇒ 会被声称(漏,不是拒)
muts = [
    ("A 去掉全部 Title: 行", A_noTitle, None),
    ("A 去掉全部 URL: 行", A_noURL, None),
    ("A 的 Title: 不在行首", A_indent, None),
    ("P 的 results 置空 []", P_empty, None),
    ("P 的 results 不是数组", P_notlist, None),
    ("D 前面包一对 Title:/URL: 行", D_wrapped, {"kind": "exa-entries", "entries": 1}),
]
ok = True
for label, t, want in muts:
    got = claim(t)
    flag = "✓" if got == want else "✗"
    ok &= got == want
    print(f"{flag} {label}: {('声称 '+json.dumps(got)) if got else '放行,不声称'}")
print("\n变异臂全部符合预期:", ok)

# A 的渲染标签清单(与 npm 各版模板对照用)
labels = sorted(set(re.findall(r"^([A-Z][A-Za-z ]{1,20}):", A, re.M)))
print("\nA 的行首标签集合:", labels, "; 分隔符 \\n\\n---\\n\\n 出现", A.count("\n\n---\n\n"), "次")
print("D 的行首标签集合:", sorted(set(re.findall(r"^([A-Z][A-Za-z ]{1,20}):", D, re.M))))
