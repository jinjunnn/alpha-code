// `#995` —— `scripts/sync-upstream-alert.ts` 与 `.github/workflows/sync-upstream-alert.yml` 的**行为闸**。
//
// 这道门守的是什么(大白话):每天 06:00 UTC 那条上游同步流水线失败时,**必须有一个人被叫到**。
// 此前它失败的唯一输出是一条 Actions 日志,而没有任何东西读那条日志 —— 实测(2026-09-19
// `ac#995` 勘破):最后一次成功 `2026-07-22T08:06:35Z`,此后 **59 次连续失败、零通知**,
// 9 月初上游是人手工追平的(`ac#1248`),而这条 cron 仍在每天红。
//
// 为什么判据必须是**行为**的:
//   · 通知逻辑写在 workflow 里的一段内联 `actions/github-script` 时,它一个判据都没有 ——
//     断言 YAML 里写着某段 JS 在本仓是点名过的假闸门形态(那段 JS 被换成 `return` 时照样绿)。
//     所以逻辑住在 `scripts/sync-upstream-alert.ts`,而这里起一个**真的 HTTP 服务**冒充
//     GitHub API、用 `Bun.spawn` 跑**生产的那个文件本体**,断言它真的发出了那次写入。
//   · **先证明这个手段能测出已知的坏,再用它判未知的好。** 第 1 条是正对照(没有它,一个
//     什么都不做的空壳能满足下面全部「不许发评论」类断言);接线那两条各带**三个变异臂**
//     (`if` 改成 success / 监视别的 workflow / 加一步 `bun install`),断言同一个检查器当场点名。
//   · **fail-closed 要被证明**:API 500、缺 token 时脚本必须**非零退出**。「通知没发出去」
//     安静返回 0,就是本票要消灭的那个形状换了个地方复活。
//
// 删掉本文件会失去什么:那条告警链退回零行为判据 —— 脚本被改成只打印不写、指纹去重被改成
// 永不发评论、fail-closed 被改成吞掉错误、workflow 的 `if` 被改成只在 success 时跑、
// 有人往那个持有 `issues: write` 的 job 里加一句 `bun install`(把写权限 token 放进与上游
// 代码同一个进程,`#899` 拆两半正是要消灭这个),都不会有任何东西变红 —— 那条链只在
// GitHub 上、且只在 sync 失败时才走到。它因此登记在 scripts/gate-files.tsv 里,拿精确条数。

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SCRIPT = resolve(REPO_ROOT, "scripts/sync-upstream-alert.ts")
const ALERT_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/sync-upstream-alert.yml")
const CANDIDATE_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/sync-upstream.yml")

const REPO = "jinjunnn/alpha-code"
const RUN_ID = "35435906706"
const MERGE_STEP = "Merge `dev` into `alpha` (local only, no push)"
const SMOKE_STEP = "Engine runtime smoke (S39 — boot/probe/kill/reboot)"

// ── 冒充 GitHub 的桩 ────────────────────────────────────────────────────────────

type Recorded = { method: string; path: string; body: any }
type StubOpts = {
  /** 本次 run 的结论 */
  conclusion?: string
  /** 本次 run 的失败步 */
  failingSteps?: string[]
  /** workflow run 历史(新→旧),只给 conclusion;本次 run 排第一 */
  history?: string[]
  /** `GET /issues?labels=…` 返回什么 */
  openIssues?: any[]
  /** 让某个 `METHOD /path 前缀` 返回 500 —— 用来证明 fail-closed */
  failOn?: { method: string; path: string }
}

function startStub(opts: StubOpts) {
  const recorded: Recorded[] = []
  const conclusion = opts.conclusion ?? "failure"
  const history = opts.history ?? ["failure", "failure", "failure"]
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const body = req.method === "GET" ? undefined : await req.json().catch(() => null)
      recorded.push({ method: req.method, path, body })
      if (opts.failOn && req.method === opts.failOn.method && path.startsWith(opts.failOn.path)) {
        return new Response(JSON.stringify({ message: "stub failure" }), { status: 500 })
      }
      const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } })

      if (path === `/repos/${REPO}/actions/runs/${RUN_ID}`)
        return json({ id: Number(RUN_ID), conclusion, html_url: `https://github.com/${REPO}/actions/runs/${RUN_ID}` })

      if (path === `/repos/${REPO}/actions/runs/${RUN_ID}/jobs`)
        return json({
          jobs: [
            {
              name: "candidate",
              steps: [
                { name: "Checkout", conclusion: "success" },
                ...(opts.failingSteps ?? [MERGE_STEP]).map((name) => ({ name, conclusion: "failure" })),
              ],
            },
          ],
        })

      if (path === `/repos/${REPO}/actions/workflows/sync-upstream.yml/runs`)
        return json({
          workflow_runs: history.map((c, i) => ({
            id: i === 0 ? Number(RUN_ID) : 1000 + i,
            conclusion: c,
            // 新→旧:第 i 条比第 i-1 条早一天
            created_at: new Date(Date.UTC(2026, 8, 19 - i, 6, 0, 0)).toISOString(),
          })),
        })

      if (path === `/repos/${REPO}/issues` && req.method === "GET") return json(opts.openIssues ?? [])
      if (path === `/repos/${REPO}/issues` && req.method === "POST") return json({ number: 4242 })
      if (/^\/repos\/.+\/issues\/\d+\/comments$/.test(path)) return json({ id: 999001 })
      if (/^\/repos\/.+\/issues\/\d+$/.test(path)) return json({ number: 7 })

      return new Response(JSON.stringify({ message: `stub 没有这条路由:${req.method} ${path}` }), { status: 404 })
    },
  })
  return { server, recorded, base: `http://127.0.0.1:${server.port}` }
}

type RunResult = { exitCode: number; stdout: string; stderr: string; recorded: Recorded[] }

async function runAlert(opts: StubOpts & { env?: Record<string, string | undefined> } = {}): Promise<RunResult> {
  const stub = startStub(opts)
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GITHUB_API_URL: stub.base,
      GITHUB_TOKEN: "stub-token",
      GITHUB_REPOSITORY: REPO,
      ALERT_RUN_ID: RUN_ID,
      ALERT_WORKFLOW: "sync-upstream.yml",
    }
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const proc = Bun.spawn(["bun", SCRIPT], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr, recorded: stub.recorded }
  } finally {
    stub.server.stop(true)
  }
}

const writes = (r: Recorded[]) => r.filter((x) => x.method !== "GET")
const comments = (r: Recorded[]) => r.filter((x) => x.method === "POST" && x.path.endsWith("/comments"))
const creates = (r: Recorded[]) => r.filter((x) => x.method === "POST" && x.path === `/repos/${REPO}/issues`)
const patches = (r: Recorded[]) => r.filter((x) => x.method === "PATCH")

function trackingIssue(fingerprint: string | null, extra: Record<string, unknown> = {}) {
  return {
    number: 7,
    body: fingerprint === null ? "没有指纹锚的旧正文" : `<!-- sync-upstream-alert fingerprint=${fingerprint} -->\n正文`,
    ...extra,
  }
}

// ── 生产脚本的行为 ──────────────────────────────────────────────────────────────

describe("#995 sync-upstream 失败告警的行为", () => {
  test("没有追踪 issue ⇒ 建一张,正文带连败条数/失败步/run 链接,并指派给 owner", async () => {
    const r = await runAlert({ openIssues: [], history: ["failure", "failure", "failure", "success"] })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(creates(r.recorded).length).toBe(1)
    const sent = creates(r.recorded)[0]!.body
    expect(sent.assignees).toEqual(["jinjunnn"])
    expect(sent.labels).toContain("sync-upstream-failure")
    expect(sent.title).toContain("3")
    expect(sent.body).toContain(MERGE_STEP)
    expect(sent.body).toContain(`/actions/runs/${RUN_ID}`)
    expect(sent.body).toContain(`fingerprint=${MERGE_STEP}`)
    expect(comments(r.recorded).length).toBe(0)
  })

  test("已有追踪 issue 且失败形态未变 ⇒ **不发评论**,只 PATCH 正文(维持真相,不制造噪声)", async () => {
    const r = await runAlert({ openIssues: [trackingIssue(MERGE_STEP)] })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(creates(r.recorded).length).toBe(0)
    expect(comments(r.recorded).length).toBe(0)
    expect(patches(r.recorded).length).toBe(1)
    expect(patches(r.recorded)[0]!.path).toBe(`/repos/${REPO}/issues/7`)
  })

  test("已有追踪 issue 但失败形态变了 ⇒ 发一条评论,且两个形态都写进去(人要再被叫一次)", async () => {
    const r = await runAlert({ openIssues: [trackingIssue(SMOKE_STEP)], failingSteps: [MERGE_STEP] })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(comments(r.recorded).length).toBe(1)
    const sent = comments(r.recorded)[0]!.body.body as string
    expect(sent).toContain(SMOKE_STEP)
    expect(sent).toContain(MERGE_STEP)
    expect(patches(r.recorded).length).toBe(1)
  })

  test("连败长度在第一个非 failure 处**停住** —— 杀掉「数窗口里有几条 failure」的实现", async () => {
    const r = await runAlert({
      openIssues: [],
      history: ["failure", "failure", "success", "failure", "failure", "failure", "failure"],
    })
    expect(r.exitCode, r.stderr).toBe(0)
    const sent = creates(r.recorded)[0]!.body
    // 窗口里共 6 条 failure,但结束于本次的连败只有 2 条。
    expect(sent.title).toContain("2")
    expect(sent.body).toContain("| 连续失败 | **2** 次 |")
  })

  test("run 的结论不是 failure ⇒ 退出 0 且**一个写入都不发**(这道通知自己不许变成噪声源)", async () => {
    const r = await runAlert({ conclusion: "success", openIssues: [] })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(writes(r.recorded).length).toBe(0)
  })

  test("带 label 的是 PR 而不是 issue ⇒ 忽略它并新建(/issues 端点会把 PR 也返回回来)", async () => {
    const r = await runAlert({ openIssues: [{ number: 555, body: "", pull_request: { url: "x" } }] })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(creates(r.recorded).length).toBe(1)
    expect(comments(r.recorded).length).toBe(0)
  })

  test("带 label 但正文没有 marker(人手写的票)⇒ **一个字都不许改它**,另开一张", async () => {
    // 身份锚必须是正文里的 marker,不是 label:label 是给人筛选用的,人随时会把它贴到一张
    // 手写的票上。只认 label 的实现会把 owner 写的正文整段 PATCH 掉 —— 静默、不可逆、
    // 而且长得像「通知正常工作」。这一条就是钉住那个方向。
    const r = await runAlert({ openIssues: [trackingIssue(null)] })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(patches(r.recorded).length).toBe(0)
    expect(comments(r.recorded).length).toBe(0)
    expect(creates(r.recorded).length).toBe(1)
  })

  test("fail-closed:写 issue 的那次调用 500 ⇒ **非零退出**,并打 `::error::`", async () => {
    const r = await runAlert({ openIssues: [], failOn: { method: "POST", path: `/repos/${REPO}/issues` } })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain("::error::")
    expect(r.stderr).toContain("500")
  })

  test("fail-closed:缺 GITHUB_TOKEN ⇒ 非零退出,且**一次 HTTP 都不发**", async () => {
    const r = await runAlert({ openIssues: [], env: { GITHUB_TOKEN: undefined } })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain("GITHUB_TOKEN")
    expect(r.recorded.length).toBe(0)
  })
})

// ── 接线(它跑不跑、以什么身份跑)────────────────────────────────────────────────

type Doc = any
const parse = (p: string): Doc => Bun.YAML.parse(readFileSync(p, "utf8"))

/**
 * 告警 workflow 的接线问题清单。写成**函数**而不是一串 `expect`,是为了能拿变异臂证明
 * 它测得出已知的坏 —— 否则这几条与「grep 到某段文本」是同一种假闸门。
 */
function wiringProblems(doc: Doc): string[] {
  const problems: string[] = []
  const trigger = doc?.on?.workflow_run
  if (!trigger) problems.push("没有 on.workflow_run 触发器")
  else {
    if (!(trigger.workflows ?? []).includes("sync-upstream")) problems.push("没有监视 sync-upstream")
    if (!(trigger.types ?? []).includes("completed")) problems.push("没有监听 completed")
  }
  const job = doc?.jobs?.alert
  if (!job) problems.push("没有 jobs.alert")
  else {
    if (!String(job.if ?? "").includes("conclusion == 'failure'")) problems.push("job 的 if 没有钉住 failure")
    const steps: any[] = job.steps ?? []
    if (!steps.some((s) => typeof s?.run === "string" && s.run.includes("scripts/sync-upstream-alert.ts")))
      problems.push("没有一步跑生产脚本")
    if (steps.some((s) => typeof s?.run === "string" && /(^|\n)\s*bun install\b/.test(s.run)))
      problems.push("持有 issues:write 的 job 里出现了 bun install")
  }
  if (doc?.permissions?.issues !== "write") problems.push("没有 issues: write")
  if (doc?.permissions?.contents !== "read") problems.push("contents 不是 read")
  return problems
}

describe("#995 告警链的接线", () => {
  test("生产 workflow 接线无问题,且三个变异臂各被点名(先证明这个检查器测得出已知的坏)", () => {
    const doc = parse(ALERT_WORKFLOW)
    expect(wiringProblems(doc)).toEqual([])

    const mutate = (fn: (d: Doc) => void) => {
      const copy = JSON.parse(JSON.stringify(doc))
      fn(copy)
      expect(JSON.stringify(copy), "变异一个字节都没改到 —— 本次测量作废,不是通过").not.toBe(JSON.stringify(doc))
      return wiringProblems(copy)
    }
    expect(mutate((d) => (d.jobs.alert.if = "${{ github.event.workflow_run.conclusion == 'success' }}"))).toContain(
      "job 的 if 没有钉住 failure",
    )
    expect(mutate((d) => (d.on.workflow_run.workflows = ["alpha-ci"]))).toContain("没有监视 sync-upstream")
    expect(mutate((d) => d.jobs.alert.steps.push({ name: "x", run: "bun install" }))).toContain(
      "持有 issues:write 的 job 里出现了 bun install",
    )
  })

  test("候选 workflow 的 `#899` 不变量没被这张票动过:contents:read、无 issues 权限、无 SYNC_TOKEN", () => {
    const doc = parse(CANDIDATE_WORKFLOW)
    expect(doc?.permissions?.contents).toBe("read")
    expect(doc?.permissions?.issues).toBeUndefined()
    // 判**解析后的文档**,不判源码文本:这个文件的抬头逐字写着「no `secrets.SYNC_TOKEN`
    // reference anywhere in this file」,裸 `grep` 会被自己那句注释命中 —— 观测手段自己瞎了
    // 的标准形态(第一版写的就是那样,当场假红)。`Bun.YAML.parse` 丢掉注释,留下的才是接线。
    const wired = (d: Doc) => JSON.stringify(d).includes("secrets.SYNC_TOKEN")
    expect(wired(doc)).toBe(false)
    // 先证明这个手段测得出已知的坏:往同一份文档里塞一次真引用,它必须命中。
    const mutated = JSON.parse(JSON.stringify(doc))
    mutated.jobs.candidate.steps[0].env = { SYNC_TOKEN: "${{ secrets.SYNC_TOKEN }}" }
    expect(wired(mutated)).toBe(true)
  })
})
