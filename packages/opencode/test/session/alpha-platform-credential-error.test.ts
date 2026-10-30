// REQ-236 AC3(`#1562`)—— 平台凭据读不到时,ext `chat.headers` 抛出的错误在引擎里是什么、会不会被重试。
//
// 错误由**生产** ext 函数 `platformCredentialHeader` 在凭据文件缺席时真实抛出(不手写替身),再交给引擎**生产**的
// `MessageV2.fromError`(界面看到的错误名)与 `SessionRetry.retryable`(会话是否按退避重试)。
// 为什么要判「不重试」:引擎对非 APIError 的消息做关键词匹配(含 unavailable / exhausted 等即判可重试),
// 一个措辞不当的确定性认证失败会被退避重试约 60 秒才显示给用户(#1562 实测踩到过)。
// 对照臂:同一个错误类,消息换成含 `unavailable` 的措辞 ⇒ retryable 判可重试 —— 证明这条判据测得出那个坏。

import { describe, expect, test } from "bun:test"
import { LoadAPIKeyError } from "@ai-sdk/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRetry } from "../../src/session/retry"
import { platformCredentialHeader } from "../../../ext/src/platform-credential-header"

const GW = "https://gw.example/v1"
const providerID = ProviderV2.ID.make("alpha")

function credentialError() {
  try {
    platformCredentialHeader({
      providerBaseURL: GW,
      env: { ALPHA_BASE_URL: GW, ALPHA_PLATFORM_AUTH_REF: "{file:/nonexistent/alpha-secrets/ALPHA_API_KEY}" },
    })
  } catch (error) {
    return error
  }
  throw new Error("platformCredentialHeader did not throw for a missing credential file")
}

describe("REQ-236 #1562 平台凭据读不到时的引擎错误", () => {
  test("归为 ProviderAuthError,且不进会话的退避重试", () => {
    const error = MessageV2.fromError(credentialError(), { providerID })
    expect(error.name).toBe("ProviderAuthError")
    expect(SessionRetry.retryable(error, providerID)).toBeUndefined()
  })

  test("对照臂:同一个错误类、消息含 unavailable ⇒ 引擎判可重试(判据测得出措辞的坏)", () => {
    const error = MessageV2.fromError(new LoadAPIKeyError({ message: "platform credential unavailable" }), { providerID })
    expect(error.name).toBe("ProviderAuthError")
    expect(SessionRetry.retryable(error, providerID)).toBeDefined()
  })
})
