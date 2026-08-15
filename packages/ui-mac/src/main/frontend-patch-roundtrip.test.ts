// `#976` —— `scripts/assert-frontend-patch-roundtrip.sh` 的**行为闸**。
//
// 这道门守的是什么(大白话):ADR-034 起 `packages/{app,ui}` 是「上游 pin + 一份 SOT 补丁」的
// 投影。sync-upstream 每次合并后 `rm -rf packages/app packages/ui` → `git checkout $PIN --` →
// `git apply <补丁>`;月更 bump 的第一块也用 pin 覆盖这两个目录。⇒ **改了这两个包而没把改动
// 重生进补丁,那份改动会被静默删除**,不是报错。已合并历史上真的发生过(f420fe2bb…7281627ed,
// 补丁缺 vendored `.tgz`,存活两天、零变红)。
//
// 为什么判据必须长这样:
//   · **不断言脚本源码文本。** 「grep 到脚本里写着 write-tree」在本仓是点名过的假闸门形态
//     (脚本被换成 `exit 0` 时它照样绿)。这里起**真的 git 仓**、造**真的漂移**、跑
//     **生产的那份脚本**(scripts/assert-frontend-patch-roundtrip.sh,CI 与本地 alpha-check.sh
//     调用的就是它),断言它**真的点名了那个文件**、真的以约定的码退出。
//   · **不只断言「漂移就红」。** 一个「永远红」的实现能满足那一条,所以有两条对照组:一致态
//     必须 exit 0(下面第一条),以及漂移之后**重生补丁就回绿**(第三条)。
//   · **粒度不比缺陷粗一格。** 名字集比较是这道门的前身,它对内容漂移结构性失明:`#976` 勘破
//     实测,改一行 `packages/app/src/context/terminal.tsx` 不重生补丁,`scripts/bun-test-app.sh`
//     的两轴交叉 5 == 5 **绿**,扩到全部文件 46 == 46 **仍绿**。所以下面每条红向断言都要求
//     **点名到具体路径**,而不只是退出码非零。
//   · **三档结局各自可判。** pin 取不到(浅克隆)是环境缺失,本地判 `恰好 2` + 「未比对」;
//     CI 侧 `ROUNDTRIP_REQUIRE_PIN=1` 判 `恰好 1`。只断「非零」会让「漂移被报成未比对」全绿;
//     一律硬红则本地浅克隆恒红 ⇒ `--no-verify` ⇒ 十道门一起关掉(`#754` 形态)。
//   · **「测不到」与「测出坏」必须分得开。** 补丁被清空时重建出来的是纯 pin 树,比较步照样红,
//     但原因完全不同 —— 那一档必须自报「测量作废」,措辞与漂移可区分。
//
// 删掉本文件会失去什么:那个脚本退回零行为判据 —— 比较步被改成恒真、只枚举 packages/app、
// 把 exit 2 改成 exit 0、把 apply 失败吞掉,都不会有任何东西变红。它因此登记在
// scripts/gate-files.tsv 里,拿精确条数。

import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SCRIPT = resolve(REPO_ROOT, "scripts/assert-frontend-patch-roundtrip.sh")

/**
 * 完全隔离的 git 环境(与 north-star-guard.test.ts 同源的理由):
 *  ① 开发机的 ~/.gitconfig 不许影响判据;
 *  ② 反过来 —— 本测试**结构上不可能**写到本仓的 .git/config 或当前分支(`ac#815` 那一类)。
 */
const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "alpha ci fixture",
  GIT_AUTHOR_EMAIL: "fixture@alpha.invalid",
  GIT_COMMITTER_NAME: "alpha ci fixture",
  GIT_COMMITTER_EMAIL: "fixture@alpha.invalid",
} as const

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...GIT_ENV } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败:${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function write(repo: string, path: string, body: string | Uint8Array) {
  Bun.spawnSync(["mkdir", "-p", join(repo, path, "..")], { env: { ...GIT_ENV } })
  writeFileSync(join(repo, path), body)
}

function commitAll(repo: string, message: string): string {
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-q", "-m", message])
  return git(repo, ["rev-parse", "HEAD"])
}

const LOCK = "frontend/frontend-pin.lock"
const PATCH = "frontend/alpha-patches/alpha-frontend.patch"

/** 上游 pin 里就有的文件(alpha 会改它)。 */
const UPSTREAM_LEAF = "packages/app/src/context/terminal.tsx"
/** alpha 自己加的 seam(只存在于补丁里)。 */
const ALPHA_SEAM = "packages/app/src/surface/alpha-seam.ts"
/** alpha 加的 **二进制**:真实世界里是 packages/session-ui 以 `file:` 直接依赖的 vendored tgz。 */
const ALPHA_VENDORED = "packages/app/vendor/alpha-client-1.0.0.tgz"
/** packages/ui 半场 —— 生产脚本枚举写成只有 packages/app 时,只有它会红。 */
const UI_LEAF = "packages/ui/src/button.tsx"
const ALPHA_UI = "packages/ui/src/alpha-overlay.ts"

/** 二进制内容(含不可打印字节)——只写进临时夹具目录,不进本仓。 */
const VENDORED_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0xca, 0x48])

/** 按 frontend/README.md 块 4 的写法重生 SOT 补丁(生成半场留在 runbook,判据半场在生产脚本)。 */
function regeneratePatch(repo: string, pin: string) {
  const result = Bun.spawnSync(["git", "diff", "--binary", pin, "--", "packages/app", "packages/ui"], {
    cwd: repo,
    env: { ...GIT_ENV },
  })
  if (result.exitCode !== 0) throw new Error(`重生补丁失败:${result.stderr.toString()}`)
  write(repo, PATCH, result.stdout.toString())
}

/**
 * 夹具形状 —— 真实世界的缩比:
 *
 *   pin 提交        packages/{app,ui} = 纯上游态(没有 alpha seam、没有 vendored tgz)
 *   alpha 提交      改上游叶 + 加 seam + 加二进制 + 改/加 ui  ⇒ 补丁 = 两者之差
 *   SOT 提交        frontend/{frontend-pin.lock, alpha-patches/alpha-frontend.patch}
 *
 * frontend/ 在 packages/{app,ui} 之外 ⇒ 提交它不改变被比较的两棵树。
 */
function fixture(): { repo: string; pin: string } {
  const repo = mkdtempSync(join(tmpdir(), "alpha-roundtrip-"))
  git(repo, ["init", "-q", "-b", "alpha"])
  write(repo, UPSTREAM_LEAF, "export const terminal = 1\n")
  write(repo, "packages/app/src/app.tsx", "export const app = 1\n")
  write(repo, UI_LEAF, "export const button = 1\n")
  const pin = commitAll(repo, "upstream pin")

  write(repo, UPSTREAM_LEAF, "export const terminal = 2 // alpha seam\n")
  write(repo, ALPHA_SEAM, "export const seam = 1\n")
  write(repo, ALPHA_VENDORED, VENDORED_BYTES)
  write(repo, ALPHA_UI, "export const overlay = 1\n")
  commitAll(repo, "alpha frontend delta")

  write(repo, LOCK, `pin=${pin} # fixture\n`)
  regeneratePatch(repo, pin)
  commitAll(repo, "record SOT")
  return { repo, pin }
}

type Run = { exitCode: number; output: string }

/** 跑**生产脚本本体**。 */
function runGate(repo: string, extraEnv: Record<string, string> = {}): Run {
  const result = Bun.spawnSync(["bash", SCRIPT], { cwd: repo, env: { ...GIT_ENV, ...extraEnv } })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  // 测不到就抛。这道门无论红绿都必须说话 —— 一个什么都不打印的运行不是「通过」。
  if (output.trim().length === 0) throw new Error("判据一个字都没输出 —— 本次测量作废(不是通过)")
  return { exitCode: result.exitCode, output }
}

describe("#976 packages/{app,ui} round-trip 判据的行为", () => {
  test("一致态(树 == pin + 补丁)⇒ exit 0 —— 没有这条对照组,一个恒红的空壳能满足下面全部红向断言", () => {
    const { repo } = fixture()
    const run = runGate(repo)
    expect(run.exitCode, `一致态被判红了 —— 恒红的门等于没有门(#754 形态):\n${run.output}`).toBe(0)
    // 且必须**真的比过**两个包,而不是提前 return 了。
    expect(run.output).toContain("packages/app")
    expect(run.output).toContain("packages/ui")
  })

  test("改一个非测试源码文件、不重生补丁 ⇒ exit 1 且点名那个文件(名字集比较在这条上是绿的)", () => {
    const { repo } = fixture()
    write(repo, UPSTREAM_LEAF, "export const terminal = 3 // 忘了重生补丁\n")
    commitAll(repo, "alpha change without regenerating the SOT patch")
    const run = runGate(repo)
    expect(run.exitCode, `一次会被 sync 静默删掉的改动被放行了:\n${run.output}`).toBe(1)
    // 点名而不只是退出码:`#976` 立票时那半边门(比 *.test.ts 名字集)在这条上实测为绿,
    // 票面建议的「扩到全部文件仍比名字集」也是绿 —— 只有内容层判据抓得到。
    expect(run.output, `红了但没点名漂移的文件,人拿不到可操作信息:\n${run.output}`).toContain(UPSTREAM_LEAF)
  })

  test("重生补丁之后回绿 —— 修法真的能修好(杀掉「碰过 app 就永远红」的实现)", () => {
    const { repo, pin } = fixture()
    write(repo, UPSTREAM_LEAF, "export const terminal = 3\n")
    commitAll(repo, "alpha change")
    expect(runGate(repo).exitCode, "前置没红,本条测的不是它要测的东西").toBe(1)

    regeneratePatch(repo, pin)
    commitAll(repo, "regenerate SOT patch")
    const run = runGate(repo)
    expect(run.exitCode, `按 frontend/README.md 块 4 重生补丁之后仍然红 —— 这道门没有出口:\n${run.output}`).toBe(0)
  })

  test("committed 一个补丁里没有的新文件(含二进制)⇒ exit 1 且点名 —— f420fe2bb 那次真实事故的形状", () => {
    const { repo } = fixture()
    write(repo, "packages/app/vendor/alpha-client-2.0.0.tgz", VENDORED_BYTES)
    commitAll(repo, "add a vendored binary without regenerating the patch")
    const run = runGate(repo)
    expect(run.exitCode, `新增文件不被点名 —— 2026-07-24 丢 vendored tgz 的那一类原样复活:\n${run.output}`).toBe(1)
    expect(run.output).toContain("packages/app/vendor/alpha-client-2.0.0.tgz")
  })

  test("删掉一个补丁里有的文件、补丁没跟 ⇒ exit 1 且点名(只比双方交集的实现在这条上是绿的)", () => {
    const { repo } = fixture()
    rmSync(join(repo, ALPHA_SEAM))
    commitAll(repo, "delete an alpha seam without regenerating the patch")
    const run = runGate(repo)
    expect(run.exitCode, `删除方向没被抓到:\n${run.output}`).toBe(1)
    expect(run.output).toContain(ALPHA_SEAM)
  })

  test("只改文件模式(chmod +x,内容一字不变)⇒ exit 1 —— 杀「逐个比内容哈希」的实现", () => {
    const { repo } = fixture()
    chmodSync(join(repo, UPSTREAM_LEAF), 0o755)
    git(repo, ["update-index", "--chmod=+x", UPSTREAM_LEAF])
    commitAll(repo, "chmod +x without regenerating the patch")
    const run = runGate(repo)
    // git tree sha 天然带 mode;内容哈希不带。负向夹具刻意不取最退化的形状(改内容)。
    expect(run.exitCode, `模式漂移被放行 —— 判据没落在 git 的对象模型上:\n${run.output}`).toBe(1)
    expect(run.output).toContain(UPSTREAM_LEAF)
  })

  test("漂移只落在 packages/ui(app 侧完全一致)⇒ exit 1 且点名 ui 路径 —— 枚举漏是九形态④", () => {
    const { repo } = fixture()
    write(repo, ALPHA_UI, "export const overlay = 2\n")
    commitAll(repo, "ui-only drift")
    const run = runGate(repo)
    // 现行 bun-test-app.sh 的树轴就只 `-- packages/app`;把生产脚本的枚举缩成只有 app,
    // 全部用例里**只有这一条**会红。
    expect(run.exitCode, `packages/ui 半场没被枚举进来:\n${run.output}`).toBe(1)
    expect(run.output).toContain(ALPHA_UI)
  })

  test("补丁在 pin 上贴不上 ⇒ exit 1,且措辞与「内容漂移」可区分(两种红的处置不同)", () => {
    const { repo } = fixture()
    // 把补丁里的上下文改坏 ⇒ 不是 3-way 能救的漂移,是根本贴不上。
    const broken = readFileSync(join(repo, PATCH), "utf8").replace("export const terminal = 1", "export const terminal = 42")
    write(repo, PATCH, broken)
    commitAll(repo, "patch no longer applies on pin")
    const run = runGate(repo)
    expect(run.exitCode, `apply 失败被吞成「没有漂移」:\n${run.output}`).toBe(1)
    expect(run.output, `贴不上与内容漂移必须可区分,否则 runbook 的处置会选错:\n${run.output}`).toContain("贴不上")
    expect(run.output, `apply 失败却报成了内容漂移:\n${run.output}`).not.toContain("漂移:")
  })

  test("补丁重生时漏了 --binary ⇒ exit 1(vendored tgz 在 pin 里不存在,普通 git diff 不携带它)", () => {
    const { repo, pin } = fixture()
    const noBinary = Bun.spawnSync(["git", "diff", pin, "--", "packages/app", "packages/ui"], {
      cwd: repo,
      env: { ...GIT_ENV },
    })
    expect(noBinary.exitCode, "夹具没生成出无 --binary 的补丁").toBe(0)
    write(repo, PATCH, noBinary.stdout.toString())
    commitAll(repo, "regenerate the patch without --binary")
    const run = runGate(repo)
    // 这一条接住 frontend/README.md 块 4 里那句 `test -f "$RT/packages/app/$VENDORED"` 的语义:
    // 补丁没带二进制 ⇒ 重建不出可安装的树。生产侧 sync-upstream.yml 另有一条 VENDORED loud-fail。
    expect(run.exitCode, `没带二进制的补丁被判成好的 —— bun install 会装不上 vendored 依赖:\n${run.output}`).toBe(1)
    expect(run.output, `红了但没说清是二进制没带:\n${run.output}`).toContain("--binary")
  })

  test("pin 对象取不到:不设 ROUNDTRIP_REQUIRE_PIN ⇒ **恰好** exit 2 且说「未比对」", () => {
    const { repo } = fixture()
    const ghost = "0".repeat(39) + "1"
    write(repo, LOCK, `pin=${ghost} # 仓里不存在的对象\n`)
    commitAll(repo, "point the lock at an unreachable object")
    // 先证明这一跑走的确实是「取不到 pin」那一档,而不是别的分支。
    const probe = Bun.spawnSync(["git", "cat-file", "-e", `${ghost}^{commit}`], { cwd: repo, env: { ...GIT_ENV } })
    expect(probe.exitCode, "夹具里那个 pin 居然解析得出 —— 本条测的不是它要测的东西").not.toBe(0)

    const run = runGate(repo)
    // 恰好 2:只断非零会把「未比对」和「真漂移」混成同一档;判 0 则浅克隆上这道门永远绿。
    expect(run.exitCode, `浅克隆档位不对(0=永远绿,1=本地恒红⇒--no-verify):\n${run.output}`).toBe(2)
    expect(run.output, `没有自报「未比对」—— 「没检查」会被读成「检查过了」:\n${run.output}`).toContain("未比对")
  })

  test("同一夹具 + ROUNDTRIP_REQUIRE_PIN=1(CI 档)⇒ **恰好** exit 1 —— CI 侧没有逃生门", () => {
    const { repo } = fixture()
    const ghost = "0".repeat(39) + "1"
    write(repo, LOCK, `pin=${ghost} # 仓里不存在的对象\n`)
    commitAll(repo, "point the lock at an unreachable object")
    const run = runGate(repo, { ROUNDTRIP_REQUIRE_PIN: "1" })
    // CI 自己控制 checkout 深度(upstream-guard 是 fetch-depth: 0),取不到 pin = 接线坏了。
    // 缺这一条,alpha-ci 会重蹈 bun-test-app.sh 那半边门「CI 里恒未比对」的覆辙(`#976` 勘破:
    // CI 日志原文「未比对:pin 849c2598 的对象本地取不到(浅克隆/未 fetch)」)。
    expect(run.exitCode, `CI 档没有硬红 —— 那半边门在 CI 里等于不存在:\n${run.output}`).toBe(1)
  })

  test("补丁被清空 ⇒ 「测量作废」且与内容漂移可区分(空补丁重建出的是纯 pin 树)", () => {
    const { repo } = fixture()
    write(repo, PATCH, "")
    commitAll(repo, "empty the SOT patch")
    const run = runGate(repo)
    expect(run.exitCode, `空补丁被当成一次有效测量:\n${run.output}`).toBe(1)
    expect(run.output, `没说「测量作废」——「测不到」被报成了一个结论:\n${run.output}`).toContain("测量作废")
    expect(run.output, `空补丁被报成内容漂移,处置会选错:\n${run.output}`).not.toContain("漂移:")
  })

  test("pin 里根本没有 packages/ui ⇒ 「测量作废」,而不是给出一个看似有意义的漂移清单", () => {
    const { repo } = fixture()
    // lock 指向一个真实存在、却不含前端包的提交(真实形状:bump 时把 pin 写成了别的 sha)。
    const orphan = mkdtempSync(join(tmpdir(), "alpha-roundtrip-orphan-"))
    rmSync(orphan, { recursive: true, force: true })
    write(repo, "docs/unrelated.md", "not a frontend commit\n")
    const unrelated = commitAll(repo, "a commit without packages/ui")
    git(repo, ["rm", "-r", "-q", "--", "packages/ui"])
    const noUi = commitAll(repo, "drop packages/ui entirely")
    expect(unrelated).not.toBe(noUi)
    write(repo, LOCK, `pin=${noUi} # 指向一个没有 packages/ui 的提交\n`)
    commitAll(repo, "point the lock at a commit without packages/ui")
    const run = runGate(repo)
    expect(run.exitCode, `基底不含 packages/ui 时给出了结论:\n${run.output}`).toBe(1)
    expect(run.output, `没说「测量作废」:\n${run.output}`).toContain("测量作废")
  })
})

// ── 生产接线 ────────────────────────────────────────────────────────────────────
//
// ⚠️ **诚实边界**:下面这一条断言的是 `scripts/alpha-check.sh` 的**源码文本**,按本仓定义它是
// **减速带**,不是闸门 —— 有人把调用行改成 `bash scripts/assert-frontend-patch-roundtrip.sh || true`
// 时它照样绿。留着它的理由是:本 portfolio 的合并路径是「本地判绿 ⇒ gh pr merge --admin」,
// **CI 那一格是被绕过的那道**,所以 alpha-check.sh 里那行调用才是真闸;而上面十三条用例是
// `Bun.spawn` 直接跑脚本本体,**一条都不经过 alpha-check.sh** ⇒ 删掉那行调用,上面全绿、
// local-gate-parity 全绿(它只比 CI_STEPS ↔ alpha-ci.yml)、gate-files 全绿 —— 本地那道门已经
// 不存在而无人知晓(失效形态⑧:没测生产接线)。同形先例与同样的诚实边界见
// packages/ui-mac/src/main/local-gate-parity.test.ts。
describe("#976 生产接线(减速带,不是闸门)", () => {
  test("alpha-check.sh 真的调用了这个脚本", () => {
    const script = readFileSync(resolve(REPO_ROOT, "scripts/alpha-check.sh"), "utf8")
    expect(existsSync(SCRIPT), "生产脚本不在了").toBe(true)
    expect(
      script.includes("bash scripts/assert-frontend-patch-roundtrip.sh"),
      "scripts/alpha-check.sh 没有调用 scripts/assert-frontend-patch-roundtrip.sh —— 本地那道门不存在了,而 CI 那一格在 --admin 合并路径下是被绕过的那道",
    ).toBe(true)
  })

  // 这道门要比**哪些包**写死在生产脚本的 `PACKAGES=` 那一行,而**决定 sync 会重写哪些目录**的
  // 真源是 .github/workflows/sync-upstream.yml 的 `rm -rf …` 那一行。两处今天一致,但仓内没有
  // 任何东西断言它们相同 ⇒ 有人按 ADR 加第三个前端包、改了 sync 的删除范围而没改这里,
  // 「改了那两个目录必须重生补丁」这句话在新成员上就不成立:sync 会重写它、本门不比它,
  // `#976` 要消灭的静默删除在新成员上原样复活,而所有门全绿。枚举漏是九形态④,同形先例
  // `#889`/`#637`(UPSTREAM_PATHS 与收编白名单两处副本只同步了一半)。
  // ⚠️ **诚实边界**:这一条比的是两份**源码文本**,是减速带不是闸门 —— 它只钉住「这两行互相
  // 一致」,钉不住「sync 的删除范围是不是真的等于 sync 实际重写的目录」(那要跑整条 workflow)。
  // 仓内另有两份可各自漂移的副本(frontend/README.md 块 4 的补丁 pathspec、
  // scripts/verify-freeze-restore.sh),本条不覆盖它们。
  test("闸门枚举的包 == sync-upstream 会 rm -rf 的目录(两处一改就红)", () => {
    const gate = readFileSync(SCRIPT, "utf8")
    const declared = /^PACKAGES="([^"]+)"$/m.exec(gate)
    // 读不出就说「测量作废」,不能因为下面的 includes 没红就报绿(`#890`/`#946` 同款语义)。
    expect(
      declared,
      "从 scripts/assert-frontend-patch-roundtrip.sh 里读不出 `PACKAGES=\"…\"` —— 本条测量作废(不是通过),枚举的写法变了就要改这条判据",
    ).not.toBeNull()
    const packages = declared![1]
    const sync = readFileSync(resolve(REPO_ROOT, ".github/workflows/sync-upstream.yml"), "utf8")
    // **整行相等**,不是 `includes`。子串匹配在这里粗一格,而且恰好对本条要抓的那个方向失明:
    // sync 加第三个包写成 `rm -rf packages/app packages/ui packages/next` 时,
    // `includes("rm -rf packages/app packages/ui")` 仍为真 ⇒ 判据全绿而新成员无人比。
    // (2026-08-15 实测:先写的 includes 版在「缩小」方向红、在「新增」方向绿。)
    const rmLine = new RegExp(String.raw`^[ \t]*rm -rf ${packages.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \t]*$`, "m")
    expect(
      rmLine.test(sync),
      `sync-upstream.yml 里没有**恰好** \`rm -rf ${packages}\` 这一行 —— 本门枚举的包与 sync 实际重写的目录已经漂开:` +
        "受 sync 重写而本门不比的那些目录上,改动仍会被静默删除,而所有门全绿。两处要一起改。",
    ).toBe(true)
  })
})
