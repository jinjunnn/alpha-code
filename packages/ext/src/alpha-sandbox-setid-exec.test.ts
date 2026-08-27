// #1149 —— 已知代价 K1 的**单一权威**:围栏开着时,set-ID 二进制在围栏内不可 exec。
//
// 用户可观察的后果:agent 在 shell 工具里跑 `ps` / `top` 会拿到 `Operation not permitted`,
// 而失败信息不解释原因。这**不是**本仓 profile 的规则造成的 —— profile 只写了
// `(allow default)` + `(deny file-write*)`(见 shell-sandbox.ts 的 SEATBELT_PROFILE);
// 是 macOS seatbelt 对**沙箱进程 exec set-ID 程序**的固有拒绝。
//
// `#1144` 的打包取证顺带量到过它
// (docs/verification/2026-08-26-req138-1144-packaged-shell-tool-chain/results/setuid-exec-observation.json),
// 但那是一份 dated 证据文件:**没有任何东西会因为这条代价被改掉或被扩大而变红**。本文件就是那个东西。
//
// ── 成员为什么不写成散文清单 ────────────────────────────────────────────────────
// 语料只登记「候选路径 + 一组无害参数」;**该被拒还是该通过,由 expectationFor() 从盘上的真实
// mode 派生**(set-ID 位 = S_ISUID|S_ISGID = 0o6000)。于是:
//   · 某个二进制在新版 macOS 上不再是 set-ID ⇒ 自动换到「该通过」那一类,不产生假红;
//   · 反过来变成 set-ID ⇒ 自动换到「该被拒」那一类,不靠人记得改一行散文;
//   · 加一个成员 = 加一行路径,类别自己算出来。
// 写死「ps/top 属于被拒类」这种清单,换台机器就假绿/假红 —— 而散文枚举漏掉的永远是最新那一项。
//
// ── 判据双向,两个方向各有正样本(AC2)──────────────────────────────────────────
//   · profile / wrapper 改动**意外恢复**了 set-ID exec ⇒ 被拒类的行翻成 exec-allowed ⇒ 红;
//   · 反过来把非 set-ID 的 ls / wc / git 也拦了 ⇒ 通过类的行翻成 exec-denied ⇒ 红。
// 判的是**真跑 sandbox-exec 的行为**(经生产的 wrapEngineShell 装出来的那份 wrapper + profile),
// 不是 profile 的**文本** —— 断言源码文本的闸门,在守卫被整段注释掉时照样绿。
//
// ── 观测手段自己的盲区,三条已封 ───────────────────────────────────────────────
//   ① **空输出不算拦住**:profile 写坏时 sandbox-exec 根本不启动进程,那个空输出长得像「拦住了」。
//      每次测量都要求 stdout 里有 STARTED 标记与 RC 行;缺席 = 本次测量作废(红),不是「拦住了」。
//   ② **反向对照**:同一语料换裸 shell(同一个真 shell,唯独不经 sandbox-exec)再跑一遍,
//      必须**无一被拒** —— 证明「拒」来自围栏,不是这台机器或这组参数本来就跑不动。
//   ③ **语料非退化**:两类各至少一个正样本。一台机器上若一个 set-ID 都没有,「0 fail」恒成立
//      = 假绿;此时判红并说明本轮测量作废。
//
// ── 刻意排除 /usr/bin/su(票面点名过)────────────────────────────────────────────
// 它在**有控制终端**时打印 `Password:` 并阻塞读 /dev/tty —— stdin 给 pipe 也拦不住。
// 实测(2026-08-26,`script -q /dev/null /usr/bin/su <不存在的用户>`):5s 未返回,只能 SIGKILL;
// 同一条命令在无 tty 时 15ms 返回 `su: Sorry`,所以「我这儿跑着没事」不是证据。
// 无围栏对照臂会真的 exec 它 ⇒ 开发者在终端里跑 `bun test` 会被挂住。set-ID 这一类由
// ps / top / quota / write 覆盖,不必拿一条会挂住 harness 的成员去凑。
//
// 需要真 /usr/bin/sandbox-exec(darwin),CI(ubuntu)上整块 skip —— 与 alpha-sandbox-escape.test.ts
// 同一支,故同样不进 scripts/gate-files.tsv(那里是精确条数,linux 上量到 0 会恒红)。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { wrapEngineShell, type WrapEngineShellSeams } from "./shell-sandbox"

const sandboxExec = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")
const describeSandbox = sandboxExec ? describe : describe.skip

/** S_ISUID | S_ISGID —— 成员资格的**唯一判据**,从盘上的 mode 算,不从清单读。 */
const SET_ID_BITS = 0o6000

/** 每次 exec 的开场白 + 回执行。两者都缺席 = 进程没启动 = 本次测量作废。 */
const MARKER = "AC1149"

type Probe = { path: string; args: string; note: string }

/**
 * 语料 —— 候选路径 + 无害参数。**这里没有类别**:类别见 expectationFor()。
 * 参数选取的硬约束:无围栏臂会真的把它 exec 起来,所以每条都必须在**有控制终端**时也快速返回
 * (2026-08-26 用 `script -q /dev/null` 起真 pty 逐条实测:最慢 top 600ms,其余 ≤100ms)。
 */
const PROBES: readonly Probe[] = [
  { path: "/bin/ps", args: "-p 1", note: "#1149 票面点名;排查场景里最常用的一条" },
  { path: "/usr/bin/top", args: "-l 1 -n 0", note: "#1149 票面点名" },
  { path: "/usr/bin/quota", args: "-v", note: "第三个 set-ID 成员,替下会挂住 harness 的 su" },
  { path: "/usr/bin/write", args: "alpha1149-no-such-user", note: "setgid-only(实测 0o2555):这条代价不止于 setuid" },
  { path: "/bin/ls", args: "/dev/null", note: "对照:非 set-ID 必须照常跑" },
  { path: "/usr/bin/wc", args: "-l /dev/null", note: "对照" },
  { path: "/usr/bin/git", args: "--version", note: "对照:开发主力命令,被误拦的代价最大" },
]

type Verdict = "exec-denied" | "exec-allowed"
type Observation = { started: boolean; rc: number | null; stderr: string; verdict: Verdict | "unmeasured" }
type Row = { probe: Probe; mode: number; expected: Verdict; fenced: Observation; bare: Observation }

/** 期望完全由真实 mode 决定 —— 与被测对象(围栏)无关,不构成自指等价链。 */
function expectationFor(mode: number): Verdict {
  return (mode & SET_ID_BITS) !== 0 ? "exec-denied" : "exec-allowed"
}

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

/**
 * 判「这一次 exec 被拒了吗」。拒绝的签名是**shell 自己打**的,不是被测二进制打的:
 * 实测 2026-08-26 —— zsh 报 rc=127 + `zsh:1: operation not permitted: /bin/ps`;
 * /bin/sh 报 rc=126 + `/bin/sh: /bin/ps: Operation not permitted`(#1144 的证据文件用的是后者)。
 * 两个条件**同时**满足才算拒:只看 rc 会把二进制自己的退出码读成拒,只看措辞会把一个自己
 * 打出同一句话的二进制读成「被围栏拦住」。
 */
function readVerdict(path: string, res: SpawnSyncReturns<string>): Observation {
  const stdout = res.stdout ?? ""
  const stderr = res.stderr ?? ""
  const started = stdout.includes(`${MARKER}-STARTED`)
  const rcMatch = new RegExp(`${MARKER}-RC=(\\d+)`).exec(stdout)
  const rc = rcMatch ? Number(rcMatch[1]) : null
  if (!started || rc === null) return { started, rc, stderr, verdict: "unmeasured" }
  const denied = (rc === 126 || rc === 127) && /operation not permitted/i.test(stderr) && stderr.includes(path)
  return { started, rc, stderr, verdict: denied ? "exec-denied" : "exec-allowed" }
}

describeSandbox("#1149 K1 —— 围栏内 set-ID 二进制不可 exec(真 sandbox-exec,双向)", () => {
  let root = ""
  let workspace = ""
  let rows: Row[] = []
  let missing: string[] = []

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ac1149-root-"))
    workspace = mkdtempSync(join(tmpdir(), "ac1149-ws-"))

    // 用**生产的** wrapEngineShell 装围栏:profile 或 wrapper 一改,这里量到的就变。
    const cfg: { shell?: string } = {}
    const installed = wrapEngineShell(cfg, root, {}, realSeams())
    if (!installed.fenced) throw new Error(`围栏没装上,本轮测量作废:${installed.reason}`)

    // 两臂只差一个变量:同一个真 shell、同一个 cwd、同一条命令,一边经 wrapper(sandbox-exec),
    // 一边直接用真 shell。
    const run = (probe: Probe, shell: string, env: NodeJS.ProcessEnv | undefined): Observation => {
      const command = `echo ${MARKER}-STARTED; ${probe.path} ${probe.args} >/dev/null; echo ${MARKER}-RC=$?`
      const res = spawnSync(command, [], {
        shell,
        cwd: workspace,
        env,
        stdio: "pipe",
        encoding: "utf8",
        input: "",
        timeout: 30_000,
      })
      return readVerdict(probe.path, res)
    }

    const fencedEnv = {
      ...process.env,
      ALPHA_SB_PROFILE: installed.profile,
      ALPHA_REAL_SHELL: installed.realShell,
    }
    for (const probe of PROBES) {
      if (!existsSync(probe.path)) {
        // 路径随 OS 版本变。缺席不判红(否则换台机器就假红),但要进非退化那一格的失败信息。
        missing.push(probe.path)
        continue
      }
      const mode = statSync(probe.path).mode
      rows.push({
        probe,
        mode,
        expected: expectationFor(mode),
        fenced: run(probe, installed.shell, fencedEnv),
        bare: run(probe, installed.realShell, undefined),
      })
    }
  })

  afterAll(() => {
    for (const dir of [root, workspace]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  })

  const modeOf = (row: Row) => `0o${(row.mode & 0o7777).toString(8)}`
  const census = () =>
    `本轮语料:${rows.map((r) => `${r.probe.path}=${modeOf(r)}`).join(" ")};缺席:${missing.join(",") || "无"}`

  test("[非退化] set-ID 与非 set-ID 各至少一个正样本 —— 否则本轮测量作废", () => {
    const denied = rows.filter((r) => r.expected === "exec-denied").map((r) => r.probe.path)
    const allowed = rows.filter((r) => r.expected === "exec-allowed").map((r) => r.probe.path)
    expect(
      denied.length,
      `语料里一个 set-ID 成员都没有 ⇒「围栏拦 set-ID」这一格本轮根本没被测到,而「0 fail」恒成立 = 假绿。${census()}`,
    ).toBeGreaterThan(0)
    expect(
      allowed.length,
      `语料里一个非 set-ID 成员都没有 ⇒「围栏不拦普通二进制」这一格本轮根本没被测到。${census()}`,
    ).toBeGreaterThan(0)
  })

  test("[观测手段] 每一次 exec,两臂的 shell 进程都真的启动过(空输出不算拦住)", () => {
    const unmeasured = rows.flatMap((row) =>
      (["fenced", "bare"] as const)
        .filter((arm) => row[arm].verdict === "unmeasured")
        .map(
          (arm) =>
            `${arm} ${row.probe.path}: started=${row[arm].started} rc=${row[arm].rc} stderr=${row[arm].stderr.slice(0, 160)}`,
        ),
    )
    expect(
      unmeasured,
      "有测量拿不到 STARTED 标记或 RC 行 —— 进程可能压根没启动(profile 解析失败时 sandbox-exec 不启动进程,那个空输出长得像「拦住了」)。这些行本轮作废,不能当结论。",
    ).toEqual([])
  })

  test("围栏 ON:每个探针的 exec 结果 = 从真实 mode 派生的期望(set-ID ⇒ 拒,其余 ⇒ 通)", () => {
    const observed = rows.map((r) => `${r.probe.path} (${modeOf(r)}): ${r.fenced.verdict}`)
    const expected = rows.map((r) => `${r.probe.path} (${modeOf(r)}): ${r.expected}`)
    expect(observed, `期望来自盘上的 mode,不来自围栏本身。${census()}`).toEqual(expected)
  })

  test("围栏 OFF(反向对照):同一语料无一被拒 —— 证明「拒」来自围栏,不是机器或参数", () => {
    const observed = rows.map((r) => `${r.probe.path}: ${r.bare.verdict}`)
    const expected = rows.map((r) => `${r.probe.path}: exec-allowed`)
    expect(observed, `裸真 shell 臂(不经 sandbox-exec)。${census()}`).toEqual(expected)
  })
})
