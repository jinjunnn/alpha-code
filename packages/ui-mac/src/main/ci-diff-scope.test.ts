// `#717` —— alpha-ci `detect` 分类步的行为闸。
//
// 这道门守的是什么(用大白话说):alpha-ci 里几乎每一步跑不跑,都由 `detect` 输出的
// `code` 一个布尔值决定 —— upstream-guard / typecheck / test / seed-assets 的**全部**步骤
// 都挂在 `needs.detect.outputs.code == 'true'` 上,docs gate 的入参就是它输出的 `md`。
// 也就是说:这个分类器错一次,不是少测一个函数,是**当天所有闸门跑不跑被算错**。
//
// 它以前错在哪:`pull_request` 事件上用的是**两点** diff `base..head`,而
// `github.event.pull_request.base.sha` 给的是**当下 alpha 的 tip**,不是分叉点。于是一个
// 落后于 alpha 的纯文档分支,会把别人已经合进 alpha 的代码算成自己的改动 ⇒ `code=true` ⇒
// 跑全量 ⇒ 继承主线的红,而这个 PR 里一行代码都没有 —— 人只好 `--admin` 绕过。
// 实证(`#717` owner 评论):同一个 commit,PR run 30756424959 判 code=true 并红在
// `bun test (ui-mac)`,push run 30756431539 判 code=false、全部 skipped。
//
// 为什么判据必须长这样:
//   · **不断言 YAML 文本**。按本仓定义那是假闸门 —— 源码里写着 `...` 三个点,不等于
//     GitHub 上跑出来的分类是对的。这里起**真的 git 仓**、造**真的落后分支**、跑
//     **生产的那个脚本**(scripts/detect-changed-scope.sh,workflow 的 `run:` 就是它),
//     断言它写进 `$GITHUB_OUTPUT` 的**实际值**。
//   · **不只断言 code=false**。一个「永远返回 false」的错误实现能满足那一条 —— 所以
//     ②③④ 分别钉住「该 true 时必须 true」「md 不许被 base 侧污染」「push 支路口径不变」。
//   · **classify() 自己会在测不到时抛**(退出码非零 / 输出文件里没有 `code=`),而不是
//     返回一个让断言空对空通过的值。观测手段自己也要有判据。
//
// 删掉本文件会失去什么:这个分类器就**再没有任何判据**。它不在本地 alpha-check.sh 的
// 跑动范围里(本地一律跑全量,没有 docs-only 快路径),CI 上也只有它自己的输出可看。
// 改坏它的人不会在任何地方变红,而后果是全部闸门的开关被算错。它因此登记在
// scripts/gate-files.tsv 里,拿精确条数。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SCRIPT = resolve(REPO_ROOT, "scripts/detect-changed-scope.sh")

/**
 * 完全隔离的 git 环境。两个理由,后一个更重要:
 *  ① 开发机的 ~/.gitconfig(core.hooksPath、templateDir、别名…)不许影响判据;
 *  ② 反过来 —— 本测试**结构上不可能**写到本仓的 .git/config 或当前分支(`ac#815` 那一类:
 *     跑门的过程往共享树里写东西,只有 reflog 分辨得出)。身份走 env,不走 `git config`。
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

function commit(repo: string, message: string, files: Record<string, string>): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-q", "-m", message])
  return git(repo, ["rev-parse", "HEAD"])
}

/**
 * 本票的形状:一条**落后于 alpha 的纯文档分支**。
 *
 *   seed ──► mainline   (alpha 前进了一个 commit:一个代码文件 + 一个 Markdown)
 *      └──► docsOnly    (分支只改了一个 Markdown)
 *
 * `base.sha` = mainline(GitHub 给 pull_request 的就是移动中的 tip),`head.sha` = docsOnly。
 * 分叉点是 seed。三点口径只看得见 docs/branch-note.md;两点口径会把 mainline 的
 * 那个 .ts 也算进来。
 */
function staleDocsBranchFixture() {
  const repo = mkdtempSync(join(tmpdir(), "alpha-detect-repo-"))
  git(repo, ["init", "-q", "-b", "alpha"])
  const seed = commit(repo, "seed", {
    "docs/seed.md": "# seed\n",
    "packages/ui-mac/src/seed.ts": "export const seed = 1\n",
  })
  const mainline = commit(repo, "mainline moves on", {
    "packages/ui-mac/src/mainline.ts": "export const mainline = 1\n",
    "docs/mainline-note.md": "# mainline\n",
  })
  git(repo, ["checkout", "-q", "-b", "docs-branch", seed])
  const docsOnly = commit(repo, "docs only", { "docs/branch-note.md": "# branch\n" })
  return { repo, seed, mainline, docsOnly }
}

type Classification = { code: string; md: string; stdout: string }

/** 跑**生产脚本本体**,把它写进 `$GITHUB_OUTPUT` 的实际值读回来。 */
function classify(repo: string, env: Record<string, string>): Classification {
  const outputFile = join(mkdtempSync(join(tmpdir(), "alpha-detect-out-")), "github-output")
  writeFileSync(outputFile, "")
  const result = Bun.spawnSync(["bash", SCRIPT], {
    cwd: repo,
    env: { ...GIT_ENV, GITHUB_OUTPUT: outputFile, ...env },
  })
  const stdout = result.stdout.toString()
  if (result.exitCode !== 0) {
    throw new Error(`detect-changed-scope.sh 退出码 ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${result.stderr.toString()}`)
  }
  const written = readFileSync(outputFile, "utf8")
  const read = (key: string) => {
    const line = written.split("\n").find((l) => l.startsWith(`${key}=`))
    // 没量到就抛。返回 undefined/"" 会让下面每条断言空对空地通过 —— 那是假绿,不是结果。
    if (line === undefined) throw new Error(`$GITHUB_OUTPUT 里没有 ${key}= —— 本次测量作废\n实际写入:\n${written}`)
    return line.slice(key.length + 1)
  }
  return { code: read("code"), md: read("md"), stdout }
}

const pullRequest = (base: string, head: string) => ({
  EVENT_NAME: "pull_request",
  PR_BASE_SHA: base,
  PR_HEAD_SHA: head,
})

const push = (before: string, head: string) => ({
  EVENT_NAME: "push",
  PUSH_BEFORE: before,
  PUSH_HEAD: head,
})

describe("#717 detect 的 diff 基准", () => {
  test("pull_request:落后于 base 的纯文档分支判 code=false(三点/merge-base 口径)", () => {
    const fixture = staleDocsBranchFixture()
    const classification = classify(fixture.repo, pullRequest(fixture.mainline, fixture.docsOnly))
    // 两点口径下 mainline.ts 会混进来 ⇒ code=true ⇒ 纯文档 PR 跑全量、继承主线红、只能 --admin。
    expect(classification.code, `分类结果被 base 漂移污染了。脚本 stdout:\n${classification.stdout}`).toBe("false")
  })

  test("pull_request:分支自己改了 ui-mac 代码时判 code=true(防过度修正成恒 false)", () => {
    const fixture = staleDocsBranchFixture()
    const withCode = commit(fixture.repo, "branch touches code", {
      "packages/ui-mac/src/branch-feature.ts": "export const feature = 1\n",
    })
    const classification = classify(fixture.repo, pullRequest(fixture.mainline, withCode))
    // 单断言 code=false 会被「永远返回 false」满足。这一条是那个错误实现的反例。
    expect(classification.code, `分支自己改了代码却没触发全量 CI:\n${classification.stdout}`).toBe("true")
  })

  test("pull_request:md 只含本分支自己改的 Markdown,不含 base 侧的", () => {
    const fixture = staleDocsBranchFixture()
    const classification = classify(fixture.repo, pullRequest(fixture.mainline, fixture.docsOnly))
    // 两点口径会把 base 侧的 docs/mainline-note.md 一起喂给 docs gate —— 那道门于是去检查
    // 一个本 PR 根本没碰的文件。分类被污染时,受害的不只是 code 这一个布尔值。
    expect(classification.md, `docs gate 的入参被 base 侧的 Markdown 污染了:\n${classification.stdout}`).toBe(
      "docs/branch-note.md",
    )
  })

  test("push:仍是 before..sha 两点口径(不许顺手改成 merge-base)", () => {
    const fixture = staleDocsBranchFixture()
    const classification = classify(fixture.repo, push(fixture.mainline, fixture.docsOnly))
    // push 的 before/sha 语义是「这次 push 推进了什么」,两点本来就是对的。这里刻意用
    // 一对**有分叉**的 SHA:两点 ⇒ 看得见 mainline.ts ⇒ true;若有人把 push 也改成
    // merge-base,这里会变成 false ——「只改 PR 那一支」是这条断言钉住的东西。
    expect(classification.code, `push 支路的 diff 口径被改动了:\n${classification.stdout}`).toBe("true")
  })

  test("没有共同祖先时 fail-closed:回落空树 ⇒ code=true", () => {
    const fixture = staleDocsBranchFixture()
    git(fixture.repo, ["checkout", "-q", "--orphan", "unrelated"])
    const orphan = commit(fixture.repo, "unrelated root", { "docs/orphan.md": "# orphan\n" })
    const classification = classify(fixture.repo, pullRequest(fixture.mainline, orphan))
    // 取不到分叉点时宁可跑全量。反向(算成 docs-only)= 在一个我们看不懂的形状上把所有闸门关掉。
    expect(classification.code, `无共同祖先时没有 fail-closed:\n${classification.stdout}`).toBe("true")
  })

  test("GITHUB_OUTPUT 缺失时当场失败,而不是静默把闸门全关掉", () => {
    const fixture = staleDocsBranchFixture()
    const result = Bun.spawnSync(["bash", SCRIPT], {
      cwd: fixture.repo,
      env: { ...GIT_ENV, ...pullRequest(fixture.mainline, fixture.docsOnly) },
    })
    // 输出写不出去 ⇒ 下游读到空串 ⇒ `code == 'true'` 恒假 ⇒ 每一道闸都被跳过而 job 报绿。
    // 这是本仓最贵的形态(假绿),所以脚本必须炸。
    expect(result.exitCode, "GITHUB_OUTPUT 未设置时脚本竟然成功了 —— 那次运行会把全部闸门静默关掉").not.toBe(0)
  })
})
