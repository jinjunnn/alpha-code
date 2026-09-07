# M1(审计 2026-09-07):裸 body 下量出的上限,不等于**生产 body** 下的上限。
# transform.ts:1202-1209 对 providerID.includes("zhipuai") + openai-compatible **无条件**写
# thinking:{type:"enabled", clear_thinking:false},默认档即到。若 thinking 模式下 max_tokens
# 合法区间不同,glm 两个模型每一发都是硬 400 —— 而改动前的 32000 不会。
import json, os, urllib.request, urllib.error
DEV = os.path.expanduser("~/Library/Application Support/ai.opencode.desktop.dev/alpha-secrets")
KEY = open(os.path.join(DEV, "ZHIPU_API_KEY")).read().strip()
BASE = "https://open.bigmodel.cn/api/paas/v4"
def call(model, mt, thinking):
    p = {"model": model, "messages": [{"role": "user", "content": "Reply with the single character: A"}],
         "max_tokens": mt, "stream": False}
    if thinking: p["thinking"] = {"type": "enabled", "clear_thinking": False}
    req = urllib.request.Request(BASE + "/chat/completions", json.dumps(p).encode(),
        {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.loads(r.read()); u = d.get("usage", {})
            return f"HTTP {r.status}  completion_tokens={u.get('completion_tokens')} finish={d['choices'][0].get('finish_reason')}"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}  {e.read().decode()[:180]}"
    except Exception as e:
        return f"ERR {e!r}"
for model, cap in (("glm-5.2", 131072), ("glm-4.5-air", 98304)):
    print(f"{model}  thinking:enabled  @{cap}      ", call(model, cap, True))
    print(f"{model}  thinking:enabled  @{cap+1}    ", call(model, cap + 1, True))
