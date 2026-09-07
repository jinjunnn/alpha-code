import json, os, urllib.request, urllib.error
DEV = os.path.expanduser("~/Library/Application Support/ai.opencode.desktop.dev/alpha-secrets")
KEY = open(os.path.join(DEV, "ZHIPU_API_KEY")).read().strip()
BASE = "https://open.bigmodel.cn/api/paas/v4"
# ~80k token 的提示词:131072 + 80k = 211k > glm-5.2 上下文 202752。
# 若上游校验 prompt+max_tokens <= context,这一发必拒;若只校验 max_tokens<=输出上限,则 200。
filler = ("The quick brown fox jumps over the lazy dog. " * 8000)
def call(mt):
    body = json.dumps({"model": "glm-5.2",
                       "messages": [{"role": "user", "content": filler + "\n\nReply with the single character: A"}],
                       "max_tokens": mt, "stream": False}).encode()
    req = urllib.request.Request(BASE + "/chat/completions", body,
        {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.loads(r.read()); u = d.get("usage", {})
            return f"HTTP {r.status}  prompt_tokens={u.get('prompt_tokens')} completion_tokens={u.get('completion_tokens')} finish={d['choices'][0].get('finish_reason')}"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}  {e.read().decode()[:260]}"
    except Exception as e:
        return f"ERR {e!r}"
print(f"prompt 字符数 ≈ {len(filler)}")
print("max_tokens=131072 (顶格,和 prompt 相加超上下文):", call(131072))
