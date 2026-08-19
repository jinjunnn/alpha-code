// release-manifest 负向门(#175 / alpha-work#11)。
//
// 这里的每一条负向用例对应契约 docs/contracts/desktop-release-manifest.md 的一条 fail-hard 规则:
// 删掉生产端任何一条裁决,对应用例当场红。锚点纪律:期望值全部用**独立字面量**,不从被测对象读
// (APPLE_TEAM_ID/白名单的钉子刻意重写字面量,与 runbook/契约交叉,而不是 import 后自比)。

import { describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"

import {
  APPLE_TEAM_ID,
  WINDOWS_PUBLISHER_ALLOWLIST,
  buildReleaseManifest,
  evaluateWindowsSigning,
  keyIdOfSpkiDerB64,
  parseMacSigningOutputs,
  parseUpdaterFeed,
  serializeManifest,
  signEd25519,
  validateTrustDoc,
  validateWindowsFactsDoc,
  verifyReleaseManifestBytes,
  type BuildManifestInput,
  type ReleaseChannel,
  type ReleaseTrustDoc,
  type WindowsSigningFactsDoc,
} from "./release-manifest"

// ── 夹具:全部摘要都是真实哈希(合成内容),不是手编字符串 ─────────────────────────────

const sha512b64 = (s: string) => createHash("sha512").update(s).digest("base64")
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex")
const KEY_ID = "a".repeat(64)

function macSigned() {
  return {
    signed: true,
    identity: "Developer ID Application: Beijing yuanyuji (RQX6X6A635)",
    teamId: "RQX6X6A635",
    notarized: true,
    stapled: true,
  }
}

function winFacts(channel: ReleaseChannel, overrides?: Partial<WindowsSigningFactsDoc["artifacts"][0]>): WindowsSigningFactsDoc {
  return {
    schema: "alpha.release.windows-signing-facts.v1",
    channel,
    collectedAt: "2026-08-19T00:00:00Z",
    artifacts: [
      {
        filename: "alpha-code-win-x64.exe",
        sha256: sha256hex("exe-bytes"),
        status: "Valid",
        signed: true,
        publisher: "CN=Alpha Publisher, O=Alpha, C=SG",
        thumbprint: "AB".repeat(20),
        ...overrides,
      },
    ],
  }
}

/** 一份在「白名单已注册」策略下应当通过的完整 prod 输入。 */
function validInput(channel: ReleaseChannel = "prod"): BuildManifestInput {
  const feedPrefix = channel === "beta" ? "beta" : "latest"
  return {
    channel,
    version: "0.1.4",
    releaseTag: "v0.1.4",
    repo: "jinjunnn/alpha-code",
    publishedAt: "2026-08-19T00:00:00Z",
    keyId: KEY_ID,
    artifacts: [
      { filename: "alpha-code-mac-arm64.dmg", platform: "darwin", arch: "arm64", kind: "installer", size: 111, sha512: sha512b64("dmg"), sha256: sha256hex("dmg") },
      { filename: "alpha-code-mac-arm64.zip", platform: "darwin", arch: "arm64", kind: "updater-archive", size: 222, sha512: sha512b64("zip"), sha256: sha256hex("zip") },
      { filename: "alpha-code-mac-arm64.zip.blockmap", platform: "darwin", arch: "arm64", kind: "blockmap", size: 33, sha512: sha512b64("zbm"), sha256: sha256hex("zbm") },
      { filename: "alpha-code-win-x64.exe", platform: "win32", arch: "x64", kind: "installer", size: 444, sha512: sha512b64("exe"), sha256: sha256hex("exe-bytes") },
      { filename: "alpha-code-win-x64.exe.blockmap", platform: "win32", arch: "x64", kind: "blockmap", size: 55, sha512: sha512b64("ebm"), sha256: sha256hex("ebm") },
    ],
    feeds: [
      {
        filename: `${feedPrefix}-mac.yml`,
        size: 300,
        sha256: sha256hex("mac-feed"),
        doc: {
          version: "0.1.4",
          files: [
            { url: "alpha-code-mac-arm64.zip", sha512: sha512b64("zip"), size: 222 },
            { url: "alpha-code-mac-arm64.dmg", sha512: sha512b64("dmg"), size: 111 },
          ],
        },
      },
      {
        filename: `${feedPrefix}.yml`,
        size: 200,
        sha256: sha256hex("win-feed"),
        doc: { version: "0.1.4", files: [{ url: "alpha-code-win-x64.exe", sha512: sha512b64("exe"), size: 444 }] },
      },
    ],
    macSigning: macSigned(),
    windowsFacts: winFacts(channel),
    sbom: { filename: "alpha-code-0.1.4-sbom.cdx.json", size: 999, sha256: sha256hex("sbom"), format: "CycloneDX-1.6", componentCount: 42 },
    policy: { appleTeamId: "RQX6X6A635", windowsPublisherAllowlist: ["CN=Alpha Publisher, O=Alpha, C=SG"] },
  }
}

const expectErrors = (input: BuildManifestInput, ...fragments: string[]) => {
  const r = buildReleaseManifest(input)
  expect(r.ok).toBe(false)
  if (r.ok) throw new Error("unreachable")
  for (const f of fragments) expect(r.errors.join("\n")).toContain(f)
  return r.errors
}

// ── 正向 ─────────────────────────────────────────────────────────────────────────────

describe("buildReleaseManifest 正向", () => {
  test("完整 prod 输入产出 v1 manifest,signing 事实逐 artifact 附着", () => {
    const r = buildReleaseManifest(validInput("prod"))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    const m = r.manifest
    expect(m.schema).toBe("alpha.release.manifest.v1")
    expect(m.channel).toBe("prod")
    expect(m.version).toBe("0.1.4")
    expect(m.artifacts.length).toBe(5)
    const dmg = m.artifacts.find((a) => a.filename === "alpha-code-mac-arm64.dmg")!
    expect(dmg.signing).toEqual({
      type: "apple",
      signed: true,
      identity: "Developer ID Application: Beijing yuanyuji (RQX6X6A635)",
      teamId: "RQX6X6A635",
      notarized: true,
      stapled: true,
    })
    const exe = m.artifacts.find((a) => a.filename === "alpha-code-win-x64.exe")!
    expect(exe.signing.type).toBe("authenticode")
    expect(exe.signing.signed).toBe(true)
    expect(m.updater.feeds.map((f) => f.filename).sort()).toEqual(["latest-mac.yml", "latest.yml"])
    expect(m.sbom.componentCount).toBe(42)
    expect(m.keyId).toBe(KEY_ID)
  })

  test("dev channel:未签名 Windows + 未签名 mac 如实记录且放行(dev 不发布)", () => {
    const input = validInput("dev")
    input.macSigning = { signed: false, identity: null, teamId: null, notarized: false, stapled: false }
    input.windowsFacts = winFacts("dev", { signed: false, status: "NotSigned", publisher: null, thumbprint: null })
    const r = buildReleaseManifest(input)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    const exe = r.manifest.artifacts.find((a) => a.filename === "alpha-code-win-x64.exe")!
    expect(exe.signing).toEqual({ type: "authenticode", signed: false, status: "NotSigned", publisher: null, thumbprint: null })
  })

  test("beta channel:feed 名走 beta 前缀(beta-mac.yml / beta.yml)", () => {
    const r = buildReleaseManifest(validInput("beta"))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.manifest.updater.feeds.map((f) => f.filename).sort()).toEqual(["beta-mac.yml", "beta.yml"])
  })

  test("serializeManifest 确定性:同输入两次序列化逐字节相等,末尾换行", () => {
    const r = buildReleaseManifest(validInput("prod"))
    if (!r.ok) throw new Error("unreachable")
    const a = serializeManifest(r.manifest)
    const b = serializeManifest(r.manifest)
    expect(a.equals(b)).toBe(true)
    expect(a.toString("utf8").endsWith("}\n")).toBe(true)
  })
})

// ── R1:版本/tag/占位符 ───────────────────────────────────────────────────────────────

describe("R1 版本与标识", () => {
  test("version 0.0.0(占位)拒", () => {
    const i = validInput()
    i.version = "0.0.0"
    i.releaseTag = "v0.0.0"
    for (const f of i.feeds) f.doc.version = "0.0.0"
    expectErrors(i, "R1 placeholder version")
  })
  test("version 0.0.0-dev.1(占位前缀)拒", () => {
    const i = validInput()
    i.version = "0.0.0-dev.1"
    i.releaseTag = "v0.0.0-dev.1"
    for (const f of i.feeds) f.doc.version = "0.0.0-dev.1"
    expectErrors(i, "R1 placeholder version")
  })
  test("version 'local' 拒(非 semver)", () => {
    const i = validInput()
    i.version = "local"
    i.releaseTag = "vlocal"
    for (const f of i.feeds) f.doc.version = "local"
    expectErrors(i, "R1 version not semver")
  })
  test("releaseTag 与 version 不一致拒", () => {
    const i = validInput()
    i.releaseTag = "v0.1.3"
    expectErrors(i, "R1 releaseTag")
  })
})

// ── R2/R3:artifact inventory 形状 ────────────────────────────────────────────────────

describe("R2/R3 artifact inventory", () => {
  test("空 artifacts 拒", () => {
    const i = validInput()
    i.artifacts = []
    i.feeds = []
    expectErrors(i, "R2 no artifacts")
  })
  test("重复 filename 拒", () => {
    const i = validInput()
    i.artifacts.push({ ...i.artifacts[0]! })
    expectErrors(i, "R2 duplicate artifact")
  })
  test("size=0 拒", () => {
    const i = validInput()
    i.artifacts[0]!.size = 0
    expectErrors(i, "R2 size not positive int")
  })
  test("sha512 非 base64-512 形状拒", () => {
    const i = validInput()
    i.artifacts[0]!.sha512 = "deadbeef"
    expectErrors(i, "R2 sha512 not base64-512")
  })
  test("没有任何 installer 拒", () => {
    const i = validInput()
    for (const a of i.artifacts) if (a.kind === "installer") a.kind = "updater-archive"
    expectErrors(i, "R2 no installer artifact")
  })
  test("孤儿 blockmap(宿主不在 inventory)拒", () => {
    const i = validInput()
    i.artifacts.push({
      filename: "ghost.exe.blockmap",
      platform: "win32",
      arch: "x64",
      kind: "blockmap",
      size: 9,
      sha512: sha512b64("g"),
      sha256: sha256hex("g"),
    })
    expectErrors(i, "R3 orphan blockmap: ghost.exe.blockmap")
  })
})

// ── R4:updater feed 与最终字节的一致性 ───────────────────────────────────────────────

describe("R4 updater metadata 一致性", () => {
  test("平台缺 feed 拒(win32 有产物但没有 latest.yml)", () => {
    const i = validInput()
    i.feeds = i.feeds.filter((f) => f.filename !== "latest.yml")
    expectErrors(i, "R4 missing updater feed for win32: latest.yml")
  })
  test("feed version 与 manifest version 不一致拒", () => {
    const i = validInput()
    i.feeds[0]!.doc.version = "0.1.3"
    expectErrors(i, "R4 feed version mismatch")
  })
  test("feed 里的 sha512 与最终字节不一致拒(打包后被改写的包)", () => {
    const i = validInput()
    i.feeds[0]!.doc.files[0]!.sha512 = sha512b64("tampered")
    expectErrors(i, "R4 digest mismatch (feed vs final bytes): alpha-code-mac-arm64.zip")
  })
  test("feed 里的 size 与最终字节不一致拒", () => {
    const i = validInput()
    i.feeds[0]!.doc.files[0]!.size = 99999
    expectErrors(i, "R4 size mismatch (feed vs final bytes): alpha-code-mac-arm64.zip")
  })
  test("feed 指向 inventory 里不存在的文件拒", () => {
    const i = validInput()
    i.feeds[0]!.doc.files.push({ url: "alpha-code-mac-x64.zip", sha512: sha512b64("x"), size: 1 })
    expectErrors(i, "R4 feed entry not in final inventory: alpha-code-mac-x64.zip")
  })
  test("非 blockmap artifact 不在 feed 覆盖面里拒(updater 拿不到它)", () => {
    const i = validInput()
    i.feeds[0]!.doc.files = i.feeds[0]!.doc.files.filter((f) => f.url !== "alpha-code-mac-arm64.dmg")
    expectErrors(i, "R4 artifact missing from updater feed latest-mac.yml: alpha-code-mac-arm64.dmg")
  })
  test("feed 条目是绝对 URL 拒(必须裸文件名)", () => {
    const i = validInput()
    i.feeds[1]!.doc.files[0]!.url = "https://evil.example/alpha-code-win-x64.exe"
    expectErrors(i, "R4 feed entry must be bare filename")
  })
  test("与任何平台产物都对不上的多余 feed 拒", () => {
    const i = validInput()
    i.feeds.push({ filename: "latest-linux.yml", size: 10, sha256: sha256hex("l"), doc: { version: "0.1.4", files: [] } })
    expectErrors(i, "R4 feed without matching platform artifacts: latest-linux.yml")
  })
})

// ── R5:SBOM 必需 ─────────────────────────────────────────────────────────────────────

describe("R5 SBOM", () => {
  test("缺 SBOM 拒", () => {
    const i = validInput()
    i.sbom = null
    expectErrors(i, "R5 SBOM missing")
  })
  test("componentCount=0 拒(空 SBOM 不算 SBOM)", () => {
    const i = validInput()
    i.sbom!.componentCount = 0
    expectErrors(i, "R5 SBOM componentCount")
  })
})

// ── R6:mac 签名/公证门 ───────────────────────────────────────────────────────────────

describe("R6 mac signing/notarization", () => {
  test("darwin 产物在场但 mac 事实缺失拒(任何 channel)", () => {
    const i = validInput("dev")
    i.macSigning = null
    expectErrors(i, "R6 darwin artifacts present but mac signing facts missing")
  })
  test("beta:未签名 mac 拒", () => {
    const i = validInput("beta")
    i.macSigning = { signed: false, identity: null, teamId: null, notarized: false, stapled: false }
    expectErrors(i, "R6 unsigned mac build on beta")
  })
  test("prod:team 不匹配拒(别人的 Developer ID 签的包)", () => {
    const i = validInput("prod")
    i.macSigning!.teamId = "ZZZZZZZZZZ"
    expectErrors(i, "R6 mac team mismatch")
  })
  test("prod:未公证拒", () => {
    const i = validInput("prod")
    i.macSigning!.notarized = false
    expectErrors(i, "R6 mac build not notarized on prod")
  })
  test("prod:公证票未 staple 拒", () => {
    const i = validInput("prod")
    i.macSigning!.stapled = false
    expectErrors(i, "R6 mac notarization ticket not stapled on prod")
  })
})

// ── R7/W:Windows 事实绑定 + Authenticode 门 ─────────────────────────────────────────

describe("R7/W windows signing", () => {
  test("win32 产物在场但 facts 缺失拒", () => {
    const i = validInput("prod")
    i.windowsFacts = null
    expectErrors(i, "R7 win32 artifacts present but windows signing facts missing")
  })
  test("facts 里没有该 exe 的条目拒", () => {
    const i = validInput("prod")
    i.windowsFacts!.artifacts[0]!.filename = "other.exe"
    expectErrors(i, "R7 no signing facts for windows artifact: alpha-code-win-x64.exe")
  })
  test("facts 的 sha256 与最终字节不一致拒(旧 facts 配新包)", () => {
    const i = validInput("prod")
    i.windowsFacts!.artifacts[0]!.sha256 = sha256hex("different-bytes")
    expectErrors(i, "R7 signing facts bytes mismatch")
  })
  test("prod:未签名 Windows 拒(本票标题那一条)", () => {
    const i = validInput("prod")
    i.windowsFacts = winFacts("prod", { signed: false, status: "NotSigned", publisher: null, thumbprint: null })
    expectErrors(i, "W2 unsigned windows artifact on prod: alpha-code-win-x64.exe")
  })
  test("beta:status=HashMismatch 即使 signed=true 也拒", () => {
    const i = validInput("beta")
    i.windowsFacts = winFacts("beta", { status: "HashMismatch" })
    expectErrors(i, "W2 unsigned windows artifact on beta")
  })
  test("prod:签了但 publisher subject 缺失拒", () => {
    const i = validInput("prod")
    i.windowsFacts = winFacts("prod", { publisher: null })
    expectErrors(i, "W3 signed but no publisher subject recorded")
  })
  test("prod:白名单为空时任何 signer 都拒(未知 signer fail-closed)", () => {
    const i = validInput("prod")
    i.policy = { appleTeamId: "RQX6X6A635", windowsPublisherAllowlist: [] }
    expectErrors(i, "W4 no trusted Windows publisher registered")
  })
  test("prod:publisher 与白名单不符拒", () => {
    const i = validInput("prod")
    i.windowsFacts = winFacts("prod", { publisher: "CN=Someone Else, O=Evil, C=XX" })
    expectErrors(i, "W5 publisher mismatch on prod")
  })
  test("channel 绑定:dev 采的 facts 拿来过 prod 门拒", () => {
    const i = validInput("prod")
    i.windowsFacts = winFacts("dev")
    expectErrors(i, "W1 channel binding")
  })
})

// ── facts 文档 schema(CI 硬门的输入面) ─────────────────────────────────────────────

describe("validateWindowsFactsDoc", () => {
  test("完整文档通过", () => {
    expect(validateWindowsFactsDoc(winFacts("prod")).ok).toBe(true)
  })
  test("未知顶层键拒", () => {
    const d = { ...winFacts("prod"), extra: 1 }
    const r = validateWindowsFactsDoc(d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("unknown keys: extra")
  })
  test("schema 字符串不对拒", () => {
    const d = { ...winFacts("prod"), schema: "alpha.release.windows-signing-facts.v2" }
    expect(validateWindowsFactsDoc(d).ok).toBe(false)
  })
  test("artifacts 为空拒(采不到事实不等于没有事实)", () => {
    const d = { ...winFacts("prod"), artifacts: [] }
    const r = validateWindowsFactsDoc(d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("artifacts empty")
  })
  test("sha256 非 hex64 拒", () => {
    const d = winFacts("prod")
    d.artifacts[0]!.sha256 = "not-hex"
    expect(validateWindowsFactsDoc(d).ok).toBe(false)
  })
})

// ── evaluateWindowsSigning 独立口径(CI 上没有完整 inventory 时的那道门) ─────────────

describe("evaluateWindowsSigning", () => {
  test("dev:未签名放行(dev 不发布,只记录)", () => {
    const facts = winFacts("dev", { signed: false, status: "NotSigned", publisher: null, thumbprint: null })
    expect(evaluateWindowsSigning(facts, "dev", { appleTeamId: "RQX6X6A635", windowsPublisherAllowlist: [] }).ok).toBe(true)
  })
  test("prod + 注册白名单 + 匹配 publisher 放行", () => {
    const facts = winFacts("prod")
    const r = evaluateWindowsSigning(facts, "prod", {
      appleTeamId: "RQX6X6A635",
      windowsPublisherAllowlist: ["CN=Alpha Publisher, O=Alpha, C=SG"],
    })
    expect(r.ok).toBe(true)
  })
})

// ── 出厂策略锚(独立字面量交叉钉,不自比) ─────────────────────────────────────────────

describe("出厂策略", () => {
  test("Apple team 锚 = RQX6X6A635(与 distribution runbook §0 交叉)", () => {
    expect(APPLE_TEAM_ID).toBe("RQX6X6A635")
  })
  test("今天没有已注册的 Windows publisher:出厂白名单为空 ⇒ beta/prod Windows 一律 fail closed", () => {
    // 证书采购(REQ-076 T3)落地时,这条测试必须连同白名单与契约文档一起有意识地更新。
    expect(WINDOWS_PUBLISHER_ALLOWLIST.length).toBe(0)
    const facts = winFacts("prod") // 签名有效、publisher 在场 —— 仍必须被拒
    const r = evaluateWindowsSigning(facts, "prod", { appleTeamId: "RQX6X6A635", windowsPublisherAllowlist: WINDOWS_PUBLISHER_ALLOWLIST })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("W4 no trusted Windows publisher registered")
  })
})

// ── manifest 自身签名:签发/验签/轮换/撤销(AC6) ─────────────────────────────────────

function makeKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  const spkiB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64")
  return { pem, spkiB64, keyId: keyIdOfSpkiDerB64(spkiB64) }
}

function trustWith(keys: ReleaseTrustDoc["keys"], revoked: ReleaseTrustDoc["revokedManifests"] = []): ReleaseTrustDoc {
  return { schema: "alpha.release-manifest.trust.v1", sequence: 1, publishedAt: "2026-08-19T00:00:00Z", keys, revokedManifests: revoked }
}

function signedManifestBytes(keyId: string, pem: string) {
  const input = validInput("prod")
  input.keyId = keyId
  const r = buildReleaseManifest(input)
  if (!r.ok) throw new Error(`fixture must build: ${r.errors.join("; ")}`)
  const bytes = serializeManifest(r.manifest)
  const sig = signEd25519(bytes, pem)
  return { bytes, sig }
}

describe("manifest 签名与信任链", () => {
  test("round-trip:active key 签发 → 验签通过并返回 manifest", () => {
    const k = makeKeypair()
    const { bytes, sig } = signedManifestBytes(k.keyId, k.pem)
    const r = verifyReleaseManifestBytes(bytes, sig, trustWith([{ keyId: k.keyId, publicKey: k.spkiB64, status: "active", notBefore: "2026-01-01T00:00:00Z" }]))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.version).toBe("0.1.4")
  })
  test("篡改一个字节验签失败", () => {
    const k = makeKeypair()
    const { bytes, sig } = signedManifestBytes(k.keyId, k.pem)
    const tampered = Buffer.from(bytes.toString("utf8").replace('"0.1.4"', '"9.9.9"'), "utf8")
    const r = verifyReleaseManifestBytes(tampered, sig, trustWith([{ keyId: k.keyId, publicKey: k.spkiB64, status: "active", notBefore: "2026-01-01T00:00:00Z" }]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("signature verification failed")
  })
  test("keyId 不在 trust 里拒(unknown signer fail closed)", () => {
    const signer = makeKeypair()
    const other = makeKeypair()
    const { bytes, sig } = signedManifestBytes(signer.keyId, signer.pem)
    const r = verifyReleaseManifestBytes(bytes, sig, trustWith([{ keyId: other.keyId, publicKey: other.spkiB64, status: "active", notBefore: "2026-01-01T00:00:00Z" }]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("unknown signing key")
  })
  test("revoked key 拒,即使签名本身有效", () => {
    const k = makeKeypair()
    const { bytes, sig } = signedManifestBytes(k.keyId, k.pem)
    const r = verifyReleaseManifestBytes(bytes, sig, trustWith([{ keyId: k.keyId, publicKey: k.spkiB64, status: "revoked", notBefore: "2026-01-01T00:00:00Z" }]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("signing key revoked")
  })
  test("retiring key 在窗口内放行(轮换 overlap)", () => {
    const k = makeKeypair()
    const { bytes, sig } = signedManifestBytes(k.keyId, k.pem)
    const r = verifyReleaseManifestBytes(
      bytes,
      sig,
      trustWith([{ keyId: k.keyId, publicKey: k.spkiB64, status: "retiring", notBefore: "2026-01-01T00:00:00Z", notAfter: "2027-01-01T00:00:00Z" }]),
      new Date("2026-08-19T00:00:00Z"),
    )
    expect(r.ok).toBe(true)
  })
  test("notBefore 未到拒", () => {
    const k = makeKeypair()
    const { bytes, sig } = signedManifestBytes(k.keyId, k.pem)
    const r = verifyReleaseManifestBytes(
      bytes,
      sig,
      trustWith([{ keyId: k.keyId, publicKey: k.spkiB64, status: "active", notBefore: "2027-01-01T00:00:00Z" }]),
      new Date("2026-08-19T00:00:00Z"),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("not yet valid")
  })
  test("notAfter 已过拒", () => {
    const k = makeKeypair()
    const { bytes, sig } = signedManifestBytes(k.keyId, k.pem)
    const r = verifyReleaseManifestBytes(
      bytes,
      sig,
      trustWith([{ keyId: k.keyId, publicKey: k.spkiB64, status: "active", notBefore: "2026-01-01T00:00:00Z", notAfter: "2026-06-01T00:00:00Z" }]),
      new Date("2026-08-19T00:00:00Z"),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("signing key expired")
  })
  test("撤销的 manifest 字节拒(坏版本召回)", () => {
    const k = makeKeypair()
    const { bytes, sig } = signedManifestBytes(k.keyId, k.pem)
    const digest = createHash("sha256").update(bytes).digest("hex")
    const r = verifyReleaseManifestBytes(
      bytes,
      sig,
      trustWith(
        [{ keyId: k.keyId, publicKey: k.spkiB64, status: "active", notBefore: "2026-01-01T00:00:00Z" }],
        [{ sha256: digest, reason: "bad build recalled", revokedAt: "2026-08-19T00:00:00Z" }],
      ),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("manifest revoked: bad build recalled")
  })
  test("未知 manifest schema 版本拒(fail closed,AC6)", () => {
    const k = makeKeypair()
    const { bytes } = signedManifestBytes(k.keyId, k.pem)
    const v2 = Buffer.from(bytes.toString("utf8").replace("alpha.release.manifest.v1", "alpha.release.manifest.v2"), "utf8")
    const sig = signEd25519(v2, k.pem)
    const r = verifyReleaseManifestBytes(v2, sig, trustWith([{ keyId: k.keyId, publicKey: k.spkiB64, status: "active", notBefore: "2026-01-01T00:00:00Z" }]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("unknown manifest schema (fail closed)")
  })
})

describe("validateTrustDoc", () => {
  const k = makeKeypair()
  test("未知顶层键拒", () => {
    const d = { ...trustWith([{ keyId: k.keyId, publicKey: k.spkiB64, status: "active", notBefore: "2026-01-01T00:00:00Z" }]), extra: 1 }
    const r = validateTrustDoc(d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("unknown keys: extra")
  })
  test("keyId 与 publicKey 不对应拒(keyId 不是任意标签,是公钥指纹)", () => {
    const other = makeKeypair()
    const d = trustWith([{ keyId: other.keyId, publicKey: k.spkiB64, status: "active", notBefore: "2026-01-01T00:00:00Z" }])
    const r = validateTrustDoc(d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("keyId does not match publicKey")
  })
  test("keys 为空拒(没有信任根的 trust 文档没有意义)", () => {
    const d = trustWith([{ keyId: k.keyId, publicKey: k.spkiB64, status: "active", notBefore: "2026-01-01T00:00:00Z" }])
    ;(d as { keys: unknown[] }).keys = []
    expect(validateTrustDoc(d).ok).toBe(false)
  })
})

// ── 出厂信任文件(仓内 vendored 数据必须自洽,消费方直接 vendor 它) ─────────────────

describe("出厂信任文件", () => {
  test("docs/contracts/desktop-release-manifest.trust.json 过严格 schema,且至少一把 active 钥", async () => {
    const p = new URL("../../../../docs/contracts/desktop-release-manifest.trust.json", import.meta.url).pathname
    const doc = JSON.parse(await Bun.file(p).text()) as unknown
    const r = validateTrustDoc(doc)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.error)
    expect(r.doc.keys.some((k) => k.status === "active")).toBe(true)
  })
})

// ── mac 工具输出解析 ─────────────────────────────────────────────────────────────────

describe("parseMacSigningOutputs", () => {
  const signedCodesign = [
    "Executable=/x/alpha-code.app/Contents/MacOS/alpha-code",
    "Identifier=com.tide.alphacode",
    "Authority=Developer ID Application: Beijing yuanyuji (RQX6X6A635)",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "TeamIdentifier=RQX6X6A635",
  ].join("\n")
  const notarizedSpctl = ["/x/alpha-code.app: accepted", "source=Notarized Developer ID", "origin=Developer ID Application: Beijing yuanyuji (RQX6X6A635)"].join("\n")

  test("签名+公证+staple 的完整输出全真", () => {
    expect(parseMacSigningOutputs(signedCodesign, notarizedSpctl, 0)).toEqual({
      signed: true,
      identity: "Developer ID Application: Beijing yuanyuji (RQX6X6A635)",
      teamId: "RQX6X6A635",
      notarized: true,
      stapled: true,
    })
  })
  test("ad-hoc 包(Signature=adhoc / 无 Authority / TeamIdentifier=not set)判未签名", () => {
    const adhoc = ["Identifier=com.tide.alphacode.dev", "Signature=adhoc", "TeamIdentifier=not set"].join("\n")
    const rejected = "/x/alpha-code.app: rejected"
    expect(parseMacSigningOutputs(adhoc, rejected, 65)).toEqual({
      signed: false,
      identity: null,
      teamId: null,
      notarized: false,
      stapled: false,
    })
  })
  test("已签名但 spctl 未见公证来源:notarized=false(不许把 accepted 当公证)", () => {
    const acceptedNotNotarized = "/x/alpha-code.app: accepted\nsource=Developer ID"
    const facts = parseMacSigningOutputs(signedCodesign, acceptedNotNotarized, 65)
    expect(facts.signed).toBe(true)
    expect(facts.notarized).toBe(false)
    expect(facts.stapled).toBe(false)
  })
})

// ── updater feed 解析(electron-builder 实际输出形状) ─────────────────────────────────

describe("parseUpdaterFeed", () => {
  test("解析 electron-builder latest-mac.yml 形状(多文件 + blockMapSize + path/sha512 尾行)", () => {
    const yml = [
      "version: 0.1.3",
      "files:",
      "  - url: alpha-code-mac-arm64.zip",
      `    sha512: ${sha512b64("zip")}`,
      "    size: 222",
      "    blockMapSize: 33",
      "  - url: alpha-code-mac-arm64.dmg",
      `    sha512: ${sha512b64("dmg")}`,
      "    size: 111",
      "path: alpha-code-mac-arm64.zip",
      `sha512: ${sha512b64("zip")}`,
      "releaseDate: '2026-08-19T00:00:00.000Z'",
      "",
    ].join("\n")
    const parsed = parseUpdaterFeed(yml)
    expect(parsed.version).toBe("0.1.3")
    expect(parsed.files).toEqual([
      { url: "alpha-code-mac-arm64.zip", sha512: sha512b64("zip"), size: 222 },
      { url: "alpha-code-mac-arm64.dmg", sha512: sha512b64("dmg"), size: 111 },
    ])
  })
  test("缺 sha512/size 的残缺条目不进结果(残缺条目随后会在 R4 覆盖面判红,不静默补全)", () => {
    const yml = ["version: 0.1.3", "files:", "  - url: broken.zip", "    size: 222", ""].join("\n")
    expect(parseUpdaterFeed(yml).files).toEqual([])
  })
})
