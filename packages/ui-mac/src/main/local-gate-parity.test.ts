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
//
// 删掉本文件会失去什么:上面四条全部退回「靠人记得」。CI 改一个 job/步骤名、加一步、
// 或者有人把 alpha-check 的某一步删掉,都不再有任何东西变红。

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const WORKFLOW = readFileSync(resolve(REPO_ROOT, ".github/workflows/alpha-ci.yml"), "utf8")
const SCRIPT = readFileSync(resolve(REPO_ROOT, "scripts/alpha-check.sh"), "utf8")

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

  test("`assert gate files` 不因前一步失败而被跳过", () => {
    const step = parseWorkflowSteps(WORKFLOW).find((s) => s.name.startsWith("assert gate files"))
    expect(step, "alpha-ci.yml 里找不到 `assert gate files` 步骤").toBeDefined()
    // GitHub 的 step 默认条件是 success():前一步红 ⇒ 这一步 skipped ⇒ 77 个登记闸门集体消失。
    expect(step!.condition, "assert gate files 缺 !cancelled() —— 前一步一红,77 个闸门就一起没了").toContain("!cancelled()")
  })
})
