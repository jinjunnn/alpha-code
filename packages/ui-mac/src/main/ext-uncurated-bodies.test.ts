// #336(残留4)—— 未策展提交面(custom MCP 导入)的账本写失败注入测试:
// 断言 fail-closed 返回(绝不谎报成功)+ 精确补偿(restoreMcpLeaf 前像复原)+ 密钥版本清理。
// ADR-040(`#825`):npm plugin 导入 body 与它的三条用例随通道整条撤下 —— `installPluginBody` /
// `persistPlugin` / `removePluginEntryExact` 都已不存在,没有任何生产路径能到达那三条断言。注入 = recordInstall 参数 DI(账本提交结果是本面唯一要观测的失败源;
// 静态 fs seam 如 installs.json 置目录会先被账本**读侧**的 ledger-corrupt fail-closed 拦截,证明
// 不了「写失败后补偿」)。其余全真盘:env 根重定向临时目录,零 mock.module(仓规)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readMcpLeaf } from "./ext-config"
import { makeUncuratedInstallBodies } from "./ext-uncurated-bodies"
import type { recordUncuratedInstall } from "./ext-uncurated-record"

let tmp = ""
let homeTmp = ""
let alphaTmp = ""
let userDataTmp = ""
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
const prevHome = process.env.ALPHA_OPENCODE_HOME
const prevAlpha = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-uncurated-"))
  homeTmp = path.join(tmp, "opencode-home")
  alphaTmp = path.join(tmp, "alpha-home")
  userDataTmp = path.join(tmp, "user-data")
  fs.mkdirSync(userDataTmp, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = tmp
  process.env.ALPHA_OPENCODE_HOME = homeTmp
  process.env.ALPHA_GLOBAL_DIR = alphaTmp
})
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
  if (prevHome === undefined) delete process.env.ALPHA_OPENCODE_HOME
  else process.env.ALPHA_OPENCODE_HOME = prevHome
  if (prevAlpha === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = prevAlpha
  fs.rmSync(tmp, { recursive: true, force: true })
})

type RecordInstall = typeof recordUncuratedInstall

/** 注入 seam:记录调用并返回失败(账本卷不可写等)。 */
function failingRecorder(calls: string[]): RecordInstall {
  return (_root, input) => {
    calls.push(`${input.kind}:${input.name}`)
    return { ok: false, reason: "injected: ledger volume gone" }
  }
}

function bodies(recordInstall?: RecordInstall) {
  return makeUncuratedInstallBodies({
    userDataPath: userDataTmp,
    globalRoot: () => alphaTmp,
    environment: () => "prod",
    ...(recordInstall ? { recordInstall } : {}),
  })
}

/** 递归扫描目录内是否有文件包含明文(密钥补偿断言用)。 */
function anyFileContains(dir: string, needle: string): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (anyFileContains(p, needle)) return true
    } else if (e.isFile()) {
      try {
        if (fs.readFileSync(p, "utf8").includes(needle)) return true
      } catch {
        /* 非文本/不可读跳过 */
      }
    }
  }
  return false
}

describe("#336 custom MCP(persistMcpBody)—— 账本写失败注入", () => {
  test("首装:账本写失败 → ok:false 如实上报;补偿删除本次写入的叶(before=undefined)", async () => {
    const calls: string[] = []
    const { persistMcpBody } = bodies(failingRecorder(calls))
    const r = await persistMcpBody("srv", { type: "local", command: ["npx"] })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toContain("install ledger write failed")
    expect(r.reason).toContain("injected: ledger volume gone")
    expect(calls).toEqual(["mcp:srv"]) // 注入 seam 确实被走到
    expect(readMcpLeaf("srv")).toBeUndefined() // 精确补偿:本次叶已撤,config 不留半装态
  })

  test("更新:账本写失败 → 前像精确复原(不删既有安装,只撤本次改动)", async () => {
    const seeded = await bodies().persistMcpBody("srv", { type: "local", command: ["npx"] }) // 真落账
    expect(seeded.ok).toBe(true)
    const before = readMcpLeaf("srv")
    expect(before).toBeDefined()

    const calls: string[] = []
    const r = await bodies(failingRecorder(calls)).persistMcpBody("srv", { type: "local", command: ["npx", "-y", "other-pkg"] })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toContain("install ledger write failed")
    expect(readMcpLeaf("srv")).toEqual(before) // before-image 逐字复原(Codex #355 精确叶子补偿)
  })

  test("带明文密钥:账本写失败 → 叶已撤 + 本次密钥版本目录清理,明文零残留", async () => {
    const calls: string[] = []
    const { persistMcpBody } = bodies(failingRecorder(calls))
    const r = await persistMcpBody(
      "secret-srv",
      { type: "local", command: ["npx"], environment: { TOKEN: "plaintext-secret-value" } },
      ["TOKEN"],
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toContain("install ledger write failed")
    expect(readMcpLeaf("secret-srv")).toBeUndefined()
    // 复原成功 → 本次版本目录已删:userData 树内不残留明文
    expect(anyFileContains(userDataTmp, "plaintext-secret-value")).toBe(false)
  })
})
