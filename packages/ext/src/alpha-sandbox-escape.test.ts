// REQ-138 / #1075 · AC2 —— 可写集合有单一权威,判据双向成立。
//
// 用**生产的** wrapEngineShell 把 profile + wrapper 落到临时 root,再用 node child_process
// 经 wrapper spawn(= shell 工具在 packages/opencode/src/tool/shell.ts 的 spawn 形状:
// `{ shell: wrapperPath, cwd, env }`,基线 §2.2 已证 argv 为 ["-c", cmd])。
//
// 判据 = **文件是否落盘**(I3),不是 exit code。正反两跑(基线 §2.6):
//   · 围栏 ON:整类逃逸语料**落不了盘**;
//   · 同一语料围栏 OFF(裸 zsh):**全部落盘** —— 先证明语料能测出已知的坏,ON 的全绿才是结论。
//
// 需要真 /usr/bin/sandbox-exec(darwin),CI(ubuntu)上 skip。本机 macOS 跑真围栏,是本票
// 交付的「一次真实越界写入被拦」的证据来源。逃逸目标写在 $HOME 下一个唯一临时子目录
// (HOME 不在允许集内 = denied),afterEach 清掉。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { wrapEngineShell, type WrapEngineShellSeams } from "./shell-sandbox"

const sandboxExec = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")
const describeSandbox = sandboxExec ? describe : describe.skip

function realSeams(): WrapEngineShellSeams {
  return {
    platform: "darwin",
    envShell: "/bin/zsh",
    statIsFile: (p) => {
      try {
        return statSync(p).isFile()
      } catch {
        return false
      }
    },
    which: () => undefined,
    mkdirSync: (p) => void mkdirSync(p, { recursive: true }),
    writeFileSync: (p, data) => void writeFileSync(p, data),
    chmodSync: (p, mode) => void chmodSync(p, mode),
  }
}

describeSandbox("AC2 escape corpus — real sandbox-exec, both directions", () => {
  let root = ""
  let workspace = ""
  let outsideDir = ""
  let escapeTarget = ""
  let wrapperPath = ""
  let profilePath = ""
  let realShell = ""

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac1075-root-"))
    workspace = mkdtempSync(join(tmpdir(), "ac1075-ws-"))
    // 逃逸目标:HOME 下唯一子目录(HOME 不在允许集内)。在**围栏外**建目录,围栏内往里写才是逃逸。
    outsideDir = mkdtempSync(join(homedir(), ".ac1075-escape-"))
    escapeTarget = join(outsideDir, "pwned.txt")

    const cfg: { shell?: string } = {}
    const env: NodeJS.ProcessEnv = {}
    const r = wrapEngineShell(cfg, root, env, realSeams())
    if (!r.fenced) throw new Error("expected fenced install")
    wrapperPath = r.shell
    profilePath = r.profile
    realShell = r.realShell
  })

  afterEach(() => {
    for (const d of [root, workspace, outsideDir]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  })

  // 经 wrapper spawn(围栏 ON):复刻 shell 工具的 { shell, cwd, env } 形状。
  function runFenced(command: string) {
    return spawnSync(command, [], {
      shell: wrapperPath,
      cwd: workspace,
      env: { ...process.env, ALPHA_SB_PROFILE: profilePath, ALPHA_REAL_SHELL: realShell },
      stdio: "pipe",
      encoding: "utf8",
    })
  }
  // 裸 zsh spawn(围栏 OFF):同 cwd、同命令,唯独不经 sandbox-exec。
  function runBare(command: string) {
    return spawnSync(command, [], { shell: "/bin/zsh", cwd: workspace, stdio: "pipe", encoding: "utf8" })
  }

  // 整类边界(父票 #1074):重定向 · 解释器 · 后台脱离 · 符号链接指向工作区外。
  function corpus(): Array<[string, string]> {
    return [
      ["redirect >", `echo pwned > ${escapeTarget}`],
      ["redirect >>", `echo pwned >> ${escapeTarget}`],
      ["via /bin/sh", `/bin/sh -c 'echo pwned > ${escapeTarget}'`],
      ["via python3", `python3 -c 'open("${escapeTarget}","w").write("x")'`],
      ["via node", `node -e 'require("fs").writeFileSync("${escapeTarget}","x")'`],
      ["nohup detach", `nohup sh -c 'echo pwned > ${escapeTarget}' >/dev/null 2>&1 || true`],
      ["symlink out", `ln -sf ${escapeTarget} link && echo pwned > link`],
    ]
  }

  test("[normal] echo 在围栏下正常返回", () => {
    const r = runFenced("echo hello")
    expect(r.status).toBe(0)
    expect((r.stdout ?? "").trim()).toBe("hello")
  })

  test("[workspace] 工作区内写入落盘(误伤检查)", () => {
    const r = runFenced("echo ok > inside.txt")
    expect(existsSync(join(workspace, "inside.txt"))).toBe(true)
    expect(r.status).toBe(0)
  })

  test("[tmp] 系统临时目录写入放行(正常开发)", () => {
    const tmpProbe = join("/private/tmp", `ac1075-tmp-${process.pid}.txt`)
    try {
      const r = runFenced(`echo ok > ${tmpProbe}`)
      expect(existsSync(tmpProbe)).toBe(true)
      expect(r.status).toBe(0)
    } finally {
      try {
        rmSync(tmpProbe, { force: true })
      } catch {}
    }
  })

  test("围栏 ON:整类逃逸语料 file 不落盘(判据 = 落盘,不是 exit code)", async () => {
    for (const [tag, command] of corpus()) {
      rmSync(escapeTarget, { force: true })
      runFenced(command)
      // nohup 是后台派生,给它一拍再判
      await new Promise((res) => setTimeout(res, 300))
      expect(`${tag}: ${existsSync(escapeTarget) ? "LEAKED" : "blocked"}`).toBe(`${tag}: blocked`)
    }
  })

  test("围栏 OFF(反向对照):同一语料全部落盘 —— 证明语料能测出已知的坏", async () => {
    for (const [tag, command] of corpus()) {
      rmSync(escapeTarget, { force: true })
      // symlink 语料在 workspace 里留了个 link,清一下免得互相干扰
      rmSync(join(workspace, "link"), { force: true })
      runBare(command)
      await new Promise((res) => setTimeout(res, 300))
      expect(`${tag}: ${existsSync(escapeTarget) ? "leaked" : "NOT-LEAKED"}`).toBe(`${tag}: leaked`)
    }
  })
})
