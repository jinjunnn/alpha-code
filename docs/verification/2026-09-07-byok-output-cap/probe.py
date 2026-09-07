import json, os, sys, urllib.request, urllib.error
DEV = os.path.expanduser("~/Library/Application Support/ai.opencode.desktop.dev/alpha-secrets")
key = lambda n: open(os.path.join(DEV, n)).read().strip()
LEGS = [
    ("zhipuai",  "https://open.bigmodel.cn/api/paas/v4", key("ZHIPU_API_KEY"),    ["glm-5.2", "glm-4.5-air"]),
    ("deepseek", "https://api.deepseek.com/v1",          key("DEEPSEEK_API_KEY"), ["deepseek-v4-flash", "deepseek-v4-pro"]),
]
def call(base, k, model, mt):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": "Reply with the single character: A"}],
                       "max_tokens": mt, "stream": False}).encode()
    req = urllib.request.Request(base + "/chat/completions", body,
        {"Authorization": "Bearer " + k, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read()); u = d.get("usage", {})
            return (r.status, f"completion_tokens={u.get('completion_tokens')} finish={d['choices'][0].get('finish_reason')}")
    except urllib.error.HTTPError as e:
        return (e.code, e.read().decode()[:200].replace("\n", " "))
    except Exception as e:
        return ("ERR", repr(e)[:200])
print(f"{'leg/model':<28} {'probe':<26} {'HTTP':<6} detail")
for leg, base, k, models in LEGS:
    for m in models:
        hi = call(base, k, m, 99999999)
        print(f"{leg+'/'+m:<28} {'ceiling probe (99999999)':<26} {str(hi[0]):<6} {hi[1]}")
        cap = None
        for tok in hi[1].replace(",", " ").replace("]", " ").split():
            if tok.isdigit() and int(tok) > 1000: cap = int(tok)
        if cap is None: continue
        ok = call(base, k, m, cap)
        print(f"{'':<28} {'accept @'+str(cap):<26} {str(ok[0]):<6} {ok[1]}")
        no = call(base, k, m, cap + 1)
        print(f"{'':<28} {'reject @'+str(cap+1):<26} {str(no[0]):<6} {no[1]}")
