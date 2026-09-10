// REQ-159 (`#1321`) —— 围栏本体的判据:真 .node(本测试用生产构建脚本现编)、真 seatbelt、
// 真**出货 sidecar 运行时**(Electron 内嵌 node,ELECTRON_RUN_AS_NODE=1),judged by 文件落没落盘。
// darwin-only;CI(ubuntu)上自报 skip,由 gate-files.tsv 按 [平台:darwin] 登记。
//
// 四块:
//   A. x64 判据(票面硬要求四):生产构建出来的 .node 必须同时有 arm64 与 x86_64 两片,且两片都导出
//      N-API 入口;先拿一个**只编 arm64** 的 thin 文件证明判据会红。
//   B. AC1 的四类派生原语(shell / cross-spawn 深度 2 / detached / PTY 缺省与带 command)在**生产渲染的
//      profile** 下越界写入 0 落盘、界内落盘;同一探针不套围栏全部落盘(正样本臂)。跑在 Electron 的
//      node 里 —— 与 utilityProcess 同一份运行时(node 24 / modules 146)。
//   C. AC4 fail-closed 且响亮:经**生产的** applyProcessFence —— 编译失败的 profile / 缺 deny 的 profile /
//      模块不在 / 装上但集合外仍写得进(围栏是空的)/ 装上但 cwd 写不进 —— 五种失败各自抛、原因可读。
//   D. 正向:applyProcessFence 成功时回报模块身份(buildId = 本次编译烤进去的那个,证明装的是这一份)。
//
// 布局纪律(勘破 §7.4 括注 / U2 §0):ws 与 esc 都放在**真 HOME** 之下的唯一临时子目录 —— 不放
// /private/tmp 或 $TMPDIR,那两处在可写集里,放那儿「escape landed」只是布局问题。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { assertFenceAddonSlices, buildFenceAddon } from "../../scripts/build-fence-addon"
import { OUTSIDE_PROBE_DIR } from "./process-fence-apply"
import { renderProcessFenceProfile, resolveEngineRoots } from "./process-fence-profile"

const describeDarwin = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") ? describe : describe.skip
const require = createRequire(import.meta.url)
const fixtures = resolve(import.meta.dir, "../../test-fixtures/process-fence")

type Arm = "bare" | "fenced"
type StepResult = { inside: unknown; outside: unknown }
type DriverOut = { runtime: string; mode: Arm; buildId?: string; apply?: { rc: number; error: string }; fatal?: string; steps: Record<string, StepResult> }

describeDarwin("REQ-159 process fence —— 真 .node / 真 seatbelt / Electron 的 node", () => {
  let scratch = ""
  let addon = ""
  let buildId = ""
  let ws = ""
  let esc = ""
  let userData = ""
  let globalRoot = ""
  let profileFile = ""
  let electron = ""
  let ptyModule = ""
  const outs: Record<Arm, DriverOut | undefined> = { bare: undefined, fenced: undefined }

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "ac1321-apply-"))
    buildId = `ac1321-test-${Date.now()}`
    const built = buildFenceAddon({ out: join(scratch, "build", "alpha_fence.node"), buildId })
    addon = built.out
    ws = mkdtempSync(join(homedir(), ".ac1321-ws-"))
    esc = mkdtempSync(join(homedir(), ".ac1321-esc-"))
    userData = join(scratch, "userData")
    globalRoot = join(scratch, "alpha-code-state", "env", "dev")
    mkdirSync(userData, { recursive: true })
    mkdirSync(globalRoot, { recursive: true })
    // 生产渲染的 profile:W1 = 本测试的 ws;其余根 = 真 HOME 的 XDG 形状(生产形状)+ 临时 userData / globalRoot。
    const profile = renderProcessFenceProfile({
      workspaces: [ws],
      alphaGlobalRoot: globalRoot,
      userDataPath: userData,
      stateHome: userData,
      roots: resolveEngineRoots({}, homedir()),
      // `#1337`:生产 profile 含网络行;本文件只判文件轴,给一个没人听的端口即可(网络轴判据在 network-egress-fence.test.ts)。
      egressProxyPort: 4443,
    })
    profileFile = join(scratch, "fence.sb")
    writeFileSync(profileFile, profile)
    // 不用 `require("electron")` 取二进制路径:bun 的 mock.module 是进程级的,全量 `bun test src` 里别的文件
    // mock 掉的 electron 会漏到这里(实测:单跑绿、全量拿到一个 Module 对象)。electron 包自己的 index.js 就是
    // 读 path.txt 再 join dist —— 这里照它的做法从文件系统解析,不经模块系统。
    const electronPkg = dirname(require.resolve("electron/package.json"))
    electron = join(electronPkg, "dist", readFileSync(join(electronPkg, "path.txt"), "utf8").trim())
    if (!existsSync(electron)) throw new Error(`electron binary missing at ${electron}(本次测量作废)`)
    ptyModule = require.resolve("@lydell/node-pty")
  })

  afterAll(() => {
    for (const d of [scratch, ws, esc]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  })

  const runDriver = (mode: Arm): DriverOut => {
    const res = spawnSync(electron, [join(fixtures, "node-driver.mjs"), addon, mode, profileFile, ws, esc, ptyModule], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 60_000,
    })
    const line = (res.stdout ?? "").trim().split("\n").filter(Boolean).at(-1)
    if (!line) throw new Error(`driver(${mode}) printed nothing (status ${res.status}); stderr: ${res.stderr}`)
    const parsed = JSON.parse(line) as DriverOut
    if (parsed.fatal) throw new Error(`driver(${mode}) fatal: ${parsed.fatal}`)
    return parsed
  }

  const landed = (dir: string) => readdirSync(dir).sort()

  // ── A. x64 判据 ────────────────────────────────────────────────────────────────
  test("A1 生产构建的 .node 同时有 arm64 + x86_64 两片,两片都导出 napi_register_module_v1", () => {
    expect(assertFenceAddonSlices(addon).sort()).toEqual(["arm64", "x86_64"])
  })
  test("A2 判据测得出已知的坏:只编 arm64 的 thin 文件 ⇒ 点名缺 x86_64", () => {
    const thin = buildFenceAddon({ out: join(scratch, "thin", "alpha_fence.node"), archs: ["arm64"], buildId: "thin" })
    expect(() => assertFenceAddonSlices(thin.out)).toThrow(/missing arch slice\(s\) x86_64/)
    // 空壳:一个 fat 但不是 N-API 模块的文件也要红(lipo 过、nm 不过)
    const shell = join(scratch, "shell", "alpha_fence.node")
    mkdirSync(join(scratch, "shell"), { recursive: true })
    const cc = spawnSync("clang", ["-shared", "-arch", "arm64", "-arch", "x86_64", "-o", shell, "-x", "c", "-"], { input: "int alpha_nothing(void){return 0;}", encoding: "utf8" })
    expect(cc.status, cc.stderr).toBe(0)
    expect(() => assertFenceAddonSlices(shell)).toThrow(/does not export _napi_register_module_v1/)
  })

  // ── B. AC1 四类原语,正反两臂 ────────────────────────────────────────────────────
  test("B0 正样本臂:不套围栏,四类原语的界内 + 界外全部落盘(证明探针测得出「写得进」)", () => {
    outs.bare = runDriver("bare")
    expect(outs.bare.runtime).toMatch(/^node 24\./)
    expect(landed(esc)).toEqual([
      "detached-bare.txt",
      "grandchild-bare.txt",
      "pty-cmd-bare.txt",
      "pty-zsh-bare.txt",
      "self-bare.txt",
      "shell-bare.txt",
    ])
    expect(landed(ws)).toEqual(landed(esc).map((f) => f))
  })

  test("B1 围栏臂:apply rc=0、buildId = 本次编译;界内六条落盘,界外**零**新增", () => {
    const before = landed(esc)
    outs.fenced = runDriver("fenced")
    expect(outs.fenced.apply).toEqual({ rc: 0, error: "" })
    expect(outs.fenced.buildId).toBe(buildId)
    expect(landed(esc)).toEqual(before) // 一条 *-fenced.txt 都没有
    expect(landed(ws).filter((f) => f.endsWith("-fenced.txt"))).toEqual([
      "detached-fenced.txt",
      "grandchild-fenced.txt",
      "pty-cmd-fenced.txt",
      "pty-zsh-fenced.txt",
      "self-fenced.txt",
      "shell-fenced.txt",
    ])
  })

  test("B2 围栏下每一类的界外写都以 EPERM / operation not permitted 失败,不是「没跑」(空输出不算拦住)", () => {
    const s = outs.fenced!.steps
    expect(s.self).toEqual({ inside: "wrote", outside: "error:EPERM" })
    for (const name of ["shell", "grandchild"]) {
      const step = s[name] as { inside: { status: number }; outside: { status: number; stderr: string } }
      expect(step.inside.status, name).toBe(0)
      expect(step.outside.status, name).not.toBe(0)
      expect(step.outside.stderr, name).toMatch(/operation not permitted/i)
    }
    const det = s.detached as { inside: { status: number }; outside: { status: number } }
    expect(det.inside.status).toBe(0)
    expect(det.outside.status).not.toBe(0)
    for (const name of ["ptyDefault", "ptyCommand"]) {
      const step = s[name] as { inside: { status: number | null; spawnError?: string }; outside: { status: number | null; spawnError?: string } }
      expect(step.inside.spawnError, `${name}: PTY 在围栏下必须开得出来(W15)`).toBeUndefined()
      expect(step.inside.status, name).toBe(0)
      expect(step.outside.status, name).not.toBe(0)
    }
  })

  // ── C/D. applyProcessFence(生产模块)的五种失败与一种成功 ─────────────────────────
  const runApply = (profile: string, opts: { addon?: string; insideDir?: string; outsideDir?: string } = {}) => {
    const file = join(scratch, `apply-${Math.random().toString(36).slice(2)}.sb`)
    writeFileSync(file, profile)
    const args = [join(fixtures, "apply-driver.ts"), opts.addon ?? addon, file]
    if (opts.insideDir || opts.outsideDir) args.push(opts.insideDir ?? ws, opts.outsideDir ?? OUTSIDE_PROBE_DIR)
    const res = spawnSync(process.execPath, args, { cwd: ws, encoding: "utf8", timeout: 60_000 })
    const line = (res.stdout ?? "").trim().split("\n").filter(Boolean).at(-1)
    if (!line) throw new Error(`apply-driver printed nothing (status ${res.status}); stderr: ${res.stderr}`)
    return { status: res.status, out: JSON.parse(line) as { ok: boolean; name?: string; message?: string; result?: { buildId: string; libsandbox: string; profileBytes: number } } }
  }
  const goodProfile = () => renderProcessFenceProfile({ workspaces: [ws], alphaGlobalRoot: globalRoot, userDataPath: userData, stateHome: userData, roots: resolveEngineRoots({}, homedir()), egressProxyPort: 4443 })

  test("D 正向:生产 profile ⇒ ok,回报 buildId / libsandbox / 字节数,进程退出 0", () => {
    const r = runApply(goodProfile())
    expect(r.status).toBe(0)
    expect(r.out.ok).toBe(true)
    expect(r.out.result?.buildId).toBe(buildId)
    expect(r.out.result?.libsandbox).toBe("/usr/lib/libsandbox.1.dylib")
    expect(r.out.result?.profileBytes).toBe(Buffer.byteLength(goodProfile()))
  })

  test("C1 AC4:必然编译失败的 profile ⇒ 抛 ProcessFenceError,消息带 libsandbox 原文,进程非零退出", () => {
    const r = runApply(goodProfile().replace('(subpath "/private/tmp")', '(subpath "/private/tmp"'))
    expect(r.status).toBe(2)
    expect(r.out.ok).toBe(false)
    expect(r.out.name).toBe("ProcessFenceError")
    expect(r.out.message).toMatch(/sandbox_init failed \(rc=-?\d+\): .*syntax error/)
  })

  test("C2 缺 (deny file-write*) 的 profile 在 apply 之前就被拒", () => {
    const r = runApply("(version 1)\n(allow default)\n")
    expect(r.status).toBe(2)
    expect(r.out.message).toMatch(/does not carry \(deny file-write\*\)/)
  })

  test("C3 模块文件不在 ⇒ 点名路径(打包漏 extraResources / 架构片缺失就是这一格)", () => {
    const r = runApply(goodProfile(), { addon: join(scratch, "nope", "alpha_fence.node") })
    expect(r.status).toBe(2)
    expect(r.out.message).toMatch(/native module missing at .*nope\/alpha_fence\.node/)
  })

  test("C4 围栏是空的(rc=0 但集合外仍写得进)⇒ 拒绝启动,并把探针删干净", () => {
    const voidProfile = goodProfile().replace(`(subpath "${ws}")`, `(subpath "${ws}") (subpath "${OUTSIDE_PROBE_DIR}")`)
    const before = readdirSync(OUTSIDE_PROBE_DIR).filter((f) => f.startsWith("alpha-fence-probe-"))
    const r = runApply(voidProfile)
    expect(r.status).toBe(2)
    expect(r.out.message).toMatch(/a write outside the writable set landed .* the fence is void/)
    expect(readdirSync(OUTSIDE_PROBE_DIR).filter((f) => f.startsWith("alpha-fence-probe-"))).toEqual(before)
  })

  test("C5 围栏太紧(cwd 写不进)⇒ 拒绝启动,说明是哪个目录", () => {
    const r = runApply(goodProfile(), { insideDir: esc })
    expect(r.status).toBe(2)
    expect(r.out.message).toMatch(/engine cwd is not writable/)
    expect(r.out.message).toContain(esc)
  })
})
