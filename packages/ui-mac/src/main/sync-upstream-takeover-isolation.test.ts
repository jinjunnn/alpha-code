// `#1566` —— 每日上游同步(`.github/workflows/sync-upstream.yml`)遵守接管清单的**行为闸**。
//
// 这道门守的是什么(大白话):我们有一批上游文件已经改成了自己的版本(接管清单 =
// `scripts/north-star-guard.sh` 的 `UPSTREAM_EXCLUDES`)。从前同步只看 git 冲突:上游改动与我们的
// 改动不在同一处时 git 干净合并,上游的改动就**悄悄混进**我们的版本(实例:`003f6f764` 给
// `session/llm/request.ts` +2 行、`57646831b` 改了 `test/provider/transform.test.ts`)。现在:
//   · `Takeover intake check` 在合并前从可信树取清单,上游候选碰到清单 ⇒ 不合并、不出推送包,
//     以「需要升级审查」失败,并把路径、上游提交、双方差异写进运行摘要与产物;
//   · `Takeover paths unchanged by merge` 在合并后再核对一次;
//   · 剩余冲突以「未登记的偏离:按 ADR-029 登记或还原」具名报错;
//   · 人工移植以**真合并提交**合入后,下一次同步不再命中同一批路径(squash 则会再次命中)。
//
// 为什么判据长这样:
//   · **不断言 YAML 源码文本。** 用 `Bun.YAML` 从生产 workflow 里取出这几步的 `run` 体,在真 git
//     仓上按顺序用 `bash -e` 跑(Actions 对不写 `shell:` 的 `run:` 用的就是 `bash -e {0}`),
//     一步失败即停 —— 与 Actions 的默认 `success()` 语义一致,于是「不出推送包」由真的
//     `Build sync bundle artifact` 那一步有没有产出 `sync-artifact/` 来判。
//   · **清单来自生产守卫本体**:夹具 alpha 树里放的是本仓 `scripts/north-star-guard.sh` 的原样副本,
//     接管文件取清单里的真条目 `packages/opencode/src/session/llm/request.ts`(上面那次静默混入的文件)。
//   · **先证明手段测得出已知的坏**:删掉 intake 步 ⇒ 无冲突那例被合并步静默合入;移植改用 squash ⇒
//     下一次同步再次命中同一批路径;intake 改成执行工作树里的守卫 ⇒ 上游树里的脚本被执行。
//
// ⚠️ 诚实边界:这里不跑 Prompt/锚点 tripwire、Engine smoke(要真 bun 与真引擎)与两个 upload 步;
// 它们与本票的判定无关,且都排在 intake 之后或只在失败时运行。
//
// 删掉本文件会失去什么:这条每天只在 GitHub 上跑的同步链回到零行为判据 —— intake 被删、清单改成
// 工作流里手抄、合并后核对被删、报错文案退回「only-add discipline was broken」,都不会有东西变红。
// 它因此登记在 scripts/gate-files.tsv 里,拿精确条数。

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const WORKFLOW = resolve(REPO_ROOT, ".github/workflows/sync-upstream.yml")
const GUARD = resolve(REPO_ROOT, "scripts/north-star-guard.sh")

const INTAKE = "Takeover intake check"
const MERGE = "Merge `dev` into `alpha`"
const POST = "Takeover paths unchanged by merge"
const BUNDLE = "Build sync bundle artifact"
const FULL = [INTAKE, MERGE, POST, BUNDLE]

const REVIEW_TITLE = "::error title=takeover upgrade review required::"
const UNREGISTERED = "未登记的偏离:按 ADR-029 登记或还原"

/** 接管清单里的真条目(`003f6f764` 静默混入的那个文件)。 */
const TAKEOVER = "packages/opencode/src/session/llm/request.ts"
const ENGINE = "packages/opencode/src/engine.ts"

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "alpha ci fixture",
  GIT_AUTHOR_EMAIL: "fixture@alpha.invalid",
  GIT_COMMITTER_NAME: "alpha ci fixture",
  GIT_COMMITTER_EMAIL: "fixture@alpha.invalid",
} as const
const BASE_PATH = process.env.PATH ?? "/usr/bin:/bin"

// ── 生产 workflow 的步骤体 ──────────────────────────────────────────────────────

function candidateSteps(): any[] {
  const doc = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as any
  const steps = doc?.jobs?.candidate?.steps
  if (!Array.isArray(steps)) throw new Error("sync-upstream.yml 里读不出 jobs.candidate.steps —— 本次测量作废,不是通过")
  return steps
}

function stepBody(name: string): string {
  const step = candidateSteps().find((s: any) => typeof s?.name === "string" && s.name.startsWith(name))
  if (!step || typeof step.run !== "string" || step.run.trim().length === 0)
    throw new Error(`sync-upstream.yml 里找不到「${name}」那一步的 run 体 —— 本次测量作废,不是通过`)
  if (typeof step.shell === "string") throw new Error(`「${name}」声明了 shell: ${step.shell} —— 本夹具按 bash -e 跑,语义已漂`)
  return step.run
}

// ── 夹具 ────────────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { PATH: BASE_PATH, ...GIT_ENV } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败:${r.stderr.toString()}${r.stdout.toString()}`)
  return r.stdout.toString().trim()
}

function tryGit(cwd: string, args: string[]): number {
  return Bun.spawnSync(["git", ...args], { cwd, env: { PATH: BASE_PATH, ...GIT_ENV } }).exitCode ?? -1
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

function showFile(repo: string, rev: string, path: string): string | null {
  const r = Bun.spawnSync(["git", "show", `${rev}:${path}`], { cwd: repo, env: { PATH: BASE_PATH, ...GIT_ENV } })
  return r.exitCode === 0 ? r.stdout.toString() : null
}

/** 12 行的接管文件;`edits` 按行号(1 起)覆盖。两处改动隔开足够远,git 才会干净合并。 */
function takeoverBody(edits: Record<number, string> = {}): string {
  return Array.from({ length: 12 }, (_, i) => edits[i + 1] ?? `export const l${i + 1} = ${i + 1}`).join("\n") + "\n"
}
const ALPHA_EDIT = { 1: 'export const l1 = "alpha" // alpha takeover' }
const UPSTREAM_FAR = { 12: 'export const l12 = "upstream" // upstream change' }
const UPSTREAM_SAME = { 1: 'export const l1 = "upstream" // upstream change' }

const VENDOR_TGZ = "vendor/opencode-ai-client-1.17.13.tgz"
const TGZ_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff])

type Shape =
  /** 上游只改非接管文件 */
  | "plain"
  /** 上游改接管文件,与我方改动不冲突 */
  | "takeover-clean"
  /** 上游改接管文件,与我方改动冲突 */
  | "takeover-conflict"
  /** 上游与我方都改了一个不在清单里的上游文件 */
  | "unregistered"

type Fixture = { repo: string; work: string; oldDev: string; newDev: string; oldAlpha: string }

/**
 * 真实世界的缩比:dev = 上游(含 ADR-034 的 pin 前端),alpha = 前端 SOT 补丁 + 生产守卫副本 +
 * 改过的接管文件;dev 前进一步。结束时工作树停在 dev —— 与生产里 intake 运行时一致
 * (上一步 `Fast-forward dev` 刚 checkout 了它)。
 */
function fixture(shape: Shape, opts: { evilGuardInDev?: boolean } = {}): Fixture {
  const work = mkdtempSync(join(tmpdir(), "alpha-sync-takeover-"))
  const repo = join(work, "repo")
  mkdirSync(repo, { recursive: true })

  git(repo, ["init", "-q", "-b", "dev"])
  write(repo, "packages/app/src/app.tsx", "export function App() {\n  return null // upstream\n}\n")
  write(repo, "packages/app/package.json", `${JSON.stringify({ name: "app" }, null, 2)}\n`)
  write(repo, "packages/ui/src/button.tsx", "export const button = 1\n")
  write(
    repo,
    "packages/session-ui/package.json",
    `${JSON.stringify({ name: "session-ui", dependencies: { "@opencode-ai/client": `file:../app/${VENDOR_TGZ}` } }, null, 2)}\n`,
  )
  write(repo, ENGINE, "export const engine = 1\n")
  write(repo, TAKEOVER, takeoverBody())
  write(repo, "bun.lock", '{\n  "lockfileVersion": 1\n}\n')
  const pin = commitAll(repo, "upstream pin")

  git(repo, ["checkout", "-q", "-b", "alpha"])
  write(repo, "packages/app/src/app.tsx", "export function App() {\n  return AppSurfaces() // alpha seam\n}\n")
  write(
    repo,
    "packages/app/package.json",
    `${JSON.stringify({ name: "app", exports: { "./surface/session": "./src/pages/session.tsx" } }, null, 2)}\n`,
  )
  write(repo, `packages/app/${VENDOR_TGZ}`, TGZ_BYTES)
  commitAll(repo, "alpha frontend delta")
  const patch = Bun.spawnSync(["git", "diff", "--binary", pin, "--", "packages/app", "packages/ui"], {
    cwd: repo,
    env: { PATH: BASE_PATH, ...GIT_ENV },
  })
  if (patch.exitCode !== 0) throw new Error(`夹具生成 SOT 补丁失败:${patch.stderr.toString()}`)
  write(repo, "frontend/frontend-pin.lock", `pin=${pin} # fixture\n`)
  write(repo, "frontend/alpha-patches/alpha-frontend.patch", patch.stdout.toString())
  // 生产守卫的原样副本 —— 接管清单只有它一份。
  mkdirSync(join(repo, "scripts"), { recursive: true })
  copyFileSync(GUARD, join(repo, "scripts/north-star-guard.sh"))
  write(repo, TAKEOVER, takeoverBody(ALPHA_EDIT))
  if (shape === "unregistered") write(repo, ENGINE, "export const engine = 2 // alpha\n")
  const oldAlpha = commitAll(repo, "alpha: SOT + takeover")

  git(repo, ["checkout", "-q", "dev"])
  if (shape === "plain") write(repo, ENGINE, "export const engine = 9 // upstream only\n")
  if (shape === "takeover-clean") write(repo, TAKEOVER, takeoverBody(UPSTREAM_FAR))
  if (shape === "takeover-conflict") write(repo, TAKEOVER, takeoverBody(UPSTREAM_SAME))
  if (shape === "unregistered") write(repo, ENGINE, "export const engine = 3 // upstream\n")
  if (opts.evilGuardInDev) {
    // 上游树里冒出一个同名脚本:被执行就留下 canary。intake 运行时工作树正是这棵树。
    write(
      repo,
      "scripts/north-star-guard.sh",
      `#!/usr/bin/env bash\ntouch "${join(work, "CANARY-upstream-script-executed")}"\necho packages/does-not-exist\n`,
    )
  }
  const newDev = commitAll(repo, `upstream advances (${shape})`)
  return { repo, work, oldDev: pin, newDev, oldAlpha }
}

/** 上游再前进一步(只改非接管文件),工作树停在 dev。 */
function upstreamAdvancesAgain(fx: Fixture): Fixture {
  git(fx.repo, ["checkout", "-q", "dev"])
  write(fx.repo, ENGINE, "export const engine = 42 // next upstream\n")
  const next = commitAll(fx.repo, "upstream advances again")
  return { ...fx, oldDev: fx.newDev, newDev: next, oldAlpha: git(fx.repo, ["rev-parse", "alpha"]) }
}

type Run = { failedAt: string | null; output: string; summary: string; ghOutput: string; runnerTemp: string }

/** 按顺序跑生产步骤体,一步失败即停(Actions 默认 `success()`)。`bodies` 可替换某一步的 body(变异臂)。 */
function runSteps(fx: Fixture, names: string[], bodies: Record<string, string> = {}): Run {
  const runId = Math.random().toString(36).slice(2)
  const runnerTemp = join(fx.work, `runner-temp-${runId}`)
  mkdirSync(runnerTemp, { recursive: true })
  const summaryFile = join(fx.work, `summary-${runId}.md`)
  const outputFile = join(fx.work, `output-${runId}.txt`)
  writeFileSync(summaryFile, "")
  writeFileSync(outputFile, "")
  let output = ""
  let failedAt: string | null = null
  for (const name of names) {
    const script = join(fx.work, `step-${runId}.sh`)
    writeFileSync(script, bodies[name] ?? stepBody(name))
    const r = Bun.spawnSync(["bash", "-e", script], {
      cwd: fx.repo,
      env: {
        PATH: BASE_PATH,
        ...GIT_ENV,
        OLD_ALPHA: fx.oldAlpha,
        OLD_DEV: fx.oldDev,
        NEW_DEV: fx.newDev,
        RUNNER_TEMP: runnerTemp,
        GITHUB_STEP_SUMMARY: summaryFile,
        GITHUB_OUTPUT: outputFile,
      },
    })
    output += `\n── ${name} (exit ${r.exitCode}) ──\n${r.stdout.toString()}${r.stderr.toString()}`
    if (r.exitCode !== 0) {
      failedAt = name
      break
    }
  }
  return {
    failedAt,
    output,
    summary: readFileSync(summaryFile, "utf8"),
    ghOutput: readFileSync(outputFile, "utf8"),
    runnerTemp,
  }
}

const bundleProduced = (fx: Fixture) => existsSync(join(fx.repo, "sync-artifact/sync.bundle"))

function expectReviewFailure(fx: Fixture, run: Run, alphaBefore: string, takeoverBefore: string | null) {
  expect(run.failedAt, `应在 intake 步以升级审查失败:\n${run.output}`).toBe(INTAKE)
  expect(run.output, `失败标题不是「需要升级审查」:\n${run.output}`).toContain(REVIEW_TITLE)
  expect(run.output).toContain("需要升级审查")
  expect(run.output, `没点名接管路径:\n${run.output}`).toContain(TAKEOVER)
  expect(bundleProduced(fx), "intake 失败了却产出了推送包").toBe(false)
  expect(git(fx.repo, ["rev-parse", "alpha"]), "intake 失败了 alpha 却前进了(发生了合并)").toBe(alphaBefore)
  expect(showFile(fx.repo, "alpha", TAKEOVER), "我方接管文件被改了").toBe(takeoverBefore)
}

// ── AC2 ─────────────────────────────────────────────────────────────────────────

describe("#1566 AC2 上游候选触及接管路径 ⇒ 不合并、不出推送包、以「需要升级审查」失败", () => {
  test("无冲突地改了接管文件 ⇒ 审查标题失败,我方文件逐字节不变;摘要与产物列出路径、上游提交与双方差异", () => {
    const fx = fixture("takeover-clean")
    const before = showFile(fx.repo, "alpha", TAKEOVER)
    const run = runSteps(fx, FULL)
    expectReviewFailure(fx, run, fx.oldAlpha, before)

    const report = join(run.runnerTemp, "takeover-review/report.md")
    expect(existsSync(report), "产物目录里没有审查报告").toBe(true)
    for (const [where, text] of [
      ["运行摘要", run.summary],
      ["产物", readFileSync(report, "utf8")],
    ] as const) {
      expect(text, `${where}没列出路径`).toContain(`### \`${TAKEOVER}\``)
      expect(text, `${where}没列出相关上游提交`).toContain("upstream advances (takeover-clean)")
      expect(text, `${where}没列出上游差异`).toContain('+export const l12 = "upstream" // upstream change')
      expect(text, `${where}没列出我方差异`).toContain('+export const l1 = "alpha" // alpha takeover')
      expect(text, `${where}没写出本次审查的上游 SHA`).toContain(fx.newDev)
    }
    expect(run.ghOutput, "没把 review=true 交给产物上传步").toContain("review=true")
  })

  test("冲突地改了接管文件 ⇒ 同样以审查标题失败,我方文件逐字节不变", () => {
    const fx = fixture("takeover-conflict")
    const before = showFile(fx.repo, "alpha", TAKEOVER)
    const run = runSteps(fx, FULL)
    expectReviewFailure(fx, run, fx.oldAlpha, before)
    expect(run.summary).toContain('+export const l1 = "upstream" // upstream change')
  })

  test("产物上传步只在 intake 判出审查时运行", () => {
    const step = candidateSteps().find((s: any) => s?.name === "Upload takeover review report")
    expect(step, "找不到审查报告的上传步").toBeDefined()
    expect(String(step.if)).toContain("failure()")
    expect(String(step.if)).toContain("steps.takeover.outputs.review == 'true'")
    expect(String(step.uses)).toStartWith("actions/upload-artifact@")
  })
})

// ── AC3 ─────────────────────────────────────────────────────────────────────────

describe("#1566 AC3 未触及接管路径照常合并;合并后接管路径不变;剩余冲突具名报错", () => {
  test("非接管改动 ⇒ 照常合并、出推送包,接管文件与合并前逐字节相同", () => {
    const fx = fixture("plain")
    const before = showFile(fx.repo, "alpha", TAKEOVER)
    const run = runSteps(fx, FULL)
    expect(run.failedAt, `干净的非接管同步被拦了:\n${run.output}`).toBeNull()
    expect(bundleProduced(fx), "照常合并却没产出推送包").toBe(true)
    expect(showFile(fx.repo, "alpha", ENGINE), "上游改动没进 alpha").toContain("upstream only")
    expect(showFile(fx.repo, "alpha", TAKEOVER)).toBe(before)
  })

  test("变异臂:删掉 intake 步 ⇒ 合并步把无冲突的接管改动静默合入;合并后核对当场失败", () => {
    const fx = fixture("takeover-clean")
    const before = showFile(fx.repo, "alpha", TAKEOVER)
    const silent = runSteps(fx, [MERGE])
    expect(silent.failedAt, `没有 intake 时合并步应当静默成功 —— 夹具没造出「无冲突混入」:\n${silent.output}`).toBeNull()
    const merged = showFile(fx.repo, "alpha", TAKEOVER)
    expect(merged, "没有 intake 时接管文件居然没变 —— 夹具测不出要测的坏").not.toBe(before)
    expect(merged).toContain('"upstream" // upstream change')

    const post = runSteps(fx, [POST])
    expect(post.failedAt, `合并后核对没拦住被改写的接管文件:\n${post.output}`).toBe(POST)
    expect(post.output).toContain("::error title=takeover changed by merge::")
    expect(post.output).toContain(TAKEOVER)
  })

  test("剩余冲突在清单外 ⇒ 以「未登记的偏离:按 ADR-029 登记或还原」点名、abort、不出推送包", () => {
    const fx = fixture("unregistered")
    const run = runSteps(fx, FULL)
    expect(run.failedAt, `清单外冲突没在合并步拦住:\n${run.output}`).toBe(MERGE)
    expect(run.output).toContain(UNREGISTERED)
    expect(run.output).not.toContain("only-add discipline was broken")
    expect(run.output, "没点名冲突路径").toContain(ENGINE)
    expect(bundleProduced(fx)).toBe(false)
    expect(tryGit(fx.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]), "merge 没有被 abort").not.toBe(0)
  })
})

// ── AC4 ─────────────────────────────────────────────────────────────────────────

/** 人工移植:在 alpha 上把本次审查的上游 SHA 并进来,接管文件写成「我方 + 上游」的移植版。 */
function portByHand(fx: Fixture, how: "merge-commit" | "squash"): string {
  git(fx.repo, ["checkout", "-q", "alpha"])
  if (how === "merge-commit") git(fx.repo, ["merge", "--no-ff", "--no-commit", fx.newDev])
  else git(fx.repo, ["merge", "--squash", fx.newDev])
  const ported = takeoverBody({ ...ALPHA_EDIT, ...UPSTREAM_FAR })
  write(fx.repo, TAKEOVER, ported)
  git(fx.repo, ["add", "-A"])
  git(fx.repo, ["commit", "-q", "--no-edit", "-m", `port upstream ${fx.newDev} into takeover (${how})`])
  return ported
}

describe("#1566 AC4 受审集成以合并提交合入后,下一次同步不再命中同一批路径", () => {
  test("合并提交移植(第二父 = 审查的上游 SHA)⇒ 下一次运行不再命中、照常合并、移植内容不变", () => {
    const fx = fixture("takeover-clean")
    expect(runSteps(fx, FULL).failedAt, "前置:第一次运行应命中升级审查").toBe(INTAKE)

    const ported = portByHand(fx, "merge-commit")
    expect(git(fx.repo, ["rev-parse", "alpha^2"]), "移植提交的第二父不是本次审查的上游 SHA").toBe(fx.newDev)

    const next = upstreamAdvancesAgain(fx)
    const run = runSteps(next, FULL)
    expect(run.failedAt, `合并提交移植之后下一次同步仍被拦:\n${run.output}`).toBeNull()
    expect(run.output).not.toContain(REVIEW_TITLE)
    expect(bundleProduced(next)).toBe(true)
    expect(showFile(next.repo, "alpha", TAKEOVER), "照常合并改写了移植好的接管文件").toBe(ported)
    expect(showFile(next.repo, "alpha", ENGINE)).toContain("next upstream")
  })

  test("变异臂:移植改用 squash ⇒ 下一次运行再次命中同一批路径", () => {
    const fx = fixture("takeover-clean")
    expect(runSteps(fx, FULL).failedAt, "前置:第一次运行应命中升级审查").toBe(INTAKE)

    portByHand(fx, "squash")
    expect(tryGit(fx.repo, ["rev-parse", "-q", "--verify", "alpha^2"]), "squash 不该有第二父 —— 变异没构造出来").not.toBe(0)

    const next = upstreamAdvancesAgain(fx)
    const before = showFile(next.repo, "alpha", TAKEOVER)
    const run = runSteps(next, FULL)
    expectReviewFailure(next, run, next.oldAlpha, before)
  })
})

// ── AC5 ─────────────────────────────────────────────────────────────────────────

describe("#1566 AC5 候选 job 不持有推送凭据;新步骤只执行 alpha 树里的脚本", () => {
  test("候选 workflow:contents: read、无写权限、无 secrets 引用、每个 checkout 都 persist-credentials: false(沿用 `#899` 判据)", () => {
    const doc = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as any
    expect(doc?.permissions).toEqual({ contents: "read" })
    expect(doc?.jobs?.candidate?.permissions, "候选 job 自己声明了权限").toBeUndefined()
    // 判解析后的文档(丢掉注释),不判源码文本 —— 抬头注释逐字写着 `secrets.SYNC_TOKEN`。
    expect(JSON.stringify(doc)).not.toContain("secrets.")
    const checkouts = candidateSteps().filter((s: any) => String(s?.uses ?? "").startsWith("actions/checkout@"))
    expect(checkouts.length, "一个 checkout 步都没解析到 —— 本次测量作废").toBeGreaterThan(0)
    for (const s of checkouts) expect(s?.with?.["persist-credentials"], `${s.name} 持有凭据`).toBe(false)
  })

  test("intake 与合并后核对只执行 $OLD_ALPHA 里的守卫;上游树里的同名脚本不被执行(变异臂:改读工作树 ⇒ 被执行)", () => {
    const canary = (fx: Fixture) => existsSync(join(fx.work, "CANARY-upstream-script-executed"))

    const fx = fixture("takeover-clean", { evilGuardInDev: true })
    const run = runSteps(fx, [INTAKE])
    expect(canary(fx), `intake 执行了上游树里的脚本:\n${run.output}`).toBe(false)
    expect(run.output, "清单没从可信树取到 —— 接管改动没被拦").toContain(REVIEW_TITLE)

    // 合并后核对单独跑在同一棵上游工作树上(合并会把同名脚本判成清单外冲突,走不到这一步)。
    const fx2 = fixture("plain", { evilGuardInDev: true })
    const ok = runSteps(fx2, [POST])
    expect(ok.failedAt, ok.output).toBeNull()
    expect(canary(fx2), `合并后核对执行了工作树里的脚本:\n${ok.output}`).toBe(false)

    const src = stepBody(INTAKE)
    const fromTree = 'git show "$OLD_ALPHA:scripts/north-star-guard.sh"'
    expect(src, "变异构造不出来 —— intake 取守卫的写法变了").toContain(fromTree)
    const fx3 = fixture("takeover-clean", { evilGuardInDev: true })
    runSteps(fx3, [INTAKE], { [INTAKE]: src.replace(fromTree, "cat scripts/north-star-guard.sh") })
    expect(canary(fx3), "变异臂没执行到工作树脚本 —— 这条判据测不出已知的坏").toBe(true)
  })
})
