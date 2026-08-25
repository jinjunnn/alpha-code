// REQ-092 / alpha-code#402 取证共用件:起 origin(独立进程)、算独立摘要、扫描敏感物。
//
// 纪律:本文件里的**期望值一律是独立字面量或独立工具的输出**,不 import 生产常量。
// 生产的 ARTIFACT_MAX_BYTES 若被改小/改大,这里的判据必须照旧红。

import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"

/** 独立锚点:平台契约文件 artifact-descriptor.schema.json 的 size.maximum(不是 TS 常量)。 */
export const CONTRACT_ARTIFACT_MAX_BYTES = 104857600
/** 独立锚点:平台契约文件 limits.json。 */
export const CONTRACT_CONTROL_ENVELOPE_MAX_BYTES = 262144
export const CONTRACT_NON_STREAMING_PAYLOAD_MAX_BYTES = 524288

export type Origin = { port: number; base: string; stop: () => void }

export async function startOrigin(serverPath: string, fixtureDir: string): Promise<Origin> {
  const child = spawn(process.execPath, [serverPath, fixtureDir], { stdio: ["ignore", "pipe", "inherit"] })
  const port = await new Promise<number>((resolve, reject) => {
    let buf = ""
    const t = setTimeout(() => reject(new Error("origin did not start in 10s")), 10_000)
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString()
      const nl = buf.indexOf("\n")
      if (nl >= 0) {
        clearTimeout(t)
        resolve(JSON.parse(buf.slice(0, nl)).port as number)
      }
    })
    child.on("exit", (code) => reject(new Error(`origin exited early: ${code}`)))
  })
  return { port, base: `http://127.0.0.1:${port}`, stop: () => child.kill("SIGKILL") }
}

/** 第三方实现的摘要(不是 node:crypto,不是被测代码):/usr/bin/shasum。 */
export function shasumOf(file: string): string {
  const r = spawnSync("/usr/bin/shasum", ["-a", "256", file], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`shasum failed: ${r.stderr}`)
  return r.stdout.trim().split(/\s+/)[0]
}

export type OriginStat = {
  requests: number
  /** origin 真正推出 socket 的 body 字节数。 */
  written: number
  clientAbortedEarly: number
  writtenAtAbort: number[]
  authorizations: string[]
  ranges: (string | null)[]
  statuses: number[]
  declaredContentLength: (string | null)[]
}

export async function originStats(o: Origin, probe: string): Promise<OriginStat> {
  const res = await fetch(`${o.base}/__stats?probe=${encodeURIComponent(probe)}`)
  return (await res.json()) as OriginStat
}

export async function originReset(o: Origin): Promise<void> {
  await fetch(`${o.base}/__reset`, { method: "POST", body: "{}" })
}

// ---------------------------------------------------------------------------
// 敏感物扫描器
// ---------------------------------------------------------------------------
export type Finding = { path: string; kind: string; sample: string }

export type ScanSecrets = {
  /** 完整 bearer token 明文。 */
  token: string
  /** 内容字节的若干前像(命中即说明完整字节泄漏)。 */
  contentProbes: { label: string; utf8?: string; base64: string; hex: string }[]
}

const DATA_URL_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^;,]*)*(?:;base64)?,/i
const BEARER_RE = /bearer[\s:=]+[A-Za-z0-9._~+/=-]{8,}/i
/** 长 base64 串(≥256 字符的 base64 字母表连续块)—— 内联内容的通用指纹。 */
const LONG_B64_RE = /[A-Za-z0-9+/]{256,}={0,2}/

const CONTENT_KEY_RE = /^(base64|b64|dataUrl|data_url|bytes|content|contentBase64|inlineContent|blob|buffer|data)$/

export function scanValue(root: unknown, secrets: ScanSecrets, rootLabel = "$"): Finding[] {
  const out: Finding[] = []
  const seen = new Set<unknown>()
  const walk = (v: unknown, p: string, depth: number) => {
    if (depth > 64) return
    if (v === null || v === undefined) return
    if (typeof v === "string") {
      if (secrets.token && v.includes(secrets.token)) out.push({ path: p, kind: "token-plaintext", sample: clip(v) })
      if (BEARER_RE.test(v)) out.push({ path: p, kind: "bearer-wordform", sample: clip(v) })
      if (DATA_URL_RE.test(v)) out.push({ path: p, kind: "data-url", sample: clip(v) })
      if (LONG_B64_RE.test(v)) out.push({ path: p, kind: "long-base64", sample: clip(v) })
      for (const probe of secrets.contentProbes) {
        if (probe.utf8 && v.includes(probe.utf8)) out.push({ path: p, kind: `content-utf8:${probe.label}`, sample: clip(v) })
        if (v.includes(probe.base64)) out.push({ path: p, kind: `content-base64:${probe.label}`, sample: clip(v) })
        if (v.includes(probe.hex)) out.push({ path: p, kind: `content-hex:${probe.label}`, sample: clip(v) })
      }
      return
    }
    if (typeof v !== "object") return
    if (seen.has(v)) return
    seen.add(v)
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
      out.push({ path: p, kind: "binary-object", sample: `${(v as { constructor: { name: string } }).constructor.name} byteLength=${(v as ArrayBufferView).byteLength ?? (v as ArrayBuffer).byteLength}` })
      return
    }
    if (Array.isArray(v)) {
      // JSON 化的 Buffer/TypedArray:`{type:"Buffer",data:[...]}` 或裸的字节数组。
      if (v.length >= 16 && v.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 255)) {
        out.push({ path: p, kind: "byte-array", sample: `number[${v.length}] all 0..255` })
        return
      }
      v.forEach((item, i) => walk(item, `${p}[${i}]`, depth + 1))
      return
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // 只有「装得下内容」的值才算内容承载:长字符串 / 二进制对象 / 字节数组。
      // 计数(`bytes: 3145728`)不是内容 —— 但把门槛放宽到 number 会让 `content-bearing-key`
      // 变成一个恒响的报警器,那和没有报警器等价。
      const heavy =
        (typeof val === "string" && val.length >= 16) ||
        ArrayBuffer.isView(val) ||
        val instanceof ArrayBuffer ||
        (Array.isArray(val) && val.length >= 16 && val.every((x) => typeof x === "number"))
      if (CONTENT_KEY_RE.test(k) && heavy) {
        out.push({ path: `${p}.${k}`, kind: "content-bearing-key", sample: clip(typeof val === "string" ? val : JSON.stringify(val)) })
      }
      walk(val, `${p}.${k}`, depth + 1)
    }
  }
  walk(root, rootLabel, 0)
  return out
}

export function scanText(text: string, secrets: ScanSecrets, label: string): Finding[] {
  return scanValue(text, secrets, label)
}

export function scanFile(file: string, secrets: ScanSecrets): Finding[] {
  return scanText(fs.readFileSync(file, "utf8"), secrets, file)
}

const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…(${s.length})` : s)

export function contentProbe(label: string, bytes: Buffer): ScanSecrets["contentProbes"][number] {
  return {
    label,
    base64: bytes.toString("base64").replace(/=+$/, ""),
    hex: bytes.toString("hex"),
  }
}
