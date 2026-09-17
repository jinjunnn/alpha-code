# ac#1352:#1278 三点探针里**不计费**的两点(上游在参数校验阶段 400,零 token 生成)。
#   ① max_tokens=99999999 → 400,错误正文自报合法区间
#   ③ 自报值+1            → 400,边界就在那个数上
# ②(顶格 200)是计费调用,本票派发只授权两次 max_tokens:1 计费调用 ⇒ 本脚本不打 ②。
# 防御:若 ①/③ 意外回 200(即产生了计费生成),立刻停止并响亮打印。
import json, os, re, sys, urllib.request, urllib.error
NAME = "DEEPSEEK_API_KEY"
def resolve():
    v = os.environ.get(NAME, "").strip()
    if v: return v
    for r in ("ai.opencode.desktop", "ai.opencode.desktop.dev"):
        f = os.path.expanduser(f"~/Library/Application Support/{r}/alpha-secrets/{NAME}")
        if os.path.exists(f):
            v = open(f).read().strip()
            if v: return v
key = resolve()
if not key: print("NO KEY"); sys.exit(3)
BASE = "https://api.deepseek.com/v1"
def call(model, mt):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": "Reply with the single character: A"}],
                       "max_tokens": mt, "stream": False}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", body,
        {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read())
            return r.status, f"UNEXPECTED 200 model={d.get('model')!r} usage={json.dumps(d.get('usage'))}"
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300].replace("\n", " ").replace(key, "<redacted>")
    except Exception as e:
        return "ERR", repr(e)[:200].replace(key, "<redacted>")
m = sys.argv[1]
s1, d1 = call(m, 99999999)
print(f"{m:<20} ceiling probe (99999999)  HTTP {s1}  {d1}")
if s1 != 400: sys.exit(1)
nums = [int(x) for x in re.findall(r"\d+", d1) if int(x) > 1000]
if not nums: print("no self-reported range ⇒ 本次测量作废"); sys.exit(2)
cap = nums[-1]
s3, d3 = call(m, cap + 1)
print(f"{'':<20} reject @{cap+1:<18} HTTP {s3}  {d3}")
if s3 != 400: sys.exit(1)
