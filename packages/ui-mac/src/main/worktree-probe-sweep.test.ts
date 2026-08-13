// `#928` —— 跑门不许泄漏探针 worktree 的**行为闸**。
//
// 这道门守的是什么(大白话):`scripts/alpha-check.sh` 第 [8/9] 步会在**共享主 checkout** 里
// 真建三棵探针 worktree、真跑 `bun install`(装好一棵 2.8 GB),跑完必须清干净。实测
// 2026-08-11:一晚四条 lane 跑五次门,留下 **4 棵 6.3 GB**;另一次三跑剩三棵 8 GB。泄漏体是
// **注册在案的** worktree:`git worktree list` 越来越长,`git worktree prune` 清不掉(prune 只
// 摘目录已消失的登记),下一个人看那张表会以为有别的 lane 在跑。
//
// 勘破(2026-08-11,跑出来的,不是读代码推断的):
//   · 把一次真跑用 `bash -x` 全程录下来 —— 正常结束时 `+ cleanup` 确实出现、`worktree remove`
//     确实执行、零残留。**`trap cleanup EXIT` 本身没坏。**
//   · 逐个信号量这台机器上的 bash(3.2.57):TERM / INT / HUP 三者 EXIT trap **都跑**(对单个
//     pid 发、对整个 process group 发都一样,真探针 2.8 GB 装好之后被打断仍然零残留);
//     只有 **KILL 跑不了**。
//   · 对整组 `kill -KILL`、且落在 `bun install` 写盘的时刻 ⇒ 复现出票面那个状态:一棵
//     **496M 半装**的 worktree,既注册在案又在盘上,prune 清不掉。票面记的四棵是
//     533M/1.0G/2.1G/2.7G,而装完整是 2.8G —— **全是半装的**,即那几次都在 install 中途被杀:
//     `-neg` 早已删除、`-fail` 尚未创建,所以只剩 `-pos`。
//   ⇒ 「trap 没在起作用」这句观察对,但原因**不是 trap 写错了**,是 SIGKILL 结构上跑不了任何
//     trap(工具超时杀进程组就是这个形状)。所以清理不能只有「退出时清自己」,还必须有
//     「**开跑时清上一轮**」——那是唯一对 SIGKILL 生效的路径。
//
// 为什么判据必须长这样:
//   · **不断言「代码里有 trap」**。本票恰恰证明了有 trap 也可以不跑 —— 那种断言是本仓点名过的
//     假闸门。这里断言的是**可观察结果**:跑完之后 `git worktree list` 里一条 `wtboot-probe-*`
//     都不剩、盘上也没有对应目录、共享 `core.hooksPath` 还是跑之前那个值。
//   · **真跑生产脚本**。B 组把 `scripts/assert-worktree-bootstrap.sh`(alpha-check 第 [8/9] 步
//     跑的就是它)整条跑完,只是跑在一个完全隔离的小 git 仓里(0.4s)。清扫被摘掉、被换成
//     `true`、或调用点被删掉,B 组当场红 —— A 组单独测清扫本体是不够的,那是「没测生产接线」。
//   · **清过头和不清一样坏**,所以反向的两条与正向同等重量:并发 lane 的探针树正活着,把它删掉
//     等于让别人的门在与他改动无关的地方变红 ⇒ `--no-verify` ⇒ 九道门一起关掉。A2/A4 钉这一半。
//   · **`core.hooksPath` 不与 worktree 残留共用一条判据**。它们此前挂在同一个 cleanup 上,一条
//     路径不跑就同时丢两件事,其中一件是**共享**配置(下一个人 `git push` 会撞上 husky 那份恒红
//     钩子)。B1 走「脚本中途失败」、B2 走「被信号打断」,两条各自单独断言它。
//   · **父进程死了 ≠ 写手都死了**(`#945`,时序实测):bash 3.2 收到未 trap 的 TERM/HUP 时
//     EXIT trap 立即跑、前台子进程被孤儿化 —— 父的还原先落盘且值正确,孤儿 bootstrap 带着
//     「[3/6] 前置之后」的陈旧基线**晚 2 秒**覆写回 `.githooks`。所以:①信号用例断言前必须等
//     fixture 的进程**全部死透**(quiesceFixture),否则迟到的覆写落在读之后 = 假绿;②新增两条
//     把信号**确定性**打进 install 窗口(husky-sim prepare 拉宽窗口),一条 TERM 判收割+还原,
//     一条 INT 判「Ctrl-C 真的停下来」(bash 3.2 默认把 pid 级 INT 整个丢弃);③修复有**两半**,
//     隔着 assert 脚本打信号只考得到 assert 那半 —— 它的 reap_owned 会掩住 bootstrap 侧的
//     还原(删掉 bootstrap 的 `trap boot_cleanup EXIT`,前面九条照样全绿,审计 MUT4 实测)。
//     bootstrap 又是 runbook 点名的人手命令,所以最后一条**直接** spawn worktree-bootstrap.sh
//     并把 TERM 打进 install 窗口,单独钉住它自己的收割+还原。
//
// 删掉本文件会失去什么:清扫可以被整段删除、可以只清一半、也可以反过来把并发 lane 的树吃掉,
// 而没有任何东西变红(泄漏本身是不可见的 —— 下一个人只会看见 `git worktree list` 越来越长)。
// 它因此登记在 scripts/gate-files.tsv 里,拿精确条数。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SWEEP = resolve(REPO_ROOT, "scripts/worktree-probe-sweep.sh")
const PROBE = resolve(REPO_ROOT, "scripts/assert-worktree-bootstrap.sh")
const BOOTSTRAP = resolve(REPO_ROOT, "scripts/worktree-bootstrap.sh")

/**
 * 完全隔离的 git 环境(与 north-star-guard.test.ts 同源的理由):开发机的 ~/.gitconfig 不许
 * 影响判据;反过来,本测试**结构上不可能**写到本仓的 .git/config 或它的 worktree 登记表
 * —— 被测脚本认的是 `git rev-parse --git-common-dir`,而 cwd 一律是夹具仓。
 */
function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "alpha ci fixture",
    GIT_AUTHOR_EMAIL: "fixture@alpha.invalid",
    GIT_COMMITTER_NAME: "alpha ci fixture",
    GIT_COMMITTER_EMAIL: "fixture@alpha.invalid",
    // 判别依据那两条会 curl registry。夹具里钉成不可达地址:本文件判的是清理,不是网络档,
    // 让它每条用例都去做一次真实的网络往返只会把这道门变成一个慢而抖的东西。
    BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
  }
}

const TEMP_ROOTS: string[] = []

function run(cwd: string, cmd: string[], home: string, extraEnv: Record<string, string> = {}) {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...gitEnv(home), ...extraEnv } })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

function git(cwd: string, args: string[], home: string): string {
  const r = run(cwd, ["git", ...args], home)
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失败:${r.err}`)
  return r.out.trim()
}

/**
 * 起一个真的 git 仓,scripts/ 下放的是**生产文件的字节**(不是重写一份替身),
 * 外加一个可控的 typecheck —— 被测脚本自己认 `dirname $BASH_SOURCE` 找同伴(SELF_ROOT),
 * 所以三份必须一起进夹具仓。
 *
 * `install`(`#945`):给夹具仓一个模拟 husky 的根 `prepare` —— 真跑 `bun install` 时把
 * **共享** core.hooksPath 写成 `corruptTo`,睡 `holdSeconds` 秒,醒来**再写一次** corruptTo。
 * 三个作用:①把「bootstrap 子进程正在 install」这个窗口从毫秒级拉宽到秒级,信号可以
 * **确定性**落进去(#945 的间歇红正是负载偶然把这个窗口拉宽时命中的);②sleep 之后的第二次
 * 写 = 一个**确定性的晚到写手**:「只还原、不收割」的错误实现,还原之后孤儿醒来必然覆写
 * ⇒ 当场红;真收割则 `&&` 链在 sleep 处被打断,第二次写结构上到不了 —— 这正是 #945
 * 「最后写的人赢」的最小可判形态;③corruptTo 每条用例用**不同的**非 `.husky/_` 字面量 ——
 * 「只认 husky 那个值才还原」这类写死字面量的错误实现会当场红。
 */
function initFixture(opts: {
  hooksPath: string
  typecheckScript: string
  install?: { corruptTo: string; holdSeconds: number }
  /** 额外提交进夹具仓根目录的文件(`#941` 的可控 typecheck 要以文件形态进探针 worktree)。 */
  files?: Record<string, string>
}) {
  const root = mkdtempSync(join(tmpdir(), "alpha928-"))
  TEMP_ROOTS.push(root)
  const home = join(root, "home")
  const repo = join(root, "repo")
  mkdirSync(home, { recursive: true })
  mkdirSync(join(repo, "scripts"), { recursive: true })
  mkdirSync(join(repo, "packages", "ui-mac"), { recursive: true })
  for (const src of [PROBE, BOOTSTRAP, SWEEP]) {
    const r = Bun.spawnSync(["cp", src, join(repo, "scripts", src.split("/").pop()!)])
    if (r.exitCode !== 0) throw new Error(`夹具仓拷不进生产脚本:${src}`)
  }
  for (const [name, body] of Object.entries(opts.files ?? {})) {
    writeFileSync(join(repo, name), body)
  }
  const rootPkg: Record<string, unknown> = { name: "fx", private: true, workspaces: ["packages/*"] }
  if (opts.install) {
    rootPkg.scripts = {
      prepare: `git config --local core.hooksPath ${opts.install.corruptTo} && sleep ${opts.install.holdSeconds} && git config --local core.hooksPath ${opts.install.corruptTo}`,
    }
  }
  writeFileSync(join(repo, "package.json"), JSON.stringify(rootPkg) + "\n")
  writeFileSync(
    join(repo, "packages", "ui-mac", "package.json"),
    JSON.stringify({ name: "fx-ui-mac", scripts: { typecheck: opts.typecheckScript } }) + "\n",
  )
  git(repo, ["init", "-q", "."], home)
  git(repo, ["add", "-A"], home)
  git(repo, ["commit", "-q", "-m", "fixture"], home)
  git(repo, ["config", "--local", "core.hooksPath", opts.hooksPath], home)
  return { root, home, repo }
}

function addWorktree(repo: string, home: string, name: string) {
  git(repo, ["worktree", "add", "--detach", "-q", `.worktrees/${name}`, "HEAD"], home)
}

function registeredWorktreeNames(repo: string, home: string): string[] {
  return git(repo, ["worktree", "list", "--porcelain"], home)
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).split("/").pop()!)
}

function hooksPathOf(repo: string, home: string): string {
  const r = run(repo, ["git", "config", "--local", "--get", "core.hooksPath"], home)
  return r.out.trim()
}

/**
 * 等 fixture 相关的进程**全部死透**再断言(`#945`):判「core.hooksPath 还原了」必须在所有
 * 可能晚到的写手消失之后读 —— 复现实测:旧实现里孤儿化的 bootstrap 子进程带着陈旧基线,
 * 在父进程死后**再过 2 秒**才覆写共享配置;读得太早,红会变假绿。
 * 匹配轴:①fixture 仓的绝对路径(bootstrap/嵌套探针的 argv 里带它);②husky-sim 的
 * corruptTo 片段(prepare 的 sh 进程 argv 里带它)。两轴都空了才算静。
 */
async function quiesceFixture(repo: string, extraPattern?: string) {
  const patterns = [repo, ...(extraPattern ? [extraPattern] : [])]
  let alive = true
  for (let i = 0; i < 300; i++) {
    alive = patterns.some((p) => Bun.spawnSync(["pgrep", "-f", p]).exitCode === 0)
    if (!alive) break
    await Bun.sleep(50)
  }
  // 超时**必须表现为红**,不能静默继续读值(`#945` R1 审计 Minor)。轮询走完还有写手活着时,
  // 后面那句「core.hooksPath 还原了」读到的是「还没被覆写」的正确值 ⇒ 绿,而生产里那次覆写
  // 随后才发生、共享配置照坏 —— 那恰好退回本函数要封的假绿。本仓判据:**测不到就说本次测量
  // 作废,而不是给一个数字**。
  expect(alive).toBe(false)
  await Bun.sleep(200)
}

/** 起一个**活着的**假探针进程:命令行里必须出现 `assert-worktree-bootstrap.sh`。 */
function spawnDecoyProbe(root: string) {
  const dir = join(root, "decoy")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "assert-worktree-bootstrap.sh")
  writeFileSync(path, "sleep 120\n")
  const proc = Bun.spawn(["bash", path], { stdout: "ignore", stderr: "ignore" })
  return proc
}

afterAll(() => {
  for (const root of TEMP_ROOTS) Bun.spawnSync(["rm", "-rf", root])
})

describe("scripts/worktree-probe-sweep.sh —— 清掉无主残骸,且**只**清无主残骸", () => {
  test("上一轮被杀留下的无主探针:登记与目录一起消失", () => {
    const { home, repo } = initFixture({ hooksPath: ".lane-311-hooks", typecheckScript: "exit 3" })
    // pid 999999 超出 macOS 的 pid 上限 ⇒ `kill -0` 必失败 ⇒ 无主。
    addWorktree(repo, home, "wtboot-probe-999999-4211-pos")
    expect(registeredWorktreeNames(repo, home)).toContain("wtboot-probe-999999-4211-pos")

    const r = run(repo, ["bash", "scripts/worktree-probe-sweep.sh"], home)
    expect(r.code).toBe(0)
    expect(registeredWorktreeNames(repo, home)).not.toContain("wtboot-probe-999999-4211-pos")
    expect(existsSync(join(repo, ".worktrees", "wtboot-probe-999999-4211-pos"))).toBe(false)
  })

  test("并发 lane 正在用的探针(pid 活着且确实是探针)必须原封不动", () => {
    const { root, home, repo } = initFixture({ hooksPath: ".lane-311-hooks", typecheckScript: "exit 3" })
    const decoy = spawnDecoyProbe(root)
    try {
      const name = `wtboot-probe-${decoy.pid}-7734-neg`
      addWorktree(repo, home, name)

      const r = run(repo, ["bash", "scripts/worktree-probe-sweep.sh"], home)
      expect(r.code).toBe(0)
      // 留着 = 别人的门不会在与他改动无关的地方变红。
      expect(registeredWorktreeNames(repo, home)).toContain(name)
      expect(existsSync(join(repo, ".worktrees", name))).toBe(true)
    } finally {
      decoy.kill("SIGKILL")
    }
  })

  test("pid 复用:pid 活着但那个进程不是探针 ⇒ 仍然清掉", () => {
    const { home, repo } = initFixture({ hooksPath: ".lane-311-hooks", typecheckScript: "exit 3" })
    // 本测试进程自己:pid 一定活着,而它的命令行是 bun,不是探针脚本。
    const name = `wtboot-probe-${process.pid}-5150-fail`
    addWorktree(repo, home, name)

    const r = run(repo, ["bash", "scripts/worktree-probe-sweep.sh"], home)
    expect(r.code).toBe(0)
    expect(registeredWorktreeNames(repo, home)).not.toContain(name)
    expect(existsSync(join(repo, ".worktrees", name))).toBe(false)
  })

  test("不是探针的 worktree 一律不碰(含前缀只是长得像的)", () => {
    const { home, repo } = initFixture({ hooksPath: ".lane-311-hooks", typecheckScript: "exit 3" })
    addWorktree(repo, home, "lane-881-attrib")
    addWorktree(repo, home, "wtboot-keepme")
    addWorktree(repo, home, "wtboot-probe-999998-6120-pos") // 无主,同一跑里必须被清 —— 证明这一跑真的在清东西

    const r = run(repo, ["bash", "scripts/worktree-probe-sweep.sh"], home)
    expect(r.code).toBe(0)
    const names = registeredWorktreeNames(repo, home)
    expect(names).toContain("lane-881-attrib")
    expect(names).toContain("wtboot-keepme")
    expect(names).not.toContain("wtboot-probe-999998-6120-pos")
  })

  test("只在盘上、没登记的无主残骸目录也清掉", () => {
    const { home, repo } = initFixture({ hooksPath: ".lane-311-hooks", typecheckScript: "exit 3" })
    const stray = join(repo, ".worktrees", "wtboot-probe-999997-8302-pos")
    mkdirSync(stray, { recursive: true })
    writeFileSync(join(stray, "half-installed.txt"), "半装的树比没有更坏\n")

    const r = run(repo, ["bash", "scripts/worktree-probe-sweep.sh"], home)
    expect(r.code).toBe(0)
    expect(existsSync(stray)).toBe(false)
  })
})

describe("生产接线:真跑 scripts/assert-worktree-bootstrap.sh(alpha-check 第 [8/9] 步)", () => {
  test("脚本中途失败:跑完零探针残留,且共享 core.hooksPath 还是跑之前那个值", () => {
    const { home, repo } = initFixture({ hooksPath: ".lane-928-hooks", typecheckScript: "exit 3" })
    addWorktree(repo, home, "wtboot-probe-999996-3077-pos") // 上一轮被 KILL 留下的
    addWorktree(repo, home, "lane-620-continue") // 别人的 lane

    const r = run(repo, ["bash", "scripts/assert-worktree-bootstrap.sh"], home, { ALPHA_WT_PROBE_NESTED: "1" })
    // 夹具仓里能力判据当然失守 —— 这正是「脚本中途失败」那条退出路径。
    expect(r.code).not.toBe(0)

    const names = registeredWorktreeNames(repo, home)
    expect(names.filter((n) => n.startsWith("wtboot-probe-"))).toEqual([])
    expect(names).toContain("lane-620-continue")
    expect(hooksPathOf(repo, home)).toBe(".lane-928-hooks")
    // `#941`:可达性共识探测(两轮 × 3 发,发间隔 1s)让离线夹具里的完整一跑确定性多花 ~4s,
    // 默认 5s 超时会被顶破 —— 与同组其余用例一致取 30s。
  }, 30_000)

  test("被信号打断(SIGTERM 落在探针已建出之后):同样零残留,且 core.hooksPath 还原", async () => {
    const { home, repo } = initFixture({ hooksPath: ".lane-42-hooks", typecheckScript: "sleep 3" })

    const proc = Bun.spawn(["bash", "scripts/assert-worktree-bootstrap.sh"], {
      cwd: repo,
      env: { ...gitEnv(home), ALPHA_WT_PROBE_NESTED: "1" },
      stdout: "ignore",
      stderr: "ignore",
    })

    // 等到「脚本已经动过共享配置(把 core.hooksPath 设成 .githooks)且已经建出自己的探针」——
    // 只有落在这个窗口里,这条用例才同时对两件事有话说。
    let armed = false
    for (let i = 0; i < 400; i++) {
      const probes = registeredWorktreeNames(repo, home).filter((n) => n.startsWith("wtboot-probe-"))
      if (probes.length > 0 && hooksPathOf(repo, home) === ".githooks") {
        armed = true
        break
      }
      if (proc.exitCode !== null) break
      await Bun.sleep(25)
    }
    // 测不到就打印本次测量作废,而不是给一个绿。
    expect(armed).toBe(true)

    proc.kill("SIGTERM")
    await proc.exited
    // `#945`:父进程死了 ≠ 写手都死了。等静默再读,否则孤儿的迟到覆写落在读之后 = 假绿。
    await quiesceFixture(repo)

    expect(registeredWorktreeNames(repo, home).filter((n) => n.startsWith("wtboot-probe-"))).toEqual([])
    expect(hooksPathOf(repo, home)).toBe(".lane-42-hooks")
  }, 30_000)

  test("SIGTERM 落在 bootstrap 子进程仍在 install 的窗口里(#945 的间歇红,确定性化):孤儿写手先被收割,core.hooksPath 还原", async () => {
    const { home, repo } = initFixture({
      hooksPath: ".lane-77-hooks",
      typecheckScript: "exit 3",
      install: { corruptTo: ".husky-sim-77/_", holdSeconds: 3 },
    })

    const proc = Bun.spawn(["bash", "scripts/assert-worktree-bootstrap.sh"], {
      cwd: repo,
      env: { ...gitEnv(home), ALPHA_WT_PROBE_NESTED: "1" },
      stdout: "ignore",
      stderr: "ignore",
    })

    // 等到「install 已把共享值写脏」:此刻必然 bootstrap 子进程活着、它自己的 restore 还没跑。
    // SIGTERM 落在这里,旧实现的孤儿覆写是**确定性**的(#945 时序实测:父的 EXIT trap 立即跑
    // 并正确还原,孤儿 bootstrap 带着「[3/6] 前置之后」的陈旧基线晚 2s 覆写)——不再依赖负载。
    let armed = false
    for (let i = 0; i < 400; i++) {
      if (hooksPathOf(repo, home) === ".husky-sim-77/_") {
        armed = true
        break
      }
      if (proc.exitCode !== null) break
      await Bun.sleep(25)
    }
    expect(armed).toBe(true)

    proc.kill("SIGTERM")
    await proc.exited
    await quiesceFixture(repo, "husky-sim-77")

    expect(registeredWorktreeNames(repo, home).filter((n) => n.startsWith("wtboot-probe-"))).toEqual([])
    expect(hooksPathOf(repo, home)).toBe(".lane-77-hooks")
  }, 30_000)

  test("Ctrl-C(SIGINT)落在同一窗口:门必须当场停下、不再跑后续步骤,且 core.hooksPath 还原", async () => {
    const { home, repo } = initFixture({
      hooksPath: ".lane-58-hooks",
      typecheckScript: "exit 3",
      install: { corruptTo: ".husky-sim-58/_", holdSeconds: 3 },
    })

    const proc = Bun.spawn(["bash", "scripts/assert-worktree-bootstrap.sh"], {
      cwd: repo,
      env: { ...gitEnv(home), ALPHA_WT_PROBE_NESTED: "1" },
      stdout: "pipe",
      stderr: "ignore",
    })

    let armed = false
    for (let i = 0; i < 400; i++) {
      if (hooksPathOf(repo, home) === ".husky-sim-58/_") {
        armed = true
        break
      }
      if (proc.exitCode !== null) break
      await Bun.sleep(25)
    }
    expect(armed).toBe(true)

    proc.kill("SIGINT")
    const code = await proc.exited
    const out = await new Response(proc.stdout).text()
    await quiesceFixture(repo, "husky-sim-58")

    // bash 3.2 对 pid 级 INT 的默认处置是**整个丢弃**(#945 实测:前台子进程正常退出后继续跑,
    // 连 trap 都不进)—— 没有显式 INT trap 的实现会把 [4/6]、[5/6]… 当没事一样全部跑完。
    // Ctrl-C 必须真的停下来:退出码走 130,后续步骤一个都不许再跑。
    expect(code).toBe(130)
    expect(out).not.toContain("[4/6]")
    expect(registeredWorktreeNames(repo, home).filter((n) => n.startsWith("wtboot-probe-"))).toEqual([])
    expect(hooksPathOf(repo, home)).toBe(".lane-58-hooks")
  }, 30_000)

  test("直接打断 worktree-bootstrap.sh 本身(runbook 的人手命令,TERM 落在 install 窗口):收割孤儿写手,共享 core.hooksPath 还原", async () => {
    // 上面四条都隔着 assert-worktree-bootstrap.sh 驱动 bootstrap —— 那一层的 reap_owned 与它
    // 自己的 cleanup 会把 bootstrap **这一侧**的还原完全掩住:单独删掉 bootstrap 的
    // `trap boot_cleanup EXIT`,四条照样全绿(审计对照实测,MUT4)。而 bootstrap 是 runbook
    // 点名的人手命令(docs/runbooks/ci.md「新建 worktree」),在 install 窗口里被 TERM/Ctrl-C
    // 打断是真实可达路径 —— 打断后共享 core.hooksPath 停在 husky 那个值,就是 #754 的形态。
    // 所以本条**不经过任何包装层**,直接 spawn 生产脚本,单独钉住 bootstrap 自己的那半修复。
    // 夹具 prepare 在 sleep 之后还有第二次脏写:「只还原、不收割」的错误实现在这里也会红,
    // 不只是「trap 被整个删掉」那一种。
    const { home, repo } = initFixture({
      hooksPath: ".lane-91-hooks",
      typecheckScript: "exit 3",
      install: { corruptTo: ".husky-sim-91/_", holdSeconds: 3 },
    })

    const proc = Bun.spawn(
      ["bash", "scripts/worktree-bootstrap.sh", "wt-945-direct", "--detach", "--base", "HEAD"],
      { cwd: repo, env: gitEnv(home), stdout: "ignore", stderr: "ignore" },
    )

    // 等到「install 已把共享值写脏」:此刻 install 进程组必然活着、bootstrap 的还原还没跑。
    let armed = false
    for (let i = 0; i < 400; i++) {
      if (hooksPathOf(repo, home) === ".husky-sim-91/_") {
        armed = true
        break
      }
      if (proc.exitCode !== null) break
      await Bun.sleep(25)
    }
    expect(armed).toBe(true)

    proc.kill("SIGTERM")
    await proc.exited
    // 父进程死了 ≠ 写手都死了:等 husky-sim 的孤儿(若有)也死透再读,迟到覆写不许落在读之后。
    await quiesceFixture(repo, "husky-sim-91")

    expect(hooksPathOf(repo, home)).toBe(".lane-91-hooks")
  }, 30_000)
})

// ── `#941` —— 可达性判别依据:网络半通不通不许硬红,恒 'network' 仍必须硬红 ──────────────
//
// 2026-08-11 夜实测(票面):同一分支几分钟内,[6/6](a) 一次硬红(「明明可达,判别依据却说
// 'network'」⇒ alpha-check 整体 ❌)、一次落降级档 —— 而同一时刻 `curl registry.npmjs.org`
// http=200(一次 0.9s、一次 7.2s),同窗 git fetch 撞 SSL_ERROR_SYSCALL、gh 两次 EOF。
// 判别依据的探测是**单发** curl(--max-time 8,零重试),两个独立调用点相隔几秒采样同一个事实,
// 代理抖动时各落矛盾一侧 ⇒ 健康仓库被判「判据失守」(exit 1)⇒ 训练人 `--no-verify`(`#754`)。
//
// 判据两个方向缺一不可(只做一边 = 把 [6/6] 换成摆设):
//   方向一:探测结果自相矛盾(半通不通)⇒ 必须落「未验证」档(exit 2)+ 说「本次测量作废」,
//           不得打出「能力判据失守」。夹具序列取自真实复现:3~4 发 curl 里抖掉 1 发。
//   方向二:判别依据真退化成恒 'network'(独立探测前后两轮全可达、复测不改口)⇒ 仍必须
//           硬红(exit 1)。少了这半,「结论不稳一律未验证」的错误实现会把真退化也放行。
//
// 夹具:curl 桩按 FLAKY_SEQ 逐次给结果(对 127.0.0.1:9 恒败 —— 那是 [6/6](b) 的不可达注入,
// 必须仍判 network);typecheck 以「worktree 根有没有 node_modules」区分 bootstrap 前后,
// 让 [1/6]~[5/6] 在夹具里全部真实可绿 —— 否则 exit 2 的断言会被别处的红污染。
describe("可达性判别依据(#941):半通不通降级,恒 'network' 硬红", () => {
  const FAKE_TYPECHECK = [
    "#!/usr/bin/env bash",
    "# cwd = <探针 worktree>/packages/ui-mac;bootstrap 过 ⇒ 根有 node_modules ⇒ 干净",
    "if [ -d ../../node_modules ]; then exit 0; fi",
    `echo "src/x.test.ts(1,1): error TS2307: Cannot find module 'bun:test' or its corresponding type declarations."`,
    "exit 2",
    "",
  ].join("\n")

  const CURL_STUB = [
    "#!/usr/bin/env bash",
    "# 对 [6/6](b) 的不可达注入(127.0.0.1:9)恒败;其余 URL 按 FLAKY_SEQ 逐次给结果,",
    "# 序列耗尽后按 FLAKY_DEFAULT。每次调用把计数写进 FLAKY_STATE。",
    'for a in "$@"; do case "$a" in *127.0.0.1:9*) exit 7 ;; esac; done',
    'STATE="${FLAKY_STATE:?}"',
    'n=$(cat "$STATE" 2>/dev/null || echo 0)',
    'echo $((n+1)) > "$STATE"',
    "seq=(${FLAKY_SEQ:-})",
    'if [ "$n" -lt "${#seq[@]}" ]; then r="${seq[$n]}"; else r="${FLAKY_DEFAULT:-ok}"; fi',
    '[ "$r" = ok ] && exit 0 || exit 7',
    "",
  ].join("\n")

  function initFlakyFixture(hooksPath: string) {
    const fx = initFixture({
      hooksPath,
      typecheckScript: "bash ../../fake-typecheck.sh",
      files: { "fake-typecheck.sh": FAKE_TYPECHECK },
    })
    const stubDir = join(fx.root, "stub-bin")
    mkdirSync(stubDir, { recursive: true })
    writeFileSync(join(stubDir, "curl"), CURL_STUB, { mode: 0o755 })
    return { ...fx, stubDir }
  }

  function flakyEnv(fx: { root: string; stubDir: string }, registry: string, seq: string, dflt: string) {
    return {
      PATH: `${fx.stubDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      BUN_CONFIG_REGISTRY: registry,
      FLAKY_STATE: join(fx.root, "curl-calls.n"),
      FLAKY_SEQ: seq,
      FLAKY_DEFAULT: dflt,
      ALPHA_WT_PROBE_NESTED: "1",
    }
  }

  test("方向一:[6/6](a) 的探测窗抖掉一发(ok ok fail)⇒ 未验证档 exit 2 + 「本次测量作废」,不得硬红", () => {
    const fx = initFlakyFixture(".lane-941a-hooks")
    // 序列取自真实复现:第 3 发 curl 抖掉,旧实现在这里打出
    // 「明明可达,判别依据却说 'network' —— 一律算网络 = 这道门永不失守」并 exit 1。
    const r = run(fx.repo, ["bash", "scripts/assert-worktree-bootstrap.sh"], fx.home, flakyEnv(fx, "http://registry.flap-941a.invalid", "ok ok fail", "ok"))
    expect(r.code).toBe(2)
    expect(r.out).toContain("本次测量作废")
    expect(r.err).not.toContain("能力判据失守")
    expect(registeredWorktreeNames(fx.repo, fx.home).filter((n) => n.startsWith("wtboot-probe-"))).toEqual([])
    expect(hooksPathOf(fx.repo, fx.home)).toBe(".lane-941a-hooks")
  }, 60_000)

  test("方向一:[5/6] 的判别与复核落在矛盾两侧(fail ok)⇒ 未验证档 exit 2,本条如实说分不出", () => {
    const fx = initFlakyFixture(".lane-941b-hooks")
    // 旧实现在这里打出「被判别依据归成 'network',而 registry 这一刻是可达的 —— 豁免成了
    // 万能挡箭牌」并 exit 1;修后:复测改口 ⇒ 结论不稳 ⇒ 本次测量作废,不冤枉判红。
    const r = run(fx.repo, ["bash", "scripts/assert-worktree-bootstrap.sh"], fx.home, flakyEnv(fx, "http://registry.flap-941b.invalid", "fail ok", "ok"))
    expect(r.code).toBe(2)
    expect(r.out).toContain("本条分不出 real / network")
    expect(r.err).not.toContain("能力判据失守")
    expect(hooksPathOf(fx.repo, fx.home)).toBe(".lane-941b-hooks")
  }, 60_000)

  test("方向二:判别依据退化成恒 'network' 且网络稳定可达 ⇒ 仍必须硬红 exit 1", () => {
    const fx = initFlakyFixture(".lane-941c-hooks")
    // 把夹具里那份生产脚本的判别依据改成恒 'network'(票面点名的绕过形态)。改不上必须红,
    // 不许静默测了个健康版本(测不出已知的坏 = 本次测量作废)。
    const probeCopy = join(fx.repo, "scripts", "assert-worktree-bootstrap.sh")
    const original = readFileSync(probeCopy, "utf8")
    const mutated = original.replace(
      "classify_bootstrap_failure() {\n",
      "classify_bootstrap_failure() { printf 'network'; return 0; }\nclassify_bootstrap_failure_dead() {\n",
    )
    expect(mutated).not.toBe(original)
    writeFileSync(probeCopy, mutated)

    const r = run(fx.repo, ["bash", "scripts/assert-worktree-bootstrap.sh"], fx.home, flakyEnv(fx, "http://registry.solid-941c.invalid", "", "ok"))
    expect(r.code).toBe(1)
    // 独立探测前后两轮全可达、复测不改口 —— 只能是判别依据退化,这道门必须失守给人看。
    expect(r.err).toContain("判别依据退化")
    expect(hooksPathOf(fx.repo, fx.home)).toBe(".lane-941c-hooks")
  }, 60_000)
})
