// release-sbom 门(#175):SBOM 必须真的从打包产物(asar)里数出来,而不是从源码树推断。
// 夹具 asar 由测试侧的独立 writer 构造(与生产 parser 互逆,写法照 asar 文档格式,不 import 生产端)。

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildCycloneDxSbom, collectBundledPackages, parseAsarHeader } from "./release-sbom"

// ── 测试侧 asar writer(pickle: [u32 4][u32 headerLen] + [u32 payloadSize][u32 strLen][json pad4]) ──

type AsarFileSpec = { content?: string; unpacked?: boolean }

function makeAsar(files: Record<string, AsarFileSpec>): { buf: Buffer; unpackedFiles: Record<string, string> } {
  const root: Record<string, unknown> = {}
  const blobs: Buffer[] = []
  const unpackedFiles: Record<string, string> = {}
  let offset = 0

  for (const [p, spec] of Object.entries(files)) {
    const segments = p.split("/")
    let node = root
    for (const seg of segments.slice(0, -1)) {
      const dir = (node["files"] ??= {}) as Record<string, unknown>
      node = (dir[seg] ??= {}) as Record<string, unknown>
    }
    const dir = (node["files"] ??= {}) as Record<string, unknown>
    const content = Buffer.from(spec.content ?? "", "utf8")
    if (spec.unpacked) {
      dir[segments[segments.length - 1]!] = { size: content.length, unpacked: true }
      unpackedFiles[p] = spec.content ?? ""
    } else {
      dir[segments[segments.length - 1]!] = { size: content.length, offset: String(offset) }
      blobs.push(content)
      offset += content.length
    }
  }

  const json = Buffer.from(JSON.stringify(root), "utf8")
  const payloadSize = 4 + json.length
  const padded = Math.ceil(payloadSize / 4) * 4
  const headerBuf = Buffer.alloc(4 + padded)
  headerBuf.writeUInt32LE(padded, 0)
  headerBuf.writeUInt32LE(json.length, 4)
  json.copy(headerBuf, 8)
  const sizeBuf = Buffer.alloc(8)
  sizeBuf.writeUInt32LE(4, 0)
  sizeBuf.writeUInt32LE(headerBuf.length, 4)
  return { buf: Buffer.concat([sizeBuf, headerBuf, ...blobs]), unpackedFiles }
}

function writeAsarToTmp(files: Record<string, AsarFileSpec>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-sbom-test-"))
  const { buf, unpackedFiles } = makeAsar(files)
  const asarPath = path.join(dir, "app.asar")
  fs.writeFileSync(asarPath, buf)
  for (const [p, content] of Object.entries(unpackedFiles)) {
    const full = path.join(`${asarPath}.unpacked`, p)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return asarPath
}

const pkgJson = (name: string, version: string, license?: string) => JSON.stringify({ name, version, ...(license ? { license } : {}) })

// ── parser ───────────────────────────────────────────────────────────────────────────

describe("parseAsarHeader", () => {
  test("往返:writer 写的条目 parser 逐个找回,内容区偏移正确", () => {
    const { buf } = makeAsar({
      "a.txt": { content: "AAA" },
      "dir/b.txt": { content: "BBBB" },
    })
    const { entries, contentOffset } = parseAsarHeader(buf)
    expect([...entries.keys()].sort()).toEqual(["a.txt", "dir/b.txt"])
    const a = entries.get("a.txt")!
    expect(buf.subarray(contentOffset + a.offset, contentOffset + a.offset + a.size).toString()).toBe("AAA")
    const b = entries.get("dir/b.txt")!
    expect(buf.subarray(contentOffset + b.offset, contentOffset + b.offset + b.size).toString()).toBe("BBBB")
  })
  test("坏 magic 硬失败(不是静默空结果)", () => {
    const { buf } = makeAsar({ "a.txt": { content: "A" } })
    buf.writeUInt32LE(7, 0)
    expect(() => parseAsarHeader(buf)).toThrow("bad size pickle")
  })
  test("截断的 header 硬失败", () => {
    const { buf } = makeAsar({ "a.txt": { content: "A" } })
    expect(() => parseAsarHeader(buf.subarray(0, 12))).toThrow()
  })
})

// ── package 枚举 ─────────────────────────────────────────────────────────────────────

describe("collectBundledPackages", () => {
  test("枚举 node_modules 包(含 @scope 与嵌套 node_modules),按名字排序", () => {
    const asarPath = writeAsarToTmp({
      "node_modules/zeta/package.json": { content: pkgJson("zeta", "2.0.0", "MIT") },
      "node_modules/@scope/alpha/package.json": { content: pkgJson("@scope/alpha", "1.0.0", "Apache-2.0") },
      "node_modules/zeta/node_modules/inner/package.json": { content: pkgJson("inner", "3.0.0") },
      "node_modules/zeta/index.js": { content: "module.exports = 1" },
      "out/main/index.js": { content: "app" },
    })
    const components = collectBundledPackages(asarPath)
    expect(components).toEqual([
      { name: "@scope/alpha", version: "1.0.0", license: "Apache-2.0" },
      { name: "inner", version: "3.0.0", license: null },
      { name: "zeta", version: "2.0.0", license: "MIT" },
    ])
  })
  test("unpacked 条目从 .unpacked 目录读真实字节", () => {
    const asarPath = writeAsarToTmp({
      "node_modules/native-mod/package.json": { content: pkgJson("native-mod", "1.2.3", "MIT"), unpacked: true },
      "node_modules/plain/package.json": { content: pkgJson("plain", "0.0.1") },
    })
    const components = collectBundledPackages(asarPath)
    expect(components.map((c) => `${c.name}@${c.version}`)).toEqual(["native-mod@1.2.3", "plain@0.0.1"])
  })
  test("同名同版本去重", () => {
    const asarPath = writeAsarToTmp({
      "node_modules/dup/package.json": { content: pkgJson("dup", "1.0.0") },
      "node_modules/host/node_modules/dup/package.json": { content: pkgJson("dup", "1.0.0") },
      "node_modules/host/package.json": { content: pkgJson("host", "1.0.0") },
    })
    expect(collectBundledPackages(asarPath).map((c) => c.name)).toEqual(["dup", "host"])
  })
  test("零个捆绑包硬失败(说明枚举的不是真的 app bundle)", () => {
    const asarPath = writeAsarToTmp({ "out/main/index.js": { content: "app" } })
    expect(() => collectBundledPackages(asarPath)).toThrow("zero bundled packages")
  })
})

// ── CycloneDX 输出 ───────────────────────────────────────────────────────────────────

describe("buildCycloneDxSbom", () => {
  const input = {
    appName: "alpha-code",
    version: "0.1.4",
    channel: "prod",
    timestamp: "2026-08-19T00:00:00Z",
    components: [
      { name: "@scope/alpha", version: "1.0.0", license: "Apache-2.0" },
      { name: "plain", version: "0.0.1", license: null },
    ],
  }
  test("确定性:同输入两次生成逐字节相等", () => {
    expect(buildCycloneDxSbom(input)).toBe(buildCycloneDxSbom(input))
  })
  test("CycloneDX 1.6 形状:bomFormat/specVersion/组件/license/channel 属性齐", () => {
    const doc = JSON.parse(buildCycloneDxSbom(input)) as {
      bomFormat: string
      specVersion: string
      serialNumber: string
      metadata: { component: { name: string; version: string }; properties: { name: string; value: string }[] }
      components: { name: string; licenses?: unknown }[]
    }
    expect(doc.bomFormat).toBe("CycloneDX")
    expect(doc.specVersion).toBe("1.6")
    expect(doc.serialNumber.startsWith("urn:uuid:")).toBe(true)
    expect(doc.metadata.component).toEqual({ type: "application", name: "alpha-code", version: "0.1.4" } as never)
    expect(doc.metadata.properties).toEqual([{ name: "alpha:release:channel", value: "prod" }])
    expect(doc.components.length).toBe(2)
    expect(doc.components[0]!.licenses).toEqual([{ license: { id: "Apache-2.0" } }])
    expect(doc.components[1]!.licenses).toBeUndefined()
  })
  test("不同内容得到不同 serialNumber(不是写死的常量)", () => {
    const a = JSON.parse(buildCycloneDxSbom(input)) as { serialNumber: string }
    const b = JSON.parse(buildCycloneDxSbom({ ...input, version: "0.1.5" })) as { serialNumber: string }
    expect(a.serialNumber).not.toBe(b.serialNumber)
  })
})
