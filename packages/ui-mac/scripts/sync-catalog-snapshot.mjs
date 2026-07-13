#!/usr/bin/env node
// sync-catalog-snapshot — REQ-046:A 内置 catalog = C 已发布产物的字节级快照,禁手编。
//
// 拍板(2026-07-06):C 仓 catalog-src 是 agent/skill/command/mcp/plugin 条目的唯一作者真源;
// A 内置 alpha-catalog.json 只是离线回退底座,由本脚本从已发布端点快照生成(发版 runbook 步骤,
// 见 docs/runbooks/distribution.md)。守卫 = alpha-catalog.test.ts 的快照断言(文件 sha256 必须与
// alpha-catalog.snapshot.json meta 一致)—— 手编 catalog 不跑本脚本即红。
//
// 流程:fetch catalog.json + .sig → ed25519 验签(公钥单源:从 remote-catalog.ts 提取,不复制常量)
//   → 形状 sanity → 版本单调(不接受回退,防误快照旧产物)→ 字节原样写入 + meta 落盘。
// 离线逃生:--from-file <path>(本地 alpha-web checkout 的 public/catalog/v1/catalog.json,
//   要求同目录有 catalog.json.sig,同样验签 —— 逃生不逃验签)。

import { createPublicKey, createHash, verify as edVerify } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const extDir = path.resolve(here, "../src/renderer/extensions")
const catalogPath = path.join(extDir, "alpha-catalog.json")
const metaPath = path.join(extDir, "alpha-catalog.snapshot.json")
// REQ-101-A 后公钥常量移居 catalog-channels.ts(remote-catalog 只是别名引用)——单源提取跟随移居
// (REQ-102-A 修复:原 remote-catalog.ts 正则已抓不到常量,脚本会在提钥处 die)。
const catalogChannelsTs = path.resolve(here, "../src/main/catalog-channels.ts")

const CATALOG_URL = "https://alphacodeone.com/catalog/v1/catalog.json"

function pubkeyFromSource() {
  const src = fs.readFileSync(catalogChannelsTs, "utf8")
  const m = src.match(/BUILTIN_CATALOG_PUBKEY_B64 = "([A-Za-z0-9+/=]+)"/)
  if (!m) throw new Error(`cannot extract BUILTIN_CATALOG_PUBKEY_B64 from ${catalogChannelsTs}`)
  return m[1]
}

function verifySig(body, sigB64) {
  const pub = createPublicKey({ key: Buffer.from(pubkeyFromSource(), "base64"), format: "der", type: "spki" })
  return edVerify(null, body, pub, Buffer.from(sigB64.trim(), "base64"))
}

// 与 remote-catalog.ts catalogVersionLess 同规则(段内数值感知)——快照不接受版本回退
function versionLess(a, b) {
  const pa = a.split(/[.\-]/)
  const pb = b.split(/[.\-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? ""
    const y = pb[i] ?? ""
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny
    } else if (x !== y) return x < y
  }
  return false
}

async function loadPublished() {
  const fromFileIdx = process.argv.indexOf("--from-file")
  if (fromFileIdx !== -1) {
    const p = process.argv[fromFileIdx + 1]
    if (!p) throw new Error("--from-file requires a path to catalog.json")
    const body = fs.readFileSync(p)
    const sig = fs.readFileSync(`${p}.sig`, "utf8")
    return { body, sig, source: `file:${path.resolve(p)}` }
  }
  const res = await fetch(CATALOG_URL)
  if (!res.ok) throw new Error(`fetch ${CATALOG_URL} → ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  const sigRes = await fetch(`${CATALOG_URL}.sig`)
  if (!sigRes.ok) throw new Error(`fetch .sig → ${sigRes.status}`)
  const sig = await sigRes.text()
  return { body, sig, source: CATALOG_URL }
}

const { body, sig, source } = await loadPublished()
if (!verifySig(body, sig)) throw new Error("ed25519 signature verification FAILED — refusing to snapshot unsigned/tampered catalog")

const parsed = JSON.parse(body.toString("utf8"))
if (typeof parsed.version !== "string" || !Array.isArray(parsed.entries) || parsed.entries.length === 0)
  throw new Error("published catalog failed shape sanity (version/entries)")

if (fs.existsSync(metaPath)) {
  const prev = JSON.parse(fs.readFileSync(metaPath, "utf8"))
  if (typeof prev.version === "string" && versionLess(parsed.version, prev.version))
    throw new Error(`version rollback refused: published ${parsed.version} < snapshot ${prev.version}`)
}

fs.writeFileSync(catalogPath, body) // 字节原样 —— 快照 == 已发布产物,diff/审计一一对应
fs.writeFileSync(
  metaPath,
  JSON.stringify(
    {
      v: 1,
      version: parsed.version,
      entries: parsed.entries.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      source,
      fetchedAt: new Date().toISOString(),
      _note: "由 scripts/sync-catalog-snapshot.mjs 生成;alpha-catalog.json 禁手编(REQ-046),上架/撤架唯一动作在 alpha-web catalog-src。",
    },
    null,
    2,
  ) + "\n",
)
console.log(`✓ snapshot ${parsed.version}: ${parsed.entries.length} entries ← ${source}`)
