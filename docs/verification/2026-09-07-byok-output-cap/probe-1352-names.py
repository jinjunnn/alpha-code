# ac#1352 勘破第 1 步:旧名 / 新名各打一次 /chat/completions,max_tokens:1。
# key 来源与 verify-byok-catalog.ts 的 resolveKey 同序:env → prod alpha-secrets → dev alpha-secrets。
# 绝不打印 key;只打状态码、响应 model 字段、usage、finish_reason、错误正文前 200 字。
import json, os, sys, urllib.request, urllib.error
NAME = "DEEPSEEK_API_KEY"
def resolve():
    v = os.environ.get(NAME, "").strip()
    if v: return v, "env"
    for r in ("ai.opencode.desktop", "ai.opencode.desktop.dev"):
        f = os.path.expanduser(f"~/Library/Application Support/{r}/alpha-secrets/{NAME}")
        if os.path.exists(f):
            v = open(f).read().strip()
            if v: return v, f"{r}/alpha-secrets"
    return None, None
key, src = resolve()
if not key: print("NO KEY"); sys.exit(3)
print("key source:", src)
BASE = "https://api.deepseek.com/v1"
def call(model, mt):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": "Reply with the single character: A"}],
                       "max_tokens": mt, "stream": False}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", body,
        {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read()); u = d.get("usage", {})
            return r.status, f"model={d.get('model')!r} finish={d['choices'][0].get('finish_reason')} usage={json.dumps(u)}"
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200].replace("\n", " ").replace(key, "<redacted>")
    except Exception as e:
        return "ERR", repr(e)[:200].replace(key, "<redacted>")
for m in sys.argv[1:]:
    s, detail = call(m, 1)
    print(f"{m:<20} max_tokens=1  HTTP {s}  {detail}")
