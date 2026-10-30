// `#1567`(SEC)—— `sync-upstream-push.yml`「Verify + unbundle candidate commits」那一步读候选清单的**行为闸**。
//
// 这道门守的是什么(大白话):自动同步上游的推送 job 持有往 `dev`/`alpha` 推送的凭据,而它读的
// `manifest.env` 来自候选阶段上传的 artifact。修复前那一步 `source` 这个文件 —— 谁能改 artifact,
// 谁就能在持有推送凭据的进程里跑任意命令(`$(…)`、额外一行语句)。现在由
// `scripts/sync-upstream-manifest.sh` 逐行按固定键名解析、值必须是 40 位十六进制 sha,不符即失败。
//
// 判据:
//   · AC2 用**生产脚本本体**跑恶意样本(`$(touch …)`、反引号、额外行),断言被拒且副作用文件不存在;
//     再用 `Bun.YAML` 从生产 workflow 取出**那一步的 run 体**,在带真 git bundle 的临时仓里用
//     `bash -e` 跑它本体:正常清单 ⇒ 绿且写出四个输出(正对照);恶意清单 ⇒ 红且 touch 没发生;
//     **变异臂**把解析换回修复前的 `source` ⇒ 同一夹具 touch 当场发生(先证明能测出已知的坏)。
//   · AC1 静态检查:push workflow 的任何 run 体里不出现 `source` / `.` / `eval`,并带变异臂。
//
// 删掉本文件会失去什么:那一步退回零判据 —— 有人把解析改回 `source`,或把解析器放宽成接受任意值,
// 都不会有任何东西变红(那条 workflow 只在 GitHub 上、只在上游有更新时才走到这几行)。

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SCRIPT = resolve(REPO_ROOT, "scripts/sync-upstream-manifest.sh")
const PUSH_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/sync-upstream-push.yml")
const UNBUNDLE_STEP = "Verify + unbundle candidate commits"
const KEYS = ["old_dev", "new_dev", "old_alpha", "new_alpha"] as const

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "alpha ci fixture",
  GIT_AUTHOR_EMAIL: "fixture@alpha.invalid",
  GIT_COMMITTER_NAME: "alpha ci fixture",
  GIT_COMMITTER_EMAIL: "fixture@alpha.invalid",
} as const
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...GIT_ENV }

const SHA = (c: string) => c.repeat(40)
const VALID = { old_dev: SHA("a"), new_dev: SHA("b"), old_alpha: SHA("c"), new_alpha: SHA("d") }
const manifestOf = (v: Record<string, string>) => KEYS.map((k) => `${k}=${v[k]}`).join("\n") + "\n"

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败:${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function runScript(manifest: string, key: string) {
  const dir = mkdtempSync(join(tmpdir(), "sync-manifest-"))
  writeFileSync(join(dir, "manifest.env"), manifest)
  const r = Bun.spawnSync(["bash", SCRIPT, join(dir, "manifest.env"), key], { cwd: dir, env: ENV })
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

function unbundleBody(): string {
  const doc = Bun.YAML.parse(readFileSync(PUSH_WORKFLOW, "utf8")) as any
  const step = doc?.jobs?.push?.steps?.find((s: any) => s?.name === UNBUNDLE_STEP)
  if (typeof step?.run !== "string") throw new Error(`读不出「${UNBUNDLE_STEP}」的 run 体 —— 本次测量作废,不是通过`)
  if (step.run.includes("${{")) throw new Error("run 体里有 Actions 表达式,本夹具不展开它 —— 本次测量作废")
  return step.run
}

/** 把解析换回修复前的 `source` ——「已知该失败的输入」。 */
function preFixBody(body: string): string {
  const parse = /^([ \t]*)old_dev="\$\(bash scripts\/sync-upstream-manifest\.sh[^\n]*\n(?:[ \t]*\w+="\$\(bash scripts\/sync-upstream-manifest\.sh[^\n]*\n){3}/m
  const mutated = body.replace(parse, (_m, indent: string) => `${indent}source sync-artifact/manifest.env\n`)
  if (mutated === body) throw new Error("变异一个字节都没改到 —— 构造不出「已知的坏」,本次测量作废,不是通过")
  return mutated
}

/** 临时仓 + 真 git bundle + 生产解析脚本;返回 run 体的执行器。 */
function stepFixture() {
  const repo = mkdtempSync(join(tmpdir(), "sync-push-"))
  git(repo, ["init", "-q", "-b", "alpha"])
  writeFileSync(join(repo, "f"), "base\n")
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-q", "-m", "base"])
  const base = git(repo, ["rev-parse", "HEAD"])
  git(repo, ["branch", "dev"])
  git(repo, ["commit", "-q", "--allow-empty", "-m", "alpha"])
  git(repo, ["checkout", "-q", "dev"])
  git(repo, ["commit", "-q", "--allow-empty", "-m", "dev"])
  const shas = { old_dev: base, new_dev: git(repo, ["rev-parse", "dev"]), old_alpha: base, new_alpha: git(repo, ["rev-parse", "alpha"]) }
  mkdirSync(join(repo, "sync-artifact"))
  git(repo, ["bundle", "create", "-q", "sync-artifact/sync.bundle", "dev", "alpha"])
  mkdirSync(join(repo, "scripts"))
  copyFileSync(SCRIPT, join(repo, "scripts/sync-upstream-manifest.sh"))
  const marker = join(repo, "PWNED")
  const run = (manifest: string, body: string) => {
    writeFileSync(join(repo, "sync-artifact/manifest.env"), manifest)
    const out = join(repo, "gh-output")
    writeFileSync(out, "")
    writeFileSync(join(repo, "step.sh"), body)
    chmodSync(join(repo, "step.sh"), 0o755)
    const r = Bun.spawnSync(["bash", "-e", "step.sh"], { cwd: repo, env: { ...ENV, GITHUB_OUTPUT: out } })
    return { exitCode: r.exitCode, log: r.stdout.toString() + r.stderr.toString(), output: readFileSync(out, "utf8") }
  }
  return { shas, marker, run }
}

describe("#1567 AC2:恶意清单在推送阶段被拒,且其中的命令不会运行", () => {
  test("正对照:合法清单 ⇒ 每个键读出对应的 sha", () => {
    for (const k of KEYS) {
      const r = runScript(manifestOf(VALID), k)
      expect(r.exitCode, r.stderr).toBe(0)
      expect(r.stdout).toBe(`${VALID[k]}\n`)
    }
  })

  test("恶意样本(命令替换 / 反引号 / 尾随语句 / 额外行)⇒ 非零退出,副作用文件不存在", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-manifest-pwn-"))
    const marker = join(dir, "PWNED")
    const samples = [
      manifestOf({ ...VALID, new_dev: `$(touch ${marker})` }),
      manifestOf({ ...VALID, new_dev: `\`touch ${marker}\`` }),
      manifestOf({ ...VALID, new_alpha: `${SHA("d")}; touch ${marker}` }),
      manifestOf(VALID) + `touch ${marker}\n`,
      manifestOf(VALID) + `old_dev=${SHA("a")}$(touch ${marker})\n`,
    ]
    for (const m of samples) {
      const r = runScript(m, "new_dev")
      expect(r.exitCode, `恶意清单没被拒:\n${m}`).not.toBe(0)
      expect(r.stdout, "被拒时不许打印任何值").toBe("")
      expect(r.stderr, "报错不许回显被拒的不可信内容").not.toContain("touch")
      expect(existsSync(marker), `清单里的命令被执行了:\n${m}`).toBe(false)
    }
  })

  test("格式不符(未知键 / 非 40 位小写 hex / 重复键 / 缺键 / 空行)⇒ 非零退出", () => {
    const bad = [
      manifestOf(VALID) + `PATH=${SHA("e")}\n`,
      manifestOf({ ...VALID, old_dev: "a".repeat(39) }),
      manifestOf({ ...VALID, old_dev: "A".repeat(40) }),
      manifestOf({ ...VALID, old_dev: `"${SHA("a")}"` }),
      manifestOf(VALID) + `new_dev=${SHA("e")}\n`,
      KEYS.slice(0, 3).map((k) => `${k}=${VALID[k]}`).join("\n") + "\n",
      manifestOf(VALID) + "\n",
    ]
    for (const m of bad) expect(runScript(m, "old_dev").exitCode, `该被拒的清单通过了:\n${m}`).not.toBe(0)
  })

  test("生产 run 体:合法清单 + 真 bundle ⇒ 绿且写出四个输出;恶意清单 ⇒ 红且命令没跑;换回 source ⇒ 命令当场跑了", () => {
    const fx = stepFixture()
    const body = unbundleBody()

    const ok = fx.run(manifestOf(fx.shas), body)
    expect(ok.exitCode, ok.log).toBe(0)
    expect(ok.output).toBe(KEYS.map((k) => `${k}=${fx.shas[k]}\n`).join(""))

    const evil = manifestOf({ ...fx.shas, new_dev: `$(touch ${fx.marker})${fx.shas.new_dev}` })
    const bad = fx.run(evil, body)
    expect(bad.exitCode, "恶意清单让推送步骤通过了").not.toBe(0)
    expect(existsSync(fx.marker), "恶意清单里的命令在推送步骤里被执行了").toBe(false)

    // 变异臂:修复前的 `source` 在同一夹具上必须让 touch 发生 —— 否则上面那条「没发生」证明不了任何事。
    fx.run(evil, preFixBody(body))
    expect(existsSync(fx.marker), "换回 source 后 touch 仍没发生 —— 夹具测不出已知的坏,本条测量作废").toBe(true)
  })
})

/** run 体里在命令位置出现的 `source` / `.` / `eval`(注释行除外)。 */
function sourcing(run: string): string[] {
  return run
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /(^|[;&|(`]|\b(then|do|else)\b)\s*(source|eval|\.)\s/.test(l))
}

describe("#1567 AC1:推送阶段不执行候选清单的任何内容", () => {
  test("push workflow 的每一个 run 体里都没有 source / . / eval", () => {
    const doc = Bun.YAML.parse(readFileSync(PUSH_WORKFLOW, "utf8")) as any
    const steps = doc?.jobs?.push?.steps
    expect(Array.isArray(steps) && steps.some((s: any) => s?.name === UNBUNDLE_STEP), "读不出 jobs.push.steps —— 测量作废").toBe(true)
    const hits = steps.flatMap((s: any) => (typeof s?.run === "string" ? sourcing(s.run).map((l) => `${s.name}: ${l.trim()}`) : []))
    expect(hits, "推送 job 里出现了 source / . / eval —— artifact 内容会在持有推送凭据的进程里被执行").toEqual([])
  })

  test("变异臂:检测器能认出修复前的 source,以及 `.` 与 eval 两种写法", () => {
    const body = unbundleBody()
    expect(sourcing(preFixBody(body))).toHaveLength(1)
    expect(sourcing(`${body}\n. sync-artifact/manifest.env\n`)).toHaveLength(1)
    expect(sourcing(`${body}\neval "$(cat sync-artifact/manifest.env)"\n`)).toHaveLength(1)
    expect(sourcing(`${body}\nset -a; source sync-artifact/manifest.env; set +a\n`)).toHaveLength(1)
  })
})
