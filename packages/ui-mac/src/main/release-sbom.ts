// release-sbom — 从**最终打包产物**(app.asar + app.asar.unpacked)枚举捆绑依赖,产 CycloneDX SBOM。
//
// #175:SBOM 是 release manifest 的必需成员。来源刻意选打包器输出的 asar 本体
// (dist/mac-arm64/*.app/Contents/Resources/app.asar 或 dist/win-unpacked/resources/app.asar),
// 而不是源码树的 lockfile —— lockfile 说的是「装了什么」,asar 说的是「**发出去**了什么」。
// asar header 是文档化的稳定格式(pickle: [u32 payloadSize][u32 stringSize][JSON]),这里直接
// 解析,不为一个 header 读取引第三方依赖。零 node_modules 条目 = 不是真的 app bundle,硬失败。

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const SBOM_FORMAT = "CycloneDX-1.6"

type AsarEntry = { offset: number; size: number; unpacked: boolean }

/** 解析 asar header,返回 filePath → 条目(offset 相对内容区起点)。 */
export function parseAsarHeader(buf: Buffer): { entries: Map<string, AsarEntry>; contentOffset: number } {
  if (buf.length < 16) throw new Error("asar: file too small")
  if (buf.readUInt32LE(0) !== 4) throw new Error("asar: bad size pickle")
  const headerSize = buf.readUInt32LE(4)
  if (buf.length < 8 + headerSize) throw new Error("asar: truncated header")
  const stringSize = buf.readUInt32LE(12)
  if (stringSize + 8 > headerSize) throw new Error("asar: bad header pickle")
  const json = buf.subarray(16, 16 + stringSize).toString("utf8")
  const root = JSON.parse(json) as unknown

  const entries = new Map<string, AsarEntry>()
  const walk = (node: unknown, prefix: string) => {
    if (!node || typeof node !== "object") return
    const files = (node as { files?: Record<string, unknown> }).files
    if (!files) return
    for (const [name, child] of Object.entries(files)) {
      const p = prefix ? `${prefix}/${name}` : name
      const c = child as { files?: unknown; size?: number; offset?: string; unpacked?: boolean; link?: string }
      if (c.files) walk(c, p)
      else if (c.link === undefined && typeof c.size === "number")
        entries.set(p, {
          offset: c.offset !== undefined ? Number(c.offset) : -1,
          size: c.size,
          unpacked: c.unpacked === true,
        })
    }
  }
  walk(root, "")
  return { entries, contentOffset: 8 + headerSize }
}

export type SbomComponent = { name: string; version: string; license: string | null }

const PKG_JSON_RE = /^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/

/**
 * 从 asar(及其 .unpacked 目录)枚举捆绑 npm 包。只认 node_modules 顶层(含 scope)的
 * package.json;嵌套 node_modules 同样计入(路径末段匹配)。零命中 = 硬失败。
 */
export function collectBundledPackages(asarPath: string): SbomComponent[] {
  const buf = fs.readFileSync(asarPath)
  const { entries, contentOffset } = parseAsarHeader(buf)
  const unpackedRoot = `${asarPath}.unpacked`

  const seen = new Map<string, SbomComponent>()
  for (const [filePath, entry] of entries) {
    const segments = filePath.split("/")
    // 匹配任意深度的 node_modules/<name>/package.json(含 @scope/name)。
    const idx = segments.lastIndexOf("node_modules")
    if (idx === -1 || segments[segments.length - 1] !== "package.json") continue
    const rel = segments.slice(idx).join("/")
    if (!PKG_JSON_RE.test(rel)) continue

    let bytes: Buffer
    if (entry.unpacked) {
      const p = path.join(unpackedRoot, ...segments)
      if (!fs.existsSync(p)) continue
      bytes = fs.readFileSync(p)
    } else {
      if (entry.offset < 0) continue
      bytes = buf.subarray(contentOffset + entry.offset, contentOffset + entry.offset + entry.size)
    }

    let pkg: { name?: unknown; version?: unknown; license?: unknown }
    try {
      pkg = JSON.parse(bytes.toString("utf8")) as typeof pkg
    } catch {
      continue
    }
    if (typeof pkg.name !== "string" || typeof pkg.version !== "string") continue
    const key = `${pkg.name}@${pkg.version}`
    if (seen.has(key)) continue
    seen.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === "string" ? pkg.license : null,
    })
  }

  const components = [...seen.values()].sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version))
  if (components.length === 0)
    throw new Error(`SBOM: zero bundled packages found in ${asarPath} — not a packaged app bundle`)
  return components
}

/** 确定性 CycloneDX 1.6 JSON(serialNumber 从内容哈希导出,重跑同输入得同字节)。 */
export function buildCycloneDxSbom(input: {
  appName: string
  version: string
  channel: string
  timestamp: string
  components: SbomComponent[]
}): string {
  const contentHash = createHash("sha256")
    .update(JSON.stringify([input.appName, input.version, input.channel, input.components]))
    .digest("hex")
  const uuid = [
    contentHash.slice(0, 8),
    contentHash.slice(8, 12),
    `4${contentHash.slice(13, 16)}`,
    `8${contentHash.slice(17, 20)}`,
    contentHash.slice(20, 32),
  ].join("-")

  const doc = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: {
      timestamp: input.timestamp,
      component: { type: "application", name: input.appName, version: input.version },
      properties: [{ name: "alpha:release:channel", value: input.channel }],
    },
    components: input.components.map((c) => ({
      type: "library",
      name: c.name,
      version: c.version,
      ...(c.license ? { licenses: [{ license: { id: c.license } }] } : {}),
    })),
  }
  return JSON.stringify(doc, null, 2) + "\n"
}
