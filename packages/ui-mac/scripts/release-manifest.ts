#!/usr/bin/env bun
// release-manifest CLI(#175)—— 发布链最后一步:从**最终发布文件的字节**产出签名 release manifest。
//
// 用法(权威流程在 docs/runbooks/distribution.md):
//   keygen:  bun scripts/release-manifest.ts keygen --out ~/.alpha-code-signing/release-manifest-ed25519.pem
//   produce: OPENCODE_CHANNEL=prod bun scripts/release-manifest.ts produce \
//              --channel prod --dist dist [--windows-dir <解包的 win artifact 目录>] \
//              --key ~/.alpha-code-signing/release-manifest-ed25519.pem
//   verify:  bun scripts/release-manifest.ts verify --manifest <json> --sig <sig> \
//              --trust ../../docs/contracts/desktop-release-manifest.trust.json
//
// 裁决逻辑全部在 src/main/release-manifest.ts(typecheck + 负向测试覆盖);本脚本只做
// 真实字节的枚举/哈希、Apple 工具的执行与文件读写。任何一致性失败 = 打印全部错误 + exit 1。

import { createHash, generateKeyPairSync } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { spawnSync } from "node:child_process"

import {
  APPLE_TEAM_ID,
  FEED_PREFIX,
  WINDOWS_PUBLISHER_ALLOWLIST,
  buildReleaseManifest,
  keyIdOfSpkiDerB64,
  parseMacSigningOutputs,
  parseUpdaterFeed,
  publicKeySpkiDerB64FromPem,
  serializeManifest,
  signEd25519,
  validateWindowsFactsDoc,
  verifyReleaseManifestBytes,
  type ArtifactFact,
  type ReleaseChannel,
  type UpdaterFeedFact,
} from "../src/main/release-manifest"
import { buildCycloneDxSbom, collectBundledPackages } from "../src/main/release-sbom"

const packageDir = path.resolve(import.meta.dir, "..")

function die(msg: string): never {
  console.error(`[release-manifest] FAIL: ${msg}`)
  process.exit(1)
}

function fileFacts(filePath: string): { size: number; sha512: string; sha256: string } {
  const bytes = fs.readFileSync(filePath)
  return {
    size: bytes.length,
    sha512: createHash("sha512").update(bytes).digest("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

function readFeed(dir: string, filename: string): UpdaterFeedFact | null {
  const p = path.join(dir, filename)
  if (!fs.existsSync(p)) return null
  const bytes = fs.readFileSync(p)
  return {
    filename,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    doc: parseUpdaterFeed(bytes.toString("utf8")),
  }
}

function run(cmd: string, args: string[]): { exitCode: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  if (r.error) return { exitCode: 127, out: String(r.error) }
  return { exitCode: r.status ?? 1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
}

const [command, ...rest] = process.argv.slice(2)

// ── keygen ───────────────────────────────────────────────────────────────────────────

if (command === "keygen") {
  const { values } = parseArgs({ args: rest, options: { out: { type: "string" } } })
  if (!values.out) die("keygen requires --out <pem path>")
  const out = values.out.replace(/^~(?=\/)/, process.env.HOME ?? "~")
  if (fs.existsSync(out)) die(`refusing to overwrite existing key: ${out}`)
  const { privateKey } = generateKeyPairSync("ed25519")
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
  fs.writeFileSync(out, pem, { mode: 0o600 })
  const pubB64 = publicKeySpkiDerB64FromPem(pem)
  const entry = {
    keyId: keyIdOfSpkiDerB64(pubB64),
    publicKey: pubB64,
    status: "active",
    notBefore: new Date().toISOString(),
  }
  console.log(`[release-manifest] private key written to ${out} (0600)`)
  console.log(`[release-manifest] trust entry for docs/contracts/desktop-release-manifest.trust.json:`)
  console.log(JSON.stringify(entry, null, 2))
  process.exit(0)
}

// ── verify ───────────────────────────────────────────────────────────────────────────

if (command === "verify") {
  const { values } = parseArgs({
    args: rest,
    options: { manifest: { type: "string" }, sig: { type: "string" }, trust: { type: "string" } },
  })
  if (!values.manifest || !values.sig || !values.trust) die("verify requires --manifest --sig --trust")
  const bytes = fs.readFileSync(values.manifest)
  const sig = fs.readFileSync(values.sig, "utf8")
  const trust = JSON.parse(fs.readFileSync(values.trust, "utf8")) as unknown
  const r = verifyReleaseManifestBytes(bytes, sig, trust)
  if (!r.ok) die(r.error)
  console.log(`[release-manifest] OK: ${r.manifest.repo} ${r.manifest.releaseTag} channel=${r.manifest.channel}`)
  process.exit(0)
}

// ── produce ──────────────────────────────────────────────────────────────────────────

if (command !== "produce") die(`unknown command '${String(command)}' (expected keygen | produce | verify)`)

const { values } = parseArgs({
  args: rest,
  options: {
    channel: { type: "string" },
    dist: { type: "string", default: "dist" },
    "windows-dir": { type: "string" },
    key: { type: "string" },
    repo: { type: "string", default: "jinjunnn/alpha-code" },
    out: { type: "string" },
  },
})

const channel = values.channel as ReleaseChannel
if (channel !== "dev" && channel !== "beta" && channel !== "prod") die("--channel must be dev | beta | prod")
if (!values.key) die("--key <ed25519 pkcs8 pem> is required")
const keyPath = values.key.replace(/^~(?=\/)/, process.env.HOME ?? "~")
if (!fs.existsSync(keyPath)) die(`signing key not found: ${keyPath}`)
const privateKeyPem = fs.readFileSync(keyPath, "utf8")
const keyId = keyIdOfSpkiDerB64(publicKeySpkiDerB64FromPem(privateKeyPem))

const distDir = path.resolve(packageDir, values.dist!)
if (!fs.existsSync(distDir)) die(`dist dir not found: ${distDir}`)
const outDir = values.out ? path.resolve(packageDir, values.out) : distDir

const version = (JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as { version: string }).version
const feedPrefix = FEED_PREFIX[channel]

const artifacts: ArtifactFact[] = []
const feeds: UpdaterFeedFact[] = []

// mac artifacts(alpha-code-mac-<arch>.dmg/.zip + blockmaps)—— 从最终 dist 字节计算。
const MAC_ARCHES = ["arm64", "x64"] as const
let appBundle: string | null = null
for (const arch of MAC_ARCHES) {
  const dmg = `alpha-code-mac-${arch}.dmg`
  const zip = `alpha-code-mac-${arch}.zip`
  if (!fs.existsSync(path.join(distDir, dmg)) && !fs.existsSync(path.join(distDir, zip))) continue
  for (const [filename, kind] of [
    [dmg, "installer"],
    [zip, "updater-archive"],
  ] as const) {
    const p = path.join(distDir, filename)
    if (!fs.existsSync(p)) die(`mac artifact set incomplete: missing ${filename}`)
    artifacts.push({ filename, platform: "darwin", arch, kind, ...fileFacts(p) })
    const bm = `${filename}.blockmap`
    if (fs.existsSync(path.join(distDir, bm)))
      artifacts.push({ filename: bm, platform: "darwin", arch, kind: "blockmap", ...fileFacts(path.join(distDir, bm)) })
  }
  const unpacked = path.join(distDir, `mac-${arch}`)
  if (fs.existsSync(unpacked)) {
    const app = fs.readdirSync(unpacked).find((n) => n.endsWith(".app"))
    if (app) appBundle = path.join(unpacked, app)
  }
}

const hasMac = artifacts.some((a) => a.platform === "darwin")
if (hasMac) {
  const feed = readFeed(distDir, `${feedPrefix}-mac.yml`)
  if (feed) feeds.push(feed)
}

// mac 签名/公证事实:对 dist 里打包器留下的 .app 执行 Apple 工具(与 dmg/zip 同一轮打包产物)。
let macSigning = null
if (hasMac) {
  if (process.platform !== "darwin") die("darwin artifacts present but not running on macOS — cannot collect signing facts")
  if (!appBundle) die("darwin artifacts present but no unpacked .app found in dist (need dist/mac-<arch>/*.app for signing facts)")
  const codesign = run("codesign", ["-dvv", appBundle])
  const spctl = run("spctl", ["-a", "-vvv", "-t", "install", appBundle])
  const stapler = run("xcrun", ["stapler", "validate", appBundle])
  macSigning = parseMacSigningOutputs(codesign.out, spctl.out, stapler.exitCode)
  console.log(`[release-manifest] mac signing facts: ${JSON.stringify(macSigning)}`)
}

// windows artifacts + facts(由 alpha-windows-build.yml 采集,经 artifact 落到本地目录)。
let windowsFacts = null
if (values["windows-dir"]) {
  const winDir = path.resolve(packageDir, values["windows-dir"])
  if (!fs.existsSync(winDir)) die(`--windows-dir not found: ${winDir}`)
  const WIN_ARCHES = ["x64", "arm64"] as const
  for (const arch of WIN_ARCHES) {
    const exe = `alpha-code-win-${arch}.exe`
    const p = path.join(winDir, exe)
    if (!fs.existsSync(p)) continue
    artifacts.push({ filename: exe, platform: "win32", arch, kind: "installer", ...fileFacts(p) })
    const bm = `${exe}.blockmap`
    if (fs.existsSync(path.join(winDir, bm)))
      artifacts.push({ filename: bm, platform: "win32", arch, kind: "blockmap", ...fileFacts(path.join(winDir, bm)) })
  }
  const feed = readFeed(winDir, `${feedPrefix}.yml`)
  if (feed) feeds.push(feed)
  const factsPath = path.join(winDir, "windows-signing-facts.json")
  if (fs.existsSync(factsPath)) {
    const parsed = validateWindowsFactsDoc(JSON.parse(fs.readFileSync(factsPath, "utf8")))
    if (!parsed.ok) die(parsed.error)
    windowsFacts = parsed.doc
  }
}

// SBOM:从本轮打包产物的 app.asar 枚举(mac 的 .app;仅 win 时从 win-unpacked)。
let sbom = null
{
  let asarPath: string | null = null
  if (appBundle) asarPath = path.join(appBundle, "Contents", "Resources", "app.asar")
  else if (values["windows-dir"]) {
    const winUnpacked = path.join(path.resolve(packageDir, values["windows-dir"]), "win-unpacked", "resources", "app.asar")
    if (fs.existsSync(winUnpacked)) asarPath = winUnpacked
  }
  if (asarPath && fs.existsSync(asarPath)) {
    const components = collectBundledPackages(asarPath)
    const text = buildCycloneDxSbom({
      appName: "alpha-code",
      version,
      channel,
      timestamp: new Date().toISOString(),
      components,
    })
    const filename = `alpha-code-${version}-sbom.cdx.json`
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, filename), text)
    const bytes = Buffer.from(text, "utf8")
    sbom = {
      filename,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "CycloneDX-1.6",
      componentCount: components.length,
    }
    console.log(`[release-manifest] SBOM: ${filename} (${components.length} components)`)
  }
}

const result = buildReleaseManifest({
  channel,
  version,
  releaseTag: `v${version}`,
  repo: values.repo!,
  publishedAt: new Date().toISOString(),
  keyId,
  artifacts,
  feeds,
  macSigning,
  windowsFacts,
  sbom,
  policy: { appleTeamId: APPLE_TEAM_ID, windowsPublisherAllowlist: WINDOWS_PUBLISHER_ALLOWLIST },
})

if (!result.ok) {
  console.error(`[release-manifest] REFUSED — ${result.errors.length} error(s); release is blocked:`)
  for (const e of result.errors) console.error(`  - ${e}`)
  process.exit(1)
}

const bytes = serializeManifest(result.manifest)
const sig = signEd25519(bytes, privateKeyPem)
fs.mkdirSync(outDir, { recursive: true })
const manifestPath = path.join(outDir, "alpha-release-manifest.json")
fs.writeFileSync(manifestPath, bytes)
fs.writeFileSync(`${manifestPath}.sig`, sig + "\n")
console.log(`[release-manifest] OK: ${manifestPath} (+.sig) — ${result.manifest.artifacts.length} artifacts, channel=${channel}, v${version}`)
