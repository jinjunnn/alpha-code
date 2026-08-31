// REQ-144 T3(#1196):①遗留 `cloud` entry 清扫的行为闸(只摘 cloud、第三方逐字保留、
// 解析不了零写入);②交互式 OAuth 退役的源码级 ratchet —— cloud 路径对 inflight 闸 /
// CIMD 常量零引用。把引用加回任何一处,对应断言当场红(变异实验见 PR)。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ENGINE_MCP_AUTH_FILE,
  engineMcpAuthPath,
  sweepLegacyCloudMcpAuthEntry,
  type SweepFsDeps,
} from "./cloud-mcp-auth-sweep"

function memDeps(files: Record<string, string>) {
  const writes: Array<{ path: string; content: string }> = []
  const deps: SweepFsDeps = {
    readFile: (p) => (p in files ? files[p] : null),
    writeFile: (p, content) => writes.push({ path: p, content }),
  }
  return { deps, writes }
}

const DIR = "/engine-data"
const FILE = join(DIR, ENGINE_MCP_AUTH_FILE)

describe("#1196 legacy cloud mcp-auth entry sweep", () => {
  test("只摘 cloud 键;第三方 entry 逐字保留;写回同一路径", () => {
    const third = {
      tokens: { accessToken: "tp-token", refreshToken: "tp-refresh" },
      clientInfo: { clientId: "tp-client" },
      serverUrl: "https://third.example/mcp",
    }
    const { deps, writes } = memDeps({
      [FILE]: JSON.stringify({
        cloud: { codeVerifier: "cv", oauthState: "st", serverUrl: "https://cloud.example/mcp" },
        "third-party": third,
      }),
    })
    const outcome = sweepLegacyCloudMcpAuthEntry(DIR, deps)
    expect(outcome).toEqual({ action: "removed", path: FILE })
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe(FILE)
    const written = JSON.parse(writes[0].content)
    expect(written).toEqual({ "third-party": third })
    expect("cloud" in written).toBe(false)
  })

  test("文件缺席 ⇒ 零写入", () => {
    const { deps, writes } = memDeps({})
    expect(sweepLegacyCloudMcpAuthEntry(DIR, deps)).toEqual({ action: "none", reason: "absent" })
    expect(writes).toHaveLength(0)
  })

  test("解析失败 ⇒ 零写入(解析不了的文件不是我们的,不重写)", () => {
    const { deps, writes } = memDeps({ [FILE]: "not-json{" })
    expect(sweepLegacyCloudMcpAuthEntry(DIR, deps)).toEqual({ action: "none", reason: "unparseable" })
    expect(writes).toHaveLength(0)
  })

  test("顶层不是对象(数组/标量)⇒ 零写入", () => {
    for (const raw of [JSON.stringify(["cloud"]), JSON.stringify("cloud"), "null"]) {
      const { deps, writes } = memDeps({ [FILE]: raw })
      expect(sweepLegacyCloudMcpAuthEntry(DIR, deps)).toEqual({ action: "none", reason: "not-object" })
      expect(writes).toHaveLength(0)
    }
  })

  test("无 cloud 键 ⇒ 零写入(幂等:摘一次后永远 no-op)", () => {
    const { deps, writes } = memDeps({ [FILE]: JSON.stringify({ "third-party": { serverUrl: "https://t.example" } }) })
    expect(sweepLegacyCloudMcpAuthEntry(DIR, deps)).toEqual({ action: "none", reason: "no-cloud-entry" })
    expect(writes).toHaveLength(0)
  })

  test("engineMcpAuthPath 与引擎 auth.ts 同一 basename", () => {
    expect(engineMcpAuthPath("/x")).toBe("/x/mcp-auth.json")
    expect(ENGINE_MCP_AUTH_FILE).toBe("mcp-auth.json")
  })
})

// ── 源码级 ratchet:退出条件「cloud 路径对 MCP.authenticate/inflight 闸零引用」的常驻闸 ──
// 先证明手段测得出已知的坏:每个被扫文件都有一条**正样本**断言(已知在场的符号必须命中),
// 检索手段失灵(读错文件/空串)时正样本先红,零命中断言不会静默假绿。
describe("#1196 interactive-OAuth retirement ratchet", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..")
  const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8")

  test("ui-mac main 对 inflight 闸零引用(正样本:runBootDanglingSweep 在场)", () => {
    const src = read("packages/ui-mac/src/main/index.ts")
    expect(src.includes("runBootDanglingSweep")).toBe(true) // 手段自证
    expect(src.includes("isCloudMcpOAuthInflight")).toBe(false)
    expect(src.includes("cloud-mcp-oauth-gate")).toBe(false)
  })

  test("引擎 authenticate 路径对 inflight 标记零引用(正样本:waitForCallback 在场)", () => {
    const src = read("packages/opencode/src/mcp/index.ts")
    expect(src.includes("waitForCallback")).toBe(true) // 手段自证:第三方交互路仍在
    expect(src.includes("cloud-mcp-oauth-inflight")).toBe(false)
    expect(src.includes("clearInflight")).toBe(false)
  })

  test("CIMD 常量已退役(正样本:materializeCloudMcpConfig 在场)", () => {
    const src = read("packages/ui-mac/src/main/cloud-sidecar-config.ts")
    expect(src.includes("materializeCloudMcpConfig")).toBe(true) // 手段自证
    expect(src.includes("CLOUD_MCP_OAUTH_CLIENT_ID")).toBe(false)
    expect(src.includes("CLOUD_MCP_OAUTH_REDIRECT_URI")).toBe(false)
  })
})
