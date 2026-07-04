// ADR-021 §2 —— 云 dispatch 上行硬校验(REQ-020 T1,兼 B3 验收⑦)。A 侧前置单点,B 侧 Zod
// schema 校验之前再挡一层;MCP facade 路径(agent 经 mcp.cloud 直调 B)由 B 侧兜底(双层,见
// ADR-021 后果)。纯函数、零 electron 依赖(镜像 alpha-cloud-events-core.ts 的拆分方式,单测友好)。
//
// 三条规则,全部 loud-fail —— 绝不静默截断/改写内容(改写 = 送出损坏数据还装没事,反 placebo
// 纪律 C28;ADR-021 §2 明文「不做静默改写」):
//   ① denied_paths 缺省注入:contract 未带有效声明时补 `.env* / *.pem / .alpha/ / .git/`;
//   ② 体积帽:注入后的实发序列化形态 >1MB 拒发(diff-only 优先,勿传全库);
//   ③ secrets 扫描:input/objective 递归扫字符串,命中即拒发并指出字段路径。

import type { CloudJobEnvelope } from "../preload/types"

export const MAX_ENVELOPE_BYTES = 1_048_576 // 1MB(ADR-021 §2)
export const DEFAULT_DENIED_PATHS = [".env*", "*.pem", ".alpha/", ".git/"]

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
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) scanValue(v, `${fieldPath}.${k}`, hits)
  }
}

/** 只扫两条出境内容通道(ADR-021 §2 点名 input/objective);budget/constraints 等控制字段不扫。 */
export function scanEnvelopeSecrets(envelope: CloudJobEnvelope): SecretHit[] {
  const hits: SecretHit[] = []
  if (envelope.input !== undefined) scanValue(envelope.input, "input", hits)
  if (envelope.objective !== undefined) scanValue(envelope.objective, "objective", hits)
  return hits
}

export type GuardResult = { ok: true; envelope: CloudJobEnvelope } | { ok: false; error: string }

export function guardCloudEnvelope(envelope: CloudJobEnvelope): GuardResult {
  // ① denied_paths 缺省注入。「未显式声明」按无有效声明算:空数组零保护、也没有正当用例
  //   (真想送 .env 内容照样被 ③ 拦),一律视同未声明补默认。
  const declared = envelope.constraints?.denied_paths
  const guarded: CloudJobEnvelope =
    declared && declared.length > 0
      ? envelope
      : { ...envelope, constraints: { ...(envelope.constraints ?? {}), denied_paths: DEFAULT_DENIED_PATHS } }

  // ② 体积帽 —— 以实际会发出的序列化形态计量;超限拒发,不截断。
  let serialized: string
  try {
    serialized = JSON.stringify(guarded)
  } catch {
    return { ok: false, error: "envelope-not-serializable" }
  }
  const bytes = Buffer.byteLength(serialized, "utf8")
  if (bytes > MAX_ENVELOPE_BYTES) {
    return { ok: false, error: `envelope-too-large: ${bytes} bytes > ${MAX_ENVELOPE_BYTES}(diff-only 优先,勿传全库)` }
  }

  // ③ secrets 扫描 —— 命中拒发并指出字段;不静默改写。
  const hits = scanEnvelopeSecrets(guarded)
  if (hits.length > 0) {
    const shown = hits.slice(0, 5).map((h) => `${h.field}(${h.pattern})`)
    const more = hits.length > shown.length ? ` +${hits.length - shown.length}` : ""
    return { ok: false, error: `secrets-detected: ${shown.join(", ")}${more} —— 移除密钥后重试(不做静默改写)` }
  }

  return { ok: true, envelope: guarded }
}
