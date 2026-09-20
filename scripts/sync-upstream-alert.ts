/**
 * `#995` —— 每日 `sync-upstream` 失败时**通知一个人**。
 *
 * 这个脚本守的是什么(大白话):`.github/workflows/sync-upstream.yml` 每天 06:00 UTC 起一次
 * run。它失败时唯一的输出是一条 Actions 日志 —— 而**没有任何东西会去读那条日志**。实测
 * (2026-09-19,`ac#995` 勘破):最后一次成功是 `2026-07-22T08:06:35Z`,此后
 * **59 次连续失败,零通知**;9 月初上游是人手工追平的(`ac#1248`),而这条 cron 仍在每天红。
 * 一个天天失败、没人看的自动任务等于没有。
 *
 * ── 为什么它是一个**文件**,而不是 workflow 里的一段内联 `actions/github-script` ─────────
 * 与 `#889`(north-star 守卫)、`#717`(detect 分类步)是同一个理由:内联时它一个判据都没有。
 * 断言 YAML 里写着某段 JS 在本仓是点名过的**假闸门**形态 —— 那段 JS 被换成 `return` 时它照样绿。
 * 抽成文件的唯一目的,是让 `packages/ui-mac/src/main/sync-upstream-alert.test.ts` 能起一个
 * **真的 HTTP 服务**冒充 GitHub API、跑**生产的这一份**,断言它真的发出了那次写入。
 *
 * ── 信任边界(`#899` 的同一条纪律)─────────────────────────────────────────────────
 * 调用它的 workflow 持有 `issues: write`,所以那个 job **不执行合并树里的任何代码**:
 * 它 checkout 的是 `alpha`(我们自己的树)、不跑 `bun install`、只跑这个零依赖的文件。
 * 本文件因此**只用 `fetch`**,不 import 任何第三方包 —— 依赖一旦出现,那条信任论证就断了。
 *
 * ── fail-closed ────────────────────────────────────────────────────────────────────
 * 任何一次 API 调用非 2xx、缺 token、缺 run id ⇒ **非零退出**。「通知没发出去」必须让
 * alert run 自己变红,不许安静地返回 0 —— 那正是本票要消灭的形状(失败了而没人知道)。
 *
 * ── 噪声:一次失败一条通知,一段连败一条 issue ───────────────────────────────────────
 * 连续 59 天各开一张 issue 或各发一条评论,与没有通知是同一个结局(人会把它静音)。规则:
 *   · 没有带 ALERT_LABEL 的 open issue ⇒ **建一张**(GitHub 给 assignee 发通知);
 *   · 已有 ⇒ 只在**失败形态变了**(失败步名变化)时再发一条评论;
 *   · 无论哪种,都把正文刷新成本次的事实(连败条数 / 最近一次 run / 上次成功是什么时候)。
 *     PATCH 正文**不产生通知**,这是有意的:它维持真相,不制造噪声。
 *
 * 用法(env,全部必填除非标了默认值):
 *   GITHUB_TOKEN        有 issues:write 的 token
 *   GITHUB_REPOSITORY   owner/repo
 *   ALERT_RUN_ID        触发本次告警的那个 run 的 id
 *   ALERT_WORKFLOW      被监视的 workflow 文件名(默认 sync-upstream.yml)
 *   ALERT_LABEL         追踪标签(默认 sync-upstream-failure)
 *   GITHUB_API_URL      API 根(默认 https://api.github.com;测试用它指向本地桩)
 *   GITHUB_SERVER_URL   站点根(默认 https://github.com,仅用于拼链接)
 */

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "")
const SERVER = (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "")
const LABEL = process.env.ALERT_LABEL || "sync-upstream-failure"
const WORKFLOW_FILE = process.env.ALERT_WORKFLOW || "sync-upstream.yml"
/** 正文里的隐藏指纹锚 —— 下一次运行据此判断「失败形态变了没有」。 */
const MARKER_RE = /<!--\s*sync-upstream-alert\s+fingerprint=(.*?)\s*-->/

class AlertError extends Error {}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new AlertError(`缺少必填环境变量 ${name} —— 通知发不出去,本次告警作废(不是「没有失败」)。`)
  return v
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "alpha-code-sync-upstream-alert",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new AlertError(`${method} ${path} → HTTP ${res.status}:${text.slice(0, 400)}`)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new AlertError(`${method} ${path} 返回的不是 JSON(前 200 字节:${text.slice(0, 200)})—— 本次告警作废。`)
  }
}

/** 本次 run 里失败的**步骤名**。它就是下面的指纹 —— 失败形态换了,人需要再被叫一次。 */
async function failingSteps(token: string, repo: string, runId: string): Promise<string[]> {
  const jobs = await api(token, "GET", `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`)
  const out: string[] = []
  for (const job of jobs?.jobs ?? []) {
    for (const step of job?.steps ?? []) {
      if (step?.conclusion === "failure" && typeof step?.name === "string") out.push(step.name)
    }
  }
  return out
}

type Streak = { failures: number; since: string | null; lastSuccess: string | null }

/**
 * 从这条 workflow 最近的 run 里数出**结束于本次的连败**。这个数字是本票存在的理由:
 * 一句「今天失败了」和一句「这是连续第 59 天」触发的是完全不同的处置。
 */
async function streak(token: string, repo: string, runId: string): Promise<Streak> {
  const runs = await api(
    token,
    "GET",
    `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=100&status=completed`,
  )
  const list: any[] = runs?.workflow_runs ?? []
  // API 已按新→旧排序;不依赖它,自己按 created_at 排一次。
  list.sort((a, b) => Date.parse(b?.created_at ?? 0) - Date.parse(a?.created_at ?? 0))
  const startAt = list.findIndex((r) => String(r?.id) === String(runId))
  const from = startAt < 0 ? 0 : startAt
  let failures = 0
  let since: string | null = null
  for (let i = from; i < list.length; i++) {
    if (list[i]?.conclusion !== "failure") break
    failures++
    since = list[i]?.created_at ?? since
  }
  const lastSuccess = list.find((r) => r?.conclusion === "success")?.created_at ?? null
  return { failures, since, lastSuccess }
}

function issueBody(args: {
  repo: string
  runUrl: string
  runId: string
  steps: string[]
  streak: Streak
  fingerprint: string
}): string {
  const { repo, runUrl, runId, steps, streak: s, fingerprint } = args
  const stepLine = steps.length ? steps.map((n) => `\`${n}\``).join("、") : "(本次 run 没有报出失败步 —— 见日志)"
  return [
    `<!-- sync-upstream-alert fingerprint=${fingerprint} -->`,
    "",
    "**谁会遇到**:负责把上游开源引擎的更新并进我们产品的人,间接是 owner。" +
      "**遇到什么**:每天自动跑的「同步上游」任务正在失败,上游的更新没有进来。" +
      "**为什么是问题**:它一天不修,我们就一天拿不到上游的修复;而且它失败的时候**不会自己停**," +
      "只会每天再失败一次。**不做会怎样**:上游更新只能靠人想起来手工并一次。",
    "",
    "---",
    "",
    `| | |`,
    `|---|---|`,
    `| 连续失败 | **${s.failures}** 次 |`,
    `| 起自 | ${s.since ?? "(窗口内数不到起点,连败长度超过一页 run 历史)"} |`,
    `| 最后一次成功 | ${s.lastSuccess ?? "(最近 100 次 run 里没有成功)"} |`,
    `| 失败步 | ${stepLine} |`,
    `| 最近一次 run | [${runId}](${runUrl}) |`,
    "",
    `失败原文:\`gh run view ${runId} -R ${repo} --log-failed\`。`,
    "",
    "**这张 issue 由 `.github/workflows/sync-upstream-alert.yml` 维护**:正文每次失败后刷新," +
      "只有**失败形态变化**时才再发一条评论。关掉它而 sync 仍在失败 ⇒ 下一次失败会重新开一张。",
  ].join("\n")
}

async function main(): Promise<number> {
  const token = required("GITHUB_TOKEN")
  const repo = required("GITHUB_REPOSITORY")
  const runId = required("ALERT_RUN_ID")

  const run = await api(token, "GET", `/repos/${repo}/actions/runs/${runId}`)
  const conclusion = run?.conclusion
  if (conclusion !== "failure") {
    // 防御性:workflow 的 `if:` 已经筛过一次。这里再筛一次,是为了让「拿一个绿的 run 跑本脚本」
    // 结构性地写不出 issue —— 否则这道通知本身会变成噪声源。
    console.log(`run ${runId} 的结论是 ${conclusion ?? "(空)"},不是 failure —— 不告警。`)
    return 0
  }
  const runUrl = run?.html_url ?? `${SERVER}/${repo}/actions/runs/${runId}`

  const steps = await failingSteps(token, repo, runId)
  const s = await streak(token, repo, runId)
  const fingerprint = steps.length ? steps.join(" | ") : "(no-failing-step)"
  const body = issueBody({ repo, runUrl, runId, steps, streak: s, fingerprint })

  const open: any[] = await api(
    token,
    "GET",
    `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100`,
  )
  // 身份锚是**正文里的 marker**,不是 label。label 是给人筛选用的,人随时会把它贴到一张
  // 手写的票上 —— 只认 label 就意味着下面那次 PATCH 会把**别人写的正文整段覆盖掉**。
  // 只碰自己盖过章的那张;没盖章的一律当作「不是我的」,另开一张。
  const tracking = (open ?? []).find((i) => i && !i.pull_request && MARKER_RE.test(String(i.body ?? "")))

  if (!tracking) {
    const created = await api(token, "POST", `/repos/${repo}/issues`, {
      title: `sync-upstream 连续失败 ${s.failures} 次 —— 上游同步已停摆`,
      body,
      labels: [LABEL, "type:bug"],
      assignees: [repo.split("/")[0]],
    })
    console.log(`created issue #${created?.number}(连败 ${s.failures},失败步:${fingerprint})`)
    return 0
  }

  const prev = MARKER_RE.exec(String(tracking.body ?? ""))?.[1] ?? null
  if (prev !== fingerprint) {
    const comment = await api(token, "POST", `/repos/${repo}/issues/${tracking.number}/comments`, {
      body:
        `sync-upstream 的**失败形态变了**(上一次记录:${prev ?? "(无)"} → 现在:${fingerprint})。\n\n` +
        `连败 ${s.failures} 次,最近一次 run:${runUrl}`,
    })
    console.log(`commented on #${tracking.number}(id ${comment?.id};指纹 ${prev ?? "(无)"} → ${fingerprint})`)
  } else {
    console.log(`#${tracking.number} 已在追踪同一形态(${fingerprint}),不再发评论 —— 只刷新正文。`)
  }
  await api(token, "PATCH", `/repos/${repo}/issues/${tracking.number}`, { body })
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`::error::sync-upstream 告警没发出去:${msg}`)
    process.exit(1)
  })
