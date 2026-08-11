// `#777` —— 「本地门与 alpha-ci 1:1」的**可检查断言**。
//
// 为什么存在:`CLAUDE.md` 的铁律是「合并门在本地验证,本地绿 ⇒ 直接合」。这条铁律的全部
// 依据,是 `scripts/alpha-check.sh` 抬头那句「This mirrors alpha-ci's jobs 1:1」。
// 2026-08-03 实读:那句话是**散文**,而实际本地只跑了 CI 十二个代码步里的九个,其中三个
// 还是降级档(裸 `bun test`,跑 0 条照样 exit 0)。缺的三步里有 `assert-gate-files.sh` ——
// 77 个登记闸门中 llm / core / opencode 那几个**只在那一步执行**。
//
// 一句没人核对的「1:1」比没有这句话更坏:它让「本地绿」被当成「CI 会绿」的证据。
// 所以这里把它变成断言:
//   ①  alpha-ci 的每一个代码步,都必须登记在 alpha-check.sh 的 CI_STEPS 对照表里(反之亦然);
//   ②  登记的档位只能是 MIRRORED / SUPERSET:<理由> / DEGRADED:<理由> —— 没有「静默不跑」这一档;
//   ③  两处的 UPSTREAM_PATHS 与 ADR-033 收编白名单必须逐条相同(`#637` 退出条件 3:
//       ADR-033 落地时只同步了 paths、白名单漏了,于是本地 north-star 在干净 alpha 上恒假红,
//       人人 `--no-verify`。修好了但没有防漂断言 = 下一次收编重演);
//   ④  `assert gate files` 这一步不得因为前一步红而被跳过(GitHub step 默认条件是 success())。
//   ⑤  (`#717`)`alpha` 分支保护要求的每个 context,都必须等于 alpha-ci 某个 job 的 `name:`;
//       反过来每个 job 要么在那份记录里、要么在本文件里显式写明「不必需」。
//   ⑥  (`#895`)每个必需 job 都必须在 `detect` 没给出结论时**照跑并变红**,而不是被 `needs`
//       折成 skipped —— GitHub 把 skipped 记成「已满足」(实测,见下)。
//
// 删掉本文件会失去什么:上面六条全部退回「靠人记得」。CI 改一个 job/步骤名、加一步、
// 或者有人把 alpha-check 的某一步删掉,都不再有任何东西变红。

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const WORKFLOW = readFileSync(resolve(REPO_ROOT, ".github/workflows/alpha-ci.yml"), "utf8")
const SCRIPT = readFileSync(resolve(REPO_ROOT, "scripts/alpha-check.sh"), "utf8")
const REQUIRED_CONTEXTS_FILE = readFileSync(resolve(REPO_ROOT, ".github/required-contexts.txt"), "utf8")
/** `#895` 的判据本体 —— 四个必需 job 的第一步跑的就是这个文件。 */
const DETECT_CLASSIFIED_SCRIPT = "scripts/assert-detect-classified.sh"

/**
 * alpha-ci.yml 里「有名字、且真的执行一条命令」的步骤。
 * 刻意不引 YAML 库:本仓无 yaml 依赖,而这份文件的缩进是自己写的、稳定的。
 */
type CiStep = { job: string; name: string; condition: string }

function parseWorkflowSteps(yaml: string): CiStep[] {
  const out: CiStep[] = []
  let job = ""
  let cur: { name?: string; run?: boolean; condition?: string } | null = null
  const flush = () => {
    if (cur?.name && cur.run) out.push({ job, name: cur.name, condition: cur.condition ?? "" })
    cur = null
  }
  for (const line of yaml.split("\n")) {
    const jobHeader = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line)
    if (jobHeader) {
      flush()
      job = jobHeader[1]
      continue
    }
    const stepStart = /^ {6}- (.*)$/.exec(line)
    if (stepStart) {
      flush()
      cur = {}
      line2prop(stepStart[1], cur)
      continue
    }
    const prop = /^ {8}(\S.*)$/.exec(line)
    if (prop && cur) line2prop(prop[1], cur)
  }
  flush()
  return out
}

function line2prop(text: string, cur: { name?: string; run?: boolean; condition?: string }) {
  const m = /^([a-z]+):\s*(.*)$/.exec(text)
  if (!m) return
  if (m[1] === "name") cur.name = m[2].trim()
  else if (m[1] === "run") cur.run = true
  else if (m[1] === "if") cur.condition = m[2].trim()
}

/**
 * 不是门的步骤:它们把环境准备好,不判任何东西。**显式登记**,新加一个就必须在这里表态 ——
 * 否则默认被当成门,少一条对照即红(咽喉对新成员默认拒绝)。
 */
const NON_GATE_STEPS = new Set(["detect|Classify diff (code vs docs-only)", "upstream-guard|Ensure origin/dev is available"])

/**
 * alpha-ci.yml 里每个 job 的 `name:` —— 也就是 GitHub 上那一格 check 的**显示名**,
 * 分支保护的 required context 用的就是这个字符串。job `name:` 恒在 4 空格缩进,
 * step 的 `- name:` 在 6 空格,两者不会混。
 */
function parseWorkflowJobNames(yaml: string): string[] {
  return [...yaml.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1].trim())
}

/**
 * job 级属性 —— `parseWorkflowSteps` 只认 6 空格的 step 与 8 空格的属性,对 **4 空格的 job 级
 * `if:`** 结构性失明。`#895` 要判的恰恰是 job 级条件,所以这里单独解析一层。
 * 只从 `jobs:` 之后开始扫:`on:` 那一段里的 `  push:` / `  pull_request:` 与 job key 同缩进。
 */
type CiJob = { key: string; name: string; condition: string; body: string }

function parseWorkflowJobs(yaml: string): CiJob[] {
  const jobsAt = yaml.indexOf("\njobs:\n")
  if (jobsAt < 0) throw new Error("alpha-ci.yml 里找不到 `jobs:`")
  const lines = yaml.slice(jobsAt + "\njobs:\n".length).split("\n")
  const out: CiJob[] = []
  let key = ""
  let buf: string[] = []
  const flush = () => {
    if (!key) return
    const body = buf.join("\n")
    out.push({
      key,
      name: /^ {4}name: (.+)$/m.exec(body)?.[1].trim() ?? "",
      condition: /^ {4}if: (.+)$/m.exec(body)?.[1].trim() ?? "",
      body,
    })
  }
  for (const line of lines) {
    const header = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line)
    if (header) {
      flush()
      key = header[1]
      buf = []
      continue
    }
    if (key) buf.push(line)
  }
  flush()
  return out
}

/** `.github/required-contexts.txt`:分支保护要求的 context 的仓内手抄快照。 */
function parseRequiredContexts(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

/**
 * **不**必需的 job —— 每个都必须在这里显式表态,理由写清楚。
 * 默认拒:新加一个 job 而不表态,下面那条断言当场红(咽喉对新成员默认拒绝)。
 */
const NOT_REQUIRED_JOBS: Record<string, string> = {
  // `#895` 更正:这条理由原文写的是「它红了下游全部 job 会因 needs 失败而拿不到结论,合并照样
  // 进不去」——**两半都与实测相反**。2026-08-11 在 PR #908 上真跑了一次 detect 硬失败:
  // 下游拿到的结论叫 **skipped**(不是「拿不到结论」),而 GitHub 把 skipped 记成「已满足」⇒
  // 四格 required 全 skipped、mergeable=true、mergeStateStatus=**UNSTABLE**(合并进得去)。
  // 也就是说仓里曾经有一条测试在为一个假闸门背书。修法不是把 detect 提成必需(那要改仓外的
  // 分支保护,CI 够不着),而是让四个必需 job 在 detect 没结论时**照跑并各自变红** ——
  // 见下面 `#895` 那两条断言与 scripts/assert-detect-classified.sh。
  // 证据:docs/verification/2026-08-11-detect-failure-required-checks.md
  "detect changes":
    "分类步。它的产物(code/md)决定别的 job 跑不跑,但它自己不判任何东西。它红了不再等于「合并进不去」——`#895` 实测 skipped 被 GitHub 当成满足;真正拦住合并的是四个必需 job 各自的 Assert detect classified this diff 那一步(下面两条断言钉住它)。行为闸在 packages/ui-mac/src/main/ci-diff-scope.test.ts。",
  "seed assets present":
    "B7 打包资源在位闸。合并前它的缺失不改变仓库正确性(打包期才吃到),历史上一直不在 required 里;要提必需是独立裁决,不在 `#717` 范围内。`#895` 刻意不给它加 !cancelled():它不是必需 context,detect 失败时它显示 skipped 不会让任何东西被误判成通过。",
}

function parseLedger(script: string): Array<{ job: string; name: string; status: string }> {
  const block = /^CI_STEPS=\(\n([\s\S]*?)^\)$/m.exec(script)
  if (!block) throw new Error("scripts/alpha-check.sh 里找不到 CI_STEPS=( … ) 对照表")
  return block[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'))
    .map((l) => {
      const [job, name, status] = l.replace(/^"|"$/g, "").split("|")
      return { job, name, status }
    })
}

function bashArrayItems(script: string, varName: string): string[] {
  const block = new RegExp(`^${varName}=\\(\\n([\\s\\S]*?)^\\)$`, "m").exec(script)
  if (!block) throw new Error(`scripts/alpha-check.sh 里找不到 ${varName}=( … )`)
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe("#777 本地门与 alpha-ci 的对照表", () => {
  test("alpha-ci 的每个代码步都登记在 alpha-check.sh 的 CI_STEPS 里", () => {
    const ciSteps = parseWorkflowSteps(WORKFLOW).filter((s) => !NON_GATE_STEPS.has(`${s.job}|${s.name}`))
    const ledger = parseLedger(SCRIPT)
    // 先证明解析手段本身没瞎:一份跑不出步骤的解析器会让下面每条断言都空对空地绿。
    expect(ciSteps.length).toBeGreaterThanOrEqual(12)
    const missing = ciSteps.filter((s) => !ledger.some((l) => l.job === s.job && l.name === s.name))
    expect(
      missing.map((s) => `${s.job}|${s.name}`),
      "alpha-ci 有这些代码步,而 scripts/alpha-check.sh 的 CI_STEPS 没有登记 —— 「1:1」这句话当场变成假话",
    ).toEqual([])
  })

  test("CI_STEPS 里的每一行都对得上 alpha-ci 的一个真实步骤(改名即红)", () => {
    const ciSteps = parseWorkflowSteps(WORKFLOW)
    const ledger = parseLedger(SCRIPT)
    expect(ledger.length).toBeGreaterThanOrEqual(12)
    const stale = ledger.filter((l) => !ciSteps.some((s) => s.job === l.job && s.name === l.name))
    expect(stale.map((l) => `${l.job}|${l.name}`), "CI_STEPS 登记了 alpha-ci 里不存在的步骤(改名或删除后没同步)").toEqual([])
  })

  test("每一行的档位只能是 MIRRORED / SUPERSET:<理由> / DEGRADED:<理由>", () => {
    for (const { job, name, status } of parseLedger(SCRIPT)) {
      const where = `${job}|${name}`
      if (status === "MIRRORED") continue
      expect(status.startsWith("SUPERSET:") || status.startsWith("DEGRADED:"), `${where} 的档位非法:${status}`).toBe(true)
      // 降级/超集必须说清是什么。「静默不跑」不是一个合法档位 —— 那是把恒红换成假绿。
      expect(status.split(":").slice(1).join(":").trim().length, `${where} 的档位缺理由`).toBeGreaterThan(0)
    }
  })

  test("#637 退出条件 3:UPSTREAM_PATHS 与 ADR-033 收编白名单两处逐条相同", () => {
    const ciPaths = /UPSTREAM_PATHS:\s*"([^"]+)"/.exec(WORKFLOW)?.[1].split(/\s+/)
    const shPaths = /^UPSTREAM_PATHS="([^"]+)"/m.exec(SCRIPT)?.[1].split(/\s+/)
    expect(ciPaths, "alpha-ci.yml 里没解析到 env.UPSTREAM_PATHS").toBeDefined()
    expect(shPaths).toEqual(ciPaths!)

    const ciExcludes = [...WORKFLOW.matchAll(/':\(exclude\)([^']+)'/g)].map((m) => m[1])
    const shExcludes = bashArrayItems(SCRIPT, "UPSTREAM_EXCLUDES").map((s) => s.replace(":(exclude)", ""))
    // 解析手段自检:两边都必须真解析出内容,否则 `[] === []` 会给一条假绿。
    expect(ciExcludes.length).toBeGreaterThanOrEqual(20)
    expect(shExcludes, "本地 north-star 的收编白名单与 CI 漂移了 —— 干净 alpha 上会恒假红(#637)").toEqual(ciExcludes)
  })

  // ── `#717`:required context 名的防漂 ──────────────────────────────────────
  // 这个值有两个家 —— 仓外的 GitHub 分支保护设置,和仓内 alpha-ci.yml 的 job `name:` ——
  // 而两边都没声明自己是真源。2026-07-22 `ebd29cda` 把 job 改名成
  // `unit tests (alpha packages)`,分支保护那侧没跟,GitHub 从此再没见过旧名字 ⇒ 每个 PR
  // 都在那一格永久 pending,人人 --admin。改名当天没有任何东西变红。
  //
  // ⚠️ 诚实边界:真源在仓外,CI 够不着(fork PR 拿不到 secrets)。`.github/required-contexts.txt`
  //    是**手抄快照**,抓得住 workflow 侧改名(咬过我们的那一类),抓不住「只改 GitHub 设置」
  //    或「两侧一起改错」。这是减速带,不是闸门 —— 文件抬头把这条也写着。
  test("#717:分支保护记录里的每个 context 都对应 alpha-ci 的一个 job name(改名即红)", () => {
    const jobNames = parseWorkflowJobNames(WORKFLOW)
    const required = parseRequiredContexts(REQUIRED_CONTEXTS_FILE)
    // 解析自检:任一侧解析退化成空,下面的比对就会空对空地绿。
    expect(jobNames.length, "alpha-ci.yml 里一个 job name 都没解析到 —— 解析器坏了").toBeGreaterThanOrEqual(6)
    expect(required.length, ".github/required-contexts.txt 一条都没解析到 —— 记录被清空或解析器坏了").toBeGreaterThanOrEqual(4)
    const orphaned = required.filter((context) => !jobNames.includes(context))
    expect(
      orphaned,
      "分支保护要求的 context 在 alpha-ci 里没有同名 job —— GitHub 永远等不到它,每个 PR 都在那一格永久 pending(`ebd29cda` 那一类)",
    ).toEqual([])
  })

  test("#717:alpha-ci 的每个 job 要么是必需 context,要么显式登记为不必需(默认拒)", () => {
    const jobNames = parseWorkflowJobNames(WORKFLOW)
    const required = parseRequiredContexts(REQUIRED_CONTEXTS_FILE)
    expect(jobNames.length).toBeGreaterThanOrEqual(6)
    const unclassified = jobNames.filter((name) => !required.includes(name) && !(name in NOT_REQUIRED_JOBS))
    expect(
      unclassified,
      "新 job 既不在 .github/required-contexts.txt 里,也没在 NOT_REQUIRED_JOBS 里写明为什么不必需 —— 一道没人表态的门等于没有门",
    ).toEqual([])
    // 反向:登记为「不必需」的 job 必须真的存在,且必须真的不在必需列表里(自相矛盾即红)。
    for (const [name, reason] of Object.entries(NOT_REQUIRED_JOBS)) {
      expect(jobNames, `NOT_REQUIRED_JOBS 登记了 alpha-ci 里不存在的 job:${name}`).toContain(name)
      expect(required, `${name} 同时被登记为「不必需」和分支保护必需 —— 两处矛盾`).not.toContain(name)
      expect(reason.trim().length, `${name} 的「不必需」理由为空`).toBeGreaterThan(0)
    }
  })

  test("`assert gate files` 不因前一步失败而被跳过", () => {
    const step = parseWorkflowSteps(WORKFLOW).find((s) => s.name.startsWith("assert gate files"))
    expect(step, "alpha-ci.yml 里找不到 `assert gate files` 步骤").toBeDefined()
    // GitHub 的 step 默认条件是 success():前一步红 ⇒ 这一步 skipped ⇒ 77 个登记闸门集体消失。
    expect(step!.condition, "assert gate files 缺 !cancelled() —— 前一步一红,77 个闸门就一起没了").toContain("!cancelled()")
  })

  // ── `#895`:detect 没结论时,四道必需检查不得被折成「skipped = 通过」───────────────
  // 实测(PR #908,2026-08-11,不是读官方文档):让 detect 硬失败 ⇒
  //   detect changes = failure;north-star / typecheck / unit tests / docs gate = **全 skipped**;
  //   PR mergeable=true、mergeStateStatus=**UNSTABLE** —— 分支保护那侧没拦。
  //   同一个 commit,四格还没上报时是 BLOCKED,变成 skipped 之后转 UNSTABLE ⇒ GitHub 把
  //   **skipped 记成「已满足」**。全文:docs/verification/2026-08-11-detect-failure-required-checks.md
  test("`#895`:scripts/assert-detect-classified.sh 在 detect 没给出可用分类时必须非零退出", () => {
    const script = resolve(REPO_ROOT, DETECT_CLASSIFIED_SCRIPT)
    const run = (env: Record<string, string>) =>
      Bun.spawnSync(["bash", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } })
    // 先证明这个手段能测出「好」——一个恒非零的脚本会让下面每条负向断言空对空地绿。
    for (const code of ["true", "false"]) {
      const ok = run({ DETECT_RESULT: "success", DETECT_CODE: code })
      expect(ok.exitCode, `detect 成功且 code=${code} 时不该拦(stderr: ${ok.stderr.toString()})`).toBe(0)
    }
    // 负向:每一种「拿不到可用分类」的真实形状都必须红。
    // 注意 failure + code=true 这一条:job 失败时 outputs 是否仍然可读由 GitHub 决定,
    // 不由我们决定 —— 所以判据钉在 result 上,而不是「反正 code 会是空的」。
    const bad: Array<[string, Record<string, string>]> = [
      ["detect 失败(outputs 仍可读)", { DETECT_RESULT: "failure", DETECT_CODE: "true" }],
      ["detect 失败(outputs 为空)", { DETECT_RESULT: "failure", DETECT_CODE: "" }],
      ["detect 被跳过", { DETECT_RESULT: "skipped", DETECT_CODE: "" }],
      ["detect 被取消", { DETECT_RESULT: "cancelled", DETECT_CODE: "" }],
      ["detect 退出 0 却没写 code", { DETECT_RESULT: "success", DETECT_CODE: "" }],
      ["code 是别的字符串", { DETECT_RESULT: "success", DETECT_CODE: "maybe" }],
      ["result 本身没传进来", { DETECT_CODE: "true" }],
    ]
    for (const [label, env] of bad) {
      const r = run(env)
      expect(r.exitCode, `${label}:这一步必须红,否则本 job 会零步骤报绿`).not.toBe(0)
    }
  })

  test("`#895`:每个必需 job 都带 !cancelled() 且第一步就跑 assert-detect-classified.sh", () => {
    // ⚠️ 诚实边界:这一条断言的是 YAML 文本,按本仓定义是**减速带**,不是闸门 ——
    //    「GitHub 上真的会红吗」只有一次真实 PR 量得出来(证据文档里那次)。它抓的是
    //    「有人把接线拆掉」,而上一条抓的是「判据本身被改坏」。两条缺一不可。
    const jobs = parseWorkflowJobs(WORKFLOW)
    const required = parseRequiredContexts(REQUIRED_CONTEXTS_FILE)
    // 解析自检:任一侧退化成空,下面的循环就一次都不跑,空对空地绿。
    expect(jobs.length, "alpha-ci.yml 一个 job 都没解析到 —— 解析器坏了").toBeGreaterThanOrEqual(6)
    expect(required.length, ".github/required-contexts.txt 一条都没解析到").toBeGreaterThanOrEqual(4)
    for (const context of required) {
      const job = jobs.find((j) => j.name === context)
      expect(job, `必需 context「${context}」在 alpha-ci.yml 里没有同名 job`).toBeDefined()
      expect(
        job!.condition,
        `必需 job「${context}」缺 job 级 !cancelled() —— detect 一失败它就被 needs 折成 skipped,而 GitHub 把 skipped 当成满足(#895 实测:四格全 skipped ⇒ mergeStateStatus=UNSTABLE ⇒ 可合)`,
      ).toContain("!cancelled()")
      expect(
        job!.body,
        `必需 job「${context}」没有跑 ${DETECT_CLASSIFIED_SCRIPT} —— 光有 !cancelled() 更坏:detect 失败时 needs.detect.outputs.code 是空串,挂在 == 'true' 上的步骤仍然一步不跑,这一格会从灰色 skipped 变成**绿色 success**`,
      ).toContain(DETECT_CLASSIFIED_SCRIPT)
    }
  })
})
