// #918 —— 桌面派发的信封能不能被平台收下。
//
// 为什么这是闸门而不是形状断言:cloud-envelope-guard.test.ts 断言的是「守卫吐出来的对象长什么样」,
// 而用户看得见的事实是「作业跑起来了没有」。alpha-platform@9cf67bd 上线了一条诚实门 ——
// 任意代码执行的作业形态强制不了路径黑名单,于是**非空 `denied_paths` 直接 400**,先于任何副作用。
// 桌面此前每次派发都缺省注入四条路径 ⇒ 每次派发都会撞上它。所以判据必须驱动真的
// `dispatchCloudJob`(守卫 → fetch → 错误归类整条链),打在一个施行同一条规则的假平台上。
//
// 下面的假平台是 alpha-platform@9cf67bd 三处规则的**复述**,逐条钉住出处:
//   · `contracts/v1/execution-policy.ts:18 DeniedPathV1Schema` —— denied path 文法
//     (upload-manifest 的 POSIX-relative 规则 + 可选 `/**` 后缀;glob 元字符一律拒)。
//   · `lib/cloud-contract.ts:57 normalizeExecutionPolicy` —— 缺失 constraints / allowed_tools /
//     denied_paths 归一成显式空数组(空 = deny-all,不是"全开")。
//   · `lib/cloud-contract.ts:78 deniedPathsEnforceable` + `lib/cloud-core.ts:172` —— 诚实门本身。
// 平台改了这三处而这里没跟,判据就该退化成假绿 —— 所以本文件末尾那条元判据先证明这个假平台
// 真的拒得动已知的坏形状(历史上那份缺省注入),再拿它判现在的好。
//
// mock.module 会污染同进程其它测试文件 ⇒ 真断言放这里,由 cloud-dispatch-gate.test.ts
// 在隔离子进程里跑(alpha-cloud-jobs.cases.ts / cloud-ipc.test.ts 同款)。

import { expect, mock, test } from "bun:test"
import type { CloudJobEnvelope } from "../preload/types"

const BASE = "https://cloud.invalid"
const JOB = "job_gate_0001"

/** 桌面在 #918 之前每次派发都会补上的那四条(现已删除;元判据用它证明假平台拒得动)。 */
const HISTORICAL_INJECTED_DENIED_PATHS = [".env*", "*.pem", ".alpha/", ".git/"]

mock.module("./alpha-auth", () => ({ getAccessToken: () => "tok.cloud.dispatch" }))
mock.module("./alpha-endpoints", () => ({ resolveEndpoints: () => ({ cloud: BASE }) }))
mock.module("./logging", () => ({ getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }) }))
mock.module("./alpha-contract-health", () => ({ reportContractFailure: () => {} }))

// ── 假平台:alpha-platform@9cf67bd 的规则复述 ───────────────────────────────────────────
type WireConstraints = { allowed_tools?: string[]; denied_paths?: string[]; network?: string }
type WireEnvelope = { autonomy?: string; kind?: string; capabilities?: string[]; constraints?: WireConstraints }

// contracts/v1/upload-manifest.ts:13 UPLOAD_MANIFEST_PATH_PATTERN_V1。
// 逐字复述,只去掉原式里排除 NUL 的那一项 —— 它对本判据不承重,而源码里放一个字面 NUL 会让
// `grep`/`rg` 对整个文件静默返回空(ac#760),下一个人据此下的结论会是假的。
const POSIX_RELATIVE =
  /^(?!\.\.?(?:\/|(?![\s\S])))[^/\\]+(?:\/(?!\.\.?(?:\/|(?![\s\S])))[^/\\]+)*(?![\s\S])/

// contracts/v1/execution-policy.ts:18 DeniedPathV1Schema。
const deniedPathGrammarOk = (entry: string): boolean => {
  const body = entry.endsWith("/**") ? entry.slice(0, -3) : entry
  return body.length > 0 && POSIX_RELATIVE.test(body) && !/[*?[\]]/.test(body)
}

// lib/cloud-contract.ts:57 normalizeExecutionPolicy —— 缺失一律折叠成显式空数组。
const normalizeExecutionPolicy = (constraints?: WireConstraints) => ({
  allowed_tools: constraints?.allowed_tools ?? [],
  denied_paths: constraints?.denied_paths ?? [],
})

// lib/tier-router.ts:22 TIER_ROUTES —— code_exec / file_mutation ⇒ Tier-2(claude_code),其余 catch-all ⇒ Tier-1。
const TIER2_CAPABILITIES = ["code_exec", "file_mutation"]
// lib/tier1-tool-registry.ts:16 TIER1_TOOL_REGISTRY —— web 不触达文件系统;code_exec 触达;**表外名字按触达处理**。
const TIER1_TOOLS_WITHOUT_FS_REACH = ["web"]

// lib/cloud-contract.ts:78 deniedPathsEnforceable。
const deniedPathsEnforceable = (
  policy: { allowed_tools: string[] },
  envelope: WireEnvelope,
): boolean => {
  if (envelope.autonomy === "pipeline") return false
  const tier2 = (envelope.capabilities ?? []).some((capability) => TIER2_CAPABILITIES.includes(capability))
  return tier2
    ? policy.allowed_tools.length === 0
    : policy.allowed_tools.every((tool) => TIER1_TOOLS_WITHOUT_FS_REACH.includes(tool))
}

/** lib/cloud-core.ts:172 的诚实门 + 信封文法闸。回 null = 收下(202)。 */
export function platformDispatchGate(envelope: WireEnvelope): { status: number; body: unknown } | null {
  const declared = envelope.constraints?.denied_paths ?? []
  if (!declared.every(deniedPathGrammarOk)) {
    return { status: 400, body: { error: "invalid request body", code: "envelope_invalid" } }
  }
  const policy = normalizeExecutionPolicy(envelope.constraints)
  if (policy.denied_paths.length > 0 && !deniedPathsEnforceable(policy, envelope)) {
    return {
      status: 400,
      body: {
        error:
          "denied_paths cannot be enforced for this execution form (arbitrary code / third-party tools can reach any file path); omit denied_paths or use a form with no filesystem-reaching tools",
        code: "denied_paths_unenforceable_for_execution_form",
      },
    }
  }
  return null
}

/** 每次真正出网的 POST body(判「有没有上网」和「上行携带了什么」)。 */
const wire: WireEnvelope[] = []

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(typeof input === "string" ? input : input.toString()).pathname
  if (path !== "/v1/cloud/jobs") return new Response(JSON.stringify({ error: "not found" }), { status: 404 })
  const envelope = JSON.parse(String(init?.body ?? "{}")) as WireEnvelope
  wire.push(envelope)
  const rejection = platformDispatchGate(envelope)
  if (rejection) return new Response(JSON.stringify(rejection.body), { status: rejection.status })
  return new Response(
    JSON.stringify({
      schema_version: 1,
      job_id: JOB,
      status: "queued",
      autonomy: envelope.autonomy,
      ...(envelope.kind ? { kind: envelope.kind } : {}),
      urls: {
        status: `${BASE}/v1/cloud/jobs/${JOB}`,
        events: `${BASE}/v1/cloud/jobs/${JOB}/events`,
        result: `${BASE}/v1/cloud/jobs/${JOB}/artifacts`,
      },
    }),
    { status: 202 },
  )
}) as typeof fetch

const jobs = await import("./alpha-cloud-jobs")

const accepted = (kind: string) => ({
  schema_version: 1,
  job_id: JOB,
  status: "queued",
  autonomy: "pipeline",
  kind,
  urls: {
    status: `${BASE}/v1/cloud/jobs/${JOB}`,
    events: `${BASE}/v1/cloud/jobs/${JOB}/events`,
    result: `${BASE}/v1/cloud/jobs/${JOB}/artifacts`,
  },
})

// ── 退出条件① —— 桌面自己发起的作业在新门下不被 400 ────────────────────────────────────
test("桌面「派发本项目 diff」发出的信封被平台收下,而不是撞上诚实门", async () => {
  wire.length = 0
  // cloud-dispatch-box.tsx runLegacyDiff 真实构造的形状(pipeline + budget + network:restricted)。
  const envelope: CloudJobEnvelope = {
    autonomy: "pipeline",
    kind: "code-review",
    input: { diff: "diff --git a/x b/x\n-old\n+new\n" },
    budget: { max_iter: 25, max_tokens: 300_000, max_wall_clock_sec: 600 },
    constraints: { network: "restricted" },
  }

  const result = await jobs.dispatchCloudJob(envelope)

  // 可观察结果:拿到 job_id(作业真的排上队),而不是一条错误。
  expect(result).toEqual(accepted("code-review"))
  // 上行的信封里一条路径限制都没有 —— 缺省注入一旦回来,上面那条断言当场变成 400。
  expect(wire).toHaveLength(1)
  expect(wire[0]?.constraints?.denied_paths).toBeUndefined()
})

test("最小信封(调用方连 constraints 都没给)同样被收下", async () => {
  wire.length = 0
  const result = await jobs.dispatchCloudJob({ autonomy: "pipeline", kind: "research", input: { question: "q" } })
  expect(result).toEqual(accepted("research"))
  expect(wire[0]?.constraints).toBeUndefined()
})

// ── 退出条件② —— 仍然声明路径限制时,用户看到的是诚实说明而不是一个数字 ──────────────────
test("调用方坚持声明路径限制 ⇒ 拿到平台的分类码,不是被抹平的 http-400", async () => {
  wire.length = 0
  const result = await jobs.dispatchCloudJob({
    autonomy: "pipeline",
    kind: "code-review",
    input: { diff: "diff --git a/x b/x\n" },
    // 文法合法的写法是 `secrets/**`(实跑 ap@9cf67bd 的 DeniedPathV1Schema 确认:`secrets/`
    // 带尾斜杠会被文法拒),所以它一定落在诚实门那一支,而不是信封文法那一支。
    constraints: { denied_paths: ["secrets/**"] },
  })

  expect(result).toEqual({ error: "denied_paths_unenforceable_for_execution_form" })
  expect(wire[0]?.constraints?.denied_paths).toEqual(["secrets/**"])
})

// ── 退出条件④ —— 零工具不能被静默接受 ──────────────────────────────────────────────────
test("没声明工具的 bounded-agent 连网都不上(平台会把它归一成零工具作业)", async () => {
  wire.length = 0
  const result = await jobs.dispatchCloudJob({
    autonomy: "bounded-agent",
    objective: "Summarise this week's release notes",
    capabilities: ["web_search"],
  })

  expect(result).toEqual({ error: "tools-not-declared" })
  // 关键:一个请求都没发出去 —— 不是"发了然后失败",是根本没送。
  expect(wire).toEqual([])
})

test("声明了工具的 bounded-agent 被收下,且工具集合原样上行", async () => {
  wire.length = 0
  const result = await jobs.dispatchCloudJob({
    autonomy: "bounded-agent",
    objective: "Summarise this week's release notes",
    capabilities: ["web_search"],
    constraints: { allowed_tools: ["web"] },
  })

  expect(result).toMatchObject({ job_id: JOB, status: "queued", autonomy: "bounded-agent" })
  expect(wire[0]?.constraints?.allowed_tools).toEqual(["web"])
})

// ── 元判据:先证明这个假平台测得出已知的坏,再用它判未知的好 ────────────────────────────
test("假平台确实拒得动 #918 之前那份缺省注入(否则上面五条全是假绿)", () => {
  const pipeline = platformDispatchGate({
    autonomy: "pipeline",
    kind: "code-review",
    constraints: { denied_paths: HISTORICAL_INJECTED_DENIED_PATHS },
  })
  // 那四条里 `.env*` / `*.pem` 自带 glob 元字符,`.alpha/` / `.git/` 带尾斜杠 —— 四条**全部**
  // 过不了信封文法(实跑 ap@9cf67bd 的 DeniedPathV1Schema 逐条确认),400 先于 job_id 生成。
  expect(pipeline).toMatchObject({ status: 400, body: { code: "envelope_invalid" } })

  // 文法合法的路径限制(`.alpha/**`),在同一个 pipeline 形态下落到诚实门那一支。
  expect(
    platformDispatchGate({ autonomy: "pipeline", kind: "code-review", constraints: { denied_paths: [".alpha/**"] } }),
  ).toMatchObject({ status: 400, body: { code: "denied_paths_unenforceable_for_execution_form" } })

  // Tier-2 编码作业:带着工具就强制不了(这正是本票标题里那个形态)。
  expect(
    platformDispatchGate({
      autonomy: "bounded-agent",
      capabilities: ["code_exec"],
      constraints: { allowed_tools: ["Write", "Bash"], denied_paths: [".alpha/**"] },
    }),
  ).toMatchObject({ status: 400, body: { code: "denied_paths_unenforceable_for_execution_form" } })

  // 而不带路径限制的同一个作业照常放行 —— 证明这个假平台不是"见谁拒谁"。
  expect(
    platformDispatchGate({
      autonomy: "bounded-agent",
      capabilities: ["code_exec"],
      constraints: { allowed_tools: ["Write", "Bash"] },
    }),
  ).toBeNull()
})
