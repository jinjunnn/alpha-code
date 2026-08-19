// release-manifest — signed desktop release manifest producer core(#175,父需求 alpha-work#11)。
//
// 这一份是发布链的**唯一机器可消费真相**:channel/version、每个最终 artifact 的
// filename/platform/arch/size/digest、SBOM、signing/notarization/Windows publisher、
// updater metadata,全部从**最终发布文件的字节**计算(CLI 侧),在这里做一致性裁决。
// 任何必需事实缺失或不一致 = 拒绝产出 manifest = 发布被阻断(fail hard,无 warning 通道)。
//
// 契约:docs/contracts/desktop-release-manifest.md(schema v1、签名模型、信任/轮换、失败类枚举)。
// 签名模型与 catalog-channels 合同 §2 同形:ed25519 over 精确字节(无 canonical-JSON),
// keyId = 公钥 SPKI DER 字节的 sha256 hex,.sig 为 base64(允许尾随空白)。
// 信任根:docs/contracts/desktop-release-manifest.trust.json(消费方 vendor 它;未知 keyId /
// revoked key / 未知 schema 版本一律 fail closed —— AC6)。
//
// 分工:本模块是纯逻辑(可 typecheck、可负向测试);真实字节的枚举与哈希、codesign/spctl/
// stapler 的执行在 scripts/release-manifest.ts;Windows Authenticode 事实由
// .github/workflows/alpha-windows-build.yml 的 pwsh 步骤采集成 facts JSON,
// scripts/verify-windows-signing.ts 在 CI 上执行 evaluateWindowsSigning 作硬门。

import { createHash, createPublicKey, createPrivateKey, sign as edSign, verify as edVerify } from "node:crypto"

// ── 常量与策略锚(独立于任何被测对象;测试用独立字面量交叉钉) ─────────────────────────

export const RELEASE_MANIFEST_SCHEMA = "alpha.release.manifest.v1"
export const RELEASE_TRUST_SCHEMA = "alpha.release-manifest.trust.v1"
export const WINDOWS_SIGNING_FACTS_SCHEMA = "alpha.release.windows-signing-facts.v1"

/** Apple Developer ID team(Beijing yuanyuji;docs/runbooks/distribution.md §0)。 */
export const APPLE_TEAM_ID = "RQX6X6A635"

/**
 * Windows Authenticode 可信 publisher 白名单(证书 Subject 逐字比较)。
 * 今天为空 = **尚无任何已注册的可信 Windows publisher**(Authenticode 证书采购归 REQ-076 T3,
 * 尚未落地)⇒ beta/prod 的任何 Windows artifact 一律 fail closed,包括「已签名但 signer 未知」。
 * 证书落地时:把精确 Subject 追加到这里 + 契约文档,同一 PR 内更新负向测试。
 */
export const WINDOWS_PUBLISHER_ALLOWLIST: readonly string[] = []

export type ReleaseChannel = "dev" | "beta" | "prod"
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ["dev", "beta", "prod"]

/** channel → electron-builder updater feed 前缀(prod=latest,beta=beta;dev 走默认 latest)。 */
export const FEED_PREFIX: Record<ReleaseChannel, string> = { dev: "latest", beta: "beta", prod: "latest" }

// ── 基础密码学(与 catalog-channels 合同 §2 同形) ────────────────────────────────────

export const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex")

export const keyIdOfSpkiDerB64 = (pubB64: string): string => sha256Hex(Buffer.from(pubB64, "base64"))

export function verifyEd25519(body: Buffer, sigB64: string, pubB64: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" })
    return edVerify(null, body, pub, Buffer.from(sigB64.trim(), "base64"))
  } catch {
    return false
  }
}

/** 用 PKCS#8 PEM 私钥对精确字节签名,返回 base64。 */
export function signEd25519(body: Buffer, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem)
  return edSign(null, body, key).toString("base64")
}

/** 从 PKCS#8 PEM 私钥导出 SPKI DER base64 公钥(keygen / 信任条目用)。 */
export function publicKeySpkiDerB64FromPem(privateKeyPem: string): string {
  const pub = createPublicKey(createPrivateKey(privateKeyPem))
  return pub.export({ format: "der", type: "spki" }).toString("base64")
}

// ── 形状工具(严格 schema:未知键一律拒) ──────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
// electron-updater 的 sha512 是 base64(88 字符含 padding)。
const SHA512_B64_RE = /^[A-Za-z0-9+/]{86}==$/
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const isDateTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v))
const onlyKeys = (o: Record<string, unknown>, allowed: string[]): string | null => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k))
  return extra.length ? `unknown keys: ${extra.join(",")}` : null
}
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0

// ── 类型 ─────────────────────────────────────────────────────────────────────────────

export type ArtifactPlatform = "darwin" | "win32"
export type ArtifactArch = "arm64" | "x64"
export type ArtifactKind = "installer" | "updater-archive" | "blockmap"

/** 从最终发布文件字节算出的 inventory 条目(CLI 计算,builder 只做一致性裁决)。 */
export type ArtifactFact = {
  filename: string
  platform: ArtifactPlatform
  arch: ArtifactArch
  kind: ArtifactKind
  size: number
  /** base64(electron-updater 口径,与 feed 直接比较)。 */
  sha512: string
  /** hex(通用消费口径)。 */
  sha256: string
}

/** 解析后的一份 updater feed(latest-mac.yml / latest.yml / beta*.yml)。 */
export type UpdaterFeedFact = {
  filename: string
  size: number
  sha256: string
  doc: { version: string; files: { url: string; sha512: string; size: number }[] }
}

export type MacSigningFacts = {
  signed: boolean
  /** codesign Authority 行的完整身份(如 "Developer ID Application: … (RQX6X6A635)");未签名为 null。 */
  identity: string | null
  teamId: string | null
  notarized: boolean
  stapled: boolean
}

export type WindowsArtifactSigningFact = {
  filename: string
  /** 采集时刻该文件字节的 sha256 hex —— 把 facts 绑到具体字节,拿旧 facts 配新包必炸。 */
  sha256: string
  /** Get-AuthenticodeSignature Status 原文(如 Valid / NotSigned / HashMismatch)。 */
  status: string
  signed: boolean
  /** SignerCertificate.Subject 逐字;未签名为 null。 */
  publisher: string | null
  thumbprint: string | null
}

export type WindowsSigningFactsDoc = {
  schema: typeof WINDOWS_SIGNING_FACTS_SCHEMA
  channel: ReleaseChannel
  collectedAt: string
  artifacts: WindowsArtifactSigningFact[]
}

export type SbomFact = {
  filename: string
  size: number
  sha256: string
  format: string
  componentCount: number
}

export type ReleasePolicy = {
  appleTeamId: string
  windowsPublisherAllowlist: readonly string[]
}

export type BuildManifestInput = {
  channel: ReleaseChannel
  version: string
  releaseTag: string
  repo: string
  publishedAt: string
  artifacts: ArtifactFact[]
  feeds: UpdaterFeedFact[]
  macSigning: MacSigningFacts | null
  windowsFacts: WindowsSigningFactsDoc | null
  sbom: SbomFact | null
  keyId: string
  policy: ReleasePolicy
}

export type ReleaseManifestV1 = {
  schema: typeof RELEASE_MANIFEST_SCHEMA
  channel: ReleaseChannel
  version: string
  releaseTag: string
  repo: string
  publishedAt: string
  keyId: string
  artifacts: (ArtifactFact & {
    signing:
      | { type: "apple"; signed: boolean; identity: string | null; teamId: string | null; notarized: boolean; stapled: boolean }
      | { type: "authenticode"; signed: boolean; status: string; publisher: string | null; thumbprint: string | null }
  })[]
  updater: {
    feeds: { filename: string; size: number; sha256: string; version: string }[]
  }
  sbom: SbomFact
}

export type TrustKey = {
  keyId: string
  publicKey: string
  status: "active" | "retiring" | "revoked"
  notBefore: string
  notAfter?: string
}

export type ReleaseTrustDoc = {
  schema: typeof RELEASE_TRUST_SCHEMA
  sequence: number
  publishedAt: string
  keys: TrustKey[]
  /** 撤销的**已发布 manifest**(bytes sha256)—— 坏版本召回位(AC6)。 */
  revokedManifests: { sha256: string; reason: string; revokedAt: string }[]
}

export type Verdict = { ok: true } | { ok: false; errors: string[] }

// ── Windows Authenticode 门(CI 硬门 + producer 复用同一份裁决) ───────────────────────

export function validateWindowsFactsDoc(v: unknown): { ok: true; doc: WindowsSigningFactsDoc } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error: `windows-facts schema: ${error}` })
  if (!isObj(v)) return bad("not an object")
  const extra = onlyKeys(v, ["schema", "channel", "collectedAt", "artifacts"])
  if (extra) return bad(extra)
  if (v.schema !== WINDOWS_SIGNING_FACTS_SCHEMA) return bad(`schema=${String(v.schema)}`)
  if (!RELEASE_CHANNELS.includes(v.channel as ReleaseChannel)) return bad("channel")
  if (!isDateTime(v.collectedAt)) return bad("collectedAt")
  if (!Array.isArray(v.artifacts) || v.artifacts.length < 1) return bad("artifacts empty")
  for (const a of v.artifacts) {
    if (!isObj(a)) return bad("artifacts[] not object")
    const e = onlyKeys(a, ["filename", "sha256", "status", "signed", "publisher", "thumbprint"])
    if (e) return bad(`artifacts[] ${e}`)
    if (typeof a.filename !== "string" || !a.filename) return bad("artifacts[].filename")
    if (typeof a.sha256 !== "string" || !HEX64.test(a.sha256)) return bad("artifacts[].sha256")
    if (typeof a.status !== "string" || !a.status) return bad("artifacts[].status")
    if (typeof a.signed !== "boolean") return bad("artifacts[].signed")
    if (a.publisher !== null && typeof a.publisher !== "string") return bad("artifacts[].publisher")
    if (a.thumbprint !== null && typeof a.thumbprint !== "string") return bad("artifacts[].thumbprint")
  }
  return { ok: true, doc: v as unknown as WindowsSigningFactsDoc }
}

/**
 * beta/prod:每个 Windows artifact 必须 signed && status=Valid && publisher 在白名单里
 * (白名单为空 = 没有已注册可信 publisher = 全拒,包括「签了但 signer 未知」)。
 * dev:只要求事实**完整如实记录**,不要求签名 —— dev 包不发布。
 */
export function evaluateWindowsSigning(doc: WindowsSigningFactsDoc, channel: ReleaseChannel, policy: ReleasePolicy): Verdict {
  const errors: string[] = []
  if (doc.channel !== channel)
    errors.push(`W1 channel binding: facts collected for '${doc.channel}', gate evaluated for '${channel}'`)
  if (channel === "beta" || channel === "prod") {
    for (const a of doc.artifacts) {
      if (!a.signed || a.status !== "Valid") {
        errors.push(`W2 unsigned windows artifact on ${channel}: ${a.filename} (status=${a.status})`)
        continue
      }
      if (a.publisher === null) {
        errors.push(`W3 signed but no publisher subject recorded: ${a.filename}`)
        continue
      }
      if (policy.windowsPublisherAllowlist.length === 0) {
        errors.push(
          `W4 no trusted Windows publisher registered (allowlist empty, fail-closed): ${a.filename} signed by '${a.publisher}'`,
        )
        continue
      }
      if (!policy.windowsPublisherAllowlist.includes(a.publisher))
        errors.push(`W5 publisher mismatch on ${channel}: ${a.filename} signed by '${a.publisher}'`)
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true }
}

// ── mac 签名/公证输出解析(codesign -dvv / spctl -a -vvv -t install / stapler validate) ──

/**
 * 从三个 Apple 工具的真实输出组装 MacSigningFacts。
 * signed 的判据是 Authority 链上出现 Developer ID Application + TeamIdentifier 有值:
 * ad-hoc 包的 codesign -dvv 输出 `Signature=adhoc`、无 Authority 行、TeamIdentifier=not set。
 */
export function parseMacSigningOutputs(codesignOut: string, spctlOut: string, staplerExitCode: number): MacSigningFacts {
  const authority = codesignOut
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("Authority=Developer ID Application:"))
  const identity = authority ? authority.slice("Authority=".length) : null
  const teamLine = codesignOut
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("TeamIdentifier="))
  const teamRaw = teamLine ? teamLine.slice("TeamIdentifier=".length) : ""
  const teamId = teamRaw && teamRaw !== "not set" ? teamRaw : null
  const signed = identity !== null && teamId !== null && !/^Signature=adhoc$/m.test(codesignOut)
  const notarized = /:\s*accepted\b/.test(spctlOut) && spctlOut.includes("source=Notarized Developer ID")
  return { signed, identity, teamId, notarized, stapled: staplerExitCode === 0 }
}

// ── updater feed 解析(electron-builder 生成的 latest*.yml;非通用 YAML,按其固定形状) ──

export function parseUpdaterFeed(text: string): { version: string; files: { url: string; sha512: string; size: number }[] } {
  const lines = text.split("\n")
  let version = ""
  const files: { url: string; sha512: string; size: number }[] = []
  let current: { url?: string; sha512?: string; size?: number } | undefined

  const flush = () => {
    if (current?.url && current.sha512 && current.size) files.push(current as { url: string; sha512: string; size: number })
    current = undefined
  }

  for (const line of lines) {
    const indented = line.startsWith("    ") || line.startsWith("  -")
    if (line.startsWith("version:")) version = line.slice("version:".length).trim()
    else if (line.trim().startsWith("- url:")) {
      flush()
      current = { url: line.trim().slice("- url:".length).trim() }
    } else if (indented && current && line.trim().startsWith("sha512:")) current.sha512 = line.trim().slice("sha512:".length).trim()
    else if (indented && current && line.trim().startsWith("size:")) current.size = Number(line.trim().slice("size:".length).trim())
    else if (!indented && current) flush()
  }
  flush()
  return { version, files }
}

// ── manifest 组装 + fail-hard 一致性裁决 ─────────────────────────────────────────────

export function buildReleaseManifest(input: BuildManifestInput): { ok: true; manifest: ReleaseManifestV1 } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const err = (m: string) => errors.push(m)

  // R1 channel/version/tag/repo
  if (!RELEASE_CHANNELS.includes(input.channel)) err(`R1 channel: '${String(input.channel)}'`)
  if (!SEMVER_RE.test(input.version)) err(`R1 version not semver: '${input.version}'`)
  if (input.version === "0.0.0" || input.version.startsWith("0.0.0-") || input.version === "local")
    err(`R1 placeholder version: '${input.version}'`)
  if (input.releaseTag !== `v${input.version}`) err(`R1 releaseTag '${input.releaseTag}' != v${input.version}`)
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo)) err(`R1 repo: '${input.repo}'`)
  if (!isDateTime(input.publishedAt)) err(`R1 publishedAt: '${input.publishedAt}'`)
  if (!HEX64.test(input.keyId)) err(`R1 keyId: '${input.keyId}'`)

  // R2 artifacts 形状 + 唯一性
  if (input.artifacts.length === 0) err("R2 no artifacts")
  const names = new Set<string>()
  for (const a of input.artifacts) {
    if (!a.filename) err("R2 artifact filename empty")
    if (names.has(a.filename)) err(`R2 duplicate artifact: ${a.filename}`)
    names.add(a.filename)
    if (!isPosInt(a.size)) err(`R2 size not positive int: ${a.filename}`)
    if (!SHA512_B64_RE.test(a.sha512)) err(`R2 sha512 not base64-512: ${a.filename}`)
    if (!HEX64.test(a.sha256)) err(`R2 sha256 not hex64: ${a.filename}`)
  }
  if (!input.artifacts.some((a) => a.kind === "installer")) err("R2 no installer artifact")

  // R3 blockmap 必须挂在既有 artifact 上
  for (const a of input.artifacts) {
    if (a.kind !== "blockmap") continue
    const base = a.filename.replace(/\.blockmap$/, "")
    if (base === a.filename || !names.has(base)) err(`R3 orphan blockmap: ${a.filename}`)
  }

  // R4 每个出现的平台必须有恰好一份 feed;feed 覆盖该平台全部非 blockmap artifact,
  //    条目 filename/sha512/size 与 inventory 逐字相等;feed.version == manifest.version。
  const platforms = [...new Set(input.artifacts.map((a) => a.platform))]
  const feedPrefix = FEED_PREFIX[input.channel]
  const feedNameFor = (p: ArtifactPlatform) => (p === "darwin" ? `${feedPrefix}-mac.yml` : `${feedPrefix}.yml`)
  const feedByName = new Map(input.feeds.map((f) => [f.filename, f]))
  for (const f of input.feeds) {
    if (!isPosInt(f.size)) err(`R4 feed size: ${f.filename}`)
    if (!HEX64.test(f.sha256)) err(`R4 feed sha256: ${f.filename}`)
    if (f.doc.version !== input.version) err(`R4 feed version mismatch: ${f.filename} has '${f.doc.version}', manifest '${input.version}'`)
  }
  for (const p of platforms) {
    const want = feedNameFor(p)
    const feed = feedByName.get(want)
    if (!feed) {
      err(`R4 missing updater feed for ${p}: ${want}`)
      continue
    }
    const covered = new Set<string>()
    for (const entry of feed.doc.files) {
      if (/^https?:\/\//.test(entry.url)) {
        err(`R4 feed entry must be bare filename, got URL: ${entry.url}`)
        continue
      }
      const artifact = input.artifacts.find((a) => a.filename === entry.url)
      if (!artifact) {
        err(`R4 feed entry not in final inventory: ${entry.url} (${want})`)
        continue
      }
      if (artifact.platform !== p) err(`R4 feed entry platform mismatch: ${entry.url} in ${want}`)
      if (artifact.sha512 !== entry.sha512) err(`R4 digest mismatch (feed vs final bytes): ${entry.url}`)
      if (artifact.size !== entry.size) err(`R4 size mismatch (feed vs final bytes): ${entry.url}`)
      covered.add(entry.url)
    }
    for (const a of input.artifacts) {
      if (a.platform !== p || a.kind === "blockmap") continue
      if (!covered.has(a.filename)) err(`R4 artifact missing from updater feed ${want}: ${a.filename}`)
    }
  }
  for (const f of input.feeds) {
    if (![...platforms].some((p) => feedNameFor(p) === f.filename)) err(`R4 feed without matching platform artifacts: ${f.filename}`)
  }

  // R5 SBOM 必须在场且完整
  if (!input.sbom) err("R5 SBOM missing")
  else {
    if (!input.sbom.filename) err("R5 SBOM filename empty")
    if (!isPosInt(input.sbom.size)) err("R5 SBOM size")
    if (!HEX64.test(input.sbom.sha256)) err("R5 SBOM sha256")
    if (!input.sbom.format) err("R5 SBOM format empty")
    if (!isPosInt(input.sbom.componentCount)) err(`R5 SBOM componentCount must be >=1, got ${input.sbom.componentCount}`)
  }

  // R6 darwin 签名/公证事实(beta/prod 硬门;dev 只要求如实在场)
  const macArtifacts = input.artifacts.filter((a) => a.platform === "darwin")
  if (macArtifacts.length > 0 && !input.macSigning) err("R6 darwin artifacts present but mac signing facts missing")
  if (input.macSigning && (input.channel === "beta" || input.channel === "prod")) {
    const m = input.macSigning
    if (!m.signed) err(`R6 unsigned mac build on ${input.channel}`)
    if (m.teamId !== input.policy.appleTeamId)
      err(`R6 mac team mismatch: got '${String(m.teamId)}', policy '${input.policy.appleTeamId}'`)
    if (!m.notarized) err(`R6 mac build not notarized on ${input.channel}`)
    if (!m.stapled) err(`R6 mac notarization ticket not stapled on ${input.channel}`)
  }

  // R7 win32 事实绑定(facts 必须逐文件在场,且 sha256 与最终字节相等)+ Authenticode 门
  const winArtifacts = input.artifacts.filter((a) => a.platform === "win32" && a.kind !== "blockmap")
  if (winArtifacts.length > 0) {
    if (!input.windowsFacts) err("R7 win32 artifacts present but windows signing facts missing")
    else {
      const factByName = new Map(input.windowsFacts.artifacts.map((f) => [f.filename, f]))
      for (const a of winArtifacts) {
        const f = factByName.get(a.filename)
        if (!f) {
          err(`R7 no signing facts for windows artifact: ${a.filename}`)
          continue
        }
        if (f.sha256 !== a.sha256)
          err(`R7 signing facts bytes mismatch (facts are for different bytes): ${a.filename}`)
      }
      const gate = evaluateWindowsSigning(input.windowsFacts, input.channel, input.policy)
      if (!gate.ok) errors.push(...gate.errors)
    }
  }

  if (errors.length) return { ok: false, errors }

  const facts = input.windowsFacts ? new Map(input.windowsFacts.artifacts.map((f) => [f.filename, f])) : new Map<string, WindowsArtifactSigningFact>()
  const manifest: ReleaseManifestV1 = {
    schema: RELEASE_MANIFEST_SCHEMA,
    channel: input.channel,
    version: input.version,
    releaseTag: input.releaseTag,
    repo: input.repo,
    publishedAt: input.publishedAt,
    keyId: input.keyId,
    artifacts: input.artifacts.map((a) => ({
      ...a,
      signing:
        a.platform === "darwin"
          ? {
              type: "apple" as const,
              signed: input.macSigning!.signed,
              identity: input.macSigning!.identity,
              teamId: input.macSigning!.teamId,
              notarized: input.macSigning!.notarized,
              stapled: input.macSigning!.stapled,
            }
          : (() => {
              // blockmap 共享其宿主 exe 的事实;facts 缺失在 R7 已拒,这里必然命中。
              const f = facts.get(a.filename.replace(/\.blockmap$/, ""))!
              return {
                type: "authenticode" as const,
                signed: f.signed,
                status: f.status,
                publisher: f.publisher,
                thumbprint: f.thumbprint,
              }
            })(),
    })),
    updater: {
      feeds: input.feeds.map((f) => ({ filename: f.filename, size: f.size, sha256: f.sha256, version: f.doc.version })),
    },
    sbom: input.sbom!,
  }
  return { ok: true, manifest }
}

/** manifest 的规范序列化(签名与验签都对这一形态的精确字节)。 */
export function serializeManifest(manifest: ReleaseManifestV1): Buffer {
  return Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8")
}

// ── 信任文档与验签(消费方口径;未知 schema / 未知 keyId / revoked 一律 fail closed) ────

export function validateTrustDoc(v: unknown): { ok: true; doc: ReleaseTrustDoc } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error: `trust schema: ${error}` })
  if (!isObj(v)) return bad("not an object")
  const extra = onlyKeys(v, ["schema", "sequence", "publishedAt", "keys", "revokedManifests"])
  if (extra) return bad(extra)
  if (v.schema !== RELEASE_TRUST_SCHEMA) return bad(`schema=${String(v.schema)}`)
  if (!isPosInt(v.sequence)) return bad("sequence")
  if (!isDateTime(v.publishedAt)) return bad("publishedAt")
  if (!Array.isArray(v.keys) || v.keys.length < 1) return bad("keys")
  for (const k of v.keys) {
    if (!isObj(k)) return bad("keys[] not object")
    const e = onlyKeys(k, ["keyId", "publicKey", "status", "notBefore", "notAfter"])
    if (e) return bad(`keys[] ${e}`)
    if (typeof k.keyId !== "string" || !HEX64.test(k.keyId)) return bad("keys[].keyId")
    if (typeof k.publicKey !== "string" || !B64_RE.test(k.publicKey) || k.publicKey.length < 40 || k.publicKey.length > 120)
      return bad("keys[].publicKey")
    if (k.status !== "active" && k.status !== "retiring" && k.status !== "revoked") return bad("keys[].status")
    if (typeof k.keyId === "string" && typeof k.publicKey === "string" && keyIdOfSpkiDerB64(k.publicKey) !== k.keyId)
      return bad("keys[].keyId does not match publicKey")
    if (!isDateTime(k.notBefore)) return bad("keys[].notBefore")
    if (k.notAfter !== undefined && !isDateTime(k.notAfter)) return bad("keys[].notAfter")
  }
  if (!Array.isArray(v.revokedManifests)) return bad("revokedManifests")
  for (const r of v.revokedManifests) {
    if (!isObj(r)) return bad("revokedManifests[] not object")
    const e = onlyKeys(r, ["sha256", "reason", "revokedAt"])
    if (e) return bad(`revokedManifests[] ${e}`)
    if (typeof r.sha256 !== "string" || !HEX64.test(r.sha256)) return bad("revokedManifests[].sha256")
    if (typeof r.reason !== "string" || !r.reason) return bad("revokedManifests[].reason")
    if (!isDateTime(r.revokedAt)) return bad("revokedManifests[].revokedAt")
  }
  return { ok: true, doc: v as unknown as ReleaseTrustDoc }
}

/**
 * 验一份已发布 manifest 的精确字节:trust 严格 schema → 未知 manifest schema 拒 →
 * revoked manifest 拒 → keyId 必须在 trust 里且 active/retiring 且在时间窗内 → ed25519 验字节。
 */
export function verifyReleaseManifestBytes(
  bytes: Buffer,
  sigB64: string,
  trust: unknown,
  now: Date = new Date(),
): { ok: true; manifest: ReleaseManifestV1 } | { ok: false; error: string } {
  const t = validateTrustDoc(trust)
  if (!t.ok) return { ok: false, error: t.error }

  let doc: unknown
  try {
    doc = JSON.parse(bytes.toString("utf8"))
  } catch {
    return { ok: false, error: "manifest not valid JSON" }
  }
  if (!isObj(doc)) return { ok: false, error: "manifest not an object" }
  if (doc.schema !== RELEASE_MANIFEST_SCHEMA)
    return { ok: false, error: `unknown manifest schema (fail closed): ${String(doc.schema)}` }
  if (typeof doc.keyId !== "string" || !HEX64.test(doc.keyId)) return { ok: false, error: "manifest keyId malformed" }

  const digest = sha256Hex(bytes)
  const revoked = t.doc.revokedManifests.find((r) => r.sha256 === digest)
  if (revoked) return { ok: false, error: `manifest revoked: ${revoked.reason}` }

  const key = t.doc.keys.find((k) => k.keyId === doc.keyId)
  if (!key) return { ok: false, error: `unknown signing key (fail closed): ${doc.keyId}` }
  if (key.status === "revoked") return { ok: false, error: `signing key revoked: ${doc.keyId}` }
  const nowMs = now.getTime()
  if (nowMs < Date.parse(key.notBefore)) return { ok: false, error: `signing key not yet valid: ${doc.keyId}` }
  if (key.notAfter !== undefined && nowMs > Date.parse(key.notAfter))
    return { ok: false, error: `signing key expired: ${doc.keyId}` }

  if (!verifyEd25519(bytes, sigB64, key.publicKey)) return { ok: false, error: "signature verification failed" }
  return { ok: true, manifest: doc as unknown as ReleaseManifestV1 }
}
