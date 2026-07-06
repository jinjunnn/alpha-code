import { describe, expect, test } from "bun:test"
import { availableStartupServer, isEphemeralLocalServerUrl } from "./connections"

// REQ-040:冷启动陈旧默认服务器守卫 —— 具体端口的本地 sidecar URL 每次失效,须丢弃回退 "sidecar"。
describe("isEphemeralLocalServerUrl", () => {
  test("具体端口的本地 URL 视为易失(随机端口每次变)", () => {
    expect(isEphemeralLocalServerUrl("http://127.0.0.1:52743")).toBe(true)
    expect(isEphemeralLocalServerUrl("http://localhost:64100")).toBe(true)
    expect(isEphemeralLocalServerUrl("https://127.0.0.1:8080/foo")).toBe(true)
    expect(isEphemeralLocalServerUrl("http://[::1]:5000")).toBe(true)
  })
  test("远端主机 / wsl / 符号 key 保留(非易失)", () => {
    expect(isEphemeralLocalServerUrl("https://opencode.example.com")).toBe(false)
    expect(isEphemeralLocalServerUrl("http://192.168.1.10:4096")).toBe(false)
    expect(isEphemeralLocalServerUrl("wsl:ubuntu")).toBe(false)
    expect(isEphemeralLocalServerUrl("sidecar")).toBe(false)
    // 无端口的 localhost 不判易失(不是 sidecar 随机端口形态)
    expect(isEphemeralLocalServerUrl("http://localhost")).toBe(false)
  })
})

describe("availableStartupServer", () => {
  test("空默认 → 符号 sidecar", () => {
    expect(availableStartupServer(null)).toBe("sidecar")
    expect(availableStartupServer(undefined)).toBe("sidecar")
  })
  test("非 wsl 默认原样返回", () => {
    expect(availableStartupServer("https://remote.example.com")).toBe("https://remote.example.com")
  })
  test("wsl 默认:live 才保留,否则回退 sidecar", () => {
    const state = { servers: [{ config: { id: "wsl:ubuntu" }, runtime: { kind: "ready" } }] } as any
    expect(availableStartupServer("wsl:ubuntu", state)).toBe("wsl:ubuntu")
    expect(availableStartupServer("wsl:ubuntu", { servers: [] } as any)).toBe("sidecar")
    expect(availableStartupServer("wsl:ubuntu")).toBe("sidecar")
  })
})
