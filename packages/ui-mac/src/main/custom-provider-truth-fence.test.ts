// `#1391` —— I2 的真裁判:生产渲染的 profile 交给真 /usr/bin/sandbox-exec(与 sidecar 里 sandbox_init 同一个 libsandbox,
// process-fence-compile.ts 文件头),围栏内往真源写 / 在真源目录建文件 / 在状态根建目录 / 从 W2 mv 进来 ⇒ Operation not permitted、
// 盘上零落盘;控制臂:同一 profile 下往 W2(env/<env>)与 W3(userData)写 ⇒ 落盘(围栏是活的,不是「什么都写不进」);
// bare 臂:不套围栏(= main 进程的形态)经生产 writeCustomProviderTruth 落盘并读回(拒绝来自围栏,不是布局)。
// 布局纪律(勘破 §7.4 / `#1322`):假的状态根放在**真 HOME** 之下 —— /private/tmp 与 $TMPDIR 在可写集里(W11 / W12),放那儿「写不进」测不出来。
// darwin-only;CI(ubuntu)上自报 skip,gate-files.tsv 按 [平台:darwin] 登记。不需要 Electron 二进制,worktree 里也能跑。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { environmentMutableRoot } from "./alpha-environment"
import { customProviderTruthPath, readCustomProviderTruth } from "./custom-provider-truth"
import { writeCustomProviderTruth } from "./custom-provider-truth-write"
import { SANDBOX_EXEC } from "./process-fence-compile"
import { renderProcessFenceProfile, resolveEngineRoots } from "./process-fence-profile"

const describeSandbox = process.platform === "darwin" && existsSync(SANDBOX_EXEC) ? describe : describe.skip

describeSandbox("I2 真围栏:custom-providers/<env>.json 在生产 profile 下写不进,W2 / W3 写得进", () => {
  let scratch = ""
  let stateRoot = ""
  let envRoot = ""
  let userData = ""
  let truthDir = ""
  let profileFile = ""

  beforeAll(() => {
    scratch = mkdtempSync(join(homedir(), ".ac1391-fence-"))
    stateRoot = join(scratch, "alpha-code-state")
    envRoot = environmentMutableRoot("prod", stateRoot)
    userData = join(scratch, "userData")
    truthDir = join(stateRoot, "custom-providers")
    for (const d of [envRoot, join(stateRoot, "cas"), truthDir, userData, join(scratch, "ws")]) mkdirSync(d, { recursive: true })
    profileFile = join(scratch, "fence.sb")
    writeFileSync(
      profileFile,
      // `#1337`:生产 profile 含网络行;这里不出网,给一个没人听的端口即可。
      renderProcessFenceProfile({ workspaces: [join(scratch, "ws")], alphaGlobalRoot: envRoot, userDataPath: userData, stateHome: userData, roots: resolveEngineRoots({}, homedir()), egressProxyPort: 4443 }),
    )
  })

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  const attempt = (fenced: boolean, script: string) => {
    const argv = fenced ? [SANDBOX_EXEC, "-f", profileFile, "/bin/sh", "-c", script] : ["/bin/sh", "-c", script]
    const res = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
    if (res.error) throw new Error(`could not run ${argv[0]}: ${res.error.message}(本次测量作废)`)
    return { status: res.status, stderr: (res.stderr ?? "").trim() }
  }

  test("围栏内:写真源文件 / 在真源目录建文件 / 在状态根建目录 / 从 W2 mv 进真源 ⇒ 全部 Operation not permitted,盘上零落盘", () => {
    const truth = customProviderTruthPath(stateRoot, "prod")
    const denied = [
      [`printf '{"v":1,"providers":[]}' > "${truth}"`, truth],
      [`printf x > "${truthDir}/forged.json"`, join(truthDir, "forged.json")],
      [`mkdir "${stateRoot}/custom-providers-forged"`, join(stateRoot, "custom-providers-forged")],
      // 先在可写处(W2)造好,再 rename 进来 —— 目录项的写在目标目录上,同样拦住
      [`printf x > "${envRoot}/staged.json" && mv "${envRoot}/staged.json" "${truth}"`, truth],
    ] as const
    for (const [script, landing] of denied) {
      const r = attempt(true, script)
      expect(r.status, script).not.toBe(0)
      expect(r.stderr, script).toContain("Operation not permitted")
      expect(existsSync(landing), script).toBe(false)
    }
    // mv 那一臂的第一步真的落在 W2 里了(证明是第二步被拦,不是第一步没跑)
    expect(readFileSync(join(envRoot, "staged.json"), "utf8")).toBe("x")
    expect(fs.readdirSync(truthDir)).toEqual([])
  })

  test("控制臂:同一 profile 下 W2 与 W3 落盘;bare 臂:不套围栏经生产 writeCustomProviderTruth 落盘并读回", () => {
    for (const target of [join(envRoot, "probe"), join(userData, "probe")]) {
      const r = attempt(true, `printf x > "${target}"`)
      expect(r.status, target).toBe(0)
      expect(readFileSync(target, "utf8"), target).toBe("x")
    }
    const truth = customProviderTruthPath(stateRoot, "prod")
    const bare = attempt(false, `printf x > "${truthDir}/bare-probe.json"`)
    expect(bare.status).toBe(0)
    expect(readFileSync(join(truthDir, "bare-probe.json"), "utf8")).toBe("x")
    rmSync(join(truthDir, "bare-probe.json"))
    writeCustomProviderTruth(truth, [{ id: "my-openai", name: "My OpenAI", compat: "openai", baseURL: "https://api.openai.com/v1", models: ["gpt-5.4"] }], fs)
    expect(readCustomProviderTruth(truth, { ...fs, log: () => {} })).toEqual({
      ok: true,
      absent: false,
      providers: [{ id: "my-openai", name: "My OpenAI", compat: "openai", baseURL: "https://api.openai.com/v1", models: ["gpt-5.4"] }],
    })
    // 写好之后围栏内仍改不了它(覆盖写 / 删除都拦)
    const overwrite = attempt(true, `printf '{"v":1,"providers":[]}' > "${truth}"`)
    expect(overwrite.status).not.toBe(0)
    expect(overwrite.stderr).toContain("Operation not permitted")
    const unlink = attempt(true, `rm "${truth}"`)
    expect(unlink.status).not.toBe(0)
    expect(unlink.stderr).toContain("Operation not permitted")
    expect(readCustomProviderTruth(truth, { ...fs, log: () => {} }).ok).toBe(true)
  })
})
