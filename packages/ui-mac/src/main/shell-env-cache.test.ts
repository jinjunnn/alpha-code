// B1:shell env 缓存单测。红线:形状/键控严格(坏缓存→null 走同步路径,宁慢不错);空探测不缓存。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readShellEnvCache, sanitizeCachedShellEnv, shellEnvCachePath, writeShellEnvCache } from "./shell-env-cache"

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

  // ── REQ-047:存量毒化缓存(会话级隔离/调试键被腌入)读侧剥离;用户真环境(PATH/API key)存活 ──

  test("REQ-047 毒化缓存 → 控制键剥离、用户键存活(S27 真机批真实形态)", () => {
    writeShellEnvCache(tmp, "/bin/zsh", {
      PATH: "/opt/homebrew/bin:/usr/bin",
      DEEPSEEK_API_KEY: "sk-user-real",
      ALPHA_GLOBAL_DIR: "/tmp/claude-501/dead-session/m1-alpha-home",
      ALPHA_ENV_BASE_DIR: "/tmp/claude-501/dead-session/state-base",
      OPENCODE_CONFIG_DIR: "/tmp/claude-501/dead-session/m1-legacy",
      ALPHA_OPENCODE_HOME: "/tmp/claude-501/dead-session/m1-opencode-home",
      ALPHA_MIGRATE_ENABLE: "1",
      ALPHA_CDP: "1",
      OPENCODE_DB: "/tmp/somewhere.db",
      ALPHA_LEGACY_INSTALL_ROOT: "1",
      OPENCODE_TEST_ONBOARDING: "1",
    })
    expect(readShellEnvCache(tmp, "/bin/zsh")).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      DEEPSEEK_API_KEY: "sk-user-real",
    })
  })

  test("REQ-047 缓存只剩控制键 → 剥离后为空 = null(回退同步干净探测,不套用空集装成功)", () => {
    writeShellEnvCache(tmp, "/bin/zsh", { ALPHA_CDP: "1", ALPHA_GLOBAL_DIR: "/tmp/x" })
    expect(readShellEnvCache(tmp, "/bin/zsh")).toBeNull()
  })

  test("REQ-051 剥离与自愈重建正式留痕,日志只含动作和控制键名", () => {
    const logs: Array<{ message: string; extra: Record<string, unknown> | undefined }> = []
    const log = (message: string, extra?: Record<string, unknown>) => logs.push({ message, extra })
    writeShellEnvCache(tmp, "/bin/zsh", {
      PATH: "/opt/req051-private/bin",
      DEEPSEEK_API_KEY: "sk-req051-credential-do-not-log",
      ALPHA_GLOBAL_DIR: "/tmp/req051-control-value-do-not-log",
      ALPHA_CDP: "req051-debug-value-do-not-log",
    })

    expect(readShellEnvCache(tmp, "/bin/zsh", log)).toEqual({
      PATH: "/opt/req051-private/bin",
      DEEPSEEK_API_KEY: "sk-req051-credential-do-not-log",
    })

    const refreshed = { PATH: "/usr/bin", DEEPSEEK_API_KEY: "sk-req051-fresh-do-not-log" }
    writeShellEnvCache(tmp, "/bin/zsh", refreshed, log)
    expect(readShellEnvCache(tmp, "/bin/zsh")).toEqual(refreshed)
    expect(logs).toEqual([
      {
        message: "req047: stripped session-control keys from cached shell env",
        extra: { stripped: ["ALPHA_GLOBAL_DIR", "ALPHA_CDP"] },
      },
      {
        message: "req047: rebuilt shell env cache after successful probe",
        extra: undefined,
      },
    ])

    const logged = JSON.stringify(logs)
    expect(logged).toContain("ALPHA_GLOBAL_DIR")
    expect(logged).toContain("ALPHA_CDP")
    expect(logged).not.toContain("/opt/req051-private/bin")
    expect(logged).not.toContain("/usr/bin")
    expect(logged).not.toContain("sk-req051-credential-do-not-log")
    expect(logged).not.toContain("/tmp/req051-control-value-do-not-log")
    expect(logged).not.toContain("req051-debug-value-do-not-log")
    expect(logged).not.toContain("sk-req051-fresh-do-not-log")
    expect(logged).not.toContain("DEEPSEEK_API_KEY")
  })

  test("sanitizeCachedShellEnv 纯函数:stripped 列表如实、干净输入原样返回(不复制)", () => {
    const dirty = sanitizeCachedShellEnv({ A: "1", ALPHA_CDP: "1", ALPHA_ENV_BASE_DIR: "/state", OPENCODE_CONFIG_DIR: "/x" })
    expect(dirty.env).toEqual({ A: "1" })
    expect(dirty.stripped.sort()).toEqual(["ALPHA_CDP", "ALPHA_ENV_BASE_DIR", "OPENCODE_CONFIG_DIR"])
    const clean = { PATH: "/usr/bin", MY_KEY: "v" }
    const r = sanitizeCachedShellEnv(clean)
    expect(r.env).toBe(clean)
    expect(r.stripped).toEqual([])
  })
})
