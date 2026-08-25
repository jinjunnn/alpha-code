// `#1106`:doom 判据的逐臂闸。判据必须逐条镜像引擎的取凭证路径
// (`packages/opencode/src/mcp/auth.ts` 的 `getForUrl`:entry 存在 + `serverUrl` 逐字相等,
// 再由 provider 用 `entry.tokens`),偏差只允许朝「保持今天行为(不 doom)」的方向。
// 每一臂都有一个能骗过粗粒度实现的反例 —— 「断言的粒度不能比缺陷粗一格」。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isCloudMcpConnectDoomed, mcpAuthPath } from "./cloud-mcp-doomed-connect"

const URL_A = "https://alpha-cloud.tidelabs.click/mcp"
const URL_B = "https://other.example/mcp"

describe("`#1106` isCloudMcpConnectDoomed", () => {
  let engineData: string

  beforeEach(() => {
    engineData = fs.mkdtempSync(path.join(os.tmpdir(), "ac1106-doom-"))
  })
  afterEach(() => {
    fs.rmSync(engineData, { recursive: true, force: true })
  })

  const plant = (data: unknown) => {
    fs.writeFileSync(mcpAuthPath(engineData), typeof data === "string" ? data : JSON.stringify(data))
  }

  test("文件不存在 ⇒ doomed(从未授权过的引擎数据目录 —— 本修复的主受益态)", () => {
    expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(true)
  })

  test("owner 机器的真实形状:codeVerifier/oauthState/serverUrl 在、tokens 缺 ⇒ doomed", () => {
    // 2026-08-24 实测本机 mcp-auth.json 就是这个形状(`#1044` 注释里那句「只剩
    // codeVerifier/oauthState」)—— 授权从未完成,引擎每次 boot 连它都只能 401。
    plant({ cloud: { codeVerifier: "v", oauthState: "s", serverUrl: URL_A } })
    expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(true)
  })

  test("tokens 在且 serverUrl 逐字匹配 ⇒ 不 doomed(引擎可能连上,boot 行为保持今天)", () => {
    plant({ cloud: { serverUrl: URL_A, tokens: { accessToken: "tok" } } })
    expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(false)
  })

  test("tokens 在但 serverUrl 不匹配 ⇒ doomed(镜像 getForUrl:URL 换了旧凭证一律不给)", () => {
    plant({ cloud: { serverUrl: URL_B, tokens: { accessToken: "tok" } } })
    expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(true)
  })

  test("tokens 在但 serverUrl 缺 ⇒ doomed(getForUrl 的 `!entry.serverUrl` 分支)", () => {
    plant({ cloud: { tokens: { accessToken: "tok" } } })
    expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(true)
  })

  test("accessToken 是空串 ⇒ doomed(引擎 schema 收下它,但发出去就是 401)", () => {
    plant({ cloud: { serverUrl: URL_A, tokens: { accessToken: "" } } })
    expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(true)
  })

  test("看的是指定的 server 名,不是任意 entry(别的 server 有凭证救不了 cloud)", () => {
    plant({ other: { serverUrl: URL_A, tokens: { accessToken: "tok" } } })
    expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(true)
  })

  test("JSON 解析失败 ⇒ doomed(引擎 decode 失败同样落 `{}`,连接照样 401)", () => {
    plant("{ not json")
    expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(true)
  })

  test("文件在但读不了(EACCES)⇒ **不** doomed —— fail-open,最坏 = 今天的 boot 等待", () => {
    if (process.getuid?.() === 0) return // root 无视权限位,这一臂在 root 下测不出
    plant({ cloud: { serverUrl: URL_A, tokens: { accessToken: "tok" } } })
    fs.chmodSync(mcpAuthPath(engineData), 0o000)
    try {
      expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(false)
    } finally {
      fs.chmodSync(mcpAuthPath(engineData), 0o600)
    }
  })

  test("顶层不是对象(JSON 合法但形状不对)⇒ doomed", () => {
    plant("[1,2,3]")
    expect(isCloudMcpConnectDoomed(engineData, "cloud", URL_A)).toBe(true)
  })
})
