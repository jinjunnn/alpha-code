// Provider connectivity probe (main process). Sends ONE minimal (max_tokens:1) chat request to the
// gateway with the user's key to verify "reachable + authenticated + model exists" before persisting
// (decided 2026-06-27: 1-token chat, not just /models). The key stays in the main process — the
// renderer only gets {ok, ms} or {ok:false, reason}. No opencode internals (ADR-006): global fetch.

import type { ProviderTestInput, ProviderTestResult } from "../shared/alpha-model-types"

const TIMEOUT_MS = 12_000

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, "") + suffix
}

export async function testProvider(input: ProviderTestInput): Promise<ProviderTestResult> {
  const { compat, baseURL, apiKey, model } = input
  if (!baseURL || !apiKey || !model) return { ok: false, reason: "缺少 baseURL / key / model" }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = Date.now()
  try {
    // URL convention (REQ-074): baseURL always INCLUDES /v1 (matching both SDKs' own defaults), and
    // the probe appends exactly what the runtime SDK appends — anthropic "@ai-sdk/anthropic" does
    // `${baseURL}/messages`, openai-compatible does `${baseURL}/chat/completions`. The probe passing
    // must predict the session working; a diverging join here is how "测试通、会话不通" happened.
    const isAnthropic = compat === "anthropic"
    const url = isAnthropic ? joinUrl(baseURL, "/messages") : joinUrl(baseURL, "/chat/completions")
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (isAnthropic) {
      headers["x-api-key"] = apiKey
      headers["anthropic-version"] = "2023-06-01"
    } else {
      headers["authorization"] = `Bearer ${apiKey}`
    }
    const body = JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    })
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal })
    const ms = Date.now() - started
    if (res.ok) return { ok: true, ms }
    // Reached the gateway but it rejected. Auth/quota/model errors are real failures; surface the
    // status + a short body snippet so the user can fix it (no silent success — [[silent-failure]]).
    let detail = ""
    try {
      detail = (await res.text()).slice(0, 160)
    } catch {
      /* ignore body read errors */
    }
    return { ok: false, reason: `HTTP ${res.status}${detail ? ` · ${detail}` : ""}` }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { ok: false, reason: "连接超时" }
    return { ok: false, reason: error instanceof Error ? error.message : "连接失败" }
  } finally {
    clearTimeout(timer)
  }
}
