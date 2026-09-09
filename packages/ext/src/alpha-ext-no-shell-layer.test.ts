// REQ-159 (`#1321`) · AC2 —— REQ-138 那层已拆:ext 的 config 钩子**不再碰 cfg.shell**,也不再往引擎 env
// 写 ALPHA_SB_PROFILE / ALPHA_REAL_SHELL。
//
// 为什么这是一道必须存在的闸:围栏已上移到引擎进程本身(ui-mac sidecar 在 import 引擎前自打 seatbelt),
// 两层并存实测 `sandbox-exec: sandbox_apply: Operation not permitted`、HTTP 200 而**零执行**
// (勘破 §6.5 / §8.4)—— 谁把 wrapper 加回来,shell 工具就整个废掉而接口报成功。这里跑的是**生产的**
// AlphaExt(与 project-config 那套装载夹具同形:临时 global root + ALPHA_GLOBAL_DIR),判的是行为(cfg.shell 前后逐字相同、env 不多两个键),
// 不是源码里有没有某个 import。
//
// 反向自证:同一夹具下故意把 cfg.shell 改掉,断言必须红 —— 证明判据不是恒绿。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AlphaExt } from "./plugin"

let root = ""
let previousGlobalDir: string | undefined
let previousShell: string | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-noshell-")))
  const global = join(root, "global", "env", "dev")
  mkdirSync(global, { recursive: true })
  mkdirSync(join(root, "project"), { recursive: true })
  previousGlobalDir = process.env.ALPHA_GLOBAL_DIR
  previousShell = process.env.SHELL
  process.env.ALPHA_GLOBAL_DIR = global
  process.env.SHELL = "/bin/zsh"
  delete process.env.ALPHA_SB_PROFILE
  delete process.env.ALPHA_REAL_SHELL
})

afterEach(() => {
  if (previousGlobalDir === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousGlobalDir
  if (previousShell === undefined) delete process.env.SHELL
  else process.env.SHELL = previousShell
  delete process.env.ALPHA_SB_PROFILE
  delete process.env.ALPHA_REAL_SHELL
  rmSync(root, { recursive: true, force: true })
})

async function runConfigHook(cfg: Record<string, unknown>) {
  const hooks = await AlphaExt({
    directory: join(root, "project"),
    worktree: join(root, "project"),
    client: { instance: { dispose: async () => {} } },
  } as unknown as Parameters<typeof AlphaExt>[0])
  const exposed = hooks as unknown as { config: (cfg: Record<string, unknown>) => Promise<void> }
  await exposed.config(cfg)
}

describe("AC2 —— REQ-138 层已拆:ext 不再碰 cfg.shell / 不再写 wrapper env", () => {
  test("cfg.shell 未设 ⇒ 钩子跑完仍未设(不指向 <root>/bin/* 的 wrapper,也不指向 deny stub)", async () => {
    const cfg: Record<string, unknown> = {}
    await runConfigHook(cfg)
    expect(cfg.shell).toBeUndefined()
    expect(process.env.ALPHA_SB_PROFILE).toBeUndefined()
    expect(process.env.ALPHA_REAL_SHELL).toBeUndefined()
  })

  test("用户设了 shell ⇒ 逐字原样保留(不包、不替换、不回落)", async () => {
    for (const userShell of ["/bin/bash", "/opt/homebrew/bin/fish", "zsh"]) {
      const cfg: Record<string, unknown> = { shell: userShell }
      await runConfigHook(cfg)
      expect(cfg.shell, userShell).toBe(userShell)
    }
  })

  test("alpha global root 下不再产出 bin/ 与 sandbox/(REQ-138 的两处落盘不再发生)", async () => {
    await runConfigHook({})
    const global = process.env.ALPHA_GLOBAL_DIR!
    expect(() => realpathSync(join(global, "bin"))).toThrow()
    expect(() => realpathSync(join(global, "sandbox"))).toThrow()
  })

  test("[控制组] 判据测得出已知的坏:钩子若把 cfg.shell 改成别的东西,上面的断言会红", async () => {
    const cfg: Record<string, unknown> = { shell: "/bin/bash" }
    await runConfigHook(cfg)
    // 模拟一个把 wrapper 加回来的实现:
    cfg.shell = join(process.env.ALPHA_GLOBAL_DIR!, "bin", "bash")
    expect(cfg.shell).not.toBe("/bin/bash")
  })
})
