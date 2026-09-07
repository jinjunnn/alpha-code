// `#1272` —— `.github/workflows/sync-upstream.yml` 里「Merge `dev` into `alpha`」那一步的**行为闸**。
//
// 这道门守的是什么(大白话):每天 06:00 UTC 那条上游同步流水线,在**遇到冲突**时会走一条与
// 平时完全不同的分支。那条分支在 2026-09-06 之前**结构性不可用** —— 它先 `bun install`、后
// `apply_alpha_frontend_delta`,而 `packages/session-ui` 以 `file:../app/vendor/*.tgz` 直接依赖的
// 那个二进制**只存在于 alpha 的 SOT 补丁里**(pin 里没有 `packages/app/vendor`,2026-09-06 实测
// `git ls-tree 849c2598 packages/app/vendor` 输出为空)。于是 install 跑的时候资产还没被贴出来
// ⇒ 必然 `failed to resolve`,而那句话不告诉任何人该做什么。同一份 workflow 的 `VENDORED` 判据
// **正是为这一格写的**(它会说「须用 git diff --binary 重生」/ 跑月更 bump)—— 判据是对的,
// 顺序是错的,于是那句可读的话永远来不及打印。
//
// 2026-09-06 `ac#1248` 的实现方手工复演同一条路径时撞上,原话:
//   `@opencode-ai/client@file:../app/vendor/opencode-ai-client-1.17.13-v2.tgz failed to resolve`
//
// 为什么判据必须长这样:
//   · **不断言 YAML 源码文本。** 「grep 到 apply_alpha_frontend_delta 排在 bun install 前面」在本仓
//     是点名过的假闸门形态 —— 有人在**更靠前的地方**再加一句 install、或把顺序改回去而文本仍匹配,
//     它照样绿。这里起**真的 git 仓**(pin / alpha delta / SOT 补丁 / 上游前进 四段历史齐备),
//     用 `Bun.YAML` 从**生产 workflow 里解析出那一步的 `run` 体**,再用 `bash -e` 跑它本体
//     (Actions 对不写 `shell:` 的 `run:` 用的就是 `bash -e {0}`),断言**行为**。
//   · **先证明这个手段能测出已知的坏,再用它判未知的好。** 下面第 2、4 条把生产 body 的
//     `apply_alpha_frontend_delta` / `bun install` 两行**换回修复前的顺序**,断言同一夹具当场
//     死在 `failed to resolve`、且**一句 `::error::` 都没有**。变异没改到字节时抛「测量作废」,
//     不给一个看着像通过的结果。
//   · **主判据不依赖假 `bun` 的保真度。** 它判的是「`bun install` 被调用的那一刻,`file:` 依赖
//     指着的那个文件在不在树上」——「资产缺席时 install 会失败」这件事由真 bun 单独证过
//     (2026-09-06 本机 bun 1.3.14 实测,见夹具里的桩注释),不由这道门推断。
//   · **两条分支都要罩住。** 「没冲突」那条路径不跑 install(它在后面的 Engine smoke 步里跑),
//     修顺序时很容易顺手把它改坏;「意外冲突」那条要 abort 且不许摸 install。各有一条。
//   · **install 不许被「删掉了事」。** 冲突分支取的是上游的 `bun.lock`(`--theirs`),不重生就会把
//     一份不含 alpha workspace 的 lockfile 推上 alpha。所以有一条专门断言重生结果**落进了提交**。
//
// 删掉本文件会失去什么:那一步退回零行为判据 —— 顺序换回去、install 被删掉、
// `apply_alpha_frontend_delta` 的 loud-fail 被吞、no-conflict 分支被改成也跑 install,
// 都不会有任何东西变红(那条 workflow 只在 GitHub 上、只在有冲突时才走到这几行)。
// 它因此登记在 scripts/gate-files.tsv 里,拿精确条数。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const WORKFLOW = resolve(REPO_ROOT, ".github/workflows/sync-upstream.yml")
/** 生产那一步的名字前缀(整名带反引号,前缀足够唯一)。 */
const MERGE_STEP = "Merge `dev` into `alpha`"

/**
 * 完全隔离的 git 环境(与 frontend-patch-roundtrip.test.ts 同源的理由):
 *  ① 开发机的 ~/.gitconfig 不许影响判据;
 *  ② 反过来 —— 本测试**结构上不可能**写到本仓的 .git/config 或当前分支。
 */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "alpha ci fixture",
  GIT_AUTHOR_EMAIL: "fixture@alpha.invalid",
  GIT_COMMITTER_NAME: "alpha ci fixture",
  GIT_COMMITTER_EMAIL: "fixture@alpha.invalid",
} as const

const VENDOR_TGZ = "vendor/opencode-ai-client-1.17.13.tgz"
/** 上游 v1.18.15~19 把 `file:` 依赖换名到的那个文件(`ac#1248` 撞上的正是它)。 */
const VENDOR_TGZ_V2 = "vendor/opencode-ai-client-1.17.13-v2.tgz"
/** 真二进制字节(含不可打印)——只写进临时夹具目录,不进本仓。 */
const TGZ_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0xca, 0x48])

const SEAM_MARKER = "AppSurfaces"
const NARROW_EXPORT = '"./surface/session": "./src/pages/session.tsx"'

// ── 生产 body 的取出与变异 ──────────────────────────────────────────────────────

function mergeStepBody(): string {
  const doc = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as any
  const steps = doc?.jobs?.candidate?.steps
  if (!Array.isArray(steps)) throw new Error("sync-upstream.yml 里读不出 jobs.candidate.steps —— 本次测量作废,不是通过")
  const step = steps.find((s: any) => typeof s?.name === "string" && s.name.startsWith(MERGE_STEP))
  if (!step || typeof step.run !== "string" || step.run.trim().length === 0)
    throw new Error(`sync-upstream.yml 里找不到「${MERGE_STEP} …」那一步的 run 体 —— 本次测量作废,不是通过`)
  if (typeof step.shell === "string")
    throw new Error(`那一步声明了 shell: ${step.shell} —— 本夹具按 Actions 默认的 \`bash -e {0}\` 跑,语义已漂,本次测量作废`)
  return step.run
}

/** 相邻两行(顺序敏感),故意不匹配 no-conflict 分支里那个后面跟 `exit 0` 的调用点。 */
const ORDER_PAIR = /^([ \t]*)apply_alpha_frontend_delta[ \t]*\n([ \t]*)bun install[ \t]*$/m

/** 把生产 body 换回**修复前**的顺序(install 先于补丁)——「已知该失败的输入」。 */
function preFixOrder(body: string): string {
  if (!ORDER_PAIR.test(body))
    throw new Error(
      "生产 body 里找不到相邻的 `apply_alpha_frontend_delta` → `bun install` 两行 —— 变异构造不出「已知的坏」," +
        "这道门就没有被证明过能测出它。本次测量作废(不是通过):顺序的写法变了就要改这条变异。",
    )
  const mutated = body.replace(ORDER_PAIR, (_m, a: string, b: string) => `${b}bun install\n${a}apply_alpha_frontend_delta`)
  if (mutated === body) throw new Error("变异一个字节都没改到 —— 本次测量作废,不是通过")
  return mutated
}

// ── 夹具 ────────────────────────────────────────────────────────────────────────

type Fixture = { repo: string; work: string; bin: string; log: string }
type Shape = {
  /** 冲突形态:app = 上游与 alpha 改同一处 app/ui(+ bun.lock);none = 干净合并;unexpected = 冲突落在 app/ui 之外 */
  conflict: "app" | "none" | "unexpected"
  /** 上游把 `file:` 依赖换名(补丁仍带旧名)—— `ac#1248` 撞上的那个形状 */
  drift?: boolean
}

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...GIT_ENV } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败:${r.stderr.toString()}${r.stdout.toString()}`)
  return r.stdout.toString().trim()
}

function write(repo: string, path: string, body: string | Uint8Array) {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), body)
}

function commitAll(repo: string, message: string): string {
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-q", "-m", message])
  return git(repo, ["rev-parse", "HEAD"])
}

function sessionUiPackageJson(tgz: string): string {
  return `${JSON.stringify({ name: "session-ui", dependencies: { "@opencode-ai/client": `file:../app/${tgz}` } }, null, 2)}\n`
}

/**
 * 假 `bun`。只做两件事:
 *   ① 把**每一次调用发生时那棵树的状态**记进日志(资产在不在);
 *   ② 忠实复现真 bun 在 `file:` 目标缺失时的失败。
 * ②的形状不是猜的 —— 2026-09-06 本机 bun 1.3.14 单独实测:
 *     error: ENOENT extracting tarball from @opencode-ai/client
 *     error: @opencode-ai/client@file:../vendor/opencode-ai-client-1.17.13-v2.tgz failed to resolve
 *     exit 1
 * 但**主判据不依赖这段复现的保真度**:下面的断言判的是日志里的 MISSING/PRESENT,
 * 即「install 被调用的那一刻资产在不在」。
 */
const BUN_STUB = `#!/usr/bin/env bash
set -u
log="\${BUN_STUB_LOG:?}"
if [ "\${1:-}" != "install" ]; then
  echo "other|\$*" >> "\$log"
  echo "stub bun: 只实现了 install,收到:\$*" >&2
  exit 2
fi
dep="\$(sed -n 's|.*"file:\\.\\./app/\\(vendor/[^"]*\\.tgz\\)".*|\\1|p' packages/session-ui/package.json | head -1)"
if [ -z "\$dep" ]; then
  echo "install|NO-FILE-DEP|" >> "\$log"
  exit 0
fi
if [ ! -f "packages/app/\$dep" ]; then
  echo "install|MISSING|\$dep" >> "\$log"
  echo "bun install v1.3.14 (stub)"
  echo "error: ENOENT extracting tarball from @opencode-ai/client"
  echo "error: @opencode-ai/client@file:../app/\$dep failed to resolve"
  exit 1
fi
echo "install|PRESENT|\$dep" >> "\$log"
printf '  "//": "regenerated-by-install"\\n' >> bun.lock
exit 0
`

/**
 * 夹具形状 —— 真实世界的缩比:
 *
 *   dev(= pin)   packages/{app,ui} 纯上游态:没有 AppSurfaces、没有窄导出、**没有 vendor/**
 *   alpha         + seam marker + 窄导出 + vendored tgz(二进制)+ ui 侧 alpha 文件
 *   alpha(SOT)   frontend/{frontend-pin.lock, alpha-patches/alpha-frontend.patch} + alpha 侧 bun.lock
 *   dev 前进      按 Shape 造出「与 alpha 冲突 / 干净 / 意外冲突」,可叠加 `file:` 换名漂移
 *
 * `packages/session-ui` 与 `packages/opencode` 在 app/ui 之外 ⇒ 它们随上游干净合并,
 * 与真实世界一致(换名漂移正是这么进来的)。
 */
function fixture(shape: Shape): Fixture {
  const work = mkdtempSync(join(tmpdir(), "alpha-sync-order-"))
  const repo = join(work, "repo")
  const bin = join(work, "bin")
  const log = join(work, "bun-calls.log")
  mkdirSync(repo, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "bun"), BUN_STUB)
  chmodSync(join(bin, "bun"), 0o755)

  git(repo, ["init", "-q", "-b", "dev"])
  write(repo, "packages/app/src/app.tsx", "export function App() {\n  return null // upstream\n}\n")
  write(repo, "packages/app/package.json", `${JSON.stringify({ name: "app", exports: { "./index": "./src/app.tsx" } }, null, 2)}\n`)
  write(repo, "packages/ui/src/button.tsx", "export const button = 1\n")
  write(repo, "packages/session-ui/package.json", sessionUiPackageJson(VENDOR_TGZ))
  write(repo, "packages/opencode/src/engine.ts", "export const engine = 1\n")
  write(repo, "bun.lock", '{\n  "lockfileVersion": 1,\n  "upstream": true\n}\n')
  const pin = commitAll(repo, "upstream pin")

  git(repo, ["checkout", "-q", "-b", "alpha"])
  write(repo, "packages/app/src/app.tsx", `export function App() {\n  return ${SEAM_MARKER}() // alpha seam\n}\n`)
  write(
    repo,
    "packages/app/package.json",
    `${JSON.stringify({ name: "app", exports: { "./index": "./src/app.tsx", "./surface/session": "./src/pages/session.tsx" } }, null, 2)}\n`,
  )
  write(repo, `packages/app/${VENDOR_TGZ}`, TGZ_BYTES)
  write(repo, "packages/ui/src/alpha-overlay.ts", "export const overlay = 1\n")
  commitAll(repo, "alpha frontend delta")

  const diff = Bun.spawnSync(["git", "diff", "--binary", pin, "--", "packages/app", "packages/ui"], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...GIT_ENV },
  })
  if (diff.exitCode !== 0) throw new Error(`夹具生成 SOT 补丁失败:${diff.stderr.toString()}`)
  write(repo, "frontend/frontend-pin.lock", `pin=${pin} # fixture\n`)
  write(repo, "frontend/alpha-patches/alpha-frontend.patch", diff.stdout.toString())
  write(repo, "bun.lock", '{\n  "lockfileVersion": 1,\n  "alpha-workspaces": true\n}\n')
  if (shape.conflict === "unexpected") write(repo, "packages/opencode/src/engine.ts", "export const engine = 2 // alpha\n")
  commitAll(repo, "record SOT")

  git(repo, ["checkout", "-q", "dev"])
  if (shape.conflict === "app") {
    write(repo, "packages/app/src/app.tsx", "export function App() {\n  return null // upstream v2\n}\n")
    write(repo, "bun.lock", '{\n  "lockfileVersion": 1,\n  "upstream": "v2"\n}\n')
  }
  if (shape.conflict === "unexpected") write(repo, "packages/opencode/src/engine.ts", "export const engine = 3 // upstream\n")
  if (shape.conflict === "none") write(repo, "packages/opencode/src/engine.ts", "export const engine = 9 // upstream only\n")
  if (shape.drift) write(repo, "packages/session-ui/package.json", sessionUiPackageJson(VENDOR_TGZ_V2))
  commitAll(repo, "upstream advances")

  return { repo, work, bin, log }
}

type Run = { exitCode: number; output: string; calls: string[] }

/**
 * 跑**生产那一步的 body 本体**,用 `bash -e` —— Actions 对不写 `shell:` 的 `run:` 用的就是
 * `bash -e {0}`。
 * ⚠️ **诚实边界**:这里只跑这**一步**,不跑它前后的步骤,也不建模 Actions 的表达式/env 层
 * (这一步的 body 不用任何 `${{ }}` 与 `$GITHUB_*`,已随 body 一起从 YAML 里解析出来核对)。
 * 「更靠前的某一步里也有 bun install」这个方向由本文件最后一条(减速带)接住。
 */
function runStep(fx: Fixture, body: string): Run {
  const script = join(fx.work, "merge-step.sh")
  writeFileSync(script, body)
  const r = Bun.spawnSync(["bash", "-e", script], {
    cwd: fx.repo,
    env: { PATH: `${fx.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, BUN_STUB_LOG: fx.log, ...GIT_ENV },
  })
  const output = `${r.stdout.toString()}${r.stderr.toString()}`
  const calls = existsSync(fx.log)
    ? readFileSync(fx.log, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
    : []
  return { exitCode: r.exitCode ?? -1, output, calls }
}

function showFile(repo: string, rev: string, path: string): string | null {
  const r = Bun.spawnSync(["git", "show", `${rev}:${path}`], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...GIT_ENV },
  })
  return r.exitCode === 0 ? r.stdout.toString() : null
}

describe("#1272 sync-upstream 冲突分支:补丁必须先于 install", () => {
  test("冲突 + 补丁健康 ⇒ exit 0,且 `bun install` 被调用时 vendored 资产**已经在树上**", () => {
    const fx = fixture({ conflict: "app" })
    const run = runStep(fx, mergeStepBody())
    expect(run.exitCode, `冲突分支跑不到底 —— 这道门要治的正是它:\n${run.output}`).toBe(0)
    // 假 bun 一次都没被调用 = PATH 没生效 / install 被删掉,两种都让下面的断言变成空话。
    expect(run.calls, `\`bun install\` 一次都没跑到(PATH 没生效?install 被删了?)—— 本次测量作废:\n${run.output}`).toHaveLength(1)
    expect(run.calls[0], `install 跑的时候 vendored 资产不在树上 —— 真 bun 会 \`failed to resolve\`:\n${run.output}`).toBe(
      `install|PRESENT|${VENDOR_TGZ}`,
    )
    // 终态必须是「pin + 补丁」,不是「纯 pin」。
    expect(showFile(fx.repo, "alpha", "packages/app/src/app.tsx"), "终态 app.tsx 里没有 seam marker").toContain(SEAM_MARKER)
    expect(showFile(fx.repo, "alpha", "packages/app/package.json"), "终态 app/package.json 里没有窄导出").toContain(NARROW_EXPORT)
  })

  test("变异臂:把两行换回修复前的顺序 ⇒ 同一夹具当场死在 `failed to resolve`,且一句 `::error::` 都没有", () => {
    const fx = fixture({ conflict: "app" })
    const run = runStep(fx, preFixOrder(mergeStepBody()))
    // 没有这一条,上面那条绿不能证明任何事 —— 先证明这个手段能测出已知的坏。
    expect(run.exitCode, `修复前的顺序居然跑通了 —— 这道门测不出它要测的那个坏:\n${run.output}`).not.toBe(0)
    expect(run.calls, `变异臂里 install 的调用记录不是一条:\n${run.output}`).toEqual([`install|MISSING|${VENDOR_TGZ}`])
    expect(run.output, `没复现出 install 期的解析失败:\n${run.output}`).toContain("failed to resolve")
    // 这才是 `#1272` 真正的代价:人拿到的是 bun 的天书,而 workflow 自己那句可读的话来不及打印。
    expect(run.output, `变异臂里居然打出了 workflow 自己的 ::error:: —— 那说明夹具没走到 install 那一格:\n${run.output}`).not.toContain(
      "::error::",
    )
  })

  test("冲突 + `file:` 换名漂移 ⇒ 以 workflow 自己那句**可读**的 loud-fail 失败,且 install **一次都没跑**", () => {
    const fx = fixture({ conflict: "app", drift: true })
    const run = runStep(fx, mergeStepBody())
    expect(run.exitCode, `漂移被放行了:\n${run.output}`).toBe(1)
    expect(run.calls, `补丁还没贴稳就跑了 install —— 顺序又反了:\n${run.output}`).toHaveLength(0)
    expect(run.output, `失败了但没给出可操作的原因:\n${run.output}`).toContain("missing after applying alpha frontend delta")
    expect(run.output, `没点名到那个精确文件,人得自己去猜:\n${run.output}`).toContain(`packages/app/${VENDOR_TGZ_V2}`)
    expect(run.output, `可读的失败仍然掺着 bun 的天书 —— 说明还是先 install 了:\n${run.output}`).not.toContain("failed to resolve")
  })

  test("变异臂 + 同一漂移 ⇒ 正是 2026-09-06 手工复演撞到的那一格:`failed to resolve`,可读原因永远不打印", () => {
    const fx = fixture({ conflict: "app", drift: true })
    const run = runStep(fx, preFixOrder(mergeStepBody()))
    expect(run.exitCode, `修复前的顺序在漂移输入上居然跑通了:\n${run.output}`).not.toBe(0)
    expect(run.calls, `变异臂的 install 调用记录不是一条:\n${run.output}`).toEqual([`install|MISSING|${VENDOR_TGZ_V2}`])
    expect(run.output, `没复现出 ac#1248 报的那句:\n${run.output}`).toContain("failed to resolve")
    expect(
      run.output,
      `变异臂里 VENDORED 判据居然说话了 —— 那它就不是「顺序错」的那个形态了:\n${run.output}`,
    ).not.toContain("missing after applying alpha frontend delta")
  })

  test("冲突分支必须**重生并提交** bun.lock —— 取了上游的 `--theirs` 之后不重生,alpha 会带着一份不含自己 workspace 的 lockfile", () => {
    const fx = fixture({ conflict: "app" })
    const run = runStep(fx, mergeStepBody())
    expect(run.exitCode, `前置没跑通,本条测的不是它要测的东西:\n${run.output}`).toBe(0)
    const lock = showFile(fx.repo, "alpha", "bun.lock")
    // 「把 install 挪到后面」最省事的错误修法是**把它删掉**;那样这一条会红。
    expect(lock, `alpha 的 bun.lock 没有被 install 重生过:\n${lock}`).toContain("regenerated-by-install")
    // 且它确实是从上游那份(--theirs)重生的,不是 alpha 旧的那份原样留着。
    expect(lock, `bun.lock 不是上游那份 —— \`git checkout --theirs\` 那一格没生效:\n${lock}`).toContain('"upstream": "v2"')
  })

  test("没有冲突的那条路径没被改坏:exit 0、补丁重贴、且这一步**不跑** install(它在后面的 Engine smoke 步)", () => {
    const fx = fixture({ conflict: "none" })
    const run = runStep(fx, mergeStepBody())
    expect(run.exitCode, `干净合并的那条路径被改坏了:\n${run.output}`).toBe(0)
    expect(run.calls, `no-conflict 分支跑了 install —— 顺手把另一条路径也改了:\n${run.output}`).toHaveLength(0)
    expect(showFile(fx.repo, "alpha", "packages/app/src/app.tsx"), "干净合并后没重贴补丁(seam marker 不在)").toContain(SEAM_MARKER)
    expect(showFile(fx.repo, "alpha", `packages/app/${VENDOR_TGZ}`), "干净合并后 vendored 资产没被补丁重建出来").not.toBeNull()
  })

  test("没有冲突 + 同一漂移 ⇒ 两条分支给出**同一句**可读 loud-fail(人不该因为走了哪条分支而看见两种话)", () => {
    const fx = fixture({ conflict: "none", drift: true })
    const run = runStep(fx, mergeStepBody())
    expect(run.exitCode, `no-conflict 分支把漂移放行了:\n${run.output}`).toBe(1)
    expect(run.output, `no-conflict 分支的 loud-fail 措辞与冲突分支不一致:\n${run.output}`).toContain(
      "missing after applying alpha frontend delta",
    )
    expect(run.calls, `no-conflict 分支不该碰 install:\n${run.output}`).toHaveLength(0)
  })

  test("意外冲突(落在 app/ui 之外)⇒ 点名、abort、exit 1,且 install 一次都不跑", () => {
    const fx = fixture({ conflict: "unexpected" })
    const run = runStep(fx, mergeStepBody())
    expect(run.exitCode, `only-add 纪律被破坏时没有拦住:\n${run.output}`).toBe(1)
    expect(run.output, `没说清是 only-add 纪律被破坏:\n${run.output}`).toContain("only-add discipline was broken")
    expect(run.output, `没点名到冲突文件:\n${run.output}`).toContain("packages/opencode/src/engine.ts")
    expect(run.calls, `意外冲突时还去跑了 install:\n${run.output}`).toHaveLength(0)
    // merge 必须被 abort —— 留着半合并的树,下一次 sync 从一个坏状态起跑。
    const merging = Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: fx.repo,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...GIT_ENV },
    })
    expect(merging.exitCode, "merge 没有被 abort,树停在半合并状态").not.toBe(0)
  })
})

// ── 减速带(不是闸门)────────────────────────────────────────────────────────────
//
// ⚠️ **诚实边界**:上面八条只跑「Merge `dev` into `alpha`」**这一步**。整条 workflow 是顺序执行的,
// 所以「有人在**更靠前**的某一步里加了 `bun install`」会让本票的缺陷原样复活,而上面八条全绿 ——
// 那个方向行为闸罩不到(要跑整条 workflow)。这一条比的是 YAML 的**文本**,按本仓定义是减速带:
// 有人把 install 写成 `bun i` 或 `npx bun install` 时它照样绿。留着它是因为这个方向今天没有别的东西看着。
describe("#1272 减速带:merge 步之前的任何一步都不许 install", () => {
  test("`Merge dev into alpha` 之前没有任何一步跑 `bun install`", () => {
    const doc = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as any
    const steps = doc?.jobs?.candidate?.steps
    expect(Array.isArray(steps), "读不出 jobs.candidate.steps —— 本条测量作废(不是通过)").toBe(true)
    const idx = steps.findIndex((s: any) => typeof s?.name === "string" && s.name.startsWith(MERGE_STEP))
    expect(idx, `找不到「${MERGE_STEP} …」这一步 —— 本条测量作废(不是通过)`).toBeGreaterThan(-1)
    const early = steps
      .slice(0, idx)
      .filter((s: any) => typeof s?.run === "string" && /(^|\s)bun\s+install(\s|$)/m.test(s.run))
      .map((s: any) => s.name)
    expect(
      early,
      `这些步骤排在合并步之前却跑了 bun install:${early.join(", ")} —— 那时 packages/{app,ui} 还没被重贴成 pin+补丁,` +
        "vendored 资产不在树上,`#1272` 的缺陷原样复活。",
    ).toEqual([])
  })
})
