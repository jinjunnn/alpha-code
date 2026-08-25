// REQ-138 / #1075 · AC3 —— 用户改配置不产生无围栏执行。
//
// `shell` 是合法 config 键(packages/opencode/src/config/config.ts:174)且可被手改。config hook
// 每次配置加载都调 wrapEngineShell,它**包住**(不替换)用户取值:无论用户把 shell 设成什么,
// 下一次加载后 cfg.shell 恒指向 wrapper,ALPHA_REAL_SHELL 记下用户的真 shell。
//
// 纯逻辑,platform 用 seam 强制 darwin,fs 用捕获式 mock —— Linux CI 照跑。

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { BIN_DIRNAME, wrapEngineShell, type WrapEngineShellSeams } from "./shell-sandbox"

const ROOT = "/alpha/env/prod"
const BIN = join(ROOT, BIN_DIRNAME)

function seams(): WrapEngineShellSeams {
  const known = new Set(["/bin/zsh", "/bin/bash", "/bin/sh"])
  return {
    platform: "darwin",
    envShell: "/bin/zsh",
    statIsFile: (p) => known.has(p),
    which: () => undefined,
    mkdirSync: () => {},
    writeFileSync: () => {},
    chmodSync: () => {},
  }
}

describe("AC3 re-wrap on every load — user config never yields an unfenced shell", () => {
  test("每次加载都重新包裹:反复调 wrapEngineShell,cfg.shell 恒是 wrapper", () => {
    const cfg: { shell?: string } = {}
    for (let i = 0; i < 3; i++) {
      const env: NodeJS.ProcessEnv = {}
      const r = wrapEngineShell(cfg, ROOT, env, seams())
      expect(r.fenced).toBe(true)
      expect(cfg.shell).toBe(join(BIN, "zsh"))
    }
  })

  test("用户手改 shell → 下一次加载仍被包裹(包住,不替换):真 shell 记进 ALPHA_REAL_SHELL", () => {
    // 模拟:磁盘上的 config 每次加载给出用户设的原始 shell(hook 的 cfg 每次从磁盘重建)
    for (const userShell of ["/bin/bash", "/bin/sh", "/bin/zsh"]) {
      const cfg: { shell?: string } = { shell: userShell }
      const env: NodeJS.ProcessEnv = {}
      const r = wrapEngineShell(cfg, ROOT, env, seams())
      expect(r.fenced).toBe(true)
      const base = userShell.split("/").pop()!
      expect(cfg.shell).toBe(join(BIN, base))
      expect(env.ALPHA_REAL_SHELL).toBe(userShell)
    }
  })

  test("用户把 shell 填成 wrapper 路径本身 → 不双重包裹、不自嵌套,real 回落默认", () => {
    const wrapperPath = join(BIN, "zsh")
    const s = seams()
    // wrapper 文件确实存在
    const withWrapper: WrapEngineShellSeams = { ...s, statIsFile: (p) => p === wrapperPath || p === "/bin/zsh" }
    const cfg: { shell?: string } = { shell: wrapperPath }
    const env: NodeJS.ProcessEnv = {}
    const r = wrapEngineShell(cfg, ROOT, env, withWrapper)
    expect(r.fenced).toBe(true)
    expect(cfg.shell).toBe(wrapperPath)
    // 关键:real 不是 wrapper 自己(否则 wrapper exec wrapper 无限自嵌套)
    expect(env.ALPHA_REAL_SHELL).toBe("/bin/zsh")
    expect(env.ALPHA_REAL_SHELL).not.toBe(wrapperPath)
  })

  test("用户设一个不存在的 shell → 回落默认 zsh 并包裹,绝不因解析失败留裸/空 shell", () => {
    const cfg: { shell?: string } = { shell: "/nope/nope/sh" }
    const env: NodeJS.ProcessEnv = {}
    const r = wrapEngineShell(cfg, ROOT, env, seams())
    expect(r.fenced).toBe(true)
    expect(cfg.shell).toBe(join(BIN, "zsh"))
    expect(env.ALPHA_REAL_SHELL).toBe("/bin/zsh")
  })
})
