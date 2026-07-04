// C24 —— CORS 放宽范围判定与 CSP 文本的守卫测试。

import { describe, expect, test } from "bun:test"
import { corsRelaxAllowed, isLoopbackUrl, RENDERER_CSP } from "./renderer-security"

describe("isLoopbackUrl / corsRelaxAllowed", () => {
  test.each([
    ["http://127.0.0.1:4096/session", true],
    ["http://localhost:8080/api/event", true],
    ["ws://127.0.0.1:9000/pty", true],
    ["http://[::1]:4096/", true],
  ])("回环 %p 放宽", (url, want) => {
    expect(isLoopbackUrl(url)).toBe(want)
    expect(corsRelaxAllowed(url, "darwin")).toBe(want)
  })

  test.each([
    ["https://evil.example.com/collect"],
    ["https://api.anthropic.com/v1"],
    ["http://192.168.1.10:4096/"],
    ["not a url"],
  ])("非回环 %p 在 darwin 不放宽(exfil 通道关闭)", (url) => {
    expect(corsRelaxAllowed(url, "darwin")).toBe(false)
  })

  test("win32 保持旧行为(WSL 远端)", () => {
    expect(corsRelaxAllowed("http://192.168.1.10:4096/", "win32")).toBe(true)
  })
})

describe("RENDERER_CSP", () => {
  test("connect-src 无通配 https(exfil 主通道收死)", () => {
    const connect = RENDERER_CSP.split("; ").find((d) => d.startsWith("connect-src"))!
    expect(connect).not.toContain("https:")
    expect(connect).not.toContain("http: ")
    expect(connect).toContain("'self'")
    expect(connect).toContain("http://127.0.0.1:*")
    expect(connect).toContain("ws://127.0.0.1:*")
  })
  test("脚本 self+wasm(ghostty 终端),不放 JS eval;object/frame 全禁", () => {
    expect(RENDERER_CSP).toContain("script-src 'self' 'wasm-unsafe-eval';")
    expect(RENDERER_CSP).toContain("object-src 'none'")
    expect(RENDERER_CSP).toContain("frame-src 'none'")
    expect(RENDERER_CSP).not.toContain(" 'unsafe-eval'") // wasm-unsafe-eval ≠ unsafe-eval(前者仅 WASM 编译)
    expect(RENDERER_CSP).not.toContain("unsafe-inline'; script") // style 的 inline 豁免不外溢到 script
  })
})
