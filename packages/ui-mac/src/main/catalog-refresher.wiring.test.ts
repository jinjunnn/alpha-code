// REQ-237 `#1555` AC1 辅助源码锚(方案 req236 §3 I1:判据是生产入口的**行为**,源码锚只作辅助)。
//
// 换代链路(index.ts 的 doRespawnSidecar)跑不进单测,行为判据是 server.test.ts「目录 fetch 永不 settle 时
// spawnLocalServer 仍完成 fork」与 dev 桩下续期的 startup-timeline 间隔;这里只钉三处接线不回退:
//   1. doRespawnSidecar 体内不再等任何远端目录(修前是 `await syncLiveAllowlist(...)`,续期平均白等 4.0s);
//   2. 启动与身份变化经 requestCatalogRefresh 触发,且不 await;
//   3. spawnLocalServer 在 fork 前钉住已应用目录,且排在出网放行派生(读 buildAlphaModelConfig)之前。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8")
const index = read("index.ts")
const server = read("server.ts")

/** doRespawnSidecar 从定义起到它调用 spawnLocalServer(fork)为止的那一段。 */
function respawnBody(): string {
  const start = index.indexOf("const doRespawnSidecar = async")
  expect(start).toBeGreaterThan(-1)
  const end = index.indexOf("spawnLocalServer(", start)
  expect(end).toBeGreaterThan(start)
  return index.slice(start, end)
}

describe("`#1555` 目录刷新与引擎换代解耦(源码锚)", () => {
  test("ANCHOR (not a gate): 换代链路在 fork 之前不等任何远端目录", () => {
    const body = respawnBody()
    expect(body).not.toContain("syncLiveAllowlist(")
    expect(body).not.toMatch(/await\s+requestCatalogRefresh/)
    expect(body).not.toMatch(/await\s+[^\n]*fetchPlatformModels/)
    expect(index).not.toContain("syncLiveAllowlist(")
  })

  test("ANCHOR (not a gate): 启动与身份变化经 requestCatalogRefresh 触发,从不 await", () => {
    expect(index).toContain('requestCatalogRefresh("boot")')
    const onChanged = index.slice(index.indexOf("onChanged: () => {"), index.indexOf("// Windows/Linux cold start"))
    expect(onChanged).toContain('requestCatalogRefresh("identity-change")')
    expect(index).not.toMatch(/await\s+requestCatalogRefresh/)
  })

  test("ANCHOR (not a gate): spawnLocalServer 先钉住已应用目录,再派生出网放行、再 fork", () => {
    const spawn = server.slice(server.indexOf("export async function spawnLocalServer("))
    const pin = spawn.indexOf("pinAppliedCatalog(options.userDataPath")
    const egress = spawn.indexOf("refreshConfiguredEgressDestinations(options.userDataPath)")
    const fork = spawn.search(/\(options\.fork \?\? [^)]*\)\(/)
    expect(pin).toBeGreaterThan(spawn.indexOf("syncSecretFiles(options.userDataPath"))
    expect(egress).toBeGreaterThan(pin)
    expect(fork).toBeGreaterThan(egress)
  })
})
