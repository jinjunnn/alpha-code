// REQ-159 (`#1322`) AC3 —— 真探针在真围栏下:真 .node(生产构建脚本现编)、真 seatbelt、真子进程(bun)。
// darwin-only;CI(ubuntu)上自报 skip,gate-files.tsv 按 [平台:darwin] 登记。合同/簿记/判据自证的全平台一半在
// workspace-write-probe.test.ts。
//
//   · 围栏臂(= sidecar 的形态):集合内 writable、集合外 denied(EPERM)、不存在的目录 unknown;两边不留探针文件;
//     在**另一个进程**里跑(pid ≠ 测试进程),围栏 = 本次编译的模块(buildId)。判据 judgeWriteProbeCalibration 过。
//   · bare 臂(= main 进程的形态,不套围栏):集合外也答 writable ⇒ 判据把它当假探针拒掉 —— 这就是
//     「在 main 里 fs.writeFile 探测恒答可写」那一格的实测。
//
// 布局纪律(勘破 §7.4 括注):ws 与 esc 都放在**真 HOME** 之下 —— /private/tmp 与 $TMPDIR 在可写集里,放那儿
// 「escape landed」只是布局问题。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildFenceAddon } from "../../scripts/build-fence-addon"
import { renderProcessFenceProfile, resolveEngineRoots } from "./process-fence-profile"
import type { WorkspaceWriteProbeOutcome } from "./workspace-write-probe"
import { judgeWriteProbeCalibration } from "./workspace-write-probe-judge"

const fixtures = resolve(import.meta.dir, "../../test-fixtures/process-fence")

const describeDarwin = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") ? describe : describe.skip

describeDarwin("AC3 真探针在真围栏下(真 .node / 真 seatbelt / 真子进程)", () => {
  let scratch = ""
  let addon = ""
  let buildId = ""
  let ws = ""
  let esc = ""
  let missing = ""
  let profileFile = ""
  type DriverOut = {
    ok: boolean
    pid: number
    mode: string
    apply?: { buildId: string }
    inside: { outcome: WorkspaceWriteProbeOutcome; detail?: string }
    outside: { outcome: WorkspaceWriteProbeOutcome; detail?: string }
    missing: { outcome: WorkspaceWriteProbeOutcome; detail?: string }
    message?: string
  }

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "ac1322-fence-"))
    buildId = `ac1322-test-${Date.now()}`
    addon = buildFenceAddon({ out: join(scratch, "build", "alpha_fence.node"), buildId }).out
    // 布局纪律(勘破 §7.4):ws 与 esc 都放真 HOME 之下 —— /private/tmp 与 $TMPDIR 在可写集里,放那儿「escape landed」只是布局问题。
    ws = mkdtempSync(join(homedir(), ".ac1322-ws-"))
    esc = mkdtempSync(join(homedir(), ".ac1322-esc-"))
    missing = join(scratch, "does-not-exist")
    const userData = join(scratch, "userData")
    const globalRoot = join(scratch, "alpha-code-state", "env", "dev")
    mkdirSync(userData, { recursive: true })
    mkdirSync(globalRoot, { recursive: true })
    profileFile = join(scratch, "fence.sb")
    writeFileSync(
      profileFile,
      renderProcessFenceProfile({ workspaces: [ws], alphaGlobalRoot: globalRoot, userDataPath: userData, stateHome: userData, roots: resolveEngineRoots({}, homedir()) }),
    )
  })

  afterAll(() => {
    for (const d of [scratch, ws, esc]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  })

  const runDriver = (mode: "bare" | "fenced"): DriverOut => {
    const res = spawnSync(process.execPath, [join(fixtures, "write-probe-driver.ts"), mode, addon, profileFile, ws, esc, missing], { cwd: ws, encoding: "utf8", timeout: 60_000 })
    const line = (res.stdout ?? "").trim().split("\n").filter(Boolean).at(-1)
    if (!line) throw new Error(`write-probe-driver(${mode}) printed nothing (status ${res.status}); stderr: ${res.stderr}(本次测量作废)`)
    const out = JSON.parse(line) as DriverOut
    if (!out.ok) throw new Error(`write-probe-driver(${mode}) failed: ${out.message}`)
    return out
  }

  test("真探针 · 围栏臂:集合内 writable、集合外 denied(EPERM)、不存在的目录 unknown;两边都不留探针文件;在**另一个进程**里跑,且围栏 = 本次编译的模块", () => {
    const out = runDriver("fenced")
    expect(out.pid).not.toBe(process.pid)
    expect(out.apply?.buildId).toBe(buildId)
    expect(out.inside).toEqual({ outcome: "writable" })
    expect(out.outside.outcome).toBe("denied")
    expect(out.outside.detail).toMatch(/^write EPERM: /)
    expect(out.missing.outcome).toBe("unknown")
    expect(out.missing.detail).toMatch(/^write ENOENT/)
    expect(readdirSync(ws).filter((f) => f.startsWith(".alpha-write-probe-"))).toEqual([])
    expect(readdirSync(esc).filter((f) => f.startsWith(".alpha-write-probe-"))).toEqual([])
    expect(judgeWriteProbeCalibration({ inside: out.inside.outcome, outside: out.outside.outcome })).toEqual({ ok: true })
  })

  test("反向 · bare 臂(不套围栏 = main 进程的形态):集合外也答 writable ⇒ 判据把它当假探针拒掉", () => {
    const out = runDriver("bare")
    expect(out.pid).not.toBe(process.pid)
    expect(out.inside).toEqual({ outcome: "writable" })
    expect(out.outside).toEqual({ outcome: "writable" })
    const verdict = judgeWriteProbeCalibration({ inside: out.inside.outcome, outside: out.outside.outcome })
    expect(verdict.ok).toBe(false)
    expect(verdict.ok ? "" : verdict.reason).toMatch(/unfenced \/ main-process probe/)
  })
})
