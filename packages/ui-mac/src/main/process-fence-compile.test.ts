// REQ-159 (`#1321`) —— 试编译这台仪器先自证:它必须测得出**已知的坏**(65 535 那道墙、语法错),
// 再用它判 §8.2 形状的 profile 是好的。真 /usr/bin/sandbox-exec,darwin-only;CI(ubuntu)上自报 skip。
//
// 两条已知的坏都来自 U2 §2.2 的实测:7 000 条 `(subpath …)` ⇒ `data object length … exceeds maximum (65535)`;
// 单位是字节不是条数(220 字符 × 340→400 条之间撞墙),所以这里用**长路径**造一份必撞墙的,
// 断言原因原文含 `exceeds maximum`。

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { SANDBOX_EXEC, trialCompileProfile } from "./process-fence-compile"
import { renderProcessFenceProfile, resolveEngineRoots } from "./process-fence-profile"

const describeSandbox = process.platform === "darwin" && existsSync(SANDBOX_EXEC) ? describe : describe.skip

describeSandbox("trialCompileProfile —— 真 sandbox-exec", () => {
  const home = homedir()
  const input = {
    workspaces: [join(home, "code-puppy"), tmpdir()],
    alphaGlobalRoot: join(home, "Library", "Application Support", "alpha-code-state", "env", "dev"),
    userDataPath: join(home, "Library", "Application Support", "ai.opencode.desktop.dev"),
    stateHome: join(home, "Library", "Application Support", "ai.opencode.desktop.dev"),
    roots: resolveEngineRoots({}, home),
  }

  test("[已知的坏 ①] 撞 65535 字节墙的 profile ⇒ ok:false,原因含 `exceeds maximum`", () => {
    // 路径必须**互不相同**:编码里有共享前缀/去重(U2 §6),1200 条只差尾号的 200 字符路径实测**编得过**
    // (2026-09-09 本票第一版就这么写、判成了假绿)。400 条各不相同的 220 字符路径 ⇒ 119 ms 撞墙。
    const rnd = (i: number) => Array.from({ length: 220 }, (_, j) => String.fromCharCode(97 + ((i * 7919 + j * 104729 + ((i * j) % 31)) % 26))).join("")
    const long = Array.from({ length: 400 }, (_, i) => `/Users/x/${rnd(i)}`)
    const r = trialCompileProfile(renderProcessFenceProfile({ ...input, workspaces: long }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/exceeds maximum \(65535\)|profile compilation failed/)
  })

  test("[已知的坏 ②] 语法坏的 profile ⇒ ok:false,原因非空", () => {
    const r = trialCompileProfile("(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath \"/x\"\n")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0)
  })

  test("[好] §8.2 形状 + 本机根 ⇒ ok:true;并且 MAX_WORKSPACES 量级(32 条本机长度的路径)也通过", () => {
    expect(trialCompileProfile(renderProcessFenceProfile(input))).toEqual({ ok: true })
    const thirtyTwo = Array.from({ length: 32 }, (_, i) => join(home, "Documents", "workspace", `project-${i}`))
    expect(trialCompileProfile(renderProcessFenceProfile({ ...input, workspaces: thirtyTwo }))).toEqual({ ok: true })
  })

  test("[观测手段] 编译器跑不起来时说「could not run」而不是 ok(空输出不算通过)", () => {
    const r = trialCompileProfile("(version 1)(allow default)", {
      spawn: (() => ({ error: new Error("ENOENT sandbox-exec"), status: null, stdout: "", stderr: "" })) as unknown as typeof import("node:child_process").spawnSync,
    })
    expect(r).toEqual({ ok: false, reason: "sandbox-exec could not run: ENOENT sandbox-exec" })
  })
})
