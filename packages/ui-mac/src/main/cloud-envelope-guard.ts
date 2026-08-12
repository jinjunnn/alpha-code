// ADR-021 §2 —— 云 dispatch 上行硬校验(REQ-020 T1,兼 B3 验收⑦)。A 侧前置单点,B 侧 Zod
// schema 校验之前再挡一层;MCP facade 路径(agent 经 mcp.cloud 直调 B)由 B 侧兜底(双层,见
// ADR-021 后果)。纯函数、零 electron 依赖(镜像 alpha-cloud-events-core.ts 的拆分方式,单测友好)。
//
// 三条规则,全部 loud-fail —— 绝不静默截断/改写内容(改写 = 送出损坏数据还装没事,反 placebo
// 纪律 C28;ADR-021 §2 明文「不做静默改写」):
//   ① 工具集合必须显式:bounded-agent 未声明非空 `constraints.allowed_tools` 即拒发;
//   ② 体积帽:实发序列化形态 >256KiB 拒发(diff-only 优先,勿传全库);
//   ③ secrets 扫描:input/objective 递归扫字符串,命中即拒发并指出字段路径。
//
// [#918] 原规则①「denied_paths 缺省注入(`.env* / *.pem / .alpha/ / .git/`)」**已删除**,
// 因为它承诺的保护从来没有真正存在,而平台侧现在会因此整个拒收作业:
//   · alpha-platform@9cf67bd `lib/cloud-contract.ts:78 deniedPathsEnforceable` ——
//     `autonomy: "pipeline"` **恒**不可强制(固定管线在沙箱跑任意代码);Tier-2(claude_code)
//     只在工具集合为空时才算可强制。桌面今天发的全是 pipeline ⇒ 恒不可强制。
//   · 因此 `lib/cloud-core.ts:172` 的诚实门对「非空 denied_paths + 不可强制」回 400
//     `denied_paths_unenforceable_for_execution_form`,先于任何副作用。
//   · 且那四条默认值本身带 glob 元字符,`contracts/v1/execution-policy.ts DeniedPathV1Schema`
//     在信封 parse 阶段就拒(文法 = upload-manifest POSIX-relative + 可选 `/**` 后缀)。
//   继续注入 = 桌面每一次云派发都被 400。真正的密钥防线是③ secrets 扫描与上传同意面的
//   `classifyUploadContent`,它们不依赖沙箱内的路径强制。
//
// [#918] 新规则①的由来:同一个平台改动把「缺 constraints」从 fail-open 翻成 fail-closed ——
// `normalizeExecutionPolicy`(cloud-contract.ts:57)把缺失的 `allowed_tools` 折叠成 `[]`,
// 而 `agent-runner.mjs:79` 的 `tools: policy.allowed_tools` 里 `[]` = 禁用全部内建工具。
// 于是一个不声明工具的 bounded-agent 会**跑起来、烧预算、什么都做不了然后 completed**。
// 这正是本票禁止的「静默降级成零工具」,所以桌面必须显式声明它要的工具集合,声明不了就别发。

import { randomUUID } from "node:crypto"
import type { CloudJobEnvelope } from "../preload/types"
import {
  CONTROL_ENVELOPE_MAX_BYTES,
  decodeContract,
  type CloudJobRequestV1,
} from "@alpha-code/contracts-consumer"

export const MAX_ENVELOPE_BYTES = CONTROL_ENVELOPE_MAX_BYTES

// 高置信度密钥模式。定位是纵深一层、非唯一防线(A6 的 {file:} 通道才是密钥主防线);刻意收窄到
// 强前缀/结构模式,把普通代码 diff 的误杀率压到最低 —— 新格式 token 有假阴性,属 ADR-021 已知
// 且接受的边界。
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "openai-anthropic-key", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
]

export type SecretHit = { field: string; pattern: string }

function scanValue(value: unknown, fieldPath: string, hits: SecretHit[]): void {
  if (typeof value === "string") {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(value)) hits.push({ field: fieldPath, pattern: p.name })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(v, `${fieldPath}[${i}]`, hits))
    return
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) scanValue(v, `${fieldPath}.${k}`, hits)
  }
}

/** 只扫两条出境内容通道(ADR-021 §2 点名 input/objective);budget/constraints 等控制字段不扫。 */
export function scanEnvelopeSecrets(envelope: CloudJobEnvelope): SecretHit[] {
  const hits: SecretHit[] = []
  if (envelope.input !== undefined) scanValue(envelope.input, "input", hits)
  if (envelope.objective !== undefined) scanValue(envelope.objective, "objective", hits)
  return hits
}

export type GuardResult = { ok: true; envelope: CloudJobRequestV1 } | { ok: false; error: string }

// #400(REQ-109 / platform#255):幂等键由 **main 在 guard 这一个咽喉** mint,每个用户意图恰好
// 一次 —— dispatch 路径与 explicit-upload 路径都只 guard 一次,之后的每次网络重试都序列化同一个
// guarded envelope,「第 N 次重试带同一个键」因此是结构性质,不靠调用方自律。renderer 自带键会被
// 拒(下方 loud-fail):键决定服务端准入去重的身份,身份由 main-owned 边界持有,与 bearer 同侧。
// deps.id 仅供测试注入;randomUUID(36 字符,[0-9a-f-])落在契约 `^[A-Za-z0-9._-]{8,128}$` 内。
export function guardCloudEnvelope(envelope: CloudJobEnvelope, deps: { id?: () => string } = {}): GuardResult {
  if (containsReservedUploadControl(envelope)) return { ok: false, error: "upload-main-gate-required" }
  // [#400] 幂等键归 main 所有:调用方(含 renderer / 技能)自带即拒 —— 键必须由这个咽喉 mint 一次,
  //   否则「一次用户意图内跨重试稳定」这条性质就成了调用方的约定而不是结构。
  if (Object.hasOwn(envelope as object, "idempotency_key")) {
    return { ok: false, error: "idempotency-key-is-main-owned" }
  }
  // ① 工具集合必须显式(见文件头 [#918])。缺失与显式 `[]` 在平台侧归一成同一个 deny-all,
  //   而 bounded-agent 的目标全靠工具达成 ⇒ 两者都当作「没说清楚」拒发,不替调用方猜。
  //   pipeline 不适用:固定管线跑的是自己的代码,`allowed_tools` 在那条路上不是工具闸
  //   (alpha-platform@9cf67bd sandbox.ts 的 /v1/exec、/v1/run-python 只透传 policy)。
  if (envelope.autonomy === "bounded-agent" && !(envelope.constraints?.allowed_tools?.length)) {
    return { ok: false, error: "tools-not-declared" }
  }
  // denied_paths 原样透传:声明了就送上去,由平台的诚实门裁决并回分类码 —— 不静默剥掉
  //   一条用户以为生效的限制(剥掉 = 我们替第三方解释它的文法,正是 ADR-021 禁止的形态)。
  const versioned = {
    schema_version: 1 as const,
    artifact_policy: { delivery: "descriptor_only" as const },
    idempotency_key: (deps.id ?? randomUUID)(),
    ...envelope,
  }

  // ② 体积帽 —— 以实际会发出的序列化形态计量;超限拒发,不截断。
  let serialized: string
  try {
    serialized = JSON.stringify(versioned)
  } catch {
    return { ok: false, error: "envelope-not-serializable" }
  }
  const bytes = Buffer.byteLength(serialized, "utf8")
  if (bytes > MAX_ENVELOPE_BYTES) {
    return { ok: false, error: `envelope-too-large: ${bytes} bytes > ${MAX_ENVELOPE_BYTES}(diff-only 优先,勿传全库)` }
  }

  // ③ secrets 扫描 —— 命中拒发并指出字段;不静默改写。
  const hits = scanEnvelopeSecrets(versioned)
  if (hits.length > 0) {
    const shown = hits.slice(0, 5).map((h) => `${h.field}(${h.pattern})`)
    const more = hits.length > shown.length ? ` +${hits.length - shown.length}` : ""
    return { ok: false, error: `secrets-detected: ${shown.join(", ")}${more} —— 移除密钥后重试(不做静默改写)` }
  }

  try {
    return { ok: true, envelope: decodeContract("CloudJobRequestV1", versioned, "cloud-http") }
  } catch {
    return { ok: false, error: "contract-incompatible" }
  }
}

function containsReservedUploadControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReservedUploadControl)
  if (!value || typeof value !== "object") return false
  return Object.entries(value).some(
    ([key, nested]) =>
      ["upload", "manifest", "upload_consent", "consent_token", "consentToken"].includes(key) ||
      containsReservedUploadControl(nested),
  )
}
