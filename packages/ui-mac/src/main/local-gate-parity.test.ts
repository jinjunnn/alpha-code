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
//
// 删掉本文件会失去什么:上面五条全部退回「靠人记得」。CI 改一个 job/步骤名、加一步、
// 或者有人把 alpha-check 的某一步删掉,都不再有任何东西变红。

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const WORKFLOW = readFileSync(resolve(REPO_ROOT, ".github/workflows/alpha-ci.yml"), "utf8")
const SCRIPT = readFileSync(resolve(REPO_ROOT, "scripts/alpha-check.sh"), "utf8")
const REQUIRED_CONTEXTS_FILE = readFileSync(resolve(REPO_ROOT, ".github/required-contexts.txt"), "utf8")

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
  "detect changes":
    "分类步。它的产物(code/md)决定别的 job 跑不跑,但它自己不判任何东西 —— 它红了下游全部 job 会因 needs 失败而拿不到结论,合并照样进不去。行为闸在 packages/ui-mac/src/main/ci-diff-scope.test.ts。",
  "seed assets present":
    "B7 打包资源在位闸。合并前它的缺失不改变仓库正确性(打包期才吃到),历史上一直不在 required 里;要提必需是独立裁决,不在 `#717` 范围内。",
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
})
