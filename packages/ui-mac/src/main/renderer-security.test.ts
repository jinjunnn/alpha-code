// C24 / #898 —— CORS 放宽范围判定、registered-origin allowlist 与 CSP 文本的守卫测试。

import { describe, expect, test } from "bun:test"
import { corsRelaxAllowed, createAlphaOriginRegistry, isLoopbackUrl, RENDERER_CSP } from "./renderer-security"

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

  test.each([
    ["http://127.0.0.1:4096/session", true],
    ["http://localhost:8080/api/event", true],
    ["ws://127.0.0.1:9000/pty", true],
    ["http://[::1]:4096/", true],
  ])("回环 %p 在 win32 上同样放宽(不依赖 registry)", (url, want) => {
    expect(corsRelaxAllowed(url, "win32")).toBe(want)
  })

  // #898(SEC 回归):此前 `corsRelaxAllowed` 对 win32 短路成
  // `platform === "win32" || isLoopbackUrl(url)`,短路项在前 ⇒ 任意 URL 都放行。以下用例锁死
  // 修复:未注册的非回环 origin 在 win32 上必须拒绝。若把短路加回去(或把它挪到 `||` 任一侧),
  // 这组用例会变红 —— 这正是它存在的目的,不是「找到另一个坏 URL」。
  test.each([
    ["https://evil.example.com/collect"],
    ["https://api.anthropic.com/v1"],
    ["http://192.168.1.10:4096/"],
    ["not a url"],
  ])("非回环 %p 在 win32 且未注册也不放宽(#898 回归锁)", (url) => {
    expect(corsRelaxAllowed(url, "win32")).toBe(false)
    expect(corsRelaxAllowed(url, "win32", createAlphaOriginRegistry())).toBe(false)
  })

  test("win32 上已登记的确切 origin 才放宽", () => {
    const registry = createAlphaOriginRegistry()
    const url = "http://192.168.1.10:4096/session"
    expect(corsRelaxAllowed(url, "win32", registry)).toBe(false)
    registry.register("http://192.168.1.10:4096", 1)
    expect(corsRelaxAllowed(url, "win32", registry)).toBe(true)
    // 登记只按 origin(scheme+host+port)匹配,同 origin 的其它路径同样命中。
    expect(corsRelaxAllowed("http://192.168.1.10:4096/other/path", "win32", registry)).toBe(true)
    // 不同 origin(端口不同)不受影响。
    expect(corsRelaxAllowed("http://192.168.1.10:9999/session", "win32", registry)).toBe(false)
  })

  test("darwin 不消费 registry —— 即便传入已登记的 registry,非回环 origin 仍不放宽", () => {
    const registry = createAlphaOriginRegistry()
    registry.register("http://192.168.1.10:4096", 1)
    expect(corsRelaxAllowed("http://192.168.1.10:4096/session", "darwin", registry)).toBe(false)
  })
})

describe("createAlphaOriginRegistry — generation 绑定的撤销语义(#898)", () => {
  test("revoke 撤销登记", () => {
    const registry = createAlphaOriginRegistry()
    registry.register("http://192.168.1.10:4096", 1)
    expect(registry.isRegistered("http://192.168.1.10:4096")).toBe(true)
    registry.revoke("http://192.168.1.10:4096", 1)
    expect(registry.isRegistered("http://192.168.1.10:4096")).toBe(false)
  })

  test("端口复用竞态:旧 generation 迟到的 revoke 不得冲掉新 generation 的 register", () => {
    const registry = createAlphaOriginRegistry()
    const origin = "http://192.168.1.10:4096"
    registry.register(origin, 1) // 服务 A(generation 1)启动并登记
    registry.register(origin, 2) // 服务 A 退出、服务 B 复用同端口(generation 2)已重新登记
    registry.revoke(origin, 1) // 服务 A 的收尾 revoke 姗姗来迟,generation 对不上
    expect(registry.isRegistered(origin)).toBe(true) // generation 2 的登记必须存活
    registry.revoke(origin, 2)
    expect(registry.isRegistered(origin)).toBe(false)
  })
})

describe("RENDERER_CSP", () => {
  test("connect-src 无通配 https(exfil 主通道收死);data: 放行(终端 WASM 加载,无外传面)", () => {
    const connect = RENDERER_CSP.split("; ").find((d) => d.startsWith("connect-src"))!
    expect(connect).not.toContain("https:")
    expect(connect).not.toContain("http: ")
    expect(connect).toContain("'self'")
    expect(connect).toContain(" data: ")
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
