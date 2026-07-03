// B1:shell env 缓存单测。红线:形状/键控严格(坏缓存→null 走同步路径,宁慢不错);空探测不缓存。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readShellEnvCache, shellEnvCachePath, writeShellEnvCache } from "./shell-env-cache"

let tmp = ""
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shell-env-cache-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("shell env cache", () => {
  test("write → read 回路(同 shell)", () => {
    writeShellEnvCache(tmp, "/bin/zsh", { PATH: "/opt/homebrew/bin:/usr/bin", NVM_DIR: "/Users/u/.nvm" })
    expect(readShellEnvCache(tmp, "/bin/zsh")).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", NVM_DIR: "/Users/u/.nvm" })
  })

  test("shell 换了 → 缓存失效(键控,回退同步探测)", () => {
    writeShellEnvCache(tmp, "/bin/zsh", { PATH: "/x" })
    expect(readShellEnvCache(tmp, "/bin/bash")).toBeNull()
  })

  test("空探测不缓存(失败下次启动重试,不固化坏态)", () => {
    writeShellEnvCache(tmp, "/bin/zsh", {})
    expect(fs.existsSync(shellEnvCachePath(tmp))).toBe(false)
  })

  test("坏 JSON / 坏形状 → null", () => {
    fs.writeFileSync(shellEnvCachePath(tmp), "{nope")
    expect(readShellEnvCache(tmp, "/bin/zsh")).toBeNull()
    fs.writeFileSync(shellEnvCachePath(tmp), JSON.stringify({ shell: "/bin/zsh", env: [1, 2] }))
    expect(readShellEnvCache(tmp, "/bin/zsh")).toBeNull()
    fs.writeFileSync(shellEnvCachePath(tmp), JSON.stringify({ shell: "/bin/zsh", env: { A: 1 } }))
    expect(readShellEnvCache(tmp, "/bin/zsh")).toBeNull()
  })
})
