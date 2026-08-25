// REQ-138 / #1075 · 等价性锚 —— resolveRealShell 必须与**真** @opencode-ai/core 的 Shell 一致。
//
// 这条锚**独立**于被测对象(基准是 core 的源码 Shell,不是本模块自己的常量),所以不是自指
// 等价链;它枚举输入的**形状域**(未设 / 绝对存在 / 绝对不存在 / denied 的绝对与裸 / 裸名字 /
// 空串)后再下等价论断(CLAUDE.md:等价性论断必须先枚举形状域)。
//
// 只在 darwin 上比对:core Shell 的 fallback 依平台(darwin=/bin/zsh、linux=which bash),而
// resolveRealShell 按 darwin 复刻,linux 上比对无意义 ⇒ describe.skip。因此本文件是平台变量
// 计数(darwin 1 / linux 0),只喂 ext 整包地板(≥100),**不**登记进 gate-files.tsv 的精确条数。
// 命名不含闸门词(见 gate-file-registry.test.ts 的 GATE_NAME_TOKENS),不触发命名启发式。

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import { resolveRealShell } from "./shell-sandbox"

const describeDarwin = process.platform === "darwin" ? describe : describe.skip

describeDarwin("resolveRealShell ≡ core Shell.acceptable + Shell.name (darwin only)", () => {
  test("枚举输入形状域,path 与 basename 双双对齐真 core Shell", async () => {
    const { Shell } = await import("../../core/src/shell")
    const binDir = "/alpha/env/prod/bin"
    const seams = {
      statIsFile: (p: string) => {
        try {
          return statSync(p).isFile()
        } catch {
          return false
        }
      },
      which: (name: string) => {
        const hit = spawnSync("/usr/bin/which", [name], { encoding: "utf8" })
        const out = (hit.stdout ?? "").trim()
        return out || undefined
      },
      envShell: process.env.SHELL,
    }
    const inputs: Array<string | undefined> = [
      undefined,
      "",
      "/bin/zsh",
      "/bin/bash",
      "/bin/sh",
      "/nonexistent/xx",
      "/opt/homebrew/bin/fish",
      "nu",
      "zsh",
    ]
    for (const input of inputs) {
      const mine = resolveRealShell(input, binDir, seams)
      const coreShell = Shell.acceptable(input)
      expect({ input, path: mine.path }).toEqual({ input, path: coreShell })
      expect({ input, base: mine.basename }).toEqual({ input, base: Shell.name(coreShell) })
    }
  })
})
