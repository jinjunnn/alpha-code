// A 侧镜像:跨端 `ArtifactDescriptor` 契约(REQ-092 / REQ-093;alpha-code#184/#185)。
//
// ⚠️ 真相源在平台仓(B),本文件是**逐字镜像**(verbatim mirror),不得在此加工:
//   · 来源:alpha-platform `packages/gateway/src/lib/artifact-descriptor.ts`
//     (merged via PR jinjunnn/alpha-platform#42;本镜像基于其 origin/main 形态,2026-07-12);
//   · 该模块零依赖、全 JSON-serializable,平台侧注释原样保留(含平台视角的措辞);
//   · 契约变更流程:先改平台真相源 → 平台合并 → 回此文件逐字同步(不接受只改镜像);
//   · A 侧扩展(manifest / ArtifactService / `.alpha/runs` registry,REQ-093)放各自模块,
//     **不放这里** —— 本文件保持与真相源可逐字 diff。
// 消费纪律:未知 schemaVersion 只读/报错(validateArtifactDescriptor),不得静默按 v1 解释。
// ---------------------------------------------------------------------------
// ▼▼ 以下为平台真相源逐字镜像 ▼▼
// REQ-092 / REQ-093(alpha-platform#27 / #28)—— 跨端 `ArtifactDescriptor` 契约(平台侧单一真相源)。
//
// ⚠️ 本模块是 **A↔B 跨仓契约**:
//   · 零依赖(无 zod / 无 cloudflare:workers / 无 node 内置)—— A 仓(alpha-code#184/#185)按此文件镜像类型;
//   · 全部类型 JSON-serializable(无 Date / Map / 函数字段);
//   · wire 形态 = **camelCase**(REQ-092 建议字段名原样),与 cloud jobs envelope 的 snake_case 分属两层:
//     envelope/status 顶层仍 snake_case(REST 惯例),descriptor 对象内部 camelCase(REQ-092/093 命名)。
//
// 契约不变量(REQ-092 AC#1):status / pipeline result / artifact list / MCP cloud_status+cloud_artifacts /
// 模型 transcript 只携带 descriptor / ID / 关系 —— **不携带 artifact 内容、base64、data URL 或内联二进制**。
// 内容字节唯一出口 = 认证流式 content endpoint(GET /v1/cloud/artifacts/:id/content,见 routes/cloud-jobs.ts)。

// ---- schema 版本 ----
// 语义:descriptor 的**结构**版本(非 API 日期版本)。消费方遇到未知版本必须只读/报错,不得静默重写(REQ-093 AC#8)。
export const ARTIFACT_SCHEMA_VERSION = 1 as const;

// ---- 枚举字段语义 ----
// source:descriptor 的产生端。平台(本仓)只产 "cloud";其余值预留给 A 仓 ArtifactService
//   (workspace/local/message/automation,REQ-093 §3)—— 枚举跨端共享,避免两边各自发明。
export type ArtifactSource = "cloud" | "workspace" | "local" | "message" | "automation";

// trust:内容可信级。
//   "sandboxed"  = 在平台隔离沙箱内生成(egress-lock MicroVM;平台默认值);
//   "platform"   = 平台自身生成(非沙箱工作负载,如未来的服务端转换);
//   "external"   = 外部来源(远端 URL 等);
//   "unverified" = 无法判定来源。
// ⚠️ trust 描述**来源**,不是内容安全结论;渲染端仍须按 detectedMime/policy 决策(REQ-093 非目标 4)。
export type ArtifactTrust = "sandboxed" | "platform" | "external" | "unverified";

// role:artifact 在 run 产出中的角色。平台侧默认 "primary"(pipeline 显式 outputs 都是被请求的成品);
//   "preview"(某 primary 的预览派生,配合 primaryId)/ "log" / "intermediate" 预留给产生预览/中间产物的生产者。
export type ArtifactRole = "primary" | "preview" | "log" | "intermediate";

// verification.status 生命周期(REQ-093 §2 verification):
//   "verified"   = 产出端(沙箱回收时)已算得 sha256,内容按此 digest 可校验;
//   "unverified" = 无 digest(legacy 结果 / 超限省略内容);消费端下载后可自行升级;
//   "pending"    = digest 计算中(平台现不产生,预留);
//   "mismatch"   = 消费端复核 digest 不符 → 必须降级不再显示 verified(A 侧职责,REQ-093 AC#4)。
export type ArtifactVerificationStatus = "verified" | "unverified" | "pending" | "mismatch";

export interface ArtifactVerification {
  status: ArtifactVerificationStatus;
  // MIME 鉴别器标识 + 版本(detectedMime 的出处;如 "alpha-magic/1")。缺省 = 未做 magic 检测。
  detector?: string;
  // ISO-8601;digest 计算时刻(产出端回收时)。
  verifiedAt?: string;
}

// contentRef:内容字节的**唯一**取回方式。
//   url = **server-relative 路径**(如 "/v1/cloud/artifacts/art_x_0_ab12cd34/content"),
//         消费端对着 cloud API origin 解析 —— descriptor 因此与部署域解耦、可长期持久化;
//   auth = "bearer":与 jobs API 同一 Authorization: Bearer(user JWT / api key with "cloud" scope)。
//         token 是 server↔main-process 契约,**不得**进 renderer IPC / 日志 / manifest(REQ-092 AC#5)。
export interface ArtifactContentRef {
  kind: "http-stream";
  url: string;
  auth: "bearer";
}

// provenance:哪个 run/job/生产者产出了它(REQ-093 §2)。不得含 bearer/secret/完整 prompt(REQ-093 AC#7)。
export interface ArtifactProvenance {
  producer: "pipeline" | "bounded-agent";
  jobId: string;      // = cloud job_id(job_<hex>);A 侧 runId 与其一一映射
  kind?: string;      // pipeline kind(office-report/data-analysis/…)或 "bounded_agent"
  step?: string;      // 产出步骤名(已知时;如 "run-sandbox")
  createdAt?: string; // ISO-8601;job 创建时间(平台 CLOUD_KV record)
}

// ---- descriptor 本体(REQ-092 建议最小字段全集)----
export interface ArtifactDescriptor {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  // 稳定 ID。派生规则见 artifactIdFor():对同一 completed job 的不可变 result 是**确定性**的,
  // 重复调用 / 进程重启 / list 与 content 两端各自派生均得到同一 ID(REQ-093「不再临时推导 list」)。
  id: string;
  source: ArtifactSource;
  name: string;          // 产出文件名(未净化原名;下载文件名另经 sanitizeFilename)
  size?: number;         // 字节数(已知时)。消费端限额判断的第一道输入(REQ-092 AC#3)
  claimedMime?: string;  // 产出端按扩展名声明的 MIME(诊断用;不得单独作为高权限渲染依据)
  detectedMime?: string; // magic-bytes 检测结果(见 verification.detector)。与 claimedMime 冲突时消费端应产 warning
  sha256?: string;       // 内容 digest(hex 小写 64 位;产出端回收时单遍计算)
  trust: ArtifactTrust;
  role: ArtifactRole;
  primaryId?: string;    // role="preview" 时指向其 primary artifact 的 id
  previewIds?: string[]; // role="primary" 时其预览派生 id 列表(平台现不产预览 → 恒缺省)
  contentRef: ArtifactContentRef;
  verification: ArtifactVerification;
  provenance: ArtifactProvenance;
}

// ---- 集中配额(REQ-092 AC#3 / REQ-093 §5 基线;两端镜像同值)----
// 单 artifact 内容上限:100 MiB。超限 fail-closed:产出端回收时前置拒绝(不 buffer)、
// content endpoint 在读 body 前按 size/Content-Length 拒绝(413)、长度未知/说谎时边流计数越界即 abort。
export const ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;
// 单 run artifact 件数上限(REQ-093 §5 基线 256;沙箱自动扫描回收也不越过)。
export const MAX_ARTIFACTS_PER_RUN = 256;
// 非流式控制面 payload 上限(alpha-work#1 审计追加:每个非流式 payload 在分配前有显式 ceiling):
// dispatch envelope 请求体 256 KiB;公共 status/result 内联 JSON 512 KiB(超限 → result 被显式省略,artifact 仍可下载)。
export const ENVELOPE_MAX_BYTES = 256 * 1024;
export const PUBLIC_RESULT_MAX_BYTES = 512 * 1024;

// ---- 兼容窗口(REQ-092 交付 6)----
// 迁移顺序:B(本仓)先上 descriptor-only 默认 + 新 content endpoint;A 切换(alpha-code#184)后删旧内联字段。
// 窗口机制:HTTP status / artifacts 路由接受 `?compat=inline-artifacts-v0` 或 `x-alpha-compat: inline-artifacts-v0`
//   → 恢复 legacy 内联 result(含 result.artifacts[].base64 /* REQ-092-compat:此行描述 legacy 字段,非重新引入 */)。
// MCP / 模型 transcript 路径**无兼容开关**(兼容路径不得把 base64 转发给模型,REQ-092 交付 6)。
// ⏰ 移除日期:**2026-08-15** 后删除该 flag 与 legacy 分支(见 docs/cloud-artifact-transport.md 记录)。
export const INLINE_ARTIFACT_COMPAT_FLAG = "inline-artifacts-v0";
export const INLINE_ARTIFACT_COMPAT_REMOVAL = "2026-08-15";

// ---- 稳定 ID 派生 ----
// 格式:art_<jobId>_<index>_<fp8>
//   · jobId  = cloud job_id(job_<a-z0-9_>);
//   · index  = artifact 在 completed result.artifacts[] 中的下标 —— CF Workflow output 终态后**不可变**,
//              故 index 对同一 job 是确定性的(这就是"确定性派生"的锚点,文档化于此);
//   · fp8    = fnv1a32(`${name}\n${size}\n${sha256}`) 8 位 hex 自校验指纹 —— content endpoint 回查时
//              重新派生并比对,防 index 错位/陈旧 ID 命中错误内容(不匹配 → 404)。
// legacy 形态 art_<jobId>_<index>(无 fp,2026-07 前发出)在兼容窗口内仍被接受(跳过指纹校验)。
export const ARTIFACT_ID_RE = /^art_(job_[a-z0-9_]+)_(\d+)(?:_([0-9a-f]{8}))?$/;

// FNV-1a 32-bit(UTF-8 字节流);非加密,仅作 ID 自校验指纹。两端镜像同实现。
export function fnv1a32Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// descriptor 元数据输入(产出端 raw artifact 的**元数据投影**;本模块刻意不认识任何内容字段)。
export interface ArtifactMetaInput {
  name?: string;
  mime?: string;         // 产出端按扩展名声明(→ claimedMime)
  size?: number;
  sha256?: string;       // 产出端回收时算得(→ verified)
  detectedMime?: string; // 产出端 magic 检测(→ detectedMime)
  detector?: string;     // 检测器标识(缺省 "alpha-magic/1" 当 detectedMime 存在)
}

export function artifactFingerprint(a: ArtifactMetaInput): string {
  return fnv1a32Hex(`${a.name ?? ""}\n${a.size ?? ""}\n${a.sha256 ?? ""}`);
}

export function artifactIdFor(jobId: string, index: number, a: ArtifactMetaInput): string {
  return `art_${jobId}_${index}_${artifactFingerprint(a)}`;
}

export interface ParsedArtifactId { jobId: string; index: number; fp?: string }
export function parseArtifactId(id: string): ParsedArtifactId | null {
  const m = ARTIFACT_ID_RE.exec(id);
  if (!m) return null;
  return { jobId: m[1], index: Number(m[2]), ...(m[3] ? { fp: m[3] } : {}) };
}

// ---- descriptor 派生(list / status / MCP / content 各端共用的**唯一**派生实现)----
export interface DeriveDescriptorOpts {
  producer: ArtifactProvenance["producer"];
  kind?: string;
  step?: string;
  createdAt?: string;
  source?: ArtifactSource;   // 平台默认 "cloud"
  trust?: ArtifactTrust;     // 平台默认 "sandboxed"(产物出自 egress-lock 沙箱)
  contentBasePath?: string;  // 默认 "/v1/cloud/artifacts"
}

export function deriveArtifactDescriptors(
  jobId: string,
  artifacts: readonly ArtifactMetaInput[],
  opts: DeriveDescriptorOpts,
): ArtifactDescriptor[] {
  const base = opts.contentBasePath ?? "/v1/cloud/artifacts";
  return artifacts.map((a, index) => {
    const id = artifactIdFor(jobId, index, a);
    const verified = typeof a.sha256 === "string" && a.sha256.length === 64;
    const d: ArtifactDescriptor = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      id,
      source: opts.source ?? "cloud",
      name: a.name ?? `artifact-${index}`,
      trust: opts.trust ?? "sandboxed",
      role: "primary",
      contentRef: { kind: "http-stream", url: `${base}/${id}/content`, auth: "bearer" },
      verification: {
        status: verified ? "verified" : "unverified",
        ...(a.detectedMime ? { detector: a.detector ?? "alpha-magic/1" } : {}),
        ...(verified && opts.createdAt ? { verifiedAt: opts.createdAt } : {}),
      },
      provenance: {
        producer: opts.producer,
        jobId,
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.step ? { step: opts.step } : {}),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    };
    if (typeof a.size === "number") d.size = a.size;
    if (a.mime) d.claimedMime = a.mime;
    if (a.detectedMime) d.detectedMime = a.detectedMime;
    if (verified) d.sha256 = a.sha256;
    return d;
  });
}

// ---- 校验(手写,零依赖;A 侧镜像同规则)----
const SOURCES: readonly string[] = ["cloud", "workspace", "local", "message", "automation"];
const TRUSTS: readonly string[] = ["sandboxed", "platform", "external", "unverified"];
const ROLES: readonly string[] = ["primary", "preview", "log", "intermediate"];
const VSTATUS: readonly string[] = ["verified", "unverified", "pending", "mismatch"];
const SHA256_RE = /^[0-9a-f]{64}$/;

export type ValidateResult = { ok: true; value: ArtifactDescriptor } | { ok: false; errors: string[] };

export function validateArtifactDescriptor(v: unknown): ValidateResult {
  const errors: string[] = [];
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, errors: ["descriptor must be an object"] };
  // 未知未来版本:只读/报错,不得静默按 v1 解释(REQ-093 AC#8)。
  if (o.schemaVersion !== ARTIFACT_SCHEMA_VERSION) errors.push(`unsupported schemaVersion: ${String(o.schemaVersion)} (expected ${ARTIFACT_SCHEMA_VERSION})`);
  if (typeof o.id !== "string" || !ARTIFACT_ID_RE.test(o.id)) errors.push("id must match art_<jobId>_<index>[_<fp8>]");
  if (typeof o.source !== "string" || !SOURCES.includes(o.source)) errors.push("source invalid");
  if (typeof o.name !== "string" || o.name.length === 0) errors.push("name required");
  if (o.size !== undefined && (typeof o.size !== "number" || o.size < 0 || !Number.isFinite(o.size))) errors.push("size must be a non-negative number");
  if (o.sha256 !== undefined && (typeof o.sha256 !== "string" || !SHA256_RE.test(o.sha256))) errors.push("sha256 must be 64 lowercase hex chars");
  if (typeof o.trust !== "string" || !TRUSTS.includes(o.trust)) errors.push("trust invalid");
  if (typeof o.role !== "string" || !ROLES.includes(o.role)) errors.push("role invalid");
  const cr = o.contentRef as Record<string, unknown> | undefined;
  if (!cr || cr.kind !== "http-stream" || typeof cr.url !== "string" || cr.auth !== "bearer") errors.push("contentRef must be {kind:'http-stream', url, auth:'bearer'}");
  const vf = o.verification as Record<string, unknown> | undefined;
  if (!vf || typeof vf.status !== "string" || !VSTATUS.includes(vf.status)) errors.push("verification.status invalid");
  const pv = o.provenance as Record<string, unknown> | undefined;
  if (!pv || (pv.producer !== "pipeline" && pv.producer !== "bounded-agent") || typeof pv.jobId !== "string") errors.push("provenance must have producer + jobId");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: o as unknown as ArtifactDescriptor };
}

// ---- 内联内容清洗(公共视图边界防线,REQ-092 AC#1)----
// 递归剥除内容承载字段:任何名为下列 key 的属性一律移除(公共 JSON 不得携带内容 / 内部存储引用):
//   "base64" / "b64" / "dataUrl" / "data_url"(内联内容)/* REQ-092-compat:剥除清单定义,非引入 */
//   "r2Key" / "downloadPath"(内部存储引用,不下发 —— 下载唯一走 contentRef)
// 字符串值若是 data: URL(RFC 2397 语法)→ 整串替换为占位符(防模型输出把 data URL 塞进 result 文本字段)。
const STRIP_KEYS = new Set(["base64", "b64", "dataUrl", "data_url", "r2Key", "downloadPath"]); /* REQ-092-compat:剥除清单 */
const DATA_URL_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^;,]*)*(?:;base64)?,/i; /* REQ-092-compat:识别用 */
export const DATA_URL_PLACEHOLDER = "[removed: data URL stripped per REQ-092]";

export function scrubInlineContent<T>(value: T, depth = 0): T {
  if (depth > 64) return value; // JSON 无环;深度上限只是防御
  if (typeof value === "string") {
    return (DATA_URL_RE.test(value) ? DATA_URL_PLACEHOLDER : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => scrubInlineContent(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STRIP_KEYS.has(k)) continue;
      out[k] = scrubInlineContent(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
