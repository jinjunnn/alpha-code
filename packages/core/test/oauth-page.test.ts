import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })

  test("#1047: success page uses alpha-code product identity, not OpenCode", () => {
    const html = OauthCallbackPage.success({ provider: "MCP" })
    expect(html).toContain("alpha-code is now connected to MCP.")
    expect(html).toContain("aria-label=\"alpha-code\"")
    expect(html).toContain("· alpha-code</title>")
    expect(html).not.toContain("OpenCode")
    expect(html).not.toContain("opencode")
  })

  test("#1047: error page uses alpha-code product identity", () => {
    const html = OauthCallbackPage.error("denied", { provider: "MCP" })
    expect(html).toContain("alpha-code couldn't finish connecting to MCP.")
    expect(html).toContain("try again from alpha-code.")
    expect(html).not.toContain("OpenCode")
  })
})
